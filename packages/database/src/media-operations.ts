import { and, eq, inArray, or } from "drizzle-orm";

import type { Database } from "./client.js";
import type { DatabaseTransaction } from "./conversation-operations.js";
import {
  conversations,
  mediaObjects,
  userAccounts,
  type MediaObjectRecord,
} from "./schema.js";

export type MediaCleanupReason = "expired" | "user_deleted";

export type MediaCleanupRequest = {
  mediaId: string;
  objectKey: string;
  reason: MediaCleanupReason;
  notBefore: Date;
  expectedExpiresAt?: Date;
};

export type MediaCleanupHook = (
  transaction: DatabaseTransaction,
  request: MediaCleanupRequest,
) => Promise<void>;

type MediaRetentionInput =
  | { retention: "temporary"; expiresAt: Date }
  | { retention: "retained"; expiresAt?: never };

export type CreateMediaObjectInput = MediaRetentionInput & {
  id?: string;
  ownerUserId: string;
  conversationId?: string;
  kind:
    | "call_recording"
    | "conversation_image"
    | "character_avatar"
    | "avatar_preview";
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  createdAt?: Date;
  onCleanup: MediaCleanupHook;
};

export type CreateMediaObjectResult =
  | { kind: "created"; media: MediaObjectRecord }
  | { kind: "conversation_not_found" };

export async function createMediaObject(
  db: Database,
  input: CreateMediaObjectInput,
): Promise<CreateMediaObjectResult> {
  const createdAt = input.createdAt ?? new Date();
  const conversationKind =
    input.kind === "call_recording" || input.kind === "conversation_image";
  if (conversationKind !== Boolean(input.conversationId)) {
    throw new TypeError(
      "Media kind and conversation association do not match.",
    );
  }
  if (input.retention === "temporary" && input.expiresAt <= createdAt) {
    throw new TypeError("Temporary media must expire after creation.");
  }

  return db.transaction(async (tx) => {
    if (input.conversationId) {
      const [conversation] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, input.conversationId),
            eq(conversations.userId, input.ownerUserId),
          ),
        )
        .limit(1);
      if (!conversation) return { kind: "conversation_not_found" };
    }

    const [media] = await tx
      .insert(mediaObjects)
      .values({
        ...(input.id ? { id: input.id } : {}),
        ownerUserId: input.ownerUserId,
        conversationId: input.conversationId ?? null,
        kind: input.kind,
        objectKey: input.objectKey,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        checksumSha256: input.checksumSha256,
        retention: input.retention,
        expiresAt: input.retention === "temporary" ? input.expiresAt : null,
        createdAt,
        updatedAt: createdAt,
      })
      .returning();
    if (!media) throw new Error("Media object was not created.");

    if (input.retention === "temporary") {
      await input.onCleanup(tx, {
        mediaId: media.id,
        objectKey: media.objectKey,
        reason: "expired",
        notBefore: input.expiresAt,
        expectedExpiresAt: input.expiresAt,
      });
    }
    return { kind: "created", media };
  });
}

export async function findReadableMediaObject(
  db: Database,
  input: {
    actorUserId: string;
    actorCanReadChildren: boolean;
    mediaId: string;
  },
): Promise<MediaObjectRecord | null> {
  const [media] = await db
    .select({ media: mediaObjects })
    .from(mediaObjects)
    .innerJoin(userAccounts, eq(mediaObjects.ownerUserId, userAccounts.id))
    .where(
      and(
        eq(mediaObjects.id, input.mediaId),
        eq(mediaObjects.status, "available"),
        or(
          eq(mediaObjects.ownerUserId, input.actorUserId),
          input.actorCanReadChildren
            ? and(
                eq(userAccounts.accountType, "child"),
                eq(userAccounts.guardianHistoryAccess, "allowed"),
                inArray(mediaObjects.kind, [
                  "call_recording",
                  "conversation_image",
                ]),
              )
            : eq(mediaObjects.ownerUserId, input.actorUserId),
        ),
      ),
    )
    .limit(1);
  return media?.media ?? null;
}

export type RequestMediaObjectDeletionResult =
  | { kind: "requested" | "unchanged"; media: MediaObjectRecord }
  | { kind: "not_found" };

export async function requestMediaObjectDeletion(
  db: Database,
  input: {
    actorUserId: string;
    mediaId: string;
    requestedAt?: Date;
    onCleanup: MediaCleanupHook;
  },
): Promise<RequestMediaObjectDeletionResult> {
  const requestedAt = input.requestedAt ?? new Date();
  return db.transaction(async (tx) => {
    const [media] = await tx
      .select()
      .from(mediaObjects)
      .where(
        and(
          eq(mediaObjects.id, input.mediaId),
          eq(mediaObjects.ownerUserId, input.actorUserId),
        ),
      )
      .for("update")
      .limit(1);
    if (!media) return { kind: "not_found" };
    if (media.status !== "available") return { kind: "unchanged", media };

    const [pending] = await tx
      .update(mediaObjects)
      .set({ status: "pending_deletion", updatedAt: requestedAt })
      .where(eq(mediaObjects.id, media.id))
      .returning();
    if (!pending) throw new Error("Media deletion was not requested.");
    await input.onCleanup(tx, {
      mediaId: pending.id,
      objectKey: pending.objectKey,
      reason: "user_deleted",
      notBefore: requestedAt,
    });
    return { kind: "requested", media: pending };
  });
}

export type RetainMediaObjectResult =
  | { kind: "retained" | "unchanged"; media: MediaObjectRecord }
  | { kind: "not_found" }
  | { kind: "deletion_started" };

export async function retainMediaObject(
  db: Database,
  input: {
    actorUserId: string;
    mediaId: string;
    retainedAt?: Date;
  },
): Promise<RetainMediaObjectResult> {
  const retainedAt = input.retainedAt ?? new Date();
  return db.transaction(async (tx) => {
    const [media] = await tx
      .select()
      .from(mediaObjects)
      .where(
        and(
          eq(mediaObjects.id, input.mediaId),
          eq(mediaObjects.ownerUserId, input.actorUserId),
        ),
      )
      .for("update")
      .limit(1);
    if (!media || media.status === "deleted") return { kind: "not_found" };
    if (media.status === "pending_deletion") {
      return { kind: "deletion_started" };
    }
    if (media.retention === "retained") return { kind: "unchanged", media };
    const [retained] = await tx
      .update(mediaObjects)
      .set({ retention: "retained", expiresAt: null, updatedAt: retainedAt })
      .where(eq(mediaObjects.id, media.id))
      .returning();
    if (!retained) throw new Error("Media object was not retained.");
    return { kind: "retained", media: retained };
  });
}

export async function claimMediaObjectForDeletion(
  db: Database,
  input: {
    mediaId: string;
    objectKey: string;
    reason: MediaCleanupReason;
    expectedExpiresAt?: Date;
    claimedAt?: Date;
  },
): Promise<MediaObjectRecord | null> {
  const claimedAt = input.claimedAt ?? new Date();
  return db.transaction(async (tx) => {
    const [media] = await tx
      .select()
      .from(mediaObjects)
      .where(
        and(
          eq(mediaObjects.id, input.mediaId),
          eq(mediaObjects.objectKey, input.objectKey),
        ),
      )
      .for("update")
      .limit(1);
    if (!media || !shouldClaimMediaForDeletion(media, input, claimedAt)) {
      return null;
    }
    if (media.status === "pending_deletion") return media;
    const [pending] = await tx
      .update(mediaObjects)
      .set({ status: "pending_deletion", updatedAt: claimedAt })
      .where(eq(mediaObjects.id, media.id))
      .returning();
    return pending ?? null;
  });
}

export function shouldClaimMediaForDeletion(
  media: Pick<
    MediaObjectRecord,
    "status" | "retention" | "expiresAt" | "objectKey"
  >,
  input: {
    objectKey: string;
    reason: MediaCleanupReason;
    expectedExpiresAt?: Date;
  },
  claimedAt: Date,
): boolean {
  if (media.objectKey !== input.objectKey || media.status === "deleted") {
    return false;
  }
  if (media.status === "pending_deletion") return true;
  if (input.reason === "user_deleted") return true;
  return Boolean(
    media.retention === "temporary" &&
    media.expiresAt &&
    input.expectedExpiresAt &&
    media.expiresAt.getTime() === input.expectedExpiresAt.getTime() &&
    media.expiresAt <= claimedAt,
  );
}

export async function completeMediaObjectDeletion(
  db: Database,
  input: {
    mediaId: string;
    objectKey: string;
    deletedAt?: Date;
  },
): Promise<boolean> {
  const deletedAt = input.deletedAt ?? new Date();
  const [deleted] = await db
    .update(mediaObjects)
    .set({ status: "deleted", deletedAt, updatedAt: deletedAt })
    .where(
      and(
        eq(mediaObjects.id, input.mediaId),
        eq(mediaObjects.objectKey, input.objectKey),
        eq(mediaObjects.status, "pending_deletion"),
      ),
    )
    .returning({ id: mediaObjects.id });
  return Boolean(deleted);
}
