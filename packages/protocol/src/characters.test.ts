import { describe, expect, it } from "vitest";

import {
  createCharacterRequestSchema,
  emptyCharacterActionRequestSchema,
  personaDefinitionSchema,
  updateCharacterRequestSchema,
  visualProfileSchema,
} from "./characters.js";

const validRequest = {
  name: "测试角色",
  description: "用于协议测试的角色。",
  persona: {
    background: "来自一座安静的小城。",
    personalityTraits: ["耐心", "真诚"],
    relationship: "是用户可靠的聊天伙伴。",
    speakingStyle: "自然、清楚。",
    emotionalStyle: "温暖但不过度煽情。",
    conversationGoals: ["认真倾听"],
    sampleLines: ["我们可以慢慢说。"],
  },
  openingLine: "你好，今天想聊什么？",
  realtimeModelProfileId: "31c9ad8e-0e8b-4e2d-8c14-318d36d617b1",
  voiceProfileId: "be8f77ec-a61e-4be0-8b70-8c7cb9e51103",
  conversationPolicy: {
    firstSpeaker: "assistant" as const,
    responseStyle: "concise" as const,
    silenceFollowUp: {
      enabled: true,
      delayMs: 12_000,
      maxConsecutivePrompts: 1 as const,
    },
  },
  visualProfile: {
    avatarUrl: "/avatars/zhixia.svg",
    accentColor: "#B45B72",
    background: "sunset" as const,
    animationStyle: "subtle" as const,
  },
};

describe("character protocol", () => {
  it("accepts a bounded, structured character card", () => {
    expect(createCharacterRequestSchema.parse(validRequest)).toEqual(
      validRequest,
    );
  });

  it("允许除角色名称外的人设文本留空", () => {
    expect(
      createCharacterRequestSchema.safeParse({
        ...validRequest,
        description: "   ",
        persona: {
          background: "",
          personalityTraits: [],
          relationship: "",
          speakingStyle: "",
          emotionalStyle: "",
          conversationGoals: [],
          sampleLines: [],
        },
        openingLine: null,
      }).success,
    ).toBe(true);
    expect(
      createCharacterRequestSchema.safeParse({
        ...validRequest,
        name: "   ",
      }).success,
    ).toBe(false);
  });

  it("支持完整 Prompt 模式并拒绝空 Prompt", () => {
    const customPromptRequest = {
      ...validRequest,
      persona: {
        ...validRequest.persona,
        definitionMode: "custom_prompt" as const,
        customPrompt: "你是一位沉稳的旅行向导。回答时先询问用户的偏好。",
      },
    };
    expect(
      createCharacterRequestSchema.safeParse(customPromptRequest).success,
    ).toBe(true);
    expect(
      createCharacterRequestSchema.safeParse({
        ...customPromptRequest,
        persona: { ...customPromptRequest.persona, customPrompt: "   " },
      }).success,
    ).toBe(false);
  });

  it("strictly rejects server-owned and provider-secret fields", () => {
    for (const forbidden of [
      { ownerUserId: crypto.randomUUID() },
      { visibility: "family" },
      { systemKey: "builtin.forged" },
      { systemVersion: 99 },
      { accountType: "admin" },
      { providerSecret: "never-accept-this" },
    ]) {
      expect(
        createCharacterRequestSchema.safeParse({
          ...validRequest,
          ...forbidden,
        }).success,
      ).toBe(false);
    }
  });

  it("only accepts built-in or authenticated uploaded avatar paths and safe themes", () => {
    expect(
      visualProfileSchema.safeParse({
        ...validRequest.visualProfile,
        avatarUrl: "/api/media/2fd4cbb6-fce4-40e2-9141-22f3a1bc2051/content",
      }).success,
    ).toBe(true);
    expect(
      visualProfileSchema.safeParse({
        ...validRequest.visualProfile,
        avatarUrl: "https://tracker.example/avatar.svg",
      }).success,
    ).toBe(false);
    expect(
      visualProfileSchema.safeParse({
        ...validRequest.visualProfile,
        avatarUrl: "/api/private/avatar.svg",
      }).success,
    ).toBe(false);
    for (const avatarUrl of [
      "/../x.svg",
      "/avatars/../x.svg",
      "/avatars/x.svg?tracking=1",
    ]) {
      expect(
        visualProfileSchema.safeParse({
          ...validRequest.visualProfile,
          avatarUrl,
        }).success,
      ).toBe(false);
    }
    expect(
      visualProfileSchema.safeParse({
        ...validRequest.visualProfile,
        accentColor: "url(javascript:alert(1))",
      }).success,
    ).toBe(false);
  });

  it("enforces the aggregate persona budget", () => {
    expect(
      personaDefinitionSchema.safeParse({
        ...validRequest.persona,
        background: "背".repeat(4_000),
        relationship: "关".repeat(1_000),
        speakingStyle: "说".repeat(1_000),
        emotionalStyle: "情".repeat(1_000),
        conversationGoals: Array.from({ length: 8 }, () => "目".repeat(500)),
      }).success,
    ).toBe(false);
  });

  it("requires an optimistic revision and at least one editable field", () => {
    expect(
      updateCharacterRequestSchema.safeParse({ revision: 1 }).success,
    ).toBe(false);
    expect(
      updateCharacterRequestSchema.safeParse({
        revision: 1,
        name: "新名称",
      }).success,
    ).toBe(true);
    expect(
      updateCharacterRequestSchema.safeParse({
        revision: 1,
        name: "新名称",
        ownerUserId: crypto.randomUUID(),
      }).success,
    ).toBe(false);
  });

  it("requires a strict empty object for payload-free character actions", () => {
    expect(emptyCharacterActionRequestSchema.safeParse({}).success).toBe(true);
    for (const value of [
      undefined,
      null,
      "",
      "{}",
      { ownerUserId: crypto.randomUUID() },
      { revision: 1 },
    ]) {
      expect(emptyCharacterActionRequestSchema.safeParse(value).success).toBe(
        false,
      );
    }
  });
});
