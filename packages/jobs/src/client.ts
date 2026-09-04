import type {
  ConversationAggregate,
  ConversationCheckpointHook,
  ConversationCompletionHook,
  DatabaseTransaction,
  MediaCleanupHook,
  MediaCleanupRequest,
  MemoryIndexHook,
} from "@meet/database";
import {
  aiWorkItems,
  conversationMessages,
  conversationSummaryCheckpoints,
  conversations,
  modelConnections,
  modelPurposeBindings,
  listMemoriesRequiringIndex,
  prepareMemoryIndexEntry,
  providerProfiles,
  type ConversationSummaryCheckpointRecord,
  type Database,
} from "@meet/database";
import type { ModelPurpose } from "@meet/protocol";
import { and, desc, eq, gt, sql, sum } from "drizzle-orm";
import { fromDrizzle, PgBoss } from "pg-boss";

import {
  CONVERSATION_CHECKPOINT_DEAD_LETTER_QUEUE,
  CONVERSATION_CHECKPOINT_QUEUE,
  CONVERSATION_FINALIZE_DEAD_LETTER_QUEUE,
  CONVERSATION_FINALIZE_QUEUE,
  MEMORY_EXTRACT_DEAD_LETTER_QUEUE,
  MEMORY_EXTRACT_QUEUE,
  MEMORY_INDEX_SYNC_DEAD_LETTER_QUEUE,
  MEMORY_INDEX_SYNC_QUEUE,
  MEDIA_EXPIRE_DEAD_LETTER_QUEUE,
  MEDIA_EXPIRE_QUEUE,
  conversationCheckpointJobSchema,
  conversationFinalizeJobSchema,
  mediaExpireJobSchema,
  memoryExtractJobSchema,
  memoryIndexSyncJobSchema,
} from "./schemas.js";

export type JobErrorHandler = (error: Error) => void;

export async function createMeetJobBoss(
  connectionString: string,
  onError: JobErrorHandler = () => undefined,
): Promise<PgBoss> {
  const boss = new PgBoss(connectionString);
  boss.on("error", onError);
  await boss.start();
  await ensureMeetQueues(boss);
  return boss;
}

export async function ensureMeetQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(CONVERSATION_CHECKPOINT_DEAD_LETTER_QUEUE, {
    deleteAfterSeconds: 30 * 24 * 60 * 60,
  });
  await boss.createQueue(CONVERSATION_FINALIZE_DEAD_LETTER_QUEUE, {
    deleteAfterSeconds: 30 * 24 * 60 * 60,
  });
  await boss.createQueue(MEMORY_EXTRACT_DEAD_LETTER_QUEUE, {
    deleteAfterSeconds: 30 * 24 * 60 * 60,
  });
  await boss.createQueue(MEMORY_INDEX_SYNC_DEAD_LETTER_QUEUE, {
    deleteAfterSeconds: 30 * 24 * 60 * 60,
  });
  await boss.createQueue(MEDIA_EXPIRE_DEAD_LETTER_QUEUE, {
    deleteAfterSeconds: 30 * 24 * 60 * 60,
  });
  await boss.createQueue(CONVERSATION_FINALIZE_QUEUE, {
    retryLimit: 4,
    retryDelay: 10,
    retryBackoff: true,
    expireInSeconds: 5 * 60,
    retentionSeconds: 14 * 24 * 60 * 60,
    deleteAfterSeconds: 7 * 24 * 60 * 60,
    deadLetter: CONVERSATION_FINALIZE_DEAD_LETTER_QUEUE,
    notify: true,
  });
  await boss.createQueue(CONVERSATION_CHECKPOINT_QUEUE, {
    retryLimit: 4,
    retryDelay: 10,
    retryBackoff: true,
    expireInSeconds: 5 * 60,
    retentionSeconds: 14 * 24 * 60 * 60,
    deleteAfterSeconds: 7 * 24 * 60 * 60,
    deadLetter: CONVERSATION_CHECKPOINT_DEAD_LETTER_QUEUE,
    notify: true,
  });
  await boss.createQueue(MEMORY_EXTRACT_QUEUE, {
    retryLimit: 4,
    retryDelay: 10,
    retryBackoff: true,
    expireInSeconds: 5 * 60,
    retentionSeconds: 14 * 24 * 60 * 60,
    deleteAfterSeconds: 7 * 24 * 60 * 60,
    deadLetter: MEMORY_EXTRACT_DEAD_LETTER_QUEUE,
    notify: true,
  });
  await boss.createQueue(MEMORY_INDEX_SYNC_QUEUE, {
    retryLimit: 6,
    retryDelay: 15,
    retryBackoff: true,
    expireInSeconds: 2 * 60,
    retentionSeconds: 14 * 24 * 60 * 60,
    deleteAfterSeconds: 7 * 24 * 60 * 60,
    deadLetter: MEMORY_INDEX_SYNC_DEAD_LETTER_QUEUE,
    notify: true,
  });
  await boss.createQueue(MEDIA_EXPIRE_QUEUE, {
    retryLimit: 8,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 10 * 60,
    retentionSeconds: 14 * 24 * 60 * 60,
    deleteAfterSeconds: 7 * 24 * 60 * 60,
    deadLetter: MEDIA_EXPIRE_DEAD_LETTER_QUEUE,
    notify: true,
  });
}

export const CONVERSATION_CHECKPOINT_MESSAGE_INTERVAL = 20;
export const CONVERSATION_CHECKPOINT_CHARACTER_INTERVAL = 12_000;

export class ConversationCheckpointJobPublisher {
  constructor(private readonly boss: PgBoss) {}

  readonly enqueue: ConversationCheckpointHook = async (
    transaction,
    aggregate,
  ) => {
    const conversation = aggregate.conversation;
    const [latest] = await transaction
      .select({
        sourceLastSequence: conversationSummaryCheckpoints.sourceLastSequence,
        sourceMessageCount: conversationSummaryCheckpoints.sourceMessageCount,
      })
      .from(conversationSummaryCheckpoints)
      .where(eq(conversationSummaryCheckpoints.conversationId, conversation.id))
      .orderBy(desc(conversationSummaryCheckpoints.sourceLastSequence))
      .limit(1);
    const previousSequence = latest?.sourceLastSequence ?? 0;
    const previousMessageCount = latest?.sourceMessageCount ?? 0;
    const messageDelta = conversation.messageCount - previousMessageCount;
    if (messageDelta < CONVERSATION_CHECKPOINT_MESSAGE_INTERVAL) {
      const [characters] = await transaction
        .select({
          value: sum(sql<number>`length(${conversationMessages.text})`),
        })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.conversationId, conversation.id),
            gt(conversationMessages.sequence, previousSequence),
          ),
        );
      if (
        !shouldCreateConversationCheckpoint(
          messageDelta,
          Number(characters?.value ?? 0),
        )
      ) {
        return;
      }
    }

    const [binding] = await transaction
      .select({ modelProfileId: modelPurposeBindings.modelProfileId })
      .from(modelPurposeBindings)
      .innerJoin(
        providerProfiles,
        and(
          eq(modelPurposeBindings.modelProfileId, providerProfiles.id),
          eq(providerProfiles.kind, "text"),
          eq(providerProfiles.status, "enabled"),
        ),
      )
      .innerJoin(
        modelConnections,
        and(
          eq(providerProfiles.connectionId, modelConnections.id),
          eq(modelConnections.status, "enabled"),
        ),
      )
      .where(eq(modelPurposeBindings.purpose, "conversation_summary"))
      .limit(1);
    const queuedAt = binding ? new Date() : null;
    const [checkpoint] = await transaction
      .insert(conversationSummaryCheckpoints)
      .values({
        conversationId: conversation.id,
        sourceLastSequence: conversation.lastSequence,
        sourceMessageCount: conversation.messageCount,
        status: binding ? "queued" : "waiting_configuration",
        modelProfileId: binding?.modelProfileId ?? null,
        queuedAt,
      })
      .onConflictDoNothing()
      .returning();
    if (!checkpoint || !binding) return;
    await sendCheckpointJob(
      this.boss,
      transaction,
      checkpoint,
      conversation.userId,
    );
  };
}

export function shouldCreateConversationCheckpoint(
  messageDelta: number,
  characterDelta: number,
): boolean {
  return (
    messageDelta >= CONVERSATION_CHECKPOINT_MESSAGE_INTERVAL ||
    characterDelta >= CONVERSATION_CHECKPOINT_CHARACTER_INTERVAL
  );
}

export class MediaCleanupJobPublisher {
  constructor(private readonly boss: PgBoss) {}

  readonly enqueue: MediaCleanupHook = async (transaction, request) => {
    await this.enqueueCleanup(transaction, request);
  };

  private async enqueueCleanup(
    transaction: DatabaseTransaction,
    request: MediaCleanupRequest,
  ): Promise<void> {
    const suffix =
      request.reason === "expired"
        ? request.expectedExpiresAt?.toISOString()
        : request.notBefore.toISOString();
    const payload = mediaExpireJobSchema.parse({
      idempotencyKey: `${MEDIA_EXPIRE_QUEUE}:${request.mediaId}:${request.reason}:${suffix}`,
      mediaId: request.mediaId,
      objectKey: request.objectKey,
      reason: request.reason,
      notBefore: request.notBefore.toISOString(),
      expectedExpiresAt: request.expectedExpiresAt?.toISOString(),
    });
    const jobId = await this.boss.send(MEDIA_EXPIRE_QUEUE, payload, {
      db: fromDrizzle(transaction, sql),
      startAfter: request.notBefore,
    });
    if (!jobId) throw new Error("Media cleanup job was not created.");
  }
}

export class MemoryIndexJobPublisher {
  constructor(private readonly boss: PgBoss) {}

  readonly enqueue: MemoryIndexHook = async (transaction, memory) => {
    await prepareMemoryIndexEntry(transaction, memory.id);
    const payload = memoryIndexSyncJobSchema.parse({
      idempotencyKey: `${MEMORY_INDEX_SYNC_QUEUE}:${memory.id}:${memory.contentFingerprint}:${memory.status}`,
      memoryId: memory.id,
    });
    const jobId = await this.boss.send(MEMORY_INDEX_SYNC_QUEUE, payload, {
      db: fromDrizzle(transaction, sql),
    });
    if (!jobId) throw new Error("Memory index sync job was not created.");
  };
}

export class MemoryIndexJobReconciler {
  constructor(
    private readonly boss: PgBoss,
    private readonly db: Database,
    private readonly indexRevision?: string,
  ) {}

  async enqueueOutstanding(limit = 1_000): Promise<number> {
    const memories = await listMemoriesRequiringIndex(
      this.db,
      limit,
      this.indexRevision,
    );
    const publisher = new MemoryIndexJobPublisher(this.boss);
    for (const memory of memories) {
      await this.db.transaction((transaction) =>
        publisher.enqueue(transaction, memory),
      );
    }
    return memories.length;
  }
}

export class ConversationCompletionJobPublisher {
  constructor(
    private readonly boss: PgBoss,
    private readonly prepareWork: typeof prepareAiWorkItem = prepareAiWorkItem,
  ) {}

  readonly enqueue: ConversationCompletionHook = async (
    transaction,
    aggregate,
  ) => {
    await this.enqueueFinalize(transaction, aggregate);
    if (aggregate.conversation.mode === "normal") {
      await this.enqueueMemoryExtraction(transaction, aggregate);
    }
  };

  private async enqueueFinalize(
    transaction: DatabaseTransaction,
    aggregate: ConversationAggregate,
  ): Promise<void> {
    const conversation = aggregate.conversation;
    const work = await this.prepareWork(
      transaction,
      aggregate,
      "conversation_summary",
    );
    if (!work) return;
    const payload = conversationFinalizeJobSchema.parse({
      idempotencyKey: `${CONVERSATION_FINALIZE_QUEUE}:${conversation.id}:${conversation.lastSequence}`,
      conversationId: conversation.id,
      userId: conversation.userId,
      completedSequence: conversation.lastSequence,
      workItemId: work.id,
      modelProfileId: work.modelProfileId,
    });
    const jobId = await this.boss.send(CONVERSATION_FINALIZE_QUEUE, payload, {
      db: fromDrizzle(transaction, sql),
    });
    if (!jobId) throw new Error("Conversation finalize job was not created.");
  }

  private async enqueueMemoryExtraction(
    transaction: DatabaseTransaction,
    aggregate: ConversationAggregate,
  ): Promise<void> {
    const conversation = aggregate.conversation;
    const work = await this.prepareWork(
      transaction,
      aggregate,
      "memory_extraction",
    );
    if (!work) return;
    const payload = memoryExtractJobSchema.parse({
      idempotencyKey: `${MEMORY_EXTRACT_QUEUE}:${conversation.id}:${conversation.lastSequence}`,
      conversationId: conversation.id,
      userId: conversation.userId,
      completedSequence: conversation.lastSequence,
      workItemId: work.id,
      modelProfileId: work.modelProfileId,
    });
    const jobId = await this.boss.send(MEMORY_EXTRACT_QUEUE, payload, {
      db: fromDrizzle(transaction, sql),
    });
    if (!jobId) throw new Error("Memory extraction job was not created.");
  }
}

async function prepareAiWorkItem(
  transaction: DatabaseTransaction,
  aggregate: ConversationAggregate,
  purpose: "conversation_summary" | "memory_extraction",
): Promise<{ id: string; modelProfileId: string } | null> {
  const [binding] = await transaction
    .select({ modelProfileId: modelPurposeBindings.modelProfileId })
    .from(modelPurposeBindings)
    .innerJoin(
      providerProfiles,
      and(
        eq(modelPurposeBindings.modelProfileId, providerProfiles.id),
        eq(providerProfiles.kind, "text"),
        eq(providerProfiles.status, "enabled"),
      ),
    )
    .innerJoin(
      modelConnections,
      and(
        eq(providerProfiles.connectionId, modelConnections.id),
        eq(modelConnections.status, "enabled"),
      ),
    )
    .where(eq(modelPurposeBindings.purpose, purpose))
    .limit(1);
  const [inserted] = await transaction
    .insert(aiWorkItems)
    .values({
      conversationId: aggregate.conversation.id,
      purpose,
      modelProfileId: binding?.modelProfileId ?? null,
      status: binding ? "queued" : "waiting_configuration",
      completedSequence: aggregate.conversation.lastSequence,
      queuedAt: binding ? new Date() : null,
    })
    .onConflictDoNothing()
    .returning();
  const work =
    inserted ??
    (
      await transaction
        .select()
        .from(aiWorkItems)
        .where(
          and(
            eq(aiWorkItems.conversationId, aggregate.conversation.id),
            eq(aiWorkItems.purpose, purpose),
          ),
        )
        .limit(1)
    )[0];
  return work?.status === "queued" && work.modelProfileId
    ? { id: work.id, modelProfileId: work.modelProfileId }
    : null;
}

export class ModelBindingJobReconciler {
  constructor(
    private readonly boss: PgBoss,
    private readonly db: Database,
  ) {}

  async enqueueWaiting(purpose: ModelPurpose, modelProfileId: string) {
    if (
      purpose === "realtime_default" ||
      purpose === "memory_embedding" ||
      purpose === "teaching_plan_generation"
    ) {
      return;
    }
    await this.db.transaction(async (tx) => {
      if (purpose === "conversation_summary") {
        const checkpoints = await tx
          .update(conversationSummaryCheckpoints)
          .set({
            modelProfileId,
            status: "queued",
            queuedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            eq(conversationSummaryCheckpoints.status, "waiting_configuration"),
          )
          .returning();
        for (const checkpoint of checkpoints) {
          await sendCheckpointJob(
            this.boss,
            tx,
            checkpoint,
            await conversationUserId(tx, checkpoint.conversationId),
          );
        }
      }
      const waiting = await tx
        .update(aiWorkItems)
        .set({
          modelProfileId,
          status: "queued",
          queuedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiWorkItems.purpose, purpose),
            eq(aiWorkItems.status, "waiting_configuration"),
          ),
        )
        .returning();
      for (const work of waiting) {
        const queue =
          purpose === "conversation_summary"
            ? CONVERSATION_FINALIZE_QUEUE
            : MEMORY_EXTRACT_QUEUE;
        const schema =
          purpose === "conversation_summary"
            ? conversationFinalizeJobSchema
            : memoryExtractJobSchema;
        const payload = schema.parse({
          idempotencyKey: `${queue}:${work.conversationId}:${work.completedSequence}`,
          conversationId: work.conversationId,
          userId: await conversationUserId(tx, work.conversationId),
          completedSequence: work.completedSequence,
          workItemId: work.id,
          modelProfileId,
        });
        const jobId = await this.boss.send(queue, payload, {
          db: fromDrizzle(tx, sql),
        });
        if (!jobId) throw new Error("Waiting AI work job was not created.");
      }
    });
  }
}

export async function sendCheckpointJob(
  boss: PgBoss,
  transaction: DatabaseTransaction,
  checkpoint: ConversationSummaryCheckpointRecord,
  userId: string,
): Promise<void> {
  if (!checkpoint.modelProfileId) {
    throw new Error("Conversation checkpoint has no text model binding.");
  }
  const payload = conversationCheckpointJobSchema.parse({
    idempotencyKey: `${CONVERSATION_CHECKPOINT_QUEUE}:${checkpoint.conversationId}:${checkpoint.sourceLastSequence}`,
    checkpointId: checkpoint.id,
    conversationId: checkpoint.conversationId,
    userId,
    targetSequence: checkpoint.sourceLastSequence,
    modelProfileId: checkpoint.modelProfileId,
  });
  const jobId = await boss.send(CONVERSATION_CHECKPOINT_QUEUE, payload, {
    db: fromDrizzle(transaction, sql),
  });
  if (!jobId) throw new Error("Conversation checkpoint job was not created.");
}

async function conversationUserId(
  transaction: DatabaseTransaction,
  conversationId: string,
): Promise<string> {
  const [row] = await transaction
    .select({ userId: conversations.userId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!row) throw new Error("AI work conversation is missing.");
  return row.userId;
}
