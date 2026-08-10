import { describe, expect, it } from "vitest";

import {
  conversationFinalizeJobSchema,
  memoryExtractJobSchema,
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
});
