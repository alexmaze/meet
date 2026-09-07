import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationContinuityStatus } from "@meet/protocol";
import {
  confirmConversationFinish,
  finishSavedConversation,
  getConversationClientId,
  savePendingEndOperation,
} from "./continuity-api.js";

const conversationId = "9172f06d-c71a-47b3-94fe-35e1204b5b55";
const userId = "4d1c2e31-ad0e-4fa9-9ae8-ae3497069117";
const requestId = "f819d072-2f86-4584-9701-04037a9c46c3";
const writer = { clientId: getConversationClientId(), epoch: 2 };
function status(completed = false): ConversationContinuityStatus {
  return {
    conversation: {
      id: conversationId,
      userId,
      character: {
        id: "c437c71e-f209-4f7d-8f98-1c1e239d4201",
        name: "知夏",
        visualProfile: {
          avatarUrl: "/avatars/zhixia.svg",
          accentColor: "#987679",
          background: "sunset",
          animationStyle: "subtle",
        },
      },
      mode: "normal",
      status: completed ? "completed" : "active",
      messageCount: 7,
      lastSequence: 7,
      provider: "qwen",
      model: "qwen-audio-3.0-realtime-plus",
      voice: "longanqian",
      startedAt: "2026-09-08T04:00:00.000Z",
      endedAt: completed ? "2026-09-08T04:05:00.000Z" : null,
      updatedAt: "2026-09-08T04:05:00.000Z",
    },
    connectionState: completed ? "completed" : "interrupted",
    writerClientId: writer.clientId,
    writerEpoch: 2,
    leaseExpiresAt: null,
    lastActivityAt: "2026-09-08T04:05:00.000Z",
    lastSavedAt: "2026-09-08T04:05:00.000Z",
    connectedDurationMs: 240_000,
    finalizedAt: null,
    hasConnected: true,
    endRequestId: requestId,
    endTargetSequence: 7,
    isOwner: true,
    canResume: !completed,
    canFinish: !completed,
    unavailableReason: completed ? "completed" : null,
    summary: { state: "not_configured", content: null },
    memory: { state: "processing", activeCount: 0, suggestedCount: 0 },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("confirmed call finish", () => {
  it("queries a lost response using the original request id and never posts a second completion", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(Response.json(status(true)));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      confirmConversationFinish(conversationId, {
        writer,
        requestId,
        lastSequence: 7,
        discardMissing: false,
      }),
    ).resolves.toMatchObject({
      conversation: { status: "completed" },
      memory: { state: "processing" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toContain(`requestId=${requestId}`);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1].body))).toMatchObject(
      { writer, requestId, lastSequence: 7 },
    );
  });
  it("does not claim completion when a status query says it remains active", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce(Response.json(status())),
    );
    await expect(
      confirmConversationFinish(conversationId, {
        writer,
        requestId,
        lastSequence: 7,
        discardMissing: false,
      }),
    ).rejects.toMatchObject({ code: "CONVERSATION_REQUEST_FAILED" });
  });
  it("resolves an already completed operation before requesting a fresh writer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(status(true)));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      finishSavedConversation(status(), userId),
    ).resolves.toMatchObject({ conversation: { status: "completed" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/status?");
  });
  it("requires explicit permission before dropping text lost by a closed page", async () => {
    const data = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => data.set(key, value),
        removeItem: (key: string) => data.delete(key),
      },
    });
    savePendingEndOperation(userId, {
      conversationId,
      requestId,
      lastSequence: 9,
    });
    const fetchMock = vi.fn().mockResolvedValue(Response.json(status()));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      finishSavedConversation(status(), userId),
    ).rejects.toMatchObject({ code: "CONVERSATION_MESSAGES_MISSING" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("does not take over another live writer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(status()))
      .mockResolvedValueOnce(
        Response.json(
          { code: "CONVERSATION_IN_USE", message: "正在另一台设备通话" },
          { status: 409 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      finishSavedConversation(status(), userId),
    ).rejects.toMatchObject({ code: "CONVERSATION_IN_USE" });
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith("/complete")),
    ).toBe(false);
  });
});
