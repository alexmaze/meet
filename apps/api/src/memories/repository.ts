import type {
  CharacterMemoryAggregate,
  ReviewCharacterMemoryResult,
} from "@meet/database";
import type { ReviewMemoryRequest } from "@meet/protocol";

export interface MemoryRepository {
  list(
    targetUserId: string,
    status: "active" | "suggested" | undefined,
    limit: number,
  ): Promise<CharacterMemoryAggregate[]>;
  isGuardianReadableTarget(targetUserId: string): Promise<boolean>;
  review(
    actorUserId: string,
    memoryId: string,
    review: ReviewMemoryRequest,
    reviewedAt: Date,
  ): Promise<ReviewCharacterMemoryResult>;
}
