import { and, desc, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";

import type { DatabaseTransaction } from "./conversation-operations.js";
import type { Database } from "./client.js";
import {
  characterMemories,
  characters,
  memoryIndexEntries,
  type CharacterMemoryRecord,
  type MemoryIndexEntryRecord,
} from "./schema.js";

export type MemoryIndexHook = (
  transaction: DatabaseTransaction,
  memory: CharacterMemoryRecord,
) => Promise<void>;

export type MemoryForIndex = {
  memory: CharacterMemoryRecord;
  index: MemoryIndexEntryRecord | null;
};

export type MemoryIndexDiagnosticRecord = MemoryForIndex & {
  character: Pick<
    typeof characters.$inferSelect,
    "id" | "name" | "visualProfile"
  >;
};

export async function listMemoryIndexDiagnostics(
  db: Database,
  input: {
    targetUserId: string;
    characterId?: string;
    limit: number;
  },
): Promise<MemoryIndexDiagnosticRecord[]> {
  return db
    .select({
      memory: characterMemories,
      index: memoryIndexEntries,
      character: {
        id: characters.id,
        name: characters.name,
        visualProfile: characters.visualProfile,
      },
    })
    .from(characterMemories)
    .innerJoin(characters, eq(characterMemories.characterId, characters.id))
    .leftJoin(
      memoryIndexEntries,
      eq(memoryIndexEntries.memoryId, characterMemories.id),
    )
    .where(
      and(
        eq(characterMemories.userId, input.targetUserId),
        input.characterId
          ? eq(characterMemories.characterId, input.characterId)
          : undefined,
      ),
    )
    .orderBy(desc(characterMemories.updatedAt), desc(characterMemories.id))
    .limit(input.limit);
}

export async function prepareMemoryIndexEntry(
  transaction: DatabaseTransaction,
  memoryId: string,
  updatedAt = new Date(),
): Promise<void> {
  await transaction
    .insert(memoryIndexEntries)
    .values({ memoryId, status: "pending", updatedAt })
    .onConflictDoUpdate({
      target: memoryIndexEntries.memoryId,
      set: {
        status: "pending",
        lastErrorCode: null,
        updatedAt,
      },
    });
}

export async function loadMemoryForIndex(
  db: Database,
  memoryId: string,
): Promise<MemoryForIndex | null> {
  const [record] = await db
    .select({ memory: characterMemories, index: memoryIndexEntries })
    .from(characterMemories)
    .leftJoin(
      memoryIndexEntries,
      eq(memoryIndexEntries.memoryId, characterMemories.id),
    )
    .where(eq(characterMemories.id, memoryId))
    .limit(1);
  return record ?? null;
}

export async function markMemoryIndexSynced(
  db: Database,
  input: {
    memoryId: string;
    externalId: string | null;
    indexedFingerprint: string | null;
    indexRevision: string;
    syncedAt?: Date;
  },
): Promise<void> {
  const syncedAt = input.syncedAt ?? new Date();
  await db
    .insert(memoryIndexEntries)
    .values({
      memoryId: input.memoryId,
      externalId: input.externalId,
      indexedFingerprint: input.indexedFingerprint,
      indexRevision: input.indexRevision,
      status: "synced",
      attemptCount: 1,
      syncedAt,
      updatedAt: syncedAt,
    })
    .onConflictDoUpdate({
      target: memoryIndexEntries.memoryId,
      set: {
        externalId: input.externalId,
        indexedFingerprint: input.indexedFingerprint,
        indexRevision: input.indexRevision,
        status: "synced",
        attemptCount: sql`${memoryIndexEntries.attemptCount} + 1`,
        lastErrorCode: null,
        syncedAt,
        updatedAt: syncedAt,
      },
    });
}

export async function markMemoryIndexFailed(
  db: Database,
  memoryId: string,
  errorCode: string,
  failedAt = new Date(),
): Promise<void> {
  await db
    .insert(memoryIndexEntries)
    .values({
      memoryId,
      status: "failed",
      attemptCount: 1,
      lastErrorCode: errorCode,
      updatedAt: failedAt,
    })
    .onConflictDoUpdate({
      target: memoryIndexEntries.memoryId,
      set: {
        status: "failed",
        attemptCount: sql`${memoryIndexEntries.attemptCount} + 1`,
        lastErrorCode: errorCode,
        updatedAt: failedAt,
      },
    });
}

export async function listMemoriesRequiringIndex(
  db: Database,
  limit = 1_000,
  indexRevision?: string,
): Promise<CharacterMemoryRecord[]> {
  const rows = await db
    .select({ memory: characterMemories })
    .from(characterMemories)
    .leftJoin(
      memoryIndexEntries,
      eq(memoryIndexEntries.memoryId, characterMemories.id),
    )
    .where(
      or(
        and(
          eq(characterMemories.status, "active"),
          or(
            isNull(memoryIndexEntries.memoryId),
            ne(memoryIndexEntries.status, "synced"),
            isNull(memoryIndexEntries.indexedFingerprint),
            ne(
              memoryIndexEntries.indexedFingerprint,
              characterMemories.contentFingerprint,
            ),
            indexRevision
              ? or(
                  isNull(memoryIndexEntries.indexRevision),
                  ne(memoryIndexEntries.indexRevision, indexRevision),
                )
              : undefined,
          ),
        ),
        and(
          ne(characterMemories.status, "active"),
          isNotNull(memoryIndexEntries.externalId),
        ),
      ),
    )
    .limit(limit);
  return rows.map(({ memory }) => memory);
}
