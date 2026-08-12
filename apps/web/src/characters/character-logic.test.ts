import type {
  CharacterPermissions,
  CharacterRuntimeResponse,
  ProviderProfile,
  UserAccount,
  VoiceProfile,
} from "@meet/protocol";
import { describe, expect, it } from "vitest";

import {
  buildCreateCharacterRequest,
  createEmptyCharacterForm,
  getCharacterActionVisibility,
  mapRuntimeToLaunchOptions,
} from "./character-logic.js";

const provider: ProviderProfile = {
  id: "00000000-0000-4000-8000-000000000002",
  provider: "qwen",
  model: "qwen-audio-3.0-realtime-plus",
  displayName: "千问实时语音",
  capabilities: { audioInput: true, textInput: true, imageInput: false },
};

const voice: VoiceProfile = {
  id: "00000000-0000-4000-8000-000000000003",
  providerProfileId: provider.id,
  type: "preset",
  providerVoiceId: "longanqian",
  displayName: "龙安浅",
  style: {},
};

const baseUser = {
  id: "00000000-0000-4000-8000-000000000004",
  username: "member",
  displayName: "家庭成员",
  status: "active",
  guardianHistoryAccess: null,
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
} as const;

const allPermissions: CharacterPermissions = {
  canEdit: true,
  canDelete: true,
  canCopy: true,
  canShare: true,
  canRestore: true,
};

describe("getCharacterActionVisibility", () => {
  it("儿童始终隐藏创建和全部角色写入口", () => {
    const child: UserAccount = { ...baseUser, accountType: "child" };
    expect(getCharacterActionVisibility(child, allPermissions)).toEqual({
      canCreate: false,
      canEdit: false,
      canDelete: false,
      canCopy: false,
      canShare: false,
      canRestore: false,
    });
  });

  it("成人与管理员不自行推导所有权，只照服务端 permissions 显示", () => {
    const actor: UserAccount = { ...baseUser, accountType: "admin" };
    const permissions = { ...allPermissions, canEdit: false, canDelete: false };
    expect(getCharacterActionVisibility(actor, permissions)).toMatchObject({
      canCreate: true,
      canEdit: false,
      canDelete: false,
      canCopy: true,
    });
  });
});

describe("character form mapping", () => {
  it("完整 Prompt 模式只需维护一段人设文本", () => {
    const form = createEmptyCharacterForm([provider], [voice]);
    form.name = "远山";
    form.personaMode = "custom_prompt";
    form.customPrompt = "  你是远山，一位熟悉徒步路线的向导。  ";

    const result = buildCreateCharacterRequest(form);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.persona).toMatchObject({
      definitionMode: "custom_prompt",
      customPrompt: "你是远山，一位熟悉徒步路线的向导。",
    });
  });

  it("完整 Prompt 模式要求填写 Prompt 文本", () => {
    const form = createEmptyCharacterForm([provider], [voice]);
    form.name = "远山";
    form.personaMode = "custom_prompt";
    expect(buildCreateCharacterRequest(form)).toEqual({
      ok: false,
      message: "请输入完整的角色 Prompt。",
    });
  });

  it("只填角色名称也可以创建，其他人设字段保持留空", () => {
    const form = createEmptyCharacterForm([provider], [voice]);
    form.name = "  小麦  ";

    const result = buildCreateCharacterRequest(form);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      name: "小麦",
      description: "",
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
    });
  });

  it("仍然要求角色名称", () => {
    const form = createEmptyCharacterForm([provider], [voice]);
    expect(buildCreateCharacterRequest(form)).toEqual({
      ok: false,
      message: "请输入角色名称。",
    });
  });

  it("新建表单不继承之前内容，并只产生服务端允许的字段", () => {
    const first = createEmptyCharacterForm([provider], [voice]);
    first.name = "不会保留";
    const form = createEmptyCharacterForm([provider], [voice]);
    expect(form.name).toBe("");

    Object.assign(form, {
      name: "  晨光伙伴  ",
      description: "  温暖的聊天伙伴  ",
      background: "  住在海边的小屋  ",
      personalityTraits: " 温柔 \n\n 好奇 ",
      relationship: " 可信赖的朋友 ",
      speakingStyle: " 简短自然 ",
      emotionalStyle: " 温暖平静 ",
      conversationGoals: " 倾听 \n 鼓励表达 ",
      sampleLines: " 今天过得怎么样？ ",
      openingLine: "  我在这里。  ",
    });

    const result = buildCreateCharacterRequest(form);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      name: "晨光伙伴",
      persona: {
        personalityTraits: ["温柔", "好奇"],
        conversationGoals: ["倾听", "鼓励表达"],
      },
      openingLine: "我在这里。",
    });
    expect(result.value).not.toHaveProperty("visibility");
    expect(result.value).not.toHaveProperty("ownerId");
    expect(result.value.persona).not.toHaveProperty("advancedInstructions");
  });
});

describe("mapRuntimeToLaunchOptions", () => {
  const runtime = {
    character: {
      id: "00000000-0000-4000-8000-000000000001",
      systemKey: null,
      systemVersion: null,
      visibility: "family",
      name: "晨光伙伴",
      description: "温暖的聊天伙伴",
      revision: 1,
      visualProfile: {
        avatarUrl: "/avatars/zhixia.svg",
        accentColor: "#936E83",
        background: "sunset",
        animationStyle: "subtle",
      },
      voiceProfile: voice,
      permissions: allPermissions,
      updatedAt: "2026-08-09T00:00:00.000Z",
    },
    realtime: {
      provider: "qwen",
      model: "qwen-audio-3.0-realtime-plus",
      voice: "longanqian",
      instructions: "保持温暖自然。",
      firstSpeaker: "assistant",
    },
  } satisfies CharacterRuntimeResponse;

  it("只映射角色 ID 与会话运行时值，不形成可编辑模型参数", () => {
    expect(mapRuntimeToLaunchOptions(runtime)).toEqual({
      ok: true,
      model: "qwen-audio-3.0-realtime-plus",
      value: {
        characterId: runtime.character.id,
        voice: "longanqian",
        instructions: "保持温暖自然。",
        assistantStarts: true,
      },
    });
  });

  it("把尚未实现的供应商转换为可展示错误，不在渲染时抛异常", () => {
    const unsupported = {
      ...runtime,
      realtime: { ...runtime.realtime, provider: "doubao" as const },
    };
    expect(mapRuntimeToLaunchOptions(unsupported)).toEqual({
      ok: false,
      message: "当前浏览器暂不支持这个角色的实时模型。",
    });
  });
});
