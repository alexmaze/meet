import {
  isGuardianReadableMemoryTarget,
  listCharacterMemories,
  listMemoryIndexDiagnostics,
  reviewCharacterMemory,
  type Database,
  type MemoryIndexHook,
} from "@meet/database";

import type { MemoryRepository } from "./repository.js";

export class PostgresMemoryRepository implements MemoryRepository {
  constructor(
    private readonly db: Database,
    private readonly onIndex?: MemoryIndexHook,
  ) {}

  list(
    targetUserId: string,
    status: "active" | "suggested" | undefined,
    limit: number,
  ) {
    return listCharacterMemories(this.db, { targetUserId, status, limit });
  }

  isGuardianReadableTarget(targetUserId: string) {
    return isGuardianReadableMemoryTarget(this.db, targetUserId);
  }

  listIndexDiagnostics(
    targetUserId: string,
    characterId: string | undefined,
    limit: number,
  ) {
    return listMemoryIndexDiagnostics(this.db, {
      targetUserId,
      characterId,
      limit,
    });
  }

  review(
    actorUserId: string,
    memoryId: string,
    review: Parameters<MemoryRepository["review"]>[2],
    reviewedAt: Date,
  ) {
    return reviewCharacterMemory(this.db, {
      actorUserId,
      memoryId,
      review,
      reviewedAt,
      onIndex: this.onIndex,
    });
  }
}
