import type { MediaObjectRecord } from "@meet/database";
import { MediaObjectNotFoundError, type MediaStore } from "@meet/media";
import {
  mediaObjectSchema,
  type MediaObjectMetadata,
  type UserAccount,
} from "@meet/protocol";

import type { MediaRepository } from "./repository.js";

export type MediaServiceErrorCode =
  "MEDIA_NOT_FOUND" | "MEDIA_RETENTION_CONFLICT" | "MEDIA_SERVICE_UNAVAILABLE";

export class MediaServiceError extends Error {
  constructor(
    readonly code: MediaServiceErrorCode,
    message: string,
    readonly statusCode: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MediaServiceError";
  }
}

export type OpenedMediaObject = {
  media: MediaObjectMetadata;
  body: ReadableStream<Uint8Array>;
};

export class MediaService {
  constructor(
    private readonly repository: MediaRepository | null,
    private readonly store: MediaStore | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async find(
    actor: UserAccount,
    mediaId: string,
  ): Promise<MediaObjectMetadata> {
    return toPublicMedia(await this.findRecord(actor, mediaId));
  }

  async open(actor: UserAccount, mediaId: string): Promise<OpenedMediaObject> {
    const record = await this.findRecord(actor, mediaId);
    const store = this.store;
    if (!store) throw unavailable();
    try {
      return {
        media: toPublicMedia(record),
        body: await store.open(record.objectKey),
      };
    } catch (error) {
      if (error instanceof MediaObjectNotFoundError) throw unavailable(error);
      throw unavailable(error);
    }
  }

  async delete(actor: UserAccount, mediaId: string): Promise<void> {
    const result = await this.call((repository) =>
      repository.requestDelete(actor.id, mediaId, this.now()),
    );
    if (result.kind === "not_found") throw notFound();
  }

  async retain(
    actor: UserAccount,
    mediaId: string,
  ): Promise<MediaObjectMetadata> {
    const result = await this.call((repository) =>
      repository.retain(actor.id, mediaId, this.now()),
    );
    if (result.kind === "not_found") throw notFound();
    if (result.kind === "deletion_started") {
      throw new MediaServiceError(
        "MEDIA_RETENTION_CONFLICT",
        "这个媒体文件已经开始清理，无法再保留。",
        409,
      );
    }
    return toPublicMedia(result.media);
  }

  private async findRecord(
    actor: UserAccount,
    mediaId: string,
  ): Promise<MediaObjectRecord> {
    const record = await this.call((repository) =>
      repository.findReadable(actor.id, actor.accountType === "admin", mediaId),
    );
    if (!record) throw notFound();
    return record;
  }

  private async call<T>(
    operation: (repository: MediaRepository) => Promise<T>,
  ): Promise<T> {
    if (!this.repository) throw unavailable();
    try {
      return await operation(this.repository);
    } catch (error) {
      if (error instanceof MediaServiceError) throw error;
      throw unavailable(error);
    }
  }
}

function toPublicMedia(record: MediaObjectRecord): MediaObjectMetadata {
  return mediaObjectSchema.parse({
    id: record.id,
    ownerUserId: record.ownerUserId,
    conversationId: record.conversationId,
    kind: record.kind,
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    retention: record.retention,
    expiresAt: record.expiresAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  });
}

function notFound(): MediaServiceError {
  return new MediaServiceError(
    "MEDIA_NOT_FOUND",
    "没有找到这个媒体文件。",
    404,
  );
}

function unavailable(cause?: unknown): MediaServiceError {
  return new MediaServiceError(
    "MEDIA_SERVICE_UNAVAILABLE",
    "媒体服务暂时不可用，请稍后重试。",
    503,
    cause === undefined ? undefined : { cause },
  );
}
