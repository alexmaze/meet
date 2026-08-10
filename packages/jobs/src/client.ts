import type {
  ConversationAggregate,
  ConversationCompletionHook,
  DatabaseTransaction,
  MediaCleanupHook,
  MediaCleanupRequest,
} from "@meet/database";
import { sql } from "drizzle-orm";
import { fromDrizzle, PgBoss } from "pg-boss";

import {
  CONVERSATION_FINALIZE_DEAD_LETTER_QUEUE,
  CONVERSATION_FINALIZE_QUEUE,
  MEMORY_EXTRACT_DEAD_LETTER_QUEUE,
  MEMORY_EXTRACT_QUEUE,
  MEDIA_EXPIRE_DEAD_LETTER_QUEUE,
  MEDIA_EXPIRE_QUEUE,
  conversationFinalizeJobSchema,
  mediaExpireJobSchema,
  memoryExtractJobSchema,
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
  await boss.createQueue(CONVERSATION_FINALIZE_DEAD_LETTER_QUEUE, {
    deleteAfterSeconds: 30 * 24 * 60 * 60,
  });
  await boss.createQueue(MEMORY_EXTRACT_DEAD_LETTER_QUEUE, {
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

export class ConversationCompletionJobPublisher {
  constructor(private readonly boss: PgBoss) {}

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
    const payload = conversationFinalizeJobSchema.parse({
      idempotencyKey: `${CONVERSATION_FINALIZE_QUEUE}:${conversation.id}:${conversation.lastSequence}`,
      conversationId: conversation.id,
      userId: conversation.userId,
      completedSequence: conversation.lastSequence,
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
    const payload = memoryExtractJobSchema.parse({
      idempotencyKey: `${MEMORY_EXTRACT_QUEUE}:${conversation.id}:${conversation.lastSequence}`,
      conversationId: conversation.id,
      userId: conversation.userId,
      completedSequence: conversation.lastSequence,
    });
    const jobId = await this.boss.send(MEMORY_EXTRACT_QUEUE, payload, {
      db: fromDrizzle(transaction, sql),
    });
    if (!jobId) throw new Error("Memory extraction job was not created.");
  }
}
