import type { MediaObjectRecord } from "@meet/database";
import { MediaObjectNotFoundError, type MediaStore } from "@meet/media";
import {
  CHARACTER_AVATAR_MAX_BYTES,
  characterAvatarContentTypeSchema,
  type CharacterAvatarContentType,
  type CharacterAvatarUploadResponse,
  mediaObjectSchema,
  type MediaObjectMetadata,
  type UserAccount,
} from "@meet/protocol";

import type { MediaRepository } from "./repository.js";

export type MediaServiceErrorCode =
  | "MEDIA_NOT_FOUND"
  | "MEDIA_UPLOAD_FORBIDDEN"
  | "MEDIA_INVALID_CHARACTER_AVATAR"
  | "MEDIA_RETENTION_CONFLICT"
  | "MEDIA_SERVICE_UNAVAILABLE";

const CHARACTER_AVATAR_PREVIEW_TTL_MS = 24 * 60 * 60 * 1_000;
const UPLOADED_AVATAR_PATH =
  /^\/api\/media\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/content$/;
const BUILT_IN_AVATAR_PATH = /^\/avatars\/[A-Za-z0-9_-]+\.svg$/;

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

  async uploadCharacterAvatar(
    actor: UserAccount,
    input: { body: Uint8Array; contentType: string },
  ): Promise<CharacterAvatarUploadResponse> {
    if (actor.accountType === "child") {
      throw new MediaServiceError(
        "MEDIA_UPLOAD_FORBIDDEN",
        "儿童账号不能上传角色形象。",
        403,
      );
    }
    const contentType = characterAvatarContentTypeSchema.safeParse(
      input.contentType,
    );
    if (
      !contentType.success ||
      input.body.byteLength === 0 ||
      input.body.byteLength > CHARACTER_AVATAR_MAX_BYTES ||
      !hasExpectedImageSignature(input.body, contentType.data)
    ) {
      throw invalidCharacterAvatar();
    }
    if (!this.repository || !this.store) throw unavailable();

    let stored: Awaited<ReturnType<MediaStore["put"]>>;
    try {
      stored = await this.store.put({
        body: input.body,
        contentType: contentType.data,
      });
    } catch (error) {
      throw unavailable(error);
    }

    const createdAt = this.now();
    try {
      const result = await this.repository.createCharacterAvatar({
        ownerUserId: actor.id,
        objectKey: stored.key,
        contentType: contentType.data,
        sizeBytes: stored.sizeBytes,
        checksumSha256: stored.checksumSha256,
        expiresAt: new Date(
          createdAt.getTime() + CHARACTER_AVATAR_PREVIEW_TTL_MS,
        ),
        createdAt,
      });
      if (result.kind !== "created")
        throw new Error("Unexpected media result.");
      return {
        media: toPublicMedia(result.media),
        avatarUrl: characterAvatarUrl(result.media.id),
      };
    } catch (error) {
      try {
        await this.store.delete(stored.key);
      } catch {
        // The original repository error is more useful; storage cleanup is idempotent.
      }
      throw error instanceof MediaServiceError ? error : unavailable(error);
    }
  }

  async retainCharacterAvatar(
    actor: UserAccount,
    avatarUrl: string,
  ): Promise<void> {
    if (BUILT_IN_AVATAR_PATH.test(avatarUrl)) return;
    const mediaId = UPLOADED_AVATAR_PATH.exec(avatarUrl)?.[1];
    if (!mediaId) throw invalidCharacterAvatar();
    const record = await this.findRecord(actor, mediaId);
    if (record.ownerUserId !== actor.id || record.kind !== "character_avatar") {
      throw invalidCharacterAvatar();
    }
    await this.retain(actor, record.id);
  }

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

function invalidCharacterAvatar(): MediaServiceError {
  return new MediaServiceError(
    "MEDIA_INVALID_CHARACTER_AVATAR",
    "请选择有效的 JPG、PNG 或 WebP 图片，文件不能超过 5 MB。",
    400,
  );
}

function characterAvatarUrl(mediaId: string): string {
  return `/api/media/${mediaId}/content`;
}

function hasExpectedImageSignature(
  body: Uint8Array,
  contentType: CharacterAvatarContentType,
): boolean {
  if (contentType === "image/jpeg") {
    return (
      body.length >= 3 &&
      body[0] === 0xff &&
      body[1] === 0xd8 &&
      body[2] === 0xff
    );
  }
  if (contentType === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return signature.every((value, index) => body[index] === value);
  }
  return (
    body.length >= 12 &&
    String.fromCharCode(...body.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...body.slice(8, 12)) === "WEBP"
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
