import type {
  AppendConversationMessagesRequest,
  ConversationMode,
} from "@meet/protocol";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";

import type { Database } from "./client.js";
import {
  characters,
  conversationMessages,
  conversations,
  providerProfiles,
  userAccounts,
  voiceProfiles,
  type ConversationMessageRecord,
  type ConversationRecord,
} from "./schema.js";

export type ConversationAggregate = {
  conversation: ConversationRecord;
  character: Pick<
    typeof characters.$inferSelect,
    "id" | "name" | "visualProfile"
  >;
};

export type ConversationDetailAggregate = ConversationAggregate & {
  messages: ConversationMessageRecord[];
};

export type ConversationContinuityMessage = Pick<
  ConversationMessageRecord,
  "id" | "conversationId" | "role" | "text" | "status" | "createdAt"
>;

export type ConversationRealtimeContext = {
  mode: ConversationMode;
  messages: ConversationContinuityMessage[];
};

export const CONVERSATION_CONTINUITY_MESSAGE_LIMIT = 24;

export type CreateConversationResult =
  | { kind: "created" | "existing"; conversation: ConversationAggregate }
  | { kind: "character_not_found" }
  | { kind: "id_conflict" };

export type AppendConversationMessagesResult =
  | { kind: "appended" | "unchanged"; acknowledgedSequence: number }
  | { kind: "not_found" }
  | { kind: "completed" }
  | { kind: "sequence_conflict" };

export type CompleteConversationResult =
  | { kind: "completed" | "unchanged"; conversation: ConversationAggregate }
  | { kind: "not_found" }
  | { kind: "sequence_conflict" };

const aggregateSelection = {
  conversation: conversations,
  character: {
    id: characters.id,
    name: characters.name,
    visualProfile: characters.visualProfile,
  },
};

export async function createConversation(
  db: Database,
  input: {
    id: string;
    actorUserId: string;
    characterId: string;
    mode: ConversationMode;
    startedAt?: Date;
  },
): Promise<CreateConversationResult> {
  const startedAt = input.startedAt ?? new Date();
  return db.transaction(async (tx) => {
    const [runtime] = await tx
      .select({
        provider: providerProfiles.provider,
        model: providerProfiles.model,
        voice: voiceProfiles.providerVoiceId,
      })
      .from(characters)
      .innerJoin(
        providerProfiles,
        eq(characters.providerProfileId, providerProfiles.id),
      )
      .innerJoin(
        voiceProfiles,
        and(
          eq(characters.voiceProfileId, voiceProfiles.id),
          eq(voiceProfiles.providerProfileId, providerProfiles.id),
        ),
      )
      .where(
        and(
          eq(characters.id, input.characterId),
          isNull(characters.deletedAt),
          or(
            eq(characters.visibility, "builtin"),
            eq(characters.visibility, "family"),
            and(
              eq(characters.visibility, "private"),
              eq(characters.ownerUserId, input.actorUserId),
            ),
          ),
        ),
      )
      .limit(1);
    if (!runtime) return { kind: "character_not_found" };

    const [created] = await tx
      .insert(conversations)
      .values({
        id: input.id,
        userId: input.actorUserId,
        characterId: input.characterId,
        mode: input.mode,
        provider: runtime.provider,
        model: runtime.model,
        voice: runtime.voice,
        startedAt,
        updatedAt: startedAt,
      })
      .onConflictDoNothing({ target: conversations.id })
      .returning({ id: conversations.id });

    const aggregate = await findConversationAggregate(tx, input.id);
    if (!aggregate) throw new Error("Conversation insert was not readable.");
    if (
      aggregate.conversation.userId !== input.actorUserId ||
      aggregate.conversation.characterId !== input.characterId ||
      aggregate.conversation.mode !== input.mode
    ) {
      return { kind: "id_conflict" };
    }
    return {
      kind: created ? "created" : "existing",
      conversation: aggregate,
    };
  });
}

export async function listConversations(
  db: Database,
  targetUserId: string,
  limit: number,
): Promise<ConversationAggregate[]> {
  return db
    .select(aggregateSelection)
    .from(conversations)
    .innerJoin(characters, eq(conversations.characterId, characters.id))
    .where(eq(conversations.userId, targetUserId))
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .limit(limit);
}

export async function isGuardianReadableHistoryTarget(
  db: Database,
  targetUserId: string,
): Promise<boolean> {
  const [target] = await db
    .select({ id: userAccounts.id })
    .from(userAccounts)
    .where(
      and(
        eq(userAccounts.id, targetUserId),
        eq(userAccounts.accountType, "child"),
        eq(userAccounts.guardianHistoryAccess, "allowed"),
        eq(userAccounts.status, "active"),
      ),
    )
    .limit(1);
  return Boolean(target);
}

export async function findReadableConversation(
  db: Database,
  input: {
    actorUserId: string;
    actorCanReadChildren: boolean;
    conversationId: string;
  },
): Promise<ConversationDetailAggregate | null> {
  const [aggregate] = await db
    .select(aggregateSelection)
    .from(conversations)
    .innerJoin(characters, eq(conversations.characterId, characters.id))
    .innerJoin(userAccounts, eq(conversations.userId, userAccounts.id))
    .where(
      and(
        eq(conversations.id, input.conversationId),
        or(
          eq(conversations.userId, input.actorUserId),
          input.actorCanReadChildren
            ? and(
                eq(userAccounts.accountType, "child"),
                eq(userAccounts.guardianHistoryAccess, "allowed"),
              )
            : eq(conversations.userId, input.actorUserId),
        ),
      ),
    )
    .limit(1);
  if (!aggregate) return null;
  const messages = await db
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, input.conversationId))
    .orderBy(asc(conversationMessages.sequence));
  return { ...aggregate, messages };
}

export async function loadConversationRealtimeContext(
  db: Database,
  input: {
    actorUserId: string;
    conversationId: string;
    characterId: string;
  },
): Promise<ConversationRealtimeContext | null> {
  const [current] = await db
    .select({ mode: conversations.mode })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, input.conversationId),
        eq(conversations.userId, input.actorUserId),
        eq(conversations.characterId, input.characterId),
        eq(conversations.status, "active"),
      ),
    )
    .limit(1);
  if (!current) return null;
  const recentFirst = await db
    .select({
      id: conversationMessages.id,
      conversationId: conversationMessages.conversationId,
      role: conversationMessages.role,
      text: conversationMessages.text,
      status: conversationMessages.status,
      createdAt: conversationMessages.createdAt,
    })
    .from(conversationMessages)
    .innerJoin(
      conversations,
      eq(conversationMessages.conversationId, conversations.id),
    )
    .where(
      and(
        eq(conversations.userId, input.actorUserId),
        current.mode === "temporary"
          ? eq(conversations.id, input.conversationId)
          : and(
              eq(conversations.characterId, input.characterId),
              eq(conversations.mode, "normal"),
            ),
        eq(conversationMessages.userId, input.actorUserId),
      ),
    )
    .orderBy(desc(conversations.startedAt), desc(conversationMessages.sequence))
    .limit(CONVERSATION_CONTINUITY_MESSAGE_LIMIT);

  return { mode: current.mode, messages: recentFirst.reverse() };
}

export async function appendConversationMessages(
  db: Database,
  input: {
    actorUserId: string;
    conversationId: string;
    messages: AppendConversationMessagesRequest["messages"];
    updatedAt?: Date;
  },
): Promise<AppendConversationMessagesResult> {
  const updatedAt = input.updatedAt ?? new Date();
  return db.transaction(async (tx) => {
    const conversation = await lockOwnedConversation(
      tx,
      input.actorUserId,
      input.conversationId,
    );
    if (!conversation) return { kind: "not_found" };
    if (conversation.status === "completed") return { kind: "completed" };

    const existing = await tx
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.conversationId, input.conversationId),
          inArray(
            conversationMessages.sequence,
            input.messages.map(({ sequence }) => sequence),
          ),
        ),
      );
    const plan = planConversationMessageAppend(
      conversation.lastSequence,
      existing,
      input.messages,
    );
    if (plan.kind === "sequence_conflict") return plan;
    const { additions, acknowledgedSequence } = plan;

    if (additions.length === 0) {
      return {
        kind: "unchanged",
        acknowledgedSequence: conversation.lastSequence,
      };
    }
    const inserted = await tx
      .insert(conversationMessages)
      .values(
        additions.map((message) => ({
          ...message,
          conversationId: input.conversationId,
          userId: input.actorUserId,
          createdAt: new Date(message.createdAt),
        })),
      )
      .onConflictDoNothing()
      .returning({ id: conversationMessages.id });
    if (inserted.length !== additions.length) {
      return { kind: "sequence_conflict" };
    }

    await tx
      .update(conversations)
      .set({
        lastSequence: acknowledgedSequence,
        messageCount: conversation.messageCount + additions.length,
        updatedAt,
      })
      .where(eq(conversations.id, input.conversationId));
    return { kind: "appended", acknowledgedSequence };
  });
}

export function planConversationMessageAppend(
  lastSequence: number,
  existing: ConversationMessageRecord[],
  incoming: AppendConversationMessagesRequest["messages"],
):
  | {
      kind: "accepted";
      additions: AppendConversationMessagesRequest["messages"];
      acknowledgedSequence: number;
    }
  | { kind: "sequence_conflict" } {
  const ordered = [...incoming].sort(
    (left, right) => left.sequence - right.sequence,
  );
  if (
    new Set(ordered.map(({ sequence }) => sequence)).size !== ordered.length ||
    new Set(ordered.map(({ id }) => id)).size !== ordered.length
  ) {
    return { kind: "sequence_conflict" };
  }

  const existingBySequence = new Map(
    existing.map((message) => [message.sequence, message]),
  );
  const additions: typeof ordered = [];
  let nextSequence = lastSequence + 1;
  for (const message of ordered) {
    const stored = existingBySequence.get(message.sequence);
    if (stored) {
      if (!sameMessage(stored, message)) return { kind: "sequence_conflict" };
      continue;
    }
    if (message.sequence !== nextSequence) {
      return { kind: "sequence_conflict" };
    }
    additions.push(message);
    nextSequence += 1;
  }
  return {
    kind: "accepted",
    additions,
    acknowledgedSequence: nextSequence - 1,
  };
}

export async function completeConversation(
  db: Database,
  input: {
    actorUserId: string;
    conversationId: string;
    lastSequence: number;
    endedAt?: Date;
  },
): Promise<CompleteConversationResult> {
  const endedAt = input.endedAt ?? new Date();
  return db.transaction(async (tx) => {
    const conversation = await lockOwnedConversation(
      tx,
      input.actorUserId,
      input.conversationId,
    );
    if (!conversation) return { kind: "not_found" };
    if (conversation.lastSequence !== input.lastSequence) {
      return { kind: "sequence_conflict" };
    }
    if (conversation.status === "completed") {
      const aggregate = await findConversationAggregate(
        tx,
        input.conversationId,
      );
      if (!aggregate) return { kind: "not_found" };
      return { kind: "unchanged", conversation: aggregate };
    }
    await tx
      .update(conversations)
      .set({ status: "completed", endedAt, updatedAt: endedAt })
      .where(eq(conversations.id, input.conversationId));
    const aggregate = await findConversationAggregate(tx, input.conversationId);
    if (!aggregate) throw new Error("Completed conversation was not readable.");
    return { kind: "completed", conversation: aggregate };
  });
}

export async function deleteOwnedConversation(
  db: Database,
  actorUserId: string,
  conversationId: string,
): Promise<boolean> {
  const [deleted] = await db
    .delete(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, actorUserId),
      ),
    )
    .returning({ id: conversations.id });
  return Boolean(deleted);
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function findConversationAggregate(
  db: Database | Transaction,
  conversationId: string,
): Promise<ConversationAggregate | null> {
  const [aggregate] = await db
    .select(aggregateSelection)
    .from(conversations)
    .innerJoin(characters, eq(conversations.characterId, characters.id))
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return aggregate ?? null;
}

async function lockOwnedConversation(
  tx: Transaction,
  actorUserId: string,
  conversationId: string,
): Promise<ConversationRecord | null> {
  const [conversation] = await tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, actorUserId),
      ),
    )
    .for("update")
    .limit(1);
  return conversation ?? null;
}

function sameMessage(
  stored: ConversationMessageRecord,
  input: AppendConversationMessagesRequest["messages"][number],
): boolean {
  return (
    stored.id === input.id &&
    stored.role === input.role &&
    stored.status === input.status &&
    stored.text === input.text &&
    stored.providerEventId === input.providerEventId &&
    stored.createdAt.toISOString() === input.createdAt
  );
}
