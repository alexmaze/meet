import { describe, expect, it } from "vitest";

import {
  CHARACTER_RELATIONSHIP_TRANSFER_SCHEMA_VERSION,
  characterRelationshipTransferPackageSchema,
} from "./relationship-transfer.js";

const conversationId = "9172f06d-c71a-47b3-94fe-35e1204b5b55";

describe("character relationship transfer protocol", () => {
  it("accepts a strict versioned package without account or credential fields", () => {
    const transferPackage = packageFixture();
    expect(
      characterRelationshipTransferPackageSchema.parse(transferPackage)
        .schemaVersion,
    ).toBe(CHARACTER_RELATIONSHIP_TRANSFER_SCHEMA_VERSION);
    expect(() =>
      characterRelationshipTransferPackageSchema.parse({
        ...transferPackage,
        payload: {
          ...transferPackage.payload,
          sourceUserId: "4d1c2e31-ad0e-4fa9-9ae8-ae3497069117",
        },
      }),
    ).toThrow();
  });

  it("rejects unordered messages and a completed conversation without an end time", () => {
    const transferPackage = packageFixture();
    expect(() =>
      characterRelationshipTransferPackageSchema.parse({
        ...transferPackage,
        payload: {
          ...transferPackage.payload,
          conversations: [
            {
              ...transferPackage.payload.conversations[0],
              messages: [message(2), message(1)],
            },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      characterRelationshipTransferPackageSchema.parse({
        ...transferPackage,
        payload: {
          ...transferPackage.payload,
          conversations: [
            {
              ...transferPackage.payload.conversations[0],
              sourceStatus: "completed",
              endedAt: null,
            },
          ],
        },
      }),
    ).toThrow();
  });
});

function packageFixture() {
  return {
    kind: "meet-character-relationship-transfer" as const,
    schemaVersion: CHARACTER_RELATIONSHIP_TRANSFER_SCHEMA_VERSION,
    payload: {
      transferId: "c437c71e-f209-4f7d-8f98-1c1e239d4201",
      exportedAt: "2026-09-05T03:00:00.000Z",
      character: { name: "奥特曼", systemKey: null },
      conversations: [
        {
          sourceId: conversationId,
          mode: "normal" as const,
          sourceStatus: "completed" as const,
          provider: "qwen" as const,
          model: "qwen-audio-3.0-realtime-plus",
          voice: "longanqian",
          startedAt: "2026-09-04T03:00:00.000Z",
          endedAt: "2026-09-04T03:10:00.000Z",
          updatedAt: "2026-09-04T03:10:00.000Z",
          messages: [message(1), message(2)],
          summary: null,
        },
      ],
      memories: [],
    },
    integritySha256: "0".repeat(64),
  };
}

function message(sequence: number) {
  return {
    sequence,
    role: sequence % 2 ? ("user" as const) : ("assistant" as const),
    status: "completed" as const,
    text: `第 ${sequence} 条消息`,
    createdAt: `2026-09-04T03:0${sequence}:00.000Z`,
  };
}
