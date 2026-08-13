import type {
  CharacterMemoryAggregate,
  MemoryIndexDiagnosticRecord,
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
  listIndexDiagnostics?(
    targetUserId: string,
    characterId: string | undefined,
    limit: number,
  ): Promise<MemoryIndexDiagnosticRecord[]>;
  review(
    actorUserId: string,
    memoryId: string,
    review: ReviewMemoryRequest,
    reviewedAt: Date,
  ): Promise<ReviewCharacterMemoryResult>;
}
