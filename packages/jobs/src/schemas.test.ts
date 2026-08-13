import { describe, expect, it } from "vitest";

import {
  conversationCheckpointJobSchema,
  conversationFinalizeJobSchema,
  mediaExpireJobSchema,
  memoryExtractJobSchema,
  memoryIndexSyncJobSchema,
} from "./schemas.js";

const payload = {
  idempotencyKey:
    "conversation.finalize:9172f06d-c71a-47b3-94fe-35e1204b5b55:12",
  conversationId: "9172f06d-c71a-47b3-94fe-35e1204b5b55",
  userId: "4d1c2e31-ad0e-4fa9-9ae8-ae3497069117",
  completedSequence: 12,
};

describe("background job payloads", () => {
  it("accepts stable business idempotency keys", () => {
    expect(conversationFinalizeJobSchema.parse(payload)).toEqual(payload);
    expect(memoryExtractJobSchema.parse(payload)).toEqual(payload);
  });

  it("validates an incremental checkpoint target", () => {
    expect(
      conversationCheckpointJobSchema.parse({
        idempotencyKey:
          "conversation.checkpoint:9172f06d-c71a-47b3-94fe-35e1204b5b55:20",
        checkpointId: "2fd4cbb6-fce4-40e2-9141-22f3a1bc2051",
        conversationId: "9172f06d-c71a-47b3-94fe-35e1204b5b55",
        userId: "4d1c2e31-ad0e-4fa9-9ae8-ae3497069117",
        targetSequence: 20,
        modelProfileId: "f9784de7-4c21-4c73-9507-54c3aa4d0281",
      }),
    ).toMatchObject({ targetSequence: 20 });
  });

  it("validates a Mem0 index synchronization target", () => {
    expect(
      memoryIndexSyncJobSchema.parse({
        idempotencyKey:
          "memory.index.sync:1d1c2e31-ad0e-4fa9-9ae8-ae3497069117:fingerprint:active",
        memoryId: "1d1c2e31-ad0e-4fa9-9ae8-ae3497069117",
      }),
    ).toMatchObject({
      memoryId: "1d1c2e31-ad0e-4fa9-9ae8-ae3497069117",
    });
  });

  it("rejects unbounded or incomplete payloads", () => {
    expect(
      conversationFinalizeJobSchema.safeParse({
        ...payload,
        idempotencyKey: "",
      }).success,
    ).toBe(false);
    expect(
      memoryExtractJobSchema.safeParse({ ...payload, unexpected: true })
        .success,
    ).toBe(false);
  });

  it("requires expiration jobs to carry the scheduled version", () => {
    const media = {
      idempotencyKey:
        "media.expire:2fd4cbb6-fce4-40e2-9141-22f3a1bc2051:expired:2026-08-11T00:00:00.000Z",
      mediaId: "2fd4cbb6-fce4-40e2-9141-22f3a1bc2051",
      objectKey: "2026/08/2fd4cbb6-fce4-40e2-9141-22f3a1bc2051",
      reason: "expired",
      notBefore: "2026-08-11T00:00:00.000Z",
      expectedExpiresAt: "2026-08-11T00:00:00.000Z",
    };
    expect(mediaExpireJobSchema.parse(media)).toEqual(media);
    expect(
      mediaExpireJobSchema.safeParse({
        ...media,
        expectedExpiresAt: undefined,
      }).success,
    ).toBe(false);
  });
});
