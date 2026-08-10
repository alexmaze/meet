import {
  claimMediaObjectForDeletion,
  completeMediaObjectDeletion,
  type Database,
  type MediaObjectRecord,
} from "@meet/database";
import { mediaExpireJobSchema, type MediaExpireJob } from "@meet/jobs";
import type { MediaStore } from "@meet/media";

export interface MediaCleanupRepository {
  claim(
    job: MediaExpireJob,
    claimedAt: Date,
  ): Promise<MediaObjectRecord | null>;
  complete(
    mediaId: string,
    objectKey: string,
    deletedAt: Date,
  ): Promise<boolean>;
}

export class PostgresMediaCleanupRepository implements MediaCleanupRepository {
  constructor(private readonly db: Database) {}

  claim(job: MediaExpireJob, claimedAt: Date) {
    return claimMediaObjectForDeletion(this.db, {
      mediaId: job.mediaId,
      objectKey: job.objectKey,
      reason: job.reason,
      expectedExpiresAt: job.expectedExpiresAt
        ? new Date(job.expectedExpiresAt)
        : undefined,
      claimedAt,
    });
  }

  complete(mediaId: string, objectKey: string, deletedAt: Date) {
    return completeMediaObjectDeletion(this.db, {
      mediaId,
      objectKey,
      deletedAt,
    });
  }
}

export function createMediaExpirationHandler(
  repository: MediaCleanupRepository,
  store: MediaStore,
  now: () => Date = () => new Date(),
) {
  return async (value: unknown): Promise<void> => {
    const job = mediaExpireJobSchema.parse(value);
    const media = await repository.claim(job, now());
    if (!media) return;
    await store.delete(media.objectKey);
    const completed = await repository.complete(
      media.id,
      media.objectKey,
      now(),
    );
    if (!completed) {
      throw new Error("Media cleanup metadata was not completed.");
    }
  };
}
