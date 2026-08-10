import { describe, expect, it } from "vitest";

import { mediaObjectSchema } from "./media.js";

describe("media protocol", () => {
  it("exposes metadata without storage keys or checksums", () => {
    const media = mediaObjectSchema.parse({
      id: "2fd4cbb6-fce4-40e2-9141-22f3a1bc2051",
      ownerUserId: "4d1c2e31-ad0e-4fa9-9ae8-ae3497069117",
      conversationId: "9172f06d-c71a-47b3-94fe-35e1204b5b55",
      kind: "call_recording",
      contentType: "audio/webm",
      sizeBytes: 42,
      retention: "retained",
      expiresAt: null,
      createdAt: "2026-08-10T05:20:00.000Z",
    });
    expect(media.kind).toBe("call_recording");
    expect(media).not.toHaveProperty("objectKey");
    expect(media).not.toHaveProperty("checksumSha256");
  });
});
