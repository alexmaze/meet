import type {
  ConversationAggregate,
  DatabaseTransaction,
} from "@meet/database";
import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";

import {
  CONVERSATION_CHECKPOINT_QUEUE,
  CONVERSATION_FINALIZE_QUEUE,
  MEDIA_EXPIRE_QUEUE,
  MEMORY_EXTRACT_QUEUE,
} from "./schemas.js";
import {
  ConversationCompletionJobPublisher,
  MediaCleanupJobPublisher,
  sendCheckpointJob,
  shouldCreateConversationCheckpoint,
} from "./client.js";

describe("conversation checkpoint policy", () => {
  it("triggers on either the message or transcript character interval", () => {
    expect(shouldCreateConversationCheckpoint(19, 11_999)).toBe(false);
    expect(shouldCreateConversationCheckpoint(20, 100)).toBe(true);
    expect(shouldCreateConversationCheckpoint(2, 12_000)).toBe(true);
  });

  it("publishes a checkpoint with its persistent business identity", async () => {
    const boss = fakeBoss();
    await sendCheckpointJob(
      boss.value,
      transaction(),
      {
        id: "2fd4cbb6-fce4-40e2-9141-22f3a1bc2051",
        conversationId: "9172f06d-c71a-47b3-94fe-35e1204b5b55",
        sourceLastSequence: 20,
        sourceMessageCount: 20,
        status: "queued",
        modelProfileId: "f9784de7-4c21-4c73-9507-54c3aa4d0281",
        content: null,
        analyzerModel: null,
        lastErrorCode: null,
        queuedAt: new Date("2026-08-10T05:10:00.000Z"),
        completedAt: null,
        createdAt: new Date("2026-08-10T05:10:00.000Z"),
        updatedAt: new Date("2026-08-10T05:10:00.000Z"),
      },
      "4d1c2e31-ad0e-4fa9-9ae8-ae3497069117",
    );

    expect(boss.send).toHaveBeenCalledWith(
      CONVERSATION_CHECKPOINT_QUEUE,
      expect.objectContaining({
        checkpointId: "2fd4cbb6-fce4-40e2-9141-22f3a1bc2051",
        targetSequence: 20,
      }),
      expect.objectContaining({ db: expect.any(Object) }),
    );
  });
});

describe("conversation completion job publisher", () => {
  it("enqueues summary and memory extraction for a normal conversation", async () => {
    const boss = fakeBoss();
    const publisher = new ConversationCompletionJobPublisher(
      boss.value,
      preparedWork,
    );
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
    const publisher = new ConversationCompletionJobPublisher(
      boss.value,
      preparedWork,
    );
    await publisher.enqueue(transaction(), aggregate("temporary"));

    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(boss.send).toHaveBeenCalledWith(
      CONVERSATION_FINALIZE_QUEUE,
      expect.any(Object),
      expect.any(Object),
    );
  });
});

describe("media cleanup job publisher", () => {
  it("schedules expiration at the metadata deadline in the same transaction", async () => {
    const boss = fakeBoss();
    const publisher = new MediaCleanupJobPublisher(boss.value);
    const expiresAt = new Date("2026-08-11T00:00:00.000Z");
    await publisher.enqueue(transaction(), {
      mediaId: "2fd4cbb6-fce4-40e2-9141-22f3a1bc2051",
      objectKey: "2026/08/2fd4cbb6-fce4-40e2-9141-22f3a1bc2051",
      reason: "expired",
      notBefore: expiresAt,
      expectedExpiresAt: expiresAt,
    });

    expect(boss.send).toHaveBeenCalledWith(
      MEDIA_EXPIRE_QUEUE,
      expect.objectContaining({
        reason: "expired",
        expectedExpiresAt: expiresAt.toISOString(),
      }),
      expect.objectContaining({
        db: expect.any(Object),
        startAfter: expiresAt,
      }),
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

async function preparedWork(
  _transaction: DatabaseTransaction,
  _aggregate: ConversationAggregate,
  purpose: "conversation_summary" | "memory_extraction",
) {
  return {
    id:
      purpose === "conversation_summary"
        ? "2fd4cbb6-fce4-40e2-9141-22f3a1bc2051"
        : "2fd4cbb6-fce4-40e2-9141-22f3a1bc2052",
    modelProfileId: "f9784de7-4c21-4c73-9507-54c3aa4d0281",
  };
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
