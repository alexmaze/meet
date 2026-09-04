import { randomUUID } from "node:crypto";

import type {
  CharacterRelationshipTransferPayload,
  RelationshipTransferImportResult,
} from "@meet/protocol";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";

import type { Database } from "./client.js";
import type { MemoryIndexHook } from "./memory-index-operations.js";
import {
  fingerprintMemoryContent,
  normalizeMemoryContent,
} from "./memory-operations.js";
import {
  characterMemories,
  characters,
  conversationMessages,
  conversationSummaryCheckpoints,
  conversationSummaries,
  conversations,
  relationshipTransferConversationOrigins,
  relationshipTransferImports,
} from "./schema.js";

export type CharacterRelationshipExportData = Omit<
  CharacterRelationshipTransferPayload,
  "transferId" | "exportedAt"
>;

export type ImportCharacterRelationshipTransferResult =
  | { kind: "imported" | "unchanged"; result: RelationshipTransferImportResult }
  | { kind: "character_not_found" }
  | { kind: "character_mismatch"; targetCharacterName: string }
  | { kind: "transfer_conflict" };

const EXPORT_CONVERSATION_LIMIT = 1_001;
const EXPORT_MEMORY_LIMIT = 5_001;

export async function loadCharacterRelationshipExport(
  db: Database,
  input: { actorUserId: string; characterId: string },
): Promise<CharacterRelationshipExportData | null> {
  const [character] = await db
    .select({
      id: characters.id,
      name: characters.name,
      systemKey: characters.systemKey,
    })
    .from(characters)
    .where(
      and(
        eq(characters.id, input.characterId),
        isNull(characters.deletedAt),
        visibleCharacterCondition(input.actorUserId),
      ),
    )
    .limit(1);
  if (!character) return null;

  const conversationRows = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.userId, input.actorUserId),
        eq(conversations.characterId, input.characterId),
      ),
    )
    .orderBy(asc(conversations.startedAt), asc(conversations.id))
    .limit(EXPORT_CONVERSATION_LIMIT);
  const conversationIds = conversationRows.map(({ id }) => id);
  const messageRows =
    conversationIds.length === 0
      ? []
      : await db
          .select()
          .from(conversationMessages)
          .where(inArray(conversationMessages.conversationId, conversationIds))
          .orderBy(
            asc(conversationMessages.conversationId),
            asc(conversationMessages.sequence),
          );
  const summaryRows =
    conversationIds.length === 0
      ? []
      : await db
          .select()
          .from(conversationSummaries)
          .where(
            inArray(conversationSummaries.conversationId, conversationIds),
          );
  const checkpointRows =
    conversationIds.length === 0
      ? []
      : await db
          .select({
            conversationId: conversationSummaryCheckpoints.conversationId,
            content: conversationSummaryCheckpoints.content,
            sourceMessageCount:
              conversationSummaryCheckpoints.sourceMessageCount,
            sourceLastSequence:
              conversationSummaryCheckpoints.sourceLastSequence,
            analyzerModel: conversationSummaryCheckpoints.analyzerModel,
            updatedAt: conversationSummaryCheckpoints.updatedAt,
          })
          .from(conversationSummaryCheckpoints)
          .where(
            and(
              inArray(
                conversationSummaryCheckpoints.conversationId,
                conversationIds,
              ),
              eq(conversationSummaryCheckpoints.status, "completed"),
            ),
          )
          .orderBy(
            asc(conversationSummaryCheckpoints.conversationId),
            desc(conversationSummaryCheckpoints.sourceLastSequence),
          );
  const memoryRows = await db
    .select()
    .from(characterMemories)
    .where(
      and(
        eq(characterMemories.userId, input.actorUserId),
        eq(characterMemories.characterId, input.characterId),
      ),
    )
    .orderBy(asc(characterMemories.createdAt), asc(characterMemories.id))
    .limit(EXPORT_MEMORY_LIMIT);

  const messagesByConversation = new Map<string, typeof messageRows>();
  for (const message of messageRows) {
    const messages = messagesByConversation.get(message.conversationId) ?? [];
    messages.push(message);
    messagesByConversation.set(message.conversationId, messages);
  }
  const summariesByConversation = new Map(
    summaryRows.map((summary) => [summary.conversationId, summary]),
  );
  for (const checkpoint of checkpointRows) {
    if (
      summariesByConversation.has(checkpoint.conversationId) ||
      !checkpoint.content ||
      !checkpoint.analyzerModel
    ) {
      continue;
    }
    summariesByConversation.set(checkpoint.conversationId, {
      conversationId: checkpoint.conversationId,
      userId: input.actorUserId,
      characterId: input.characterId,
      content: checkpoint.content,
      sourceMessageCount: checkpoint.sourceMessageCount,
      sourceLastSequence: checkpoint.sourceLastSequence,
      analyzerModel: checkpoint.analyzerModel,
      analyzerProfileId: null,
      createdAt: checkpoint.updatedAt,
      updatedAt: checkpoint.updatedAt,
    });
  }

  return {
    character: { name: character.name, systemKey: character.systemKey },
    conversations: conversationRows.map((conversation) => {
      const summary = summariesByConversation.get(conversation.id);
      return {
        sourceId: conversation.id,
        mode: conversation.mode,
        sourceStatus: conversation.status,
        provider: conversation.provider,
        model: conversation.model,
        voice: conversation.voice,
        startedAt: conversation.startedAt.toISOString(),
        endedAt: conversation.endedAt?.toISOString() ?? null,
        updatedAt: conversation.updatedAt.toISOString(),
        messages: (messagesByConversation.get(conversation.id) ?? []).map(
          (message) => ({
            sequence: message.sequence,
            role: message.role,
            status: message.status,
            text: message.text,
            createdAt: message.createdAt.toISOString(),
          }),
        ),
        summary: summary
          ? {
              content: summary.content,
              sourceMessageCount: summary.sourceMessageCount,
              sourceLastSequence: summary.sourceLastSequence,
              analyzerModel: summary.analyzerModel,
              updatedAt: summary.updatedAt.toISOString(),
            }
          : null,
      };
    }),
    memories: memoryRows.map((memory) => ({
      sourceConversationId: memory.sourceConversationId,
      content: memory.content,
      sourceExcerpt: memory.sourceExcerpt,
      confidence: memory.confidence,
      analyzerModel: memory.analyzerModel,
      status: memory.status,
      reviewedAt: memory.reviewedAt?.toISOString() ?? null,
      createdAt: memory.createdAt.toISOString(),
      updatedAt: memory.updatedAt.toISOString(),
    })),
  };
}

export async function importCharacterRelationshipTransfer(
  db: Database,
  input: {
    actorUserId: string;
    targetCharacterId: string;
    packageChecksum: string;
    payload: CharacterRelationshipTransferPayload;
    confirmCharacterMismatch: boolean;
    importedAt?: Date;
    onMemoryIndex?: MemoryIndexHook;
  },
): Promise<ImportCharacterRelationshipTransferResult> {
  const importedAt = input.importedAt ?? new Date();
  return db.transaction(async (tx) => {
    const [targetCharacter] = await tx
      .select({ name: characters.name, systemKey: characters.systemKey })
      .from(characters)
      .where(
        and(
          eq(characters.id, input.targetCharacterId),
          isNull(characters.deletedAt),
          visibleCharacterCondition(input.actorUserId),
        ),
      )
      .limit(1);
    if (!targetCharacter) return { kind: "character_not_found" };
    if (
      !input.confirmCharacterMismatch &&
      !isSameCharacter(input.payload.character, targetCharacter)
    ) {
      return {
        kind: "character_mismatch",
        targetCharacterName: targetCharacter.name,
      };
    }

    const [existingImport] = await tx
      .select()
      .from(relationshipTransferImports)
      .where(
        and(
          eq(relationshipTransferImports.targetUserId, input.actorUserId),
          eq(relationshipTransferImports.transferId, input.payload.transferId),
        ),
      )
      .limit(1);
    if (existingImport) {
      if (
        existingImport.targetCharacterId !== input.targetCharacterId ||
        existingImport.packageChecksum !== input.packageChecksum
      ) {
        return { kind: "transfer_conflict" };
      }
      return {
        kind: "unchanged",
        result: importResult(existingImport, true),
      };
    }

    const [createdImport] = await tx
      .insert(relationshipTransferImports)
      .values({
        targetUserId: input.actorUserId,
        targetCharacterId: input.targetCharacterId,
        transferId: input.payload.transferId,
        packageChecksum: input.packageChecksum,
        sourceCharacterName: input.payload.character.name,
        sourceCharacterSystemKey: input.payload.character.systemKey,
        createdAt: importedAt,
      })
      .onConflictDoNothing({
        target: [
          relationshipTransferImports.targetUserId,
          relationshipTransferImports.transferId,
        ],
      })
      .returning();
    if (!createdImport) {
      const [racedImport] = await tx
        .select()
        .from(relationshipTransferImports)
        .where(
          and(
            eq(relationshipTransferImports.targetUserId, input.actorUserId),
            eq(
              relationshipTransferImports.transferId,
              input.payload.transferId,
            ),
          ),
        )
        .limit(1);
      if (
        !racedImport ||
        racedImport.targetCharacterId !== input.targetCharacterId ||
        racedImport.packageChecksum !== input.packageChecksum
      ) {
        return { kind: "transfer_conflict" };
      }
      return {
        kind: "unchanged",
        result: importResult(racedImport, true),
      };
    }

    const sourceConversationIds = input.payload.conversations.map(
      ({ sourceId }) => sourceId,
    );
    const existingOrigins =
      sourceConversationIds.length === 0
        ? []
        : await tx
            .select()
            .from(relationshipTransferConversationOrigins)
            .where(
              and(
                eq(
                  relationshipTransferConversationOrigins.targetUserId,
                  input.actorUserId,
                ),
                eq(
                  relationshipTransferConversationOrigins.targetCharacterId,
                  input.targetCharacterId,
                ),
                inArray(
                  relationshipTransferConversationOrigins.sourceConversationId,
                  sourceConversationIds,
                ),
              ),
            );
    const targetConversationBySource = new Map(
      existingOrigins.map((origin) => [
        origin.sourceConversationId,
        origin.importedConversationId,
      ]),
    );
    let importedConversationCount = 0;
    const skippedConversationCount = existingOrigins.length;

    for (const source of input.payload.conversations) {
      if (targetConversationBySource.has(source.sourceId)) continue;
      const conversationId = randomUUID();
      const startedAt = new Date(source.startedAt);
      const sourceEnd = new Date(source.endedAt ?? source.updatedAt);
      const endedAt =
        sourceEnd.getTime() < startedAt.getTime() ? startedAt : sourceEnd;
      const lastSequence = source.messages.at(-1)?.sequence ?? 0;
      await tx.insert(conversations).values({
        id: conversationId,
        userId: input.actorUserId,
        characterId: input.targetCharacterId,
        mode: source.mode,
        status: "completed",
        provider: source.provider,
        model: source.model,
        voice: source.voice,
        messageCount: source.messages.length,
        lastSequence,
        startedAt,
        endedAt,
        updatedAt: new Date(source.updatedAt),
      });
      if (source.messages.length > 0) {
        await tx.insert(conversationMessages).values(
          source.messages.map((message) => ({
            id: randomUUID(),
            conversationId,
            userId: input.actorUserId,
            sequence: message.sequence,
            role: message.role,
            status: message.status,
            text: message.text,
            providerEventId: null,
            createdAt: new Date(message.createdAt),
          })),
        );
      }
      if (source.summary) {
        await tx.insert(conversationSummaries).values({
          conversationId,
          userId: input.actorUserId,
          characterId: input.targetCharacterId,
          content: source.summary.content,
          sourceMessageCount: source.summary.sourceMessageCount,
          sourceLastSequence: source.summary.sourceLastSequence,
          analyzerModel: source.summary.analyzerModel,
          analyzerProfileId: null,
          createdAt: new Date(source.summary.updatedAt),
          updatedAt: new Date(source.summary.updatedAt),
        });
      }
      await tx.insert(relationshipTransferConversationOrigins).values({
        transferImportId: createdImport.id,
        targetUserId: input.actorUserId,
        targetCharacterId: input.targetCharacterId,
        sourceConversationId: source.sourceId,
        importedConversationId: conversationId,
        createdAt: importedAt,
      });
      targetConversationBySource.set(source.sourceId, conversationId);
      importedConversationCount += 1;
    }

    const preparedMemories = input.payload.memories.map((memory) => {
      const content = normalizeMemoryContent(memory.content);
      return {
        ...memory,
        content,
        contentFingerprint: fingerprintMemoryContent(content),
      };
    });
    const fingerprints = [
      ...new Set(
        preparedMemories.map(({ contentFingerprint }) => contentFingerprint),
      ),
    ];
    const existingMemories =
      fingerprints.length === 0
        ? []
        : await tx
            .select({ fingerprint: characterMemories.contentFingerprint })
            .from(characterMemories)
            .where(
              and(
                eq(characterMemories.userId, input.actorUserId),
                eq(characterMemories.characterId, input.targetCharacterId),
                inArray(characterMemories.contentFingerprint, fingerprints),
              ),
            );
    const knownFingerprints = new Set(
      existingMemories.map(({ fingerprint }) => fingerprint),
    );
    let importedMemoryCount = 0;
    let skippedMemoryCount = 0;
    for (const memory of preparedMemories) {
      if (knownFingerprints.has(memory.contentFingerprint)) {
        skippedMemoryCount += 1;
        continue;
      }
      const [inserted] = await tx
        .insert(characterMemories)
        .values({
          userId: input.actorUserId,
          characterId: input.targetCharacterId,
          sourceConversationId: memory.sourceConversationId
            ? (targetConversationBySource.get(memory.sourceConversationId) ??
              null)
            : null,
          contentFingerprint: memory.contentFingerprint,
          content: memory.content,
          sourceExcerpt: memory.sourceExcerpt,
          confidence: memory.confidence,
          analyzerModel: memory.analyzerModel,
          analyzerProfileId: null,
          status: memory.status,
          reviewedAt: memory.reviewedAt ? new Date(memory.reviewedAt) : null,
          createdAt: new Date(memory.createdAt),
          updatedAt: new Date(memory.updatedAt),
        })
        .returning();
      if (!inserted) throw new Error("Imported memory was not readable.");
      if (inserted.status === "active") {
        await input.onMemoryIndex?.(tx, inserted);
      }
      knownFingerprints.add(memory.contentFingerprint);
      importedMemoryCount += 1;
    }

    const [completedImport] = await tx
      .update(relationshipTransferImports)
      .set({
        importedConversationCount,
        skippedConversationCount,
        importedMemoryCount,
        skippedMemoryCount,
      })
      .where(eq(relationshipTransferImports.id, createdImport.id))
      .returning();
    if (!completedImport) throw new Error("Transfer import was not readable.");
    return {
      kind: "imported",
      result: importResult(completedImport, false),
    };
  });
}

function visibleCharacterCondition(actorUserId: string) {
  return or(
    eq(characters.visibility, "builtin"),
    eq(characters.visibility, "family"),
    and(
      eq(characters.visibility, "private"),
      eq(characters.ownerUserId, actorUserId),
    ),
  );
}

function isSameCharacter(
  source: { name: string; systemKey: string | null },
  target: { name: string; systemKey: string | null },
): boolean {
  if (source.systemKey || target.systemKey) {
    return Boolean(
      source.systemKey &&
      target.systemKey &&
      source.systemKey === target.systemKey,
    );
  }
  return (
    source.name.trim().toLocaleLowerCase("zh-CN") ===
    target.name.trim().toLocaleLowerCase("zh-CN")
  );
}

function importResult(
  record: typeof relationshipTransferImports.$inferSelect,
  wasAlreadyImported: boolean,
): RelationshipTransferImportResult {
  return {
    transferId: record.transferId,
    targetCharacterId: record.targetCharacterId,
    importedConversations: record.importedConversationCount,
    skippedConversations: record.skippedConversationCount,
    importedMemories: record.importedMemoryCount,
    skippedMemories: record.skippedMemoryCount,
    wasAlreadyImported,
  };
}
