import { describe, expect, it } from "vitest";

import {
  appendConversationMessagesRequestSchema,
  conversationRuntimeSnapshotSchema,
  conversationRealtimeQuerySchema,
  createConversationRequestSchema,
  completeConversationRequestSchema,
} from "./conversations.js";

const writer = { clientId: "83e63c3c-7d2c-410b-9052-9f74c6195041", epoch: 1 };

describe("conversation protocol", () => {
  it("validates a provider-neutral runtime snapshot", () => {
    const snapshot = {
      characterRevision: 3,
      realtimeModelProfileId: "c437c71e-f209-4f7d-8f98-1c1e239d4201",
      provider: "qwen",
      model: "qwen-audio-3.0-realtime-plus",
      voice: "longanqian",
      instructions: "保持角色设定。",
      firstSpeaker: "assistant",
      openingLine: "你好。",
      contextPolicyVersion: "context-v1",
    };
    expect(conversationRuntimeSnapshotSchema.parse(snapshot)).toMatchObject({
      characterRevision: 3,
      provider: "qwen",
    });
    expect(() =>
      conversationRuntimeSnapshotSchema.parse({
        ...snapshot,
        contextPolicyVersion: "unknown-policy",
      }),
    ).toThrow();
  });

  it("accepts client-owned stable ids and a temporary conversation mode", () => {
    expect(
      createConversationRequestSchema.parse({
        id: "9172f06d-c71a-47b3-94fe-35e1204b5b55",
        characterId: "c437c71e-f209-4f7d-8f98-1c1e239d4201",
        mode: "temporary",
      }),
    ).toMatchObject({ mode: "temporary" });
  });

  it("defaults persisted transcript metadata without accepting forged fields", () => {
    const parsed = appendConversationMessagesRequestSchema.parse({
      writer,
      messages: [
        {
          id: "9bb6162e-e85c-4e5d-a3ff-000000000001",
          sequence: 1,
          role: "user",
          text: "你好",
          createdAt: "2026-08-10T05:00:01.000Z",
        },
      ],
    });
    expect(parsed.messages[0]).toMatchObject({
      status: "completed",
      providerEventId: null,
    });
    expect(() =>
      appendConversationMessagesRequestSchema.parse({
        writer,
        messages: [
          {
            ...parsed.messages[0],
            userId: "4d1c2e31-ad0e-4fa9-9ae8-ae3497069116",
          },
        ],
      }),
    ).toThrow();
  });

  it("requires exactly one valid conversation id for realtime continuity", () => {
    expect(
      conversationRealtimeQuerySchema.parse({
        ...writer,
        conversationId: "9172f06d-c71a-47b3-94fe-35e1204b5b55",
      }),
    ).toEqual({
      ...writer,
      conversationId: "9172f06d-c71a-47b3-94fe-35e1204b5b55",
    });
    expect(() => conversationRealtimeQuerySchema.parse({})).toThrow();
    expect(() =>
      conversationRealtimeQuerySchema.parse({
        ...writer,
        conversationId: "not-a-uuid",
        userId: "forged-user",
      }),
    ).toThrow();
  });
  it("rejects legacy writes and handshakes without a fenced writer", () => {
    expect(
      conversationRealtimeQuerySchema.safeParse({
        conversationId: "9172f06d-c71a-47b3-94fe-35e1204b5b55",
      }).success,
    ).toBe(false);
    expect(
      completeConversationRequestSchema.safeParse({ lastSequence: 0 }).success,
    ).toBe(false);
    expect(
      completeConversationRequestSchema.safeParse({
        writer,
        requestId: "1580d5cb-ef45-491e-af4d-8f9a9c0b8403",
        lastSequence: 0,
      }).success,
    ).toBe(true);
    const messages = [
      {
        id: "9bb6162e-e85c-4e5d-a3ff-000000000001",
        sequence: 1,
        role: "user",
        text: "你好",
        createdAt: "2026-08-10T05:00:01.000Z",
      },
    ];
    expect(
      appendConversationMessagesRequestSchema.safeParse({ messages }).success,
    ).toBe(false);
    expect(
      appendConversationMessagesRequestSchema.safeParse({
        writer: { ...writer, epoch: 0 },
        messages,
      }).success,
    ).toBe(false);
    expect(
      appendConversationMessagesRequestSchema.safeParse({
        writer: { ...writer, userId: "forged" },
        messages,
      }).success,
    ).toBe(false);
  });
});
