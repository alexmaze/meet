import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendConversationMessages,
  createConversation,
  listConversations,
  requestJson,
} from "./conversation-api.js";

const conversation = {
  id: "9172f06d-c71a-47b3-94fe-35e1204b5b55",
  userId: "4d1c2e31-ad0e-4fa9-9ae8-ae3497069117",
  character: {
    id: "c437c71e-f209-4f7d-8f98-1c1e239d4201",
    name: "林老师",
    visualProfile: {
      avatarUrl: "/avatars/teacher-lin.svg",
      accentColor: "#487a67",
      background: "classroom",
      animationStyle: "subtle",
    },
  },
  mode: "normal",
  status: "active",
  messageCount: 0,
  lastSequence: 0,
  provider: "qwen",
  model: "qwen-audio-3.0-realtime-plus",
  voice: "longanqian",
  startedAt: "2026-08-10T05:00:00.000Z",
  endedAt: null,
  updatedAt: "2026-08-10T05:00:00.000Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("conversation API client", () => {
  it("creates a temporary conversation with credentials", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          conversation: { ...conversation, mode: "temporary" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createConversation({
        id: conversation.id,
        characterId: conversation.character.id,
        mode: "temporary",
      }),
    ).resolves.toMatchObject({ mode: "temporary" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations",
      expect.objectContaining({
        credentials: "same-origin",
        method: "POST",
      }),
    );
  });

  it("sends stable message ids and reads the acknowledged sequence", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ acknowledgedSequence: 7 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const acknowledged = await appendConversationMessages(conversation.id, {
      writer: { clientId: "f819d072-2f86-4584-9701-04037a9c46c3", epoch: 3 },
      messages: [
        {
          id: "9bb6162e-e85c-4e5d-a3ff-000000000007",
          sequence: 7,
          role: "assistant",
          status: "interrupted",
          text: "我们先看第一步",
          providerEventId: "response-7",
          createdAt: "2026-08-10T05:00:07.000Z",
        },
      ],
    });
    expect(acknowledged).toBe(7);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      messages: [
        {
          sequence: 7,
          status: "interrupted",
          providerEventId: "response-7",
        },
      ],
    });
  });

  it("rejects malformed history responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ items: [] })),
    );
    await expect(listConversations()).rejects.toMatchObject({
      code: "INVALID_CONVERSATION_RESPONSE",
    });
  });
});

it("bounds a slow response body as well as the initial connection", async () => {
  vi.useFakeTimers();
  try {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => ({
        status: 200,
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      })),
    );
    const outcome = expect(
      requestJson("/api/conversations"),
    ).rejects.toMatchObject({ code: "CONVERSATION_REQUEST_FAILED" });
    await vi.advanceTimersByTimeAsync(12_000);
    await outcome;
  } finally {
    vi.useRealTimers();
  }
});
