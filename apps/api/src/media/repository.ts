import type {
  CreateMediaObjectResult,
  MediaCleanupHook,
  MediaObjectRecord,
  RequestMediaObjectDeletionResult,
  RetainMediaObjectResult,
} from "@meet/database";

export interface MediaRepository {
  createCharacterAvatar(input: {
    ownerUserId: string;
    objectKey: string;
    contentType: string;
    sizeBytes: number;
    checksumSha256: string;
    expiresAt: Date;
    createdAt: Date;
  }): Promise<CreateMediaObjectResult>;
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
