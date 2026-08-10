import type {
  ConversationAggregate,
  DatabaseTransaction,
} from "@meet/database";
import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";

import {
  CONVERSATION_FINALIZE_QUEUE,
  MEMORY_EXTRACT_QUEUE,
} from "./schemas.js";
import { ConversationCompletionJobPublisher } from "./client.js";

describe("conversation completion job publisher", () => {
  it("enqueues summary and memory extraction for a normal conversation", async () => {
    const boss = fakeBoss();
    const publisher = new ConversationCompletionJobPublisher(boss.value);
    await publisher.enqueue(transaction(), aggregate("normal"));

    expect(boss.send).toHaveBeenCalledTimes(2);
    expect(boss.send).toHaveBeenNthCalledWith(
      1,
      CONVERSATION_FINALIZE_QUEUE,
      expect.objectContaining({
        conversationId: "9172f06d-c71a-47b3-94fe-35e1204b5b55",
        completedSequence: 12,
      }),
      expect.objectContaining({ db: expect.any(Object) }),
    );
    expect(boss.send).toHaveBeenNthCalledWith(
      2,
      MEMORY_EXTRACT_QUEUE,
      expect.any(Object),
      expect.objectContaining({ db: expect.any(Object) }),
    );
  });

  it("does not enqueue long-term memory extraction for a temporary call", async () => {
    const boss = fakeBoss();
    const publisher = new ConversationCompletionJobPublisher(boss.value);
    await publisher.enqueue(transaction(), aggregate("temporary"));

    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(boss.send).toHaveBeenCalledWith(
      CONVERSATION_FINALIZE_QUEUE,
      expect.any(Object),
      expect.any(Object),
    );
  });
});

function fakeBoss() {
  const send = vi.fn(async () => "2fd4cbb6-fce4-40e2-9141-22f3a1bc2051");
  return { send, value: { send } as unknown as PgBoss };
}

function transaction(): DatabaseTransaction {
  return {} as DatabaseTransaction;
}

function aggregate(mode: "normal" | "temporary"): ConversationAggregate {
  const now = new Date("2026-08-10T05:20:00.000Z");
  return {
    conversation: {
      id: "9172f06d-c71a-47b3-94fe-35e1204b5b55",
      userId: "4d1c2e31-ad0e-4fa9-9ae8-ae3497069117",
      characterId: "c437c71e-f209-4f7d-8f98-1c1e239d4201",
      mode,
      status: "completed",
      provider: "qwen",
      model: "qwen-audio-3.0-realtime-plus",
      voice: "longanqian",
      messageCount: 12,
      lastSequence: 12,
      startedAt: new Date("2026-08-10T05:00:00.000Z"),
      endedAt: now,
      updatedAt: now,
    },
    character: {
      id: "c437c71e-f209-4f7d-8f98-1c1e239d4201",
      name: "知夏",
      visualProfile: {
        avatarUrl: "/avatars/zhixia.svg",
        accentColor: "#9a5d73",
        background: "sunset",
        animationStyle: "subtle",
      },
    },
  };
}
