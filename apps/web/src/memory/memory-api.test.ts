import { afterEach, describe, expect, it, vi } from "vitest";

import { listMemories, reviewMemory } from "./memory-api.js";

const memory = {
  id: "2fd4cbb6-fce4-40e2-9141-22f3a1bc2051",
  userId: "4d1c2e31-ad0e-4fa9-9ae8-ae3497069117",
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
  sourceConversationId: "9172f06d-c71a-47b3-94fe-35e1204b5b55",
  sourceExcerpt: "我一直很喜欢围棋",
  content: "用户喜欢围棋",
  confidence: 0.95,
  status: "active",
  createdAt: "2026-08-10T05:20:00.000Z",
  updatedAt: "2026-08-10T05:20:00.000Z",
  reviewedAt: null,
};

afterEach(() => vi.unstubAllGlobals());

describe("memory API client", () => {
  it("按角色和来源会话在服务端筛选，避免先截断全部记忆再本地查找", async () => {
    const fetchMock = vi.fn(async () => Response.json({ memories: [memory] }));
    vi.stubGlobal("fetch", fetchMock);
    await listMemories(undefined, {
      characterId: memory.character.id,
      sourceConversationId: memory.sourceConversationId,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/memories?characterId=${memory.character.id}&sourceConversationId=${memory.sourceConversationId}`,
      expect.any(Object),
    );
  });
  it("validates the private memory list response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ memories: [memory] })),
    );
    await expect(listMemories()).resolves.toEqual([memory]);
  });

  it("sends explicit review actions", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      expect(init).toMatchObject({ method: "PATCH", credentials: "include" });
      expect(JSON.parse(String(init?.body))).toEqual({ action: "accept" });
      return Response.json({ memory });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      reviewMemory(memory.id, { action: "accept" }),
    ).resolves.toEqual(memory);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/memories/${memory.id}`,
      expect.any(Object),
    );
  });
});
