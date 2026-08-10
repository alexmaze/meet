import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CharacterApiError,
  parseCharacter,
  parseCharacterList,
  parseCharacterRuntime,
  previewVoice,
} from "./character-api.js";

const ids = {
  character: "00000000-0000-4000-8000-000000000001",
  provider: "00000000-0000-4000-8000-000000000002",
  voice: "00000000-0000-4000-8000-000000000003",
};

const summary = {
  id: ids.character,
  systemKey: "star-shield-captain",
  systemVersion: 1,
  visibility: "builtin",
  name: "星盾队长",
  description: "陪孩子探索勇气与责任的原创英雄。",
  revision: 1,
  visualProfile: {
    avatarUrl: "/avatars/star-shield-captain.svg",
    accentColor: "#2F6F78",
    background: "aurora",
    animationStyle: "subtle",
  },
  voiceProfile: {
    id: ids.voice,
    providerProfileId: ids.provider,
    type: "preset",
    providerVoiceId: "longanqian",
    displayName: "龙安浅",
    style: { energy: "high", warmth: "medium" },
  },
  permissions: {
    canEdit: false,
    canDelete: false,
    canCopy: true,
    canShare: false,
    canRestore: true,
  },
  updatedAt: "2026-08-09T00:00:00.000Z",
};

const detail = {
  ...summary,
  persona: {
    background: "来自星海的守护者。",
    personalityTraits: ["勇敢", "耐心"],
    relationship: "可靠的成长伙伴",
    speakingStyle: "自然、简短",
    emotionalStyle: "温暖坚定",
    conversationGoals: ["鼓励表达"],
    sampleLines: ["我们一起想办法。"],
  },
  openingLine: "今天想探索什么？",
  conversationPolicy: {
    firstSpeaker: "assistant",
    responseStyle: "concise",
    silenceFollowUp: {
      enabled: true,
      delayMs: 12_000,
      maxConsecutivePrompts: 1,
    },
  },
  providerProfile: {
    id: ids.provider,
    provider: "qwen",
    model: "qwen-audio-3.0-realtime-plus",
    displayName: "千问实时语音",
    capabilities: { audioInput: true, textInput: true, imageInput: false },
  },
  createdAt: "2026-08-09T00:00:00.000Z",
};

describe("character API parsers", () => {
  it("严格解析角色列表 envelope 与嵌套 DTO", () => {
    expect(parseCharacterList({ characters: [summary] })).toHaveLength(1);
    expect(() =>
      parseCharacterList({
        characters: [{ ...summary, leakedOwnerId: ids.provider }],
      }),
    ).toThrow(CharacterApiError);
    expect(() =>
      parseCharacterList({ characters: [summary], unexpected: true }),
    ).toThrow(CharacterApiError);
  });

  it("严格解析角色详情，不接受自由 URL 或多余字段", () => {
    expect(parseCharacter({ character: detail }).name).toBe("星盾队长");
    expect(() =>
      parseCharacter({
        character: {
          ...detail,
          visualProfile: {
            ...detail.visualProfile,
            avatarUrl: "https://untrusted.example/avatar.png",
          },
        },
      }),
    ).toThrow(CharacterApiError);
  });

  it("严格解析角色运行时且不接受服务端多余参数", () => {
    const runtime = {
      character: summary,
      realtime: {
        provider: "qwen",
        model: "qwen-audio-3.0-realtime-plus",
        voice: "longanqian",
        instructions: "保持角色设定并自然对话。",
        firstSpeaker: "assistant",
      },
    };
    expect(parseCharacterRuntime(runtime).realtime.voice).toBe("longanqian");
    expect(() =>
      parseCharacterRuntime({
        ...runtime,
        realtime: { ...runtime.realtime, apiKey: "should-not-exist" },
      }),
    ).toThrow(CharacterApiError);
  });
});

describe("previewVoice", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests an authenticated no-store WAV preview", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([82, 73, 70, 70]), {
          status: 200,
          headers: { "Content-Type": "audio/wav" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const blob = await previewVoice("be8f77ec-a61e-4be0-8b70-8c7cb9e51105");
    expect(blob.type).toBe("audio/wav");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/characters/voices/be8f77ec-a61e-4be0-8b70-8c7cb9e51105/preview",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      }),
    );
  });

  it("rejects a successful response that is not WAV", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("not audio", {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          }),
      ),
    );

    await expect(
      previewVoice("be8f77ec-a61e-4be0-8b70-8c7cb9e51105"),
    ).rejects.toMatchObject({
      code: "INVALID_VOICE_PREVIEW_RESPONSE",
    });
  });
});
