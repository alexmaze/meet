import {
  isGuardianReadableMemoryTarget,
  listCharacterMemories,
  reviewCharacterMemory,
  type Database,
} from "@meet/database";

import type { MemoryRepository } from "./repository.js";

export class PostgresMemoryRepository implements MemoryRepository {
  constructor(private readonly db: Database) {}

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
    });
  }
}
