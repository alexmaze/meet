import type { MediaObjectRecord } from "@meet/database";
import type { MediaExpireJob } from "@meet/jobs";
import type { MediaStore } from "@meet/media";
import { describe, expect, it, vi } from "vitest";

import {
  createMediaExpirationHandler,
  type MediaCleanupRepository,
} from "./media-cleanup.js";

describe("media expiration", () => {
  it("deletes claimed storage objects before completing metadata", async () => {
    const order: string[] = [];
    const repository = fakeRepository();
    vi.mocked(repository.claim).mockResolvedValue(record());
    vi.mocked(repository.complete).mockImplementation(async () => {
      order.push("metadata");
      return true;
    });
    const store = fakeStore();
    vi.mocked(store.delete).mockImplementation(async () => {
      order.push("object");
    });
    const handler = createMediaExpirationHandler(
      repository,
      store,
      () => new Date("2026-08-11T00:00:01.000Z"),
    );

    await handler(job());

    expect(order).toEqual(["object", "metadata"]);
    expect(store.delete).toHaveBeenCalledWith(record().objectKey);
  });

  it("is a no-op when the metadata is retained, stale, or already deleted", async () => {
    const repository = fakeRepository();
    const store = fakeStore();
    const handler = createMediaExpirationHandler(repository, store);
    await handler(job());
    expect(store.delete).not.toHaveBeenCalled();
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it("leaves metadata pending when object deletion fails so the job can retry", async () => {
    const repository = fakeRepository();
    vi.mocked(repository.claim).mockResolvedValue(record());
    const store = fakeStore();
    vi.mocked(store.delete).mockRejectedValue(new Error("storage unavailable"));
    const handler = createMediaExpirationHandler(repository, store);
    await expect(handler(job())).rejects.toThrow("storage unavailable");
    expect(repository.complete).not.toHaveBeenCalled();
  });
});

function fakeRepository(): MediaCleanupRepository {
  return {
    claim: vi.fn(async () => null),
    complete: vi.fn(async () => true),
  };
}

function fakeStore(): MediaStore {
  return {
    put: vi.fn(),
    open: vi.fn(),
    delete: vi.fn(async () => undefined),
    exists: vi.fn(async () => false),
  };
}

function job(): MediaExpireJob {
  return {
    idempotencyKey:
      "media.expire:2fd4cbb6-fce4-40e2-9141-22f3a1bc2051:expired:2026-08-11T00:00:00.000Z",
    mediaId: "2fd4cbb6-fce4-40e2-9141-22f3a1bc2051",
    objectKey: "2026/08/2fd4cbb6-fce4-40e2-9141-22f3a1bc2051",
    reason: "expired",
    notBefore: "2026-08-11T00:00:00.000Z",
    expectedExpiresAt: "2026-08-11T00:00:00.000Z",
  };
}

function record(): MediaObjectRecord {
  const now = new Date("2026-08-11T00:00:00.000Z");
  return {
    id: "2fd4cbb6-fce4-40e2-9141-22f3a1bc2051",
    ownerUserId: "4d1c2e31-ad0e-4fa9-9ae8-ae3497069117",
    conversationId: "9172f06d-c71a-47b3-94fe-35e1204b5b55",
    kind: "call_recording",
    objectKey: "2026/08/2fd4cbb6-fce4-40e2-9141-22f3a1bc2051",
    contentType: "audio/webm",
    sizeBytes: 42,
    checksumSha256: "a".repeat(64),
    retention: "temporary",
    status: "pending_deletion",
    expiresAt: now,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}
