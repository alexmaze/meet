import { createHash } from "node:crypto";

import type { MemoryStatus, ReviewMemoryRequest } from "@meet/protocol";
import { and, desc, eq, inArray, ne } from "drizzle-orm";

import type { Database } from "./client.js";
import {
  characterMemories,
  characters,
  conversationMessages,
  conversationSummaries,
  conversations,
  userAccounts,
  type CharacterMemoryRecord,
  type ConversationMessageRecord,
  type ConversationRecord,
} from "./schema.js";

export type CharacterMemoryAggregate = {
  memory: CharacterMemoryRecord;
  character: Pick<
    typeof characters.$inferSelect,
    "id" | "name" | "visualProfile"
  >;
};

export type CompletedConversationForAnalysis = {
  conversation: ConversationRecord;
  characterName: string;
  messages: ConversationMessageRecord[];
};

export type ExtractedMemoryInput = {
  content: string;
  sourceExcerpt: string;
  confidence: number;
  status: "active" | "suggested";
};

export type ReviewCharacterMemoryResult =
  | { kind: "updated"; memory: CharacterMemoryAggregate }
  | { kind: "not_found" }
  | { kind: "invalid_state" }
  | { kind: "content_conflict" };

const memoryAggregateSelection = {
  memory: characterMemories,
  character: {
    id: characters.id,
    name: characters.name,
    visualProfile: characters.visualProfile,
  },
};

export async function isGuardianReadableMemoryTarget(
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

export async function listCharacterMemories(
  db: Database,
  input: {
    targetUserId: string;
    status?: "active" | "suggested";
    limit: number;
  },
): Promise<CharacterMemoryAggregate[]> {
  return db
    .select(memoryAggregateSelection)
    .from(characterMemories)
    .innerJoin(characters, eq(characterMemories.characterId, characters.id))
    .where(
      and(
        eq(characterMemories.userId, input.targetUserId),
        input.status
          ? eq(characterMemories.status, input.status)
          : inArray(characterMemories.status, ["active", "suggested"]),
      ),
    )
    .orderBy(desc(characterMemories.updatedAt), desc(characterMemories.id))
    .limit(input.limit);
}

export async function reviewCharacterMemory(
  db: Database,
  input: {
    actorUserId: string;
    memoryId: string;
    review: ReviewMemoryRequest;
    reviewedAt?: Date;
  },
): Promise<ReviewCharacterMemoryResult> {
  const reviewedAt = input.reviewedAt ?? new Date();
  return db.transaction(async (tx) => {
    const [stored] = await tx
      .select()
      .from(characterMemories)
      .where(
        and(
          eq(characterMemories.id, input.memoryId),
          eq(characterMemories.userId, input.actorUserId),
        ),
      )
      .for("update")
      .limit(1);
    if (!stored) return { kind: "not_found" };

    const visible = stored.status === "active" || stored.status === "suggested";
    if (!visible) return { kind: "invalid_state" };

    let status: MemoryStatus = stored.status;
    let content = stored.content;
    let contentFingerprint = stored.contentFingerprint;
    if (input.review.action === "accept") {
      if (stored.status !== "suggested") return { kind: "invalid_state" };
      status = "active";
    } else if (input.review.action === "reject") {
      if (stored.status !== "suggested") return { kind: "invalid_state" };
      status = "rejected";
    } else if (input.review.action === "delete") {
      status = "deleted";
    } else {
      content = normalizeMemoryContent(input.review.content);
      contentFingerprint = fingerprintMemoryContent(content);
      const [conflict] = await tx
        .select({ id: characterMemories.id })
        .from(characterMemories)
        .where(
          and(
            eq(characterMemories.userId, stored.userId),
            eq(characterMemories.characterId, stored.characterId),
            eq(characterMemories.contentFingerprint, contentFingerprint),
            ne(characterMemories.id, stored.id),
          ),
        )
        .limit(1);
      if (conflict) return { kind: "content_conflict" };
    }

    await tx
      .update(characterMemories)
      .set({
        status,
        content,
        contentFingerprint,
        reviewedAt,
        updatedAt: reviewedAt,
      })
      .where(eq(characterMemories.id, stored.id));
    const aggregate = await findMemoryAggregate(tx, stored.id);
    if (!aggregate) throw new Error("Updated memory was not readable.");
    return { kind: "updated", memory: aggregate };
  });
}

export async function loadCompletedConversationForAnalysis(
  db: Database,
  input: {
    conversationId: string;
    userId: string;
    completedSequence: number;
  },
): Promise<CompletedConversationForAnalysis | null> {
  const [record] = await db
    .select({ conversation: conversations, characterName: characters.name })
    .from(conversations)
    .innerJoin(characters, eq(conversations.characterId, characters.id))
    .where(
      and(
        eq(conversations.id, input.conversationId),
        eq(conversations.userId, input.userId),
        eq(conversations.status, "completed"),
        eq(conversations.lastSequence, input.completedSequence),
      ),
    )
    .limit(1);
  if (!record) return null;
  const messages = await db
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, input.conversationId))
    .orderBy(conversationMessages.sequence);
  return { ...record, messages };
}

export async function upsertConversationSummary(
  db: Database,
  input: {
    conversationId: string;
    userId: string;
    characterId: string;
    content: string;
    sourceMessageCount: number;
    sourceLastSequence: number;
    analyzerModel: string;
    analyzerProfileId?: string;
    updatedAt?: Date;
  },
): Promise<void> {
  const updatedAt = input.updatedAt ?? new Date();
  await db
    .insert(conversationSummaries)
    .values({ ...input, content: input.content.trim(), updatedAt })
    .onConflictDoUpdate({
      target: conversationSummaries.conversationId,
      set: {
        content: input.content.trim(),
        sourceMessageCount: input.sourceMessageCount,
        sourceLastSequence: input.sourceLastSequence,
        analyzerModel: input.analyzerModel,
        analyzerProfileId: input.analyzerProfileId,
        updatedAt,
      },
    });
}

export async function upsertExtractedMemories(
  db: Database,
  input: {
    conversationId: string;
    userId: string;
    characterId: string;
    analyzerModel?: string;
    analyzerProfileId?: string;
    memories: ExtractedMemoryInput[];
    updatedAt?: Date;
  },
): Promise<void> {
  if (input.memories.length === 0) return;
  const updatedAt = input.updatedAt ?? new Date();
  await db.transaction(async (tx) => {
    for (const candidate of input.memories) {
      const content = normalizeMemoryContent(candidate.content);
      const contentFingerprint = fingerprintMemoryContent(content);
      const [stored] = await tx
        .select()
        .from(characterMemories)
        .where(
          and(
            eq(characterMemories.userId, input.userId),
            eq(characterMemories.characterId, input.characterId),
            eq(characterMemories.contentFingerprint, contentFingerprint),
          ),
        )
        .limit(1);
      if (stored?.status === "rejected" || stored?.status === "deleted") {
        continue;
      }
      if (stored) {
        await tx
          .update(characterMemories)
          .set({
            sourceConversationId: input.conversationId,
            sourceExcerpt: candidate.sourceExcerpt.trim(),
            confidence: Math.max(stored.confidence, candidate.confidence),
            analyzerModel: input.analyzerModel,
            analyzerProfileId: input.analyzerProfileId,
            status:
              stored.status === "active" || candidate.status === "active"
                ? "active"
                : "suggested",
            updatedAt,
          })
          .where(eq(characterMemories.id, stored.id));
        continue;
      }
      await tx
        .insert(characterMemories)
        .values({
          userId: input.userId,
          characterId: input.characterId,
          sourceConversationId: input.conversationId,
          contentFingerprint,
          content,
          sourceExcerpt: candidate.sourceExcerpt.trim(),
          confidence: candidate.confidence,
          analyzerModel: input.analyzerModel,
          analyzerProfileId: input.analyzerProfileId,
          status: candidate.status,
          updatedAt,
        })
        .onConflictDoNothing();
    }
  });
}

export function normalizeMemoryContent(content: string): string {
  return content.trim().replace(/\s+/g, " ");
}

export function fingerprintMemoryContent(content: string): string {
  return createHash("sha256")
    .update(normalizeMemoryContent(content).toLocaleLowerCase("zh-CN"))
    .digest("hex");
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function findMemoryAggregate(
  db: Database | Transaction,
  memoryId: string,
): Promise<CharacterMemoryAggregate | null> {
  const [aggregate] = await db
    .select(memoryAggregateSelection)
    .from(characterMemories)
    .innerJoin(characters, eq(characterMemories.characterId, characters.id))
    .where(eq(characterMemories.id, memoryId))
    .limit(1);
  return aggregate ?? null;
}
