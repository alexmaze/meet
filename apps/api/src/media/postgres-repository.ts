import {
  createMediaObject,
  findReadableMediaObject,
  requestMediaObjectDeletion,
  retainMediaObject,
  type Database,
  type MediaCleanupHook,
} from "@meet/database";

import type { MediaRepository } from "./repository.js";

export class PostgresMediaRepository implements MediaRepository {
  constructor(
    private readonly db: Database,
    private readonly onCleanup: MediaCleanupHook,
  ) {}

  createCharacterAvatar(
    input: Parameters<MediaRepository["createCharacterAvatar"]>[0],
  ) {
    return createMediaObject(this.db, {
      ...input,
      kind: "character_avatar",
      retention: "temporary",
      onCleanup: this.onCleanup,
    });
  }

  findReadable(
    actorUserId: string,
    actorCanReadChildren: boolean,
    mediaId: string,
  ) {
    return findReadableMediaObject(this.db, {
      actorUserId,
      actorCanReadChildren,
      mediaId,
    });
  }

  requestDelete(actorUserId: string, mediaId: string, requestedAt: Date) {
    return requestMediaObjectDeletion(this.db, {
      actorUserId,
      mediaId,
      requestedAt,
      onCleanup: this.onCleanup,
    });
  }

  retain(actorUserId: string, mediaId: string, retainedAt: Date) {
    return retainMediaObject(this.db, { actorUserId, mediaId, retainedAt });
  }
}
