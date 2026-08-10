import type {
  MediaCleanupHook,
  MediaObjectRecord,
  RequestMediaObjectDeletionResult,
  RetainMediaObjectResult,
} from "@meet/database";

export interface MediaRepository {
  findReadable(
    actorUserId: string,
    actorCanReadChildren: boolean,
    mediaId: string,
  ): Promise<MediaObjectRecord | null>;
  requestDelete(
    actorUserId: string,
    mediaId: string,
    requestedAt: Date,
  ): Promise<RequestMediaObjectDeletionResult>;
  retain(
    actorUserId: string,
    mediaId: string,
    retainedAt: Date,
  ): Promise<RetainMediaObjectResult>;
}

export type MediaRepositoryCleanupHook = MediaCleanupHook;
