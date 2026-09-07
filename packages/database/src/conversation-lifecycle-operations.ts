import type {
  ConversationWriter,
  PrepareConversationRequest,
} from "@meet/protocol";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  aiWorkItems,
  characterMemories,
  characters,
  conversationControls,
  conversationOperations,
  conversationRuntimeSnapshots,
  conversationSummaries,
  conversations,
  type ConversationControlRecord,
  type ConversationOperationRecord,
  type ConversationRecord,
} from "./schema.js";
import {
  findConversationAggregate,
  lockOwnedConversation,
  type ConversationAggregate,
  type DatabaseTransaction,
} from "./conversation-operations.js";

export const CONVERSATION_LEASE_MS = 45_000;
export const CONVERSATION_HEARTBEAT_MS = 10_000;
export type ConversationControlFailure =
  | "not_found"
  | "already_completed"
  | "in_use"
  | "writer_stale"
  | "request_conflict"
  | "character_unavailable"
  | "ending";
export type ConversationLifecycleAggregate = {
  aggregate: ConversationAggregate;
  control: ConversationControlRecord | null;
  operation: ConversationOperationRecord | null;
  characterAvailable: boolean;
  summary: { status: string | null; content: string | null };
  memory: {
    status: string | null;
    activeCount: number;
    suggestedCount: number;
  };
};

export function hasLiveWriter(
  control: ConversationControlRecord,
  now: Date,
): boolean {
  return (
    control.writerClientId !== null &&
    (control.leaseExpiresAt?.getTime() ?? 0) > now.getTime()
  );
}
export function hasLiveConnection(
  control: ConversationControlRecord,
  now: Date,
): boolean {
  return (
    control.connectionId !== null &&
    (control.connectionExpiresAt?.getTime() ?? 0) > now.getTime() &&
    hasLiveWriter(control, now)
  );
}
export function acceptsConversationWriter(
  control: ConversationControlRecord | null,
  writer: ConversationWriter | undefined,
  now: Date,
): boolean {
  return Boolean(
    control &&
    writer &&
    hasLiveWriter(control, now) &&
    control.writerClientId === writer.clientId &&
    control.writerEpoch === writer.epoch,
  );
}
export function connectedDuration(
  control: ConversationControlRecord,
  now: Date,
): number {
  if (!control.connectionStartedAt) return control.connectedDurationMs;
  const through = Math.min(
    now.getTime(),
    control.lastHeartbeatAt?.getTime() ?? control.connectionStartedAt.getTime(),
  );
  return (
    control.connectedDurationMs +
    Math.max(0, through - control.connectionStartedAt.getTime())
  );
}
export function clearConnection(control: ConversationControlRecord, now: Date) {
  return {
    connectionId: null,
    connectionExpiresAt: null,
    connectionStartedAt: null,
    connectedDurationMs: connectedDuration(control, now),
  };
}

export async function ensureConversationControl(
  tx: DatabaseTransaction,
  conversationId: string,
): Promise<ConversationControlRecord> {
  await tx
    .insert(conversationControls)
    .values({ conversationId })
    .onConflictDoNothing();
  const [control] = await tx
    .select()
    .from(conversationControls)
    .where(eq(conversationControls.conversationId, conversationId))
    .limit(1);
  if (!control) throw new Error("Conversation control was not readable.");
  return control;
}
export async function readConversationControl(
  tx: DatabaseTransaction,
  conversationId: string,
) {
  const [control] = await tx
    .select()
    .from(conversationControls)
    .where(eq(conversationControls.conversationId, conversationId))
    .limit(1);
  return control ?? null;
}
async function operationById(
  db: Database | DatabaseTransaction,
  conversationId: string,
  requestId: string,
) {
  const [operation] = await db
    .select()
    .from(conversationOperations)
    .where(
      and(
        eq(conversationOperations.conversationId, conversationId),
        eq(conversationOperations.requestId, requestId),
      ),
    )
    .limit(1);
  return operation ?? null;
}
export { operationById as findConversationOperation };

export async function isConversationCharacterAvailable(
  db: Database | DatabaseTransaction,
  conversation: ConversationRecord,
): Promise<boolean> {
  const [character] = await db
    .select({ id: characters.id })
    .from(characters)
    .where(
      and(
        eq(characters.id, conversation.characterId),
        isNull(characters.deletedAt),
        or(
          eq(characters.visibility, "builtin"),
          eq(characters.visibility, "family"),
          and(
            eq(characters.visibility, "private"),
            eq(characters.ownerUserId, conversation.userId),
          ),
        ),
      ),
    )
    .limit(1);
  return Boolean(character);
}

export async function prepareConversation(
  db: Database,
  input: PrepareConversationRequest & {
    actorUserId: string;
    conversationId: string;
    now: Date;
  },
): Promise<
  | {
      kind: "prepared";
      writer: ConversationWriter;
      hasConnected: boolean;
      runtimeSnapshot:
        (typeof conversationRuntimeSnapshots.$inferSelect)["snapshot"] | null;
    }
  | { kind: ConversationControlFailure }
> {
  return db.transaction(async (tx) => {
    const conversation = await lockOwnedConversation(
      tx,
      input.actorUserId,
      input.conversationId,
    );
    if (!conversation) return { kind: "not_found" };
    if (conversation.status === "completed")
      return { kind: "already_completed" };
    if (
      input.intent === "connect" &&
      !(await isConversationCharacterAvailable(tx, conversation))
    )
      return { kind: "character_unavailable" };
    const control = await ensureConversationControl(tx, input.conversationId);
    const previous = await operationById(
      tx,
      input.conversationId,
      input.requestId,
    );
    if (
      previous &&
      (previous.kind !== "prepare" ||
        previous.clientId !== input.clientId ||
        previous.intent !== input.intent)
    )
      return { kind: "request_conflict" };
    if (previous && previous.writerEpoch !== control.writerEpoch)
      return { kind: "writer_stale" };
    if (
      hasLiveWriter(control, input.now) &&
      control.writerClientId !== input.clientId
    )
      return { kind: "in_use" };
    if (hasLiveConnection(control, input.now) && !previous)
      return { kind: "in_use" };
    if (input.intent === "connect" && control.endRequestId)
      return { kind: "ending" };
    const epoch = previous
      ? previous.writerEpoch
      : hasLiveWriter(control, input.now)
        ? control.writerEpoch
        : control.writerEpoch + 1;
    const connectionPatch = hasLiveConnection(control, input.now)
      ? {}
      : clearConnection(control, input.now);
    await tx
      .update(conversationControls)
      .set({
        ...connectionPatch,
        writerClientId: input.clientId,
        writerEpoch: epoch,
        leaseExpiresAt: new Date(input.now.getTime() + CONVERSATION_LEASE_MS),
      })
      .where(eq(conversationControls.conversationId, input.conversationId));
    if (!previous)
      await tx.insert(conversationOperations).values({
        conversationId: input.conversationId,
        requestId: input.requestId,
        kind: "prepare",
        clientId: input.clientId,
        writerEpoch: epoch,
        intent: input.intent,
        createdAt: input.now,
      });
    const [runtime] = await tx
      .select()
      .from(conversationRuntimeSnapshots)
      .where(
        eq(conversationRuntimeSnapshots.conversationId, input.conversationId),
      )
      .limit(1);
    return {
      kind: "prepared",
      writer: { clientId: input.clientId, epoch },
      hasConnected: control.hasConnected,
      runtimeSnapshot: runtime?.snapshot ?? null,
    };
  });
}

export async function heartbeatConversationWriter(
  db: Database,
  input: {
    actorUserId: string;
    conversationId: string;
    writer: ConversationWriter;
    now: Date;
  },
): Promise<{ kind: "renewed" } | { kind: ConversationControlFailure }> {
  return db.transaction(async (tx) => {
    const conversation = await lockOwnedConversation(
      tx,
      input.actorUserId,
      input.conversationId,
    );
    if (!conversation) return { kind: "not_found" };
    if (conversation.status === "completed")
      return { kind: "already_completed" };
    const control = await ensureConversationControl(tx, input.conversationId);
    if (!acceptsConversationWriter(control, input.writer, input.now))
      return { kind: "writer_stale" };
    await tx
      .update(conversationControls)
      .set({
        leaseExpiresAt: new Date(input.now.getTime() + CONVERSATION_LEASE_MS),
      })
      .where(eq(conversationControls.conversationId, input.conversationId));
    return { kind: "renewed" };
  });
}

export async function attachConversationConnection(
  db: Database,
  input: {
    actorUserId: string;
    conversationId: string;
    writer: ConversationWriter;
    connectionId: string;
    now: Date;
  },
): Promise<
  { kind: "attached"; initial: boolean } | { kind: ConversationControlFailure }
> {
  return db.transaction(async (tx) => {
    const conversation = await lockOwnedConversation(
      tx,
      input.actorUserId,
      input.conversationId,
    );
    if (!conversation) return { kind: "not_found" };
    if (conversation.status === "completed")
      return { kind: "already_completed" };
    if (!(await isConversationCharacterAvailable(tx, conversation)))
      return { kind: "character_unavailable" };
    const control = await ensureConversationControl(tx, input.conversationId);
    if (!acceptsConversationWriter(control, input.writer, input.now))
      return { kind: "writer_stale" };
    if (hasLiveConnection(control, input.now)) return { kind: "in_use" };
    if (control.endRequestId) return { kind: "ending" };
    const expires = new Date(input.now.getTime() + CONVERSATION_LEASE_MS);
    await tx
      .update(conversationControls)
      .set({
        ...clearConnection(control, input.now),
        connectionId: input.connectionId,
        connectionExpiresAt: expires,
        lastHeartbeatAt: input.now,
        leaseExpiresAt: expires,
      })
      .where(eq(conversationControls.conversationId, input.conversationId));
    return { kind: "attached", initial: !control.hasConnected };
  });
}

export async function heartbeatConversationConnection(
  db: Database,
  input: {
    actorUserId: string;
    conversationId: string;
    writer: ConversationWriter;
    connectionId: string;
    now: Date;
    active?: boolean;
    activity?: boolean;
  },
): Promise<{ kind: "renewed" } | { kind: ConversationControlFailure }> {
  return db.transaction(async (tx) => {
    const conversation = await lockOwnedConversation(
      tx,
      input.actorUserId,
      input.conversationId,
    );
    if (!conversation) return { kind: "not_found" };
    if (conversation.status === "completed")
      return { kind: "already_completed" };
    const control = await ensureConversationControl(tx, input.conversationId);
    if (
      !acceptsConversationWriter(control, input.writer, input.now) ||
      !hasLiveConnection(control, input.now) ||
      control.connectionId !== input.connectionId
    )
      return { kind: "writer_stale" };
    const expires = new Date(input.now.getTime() + CONVERSATION_LEASE_MS);
    await tx
      .update(conversationControls)
      .set({
        leaseExpiresAt: expires,
        connectionExpiresAt: expires,
        lastHeartbeatAt: input.now,
        ...(input.active
          ? {
              hasConnected: true,
              connectionStartedAt: control.connectionStartedAt ?? input.now,
            }
          : {}),
        ...(input.activity ? { lastActivityAt: input.now } : {}),
      })
      .where(eq(conversationControls.conversationId, input.conversationId));
    return { kind: "renewed" };
  });
}

export async function detachConversationConnection(
  db: Database,
  input: {
    actorUserId: string;
    conversationId: string;
    writer: ConversationWriter;
    connectionId: string;
    now: Date;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const conversation = await lockOwnedConversation(
      tx,
      input.actorUserId,
      input.conversationId,
    );
    if (!conversation) return;
    const control = await readConversationControl(tx, input.conversationId);
    if (
      !control ||
      control.writerClientId !== input.writer.clientId ||
      control.writerEpoch !== input.writer.epoch ||
      control.connectionId !== input.connectionId
    )
      return;
    await tx
      .update(conversationControls)
      .set(clearConnection(control, input.now))
      .where(eq(conversationControls.conversationId, input.conversationId));
  });
}

export async function readConversationLifecycle(
  db: Database,
  conversationId: string,
  requestId?: string,
): Promise<ConversationLifecycleAggregate | null> {
  const aggregate = await findConversationAggregate(db, conversationId);
  if (!aggregate) return null;
  const [control] = await db
    .select()
    .from(conversationControls)
    .where(eq(conversationControls.conversationId, conversationId))
    .limit(1);
  const work = await db
    .select({ purpose: aiWorkItems.purpose, status: aiWorkItems.status })
    .from(aiWorkItems)
    .where(eq(aiWorkItems.conversationId, conversationId));
  const [summary] = await db
    .select({ content: conversationSummaries.content })
    .from(conversationSummaries)
    .where(eq(conversationSummaries.conversationId, conversationId))
    .limit(1);
  const counts = await db
    .select({
      status: characterMemories.status,
      count: sql<number>`count(*)::int`,
    })
    .from(characterMemories)
    .where(
      and(
        eq(characterMemories.userId, aggregate.conversation.userId),
        eq(characterMemories.sourceConversationId, conversationId),
      ),
    )
    .groupBy(characterMemories.status);
  return {
    aggregate,
    control: control ?? null,
    operation: requestId
      ? await operationById(db, conversationId, requestId)
      : null,
    characterAvailable: await isConversationCharacterAvailable(
      db,
      aggregate.conversation,
    ),
    summary: {
      status:
        work.find((item) => item.purpose === "conversation_summary")?.status ??
        null,
      content: summary?.content ?? null,
    },
    memory: {
      status:
        work.find((item) => item.purpose === "memory_extraction")?.status ??
        null,
      activeCount: counts.find((item) => item.status === "active")?.count ?? 0,
      suggestedCount:
        counts.find((item) => item.status === "suggested")?.count ?? 0,
    },
  };
}

export async function listConversationOverviewIds(
  db: Database,
  userId: string,
  characterId?: string,
): Promise<{ pending: string[]; recent: string[] }> {
  await cleanupExpiredEmptyConversations(db, userId, new Date());
  const filter = and(
    eq(conversations.userId, userId),
    characterId ? eq(conversations.characterId, characterId) : undefined,
  );
  const pending = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(filter, eq(conversations.status, "active")))
    .orderBy(desc(conversations.updatedAt));
  const recentRows = await db
    .select({ id: conversations.id, characterId: conversations.characterId })
    .from(conversations)
    .leftJoin(
      conversationControls,
      eq(conversationControls.conversationId, conversations.id),
    )
    .innerJoin(characters, eq(characters.id, conversations.characterId))
    .where(
      and(
        filter,
        eq(conversations.status, "completed"),
        eq(conversations.mode, "normal"),
        gt(conversations.messageCount, 0),
        isNull(characters.deletedAt),
        or(
          eq(characters.visibility, "builtin"),
          eq(characters.visibility, "family"),
          eq(characters.ownerUserId, userId),
        ),
      ),
    )
    .orderBy(
      desc(
        sql`coalesce(${conversationControls.lastActivityAt},${conversations.endedAt},${conversations.startedAt})`,
      ),
    );
  const seen = new Set<string>();
  const recent = recentRows
    .filter((row) => {
      if (characterId) return true;
      if (seen.has(row.characterId)) return false;
      seen.add(row.characterId);
      return true;
    })
    .slice(0, 4)
    .map((row) => row.id);
  return { pending: pending.map((row) => row.id), recent };
}

export async function cleanupExpiredEmptyConversations(
  db: Database,
  userId: string,
  now: Date,
): Promise<void> {
  const candidates = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.userId, userId),
        eq(conversations.status, "active"),
        eq(conversations.lastSequence, 0),
      ),
    );
  for (const candidate of candidates)
    await db.transaction(async (tx) => {
      const conversation = await lockOwnedConversation(
        tx,
        userId,
        candidate.id,
      );
      if (
        !conversation ||
        conversation.status !== "active" ||
        conversation.lastSequence !== 0 ||
        conversation.startedAt.getTime() + CONVERSATION_LEASE_MS > now.getTime()
      )
        return;
      const control = await ensureConversationControl(tx, candidate.id);
      if (control.hasConnected || hasLiveWriter(control, now)) return;
      await tx
        .update(conversations)
        .set({
          status: "completed",
          endedAt: conversation.startedAt,
          updatedAt: now,
        })
        .where(eq(conversations.id, candidate.id));
      await tx
        .update(conversationControls)
        .set({ ...clearConnection(control, now), finalizedAt: now })
        .where(eq(conversationControls.conversationId, candidate.id));
    });
}
