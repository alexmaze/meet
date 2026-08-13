import {
  createCharacterRequestSchema,
  doubaoRealtimeModelSchema,
  qwenRealtimeModelSchema,
  type Character,
  type CharacterPermissions,
  type CharacterRuntimeResponse,
  type CreateCharacterRequest,
  type PersonaDefinitionMode,
  type RealtimeModelProfile,
  type RealtimeProviderKind,
  type UserAccount,
  type VisualProfile,
  type VoiceProfile,
} from "@meet/protocol";

import { CharacterApiError } from "./character-api.js";

export type CharacterActionVisibility = CharacterPermissions & {
  canCreate: boolean;
};

export type CharacterFormValue = {
  name: string;
  description: string;
  personaMode: PersonaDefinitionMode;
  customPrompt: string;
  background: string;
  personalityTraits: string;
  relationship: string;
  speakingStyle: string;
  emotionalStyle: string;
  conversationGoals: string;
  sampleLines: string;
  advancedInstructions: string;
  openingLine: string;
  firstSpeaker: "assistant" | "user";
  responseStyle: "concise" | "adaptive" | "detailed";
  silenceFollowUpEnabled: boolean;
  providerProfileId: string;
  voiceProfileId: string;
  avatarUrl: string;
  accentColor: string;
  visualBackground: VisualProfile["background"];
};

export type RealtimeLaunchOptions = {
  characterId: string;
  voice: string;
  instructions: string;
  assistantStarts: boolean;
  openingText?: string;
};

export type RuntimeLaunchMapping =
  | {
      ok: true;
      value: RealtimeLaunchOptions;
      provider: Extract<RealtimeProviderKind, "qwen" | "doubao">;
      model: string;
    }
  | { ok: false; message: string };

export const builtInAvatarChoices = [
  {
    value: "/avatars/star-shield-captain.svg",
    label: "星盾蓝",
    accentColor: "#2F6F78",
    background: "aurora" as const,
  },
  {
    value: "/avatars/teacher-lin.svg",
    label: "书卷绿",
    accentColor: "#657E71",
    background: "classroom" as const,
  },
  {
    value: "/avatars/zhixia.svg",
    label: "暮色紫",
    accentColor: "#936E83",
    background: "sunset" as const,
  },
] as const;

export function getCharacterActionVisibility(
  user: UserAccount,
  permissions: CharacterPermissions,
): CharacterActionVisibility {
  if (user.accountType === "child") {
    return {
      canCreate: false,
      canEdit: false,
      canDelete: false,
      canCopy: false,
      canShare: false,
      canRestore: false,
    };
  }

  return { canCreate: true, ...permissions };
}

export function canCreateCharacter(user: UserAccount): boolean {
  return user.accountType !== "child";
}

export function createEmptyCharacterForm(
  providers: RealtimeModelProfile[],
  voices: VoiceProfile[],
  realtimeDefaultModelProfileId: string | null = providers[0]?.id ?? null,
): CharacterFormValue {
  const provider = providers.find(
    (candidate) => candidate.id === realtimeDefaultModelProfileId,
  );
  const voice = voices.find(
    (candidate) => candidate.realtimeModelProfileId === provider?.id,
  );
  const avatar = builtInAvatarChoices[0];

  return {
    name: "",
    description: "",
    personaMode: "structured",
    customPrompt: "",
    background: "",
    personalityTraits: "",
    relationship: "",
    speakingStyle: "",
    emotionalStyle: "",
    conversationGoals: "",
    sampleLines: "",
    advancedInstructions: "",
    openingLine: "",
    firstSpeaker: "assistant",
    responseStyle: "adaptive",
    silenceFollowUpEnabled: true,
    providerProfileId: provider?.id ?? "",
    voiceProfileId: voice?.id ?? "",
    avatarUrl: avatar.value,
    accentColor: avatar.accentColor,
    visualBackground: avatar.background,
  };
}

export function characterToForm(character: Character): CharacterFormValue {
  return {
    name: character.name,
    description: character.description,
    personaMode: character.persona.definitionMode ?? "structured",
    customPrompt: character.persona.customPrompt ?? "",
    background: character.persona.background,
    personalityTraits: character.persona.personalityTraits.join("\n"),
    relationship: character.persona.relationship,
    speakingStyle: character.persona.speakingStyle,
    emotionalStyle: character.persona.emotionalStyle,
    conversationGoals: character.persona.conversationGoals.join("\n"),
    sampleLines: character.persona.sampleLines.join("\n"),
    advancedInstructions: character.persona.advancedInstructions ?? "",
    openingLine: character.openingLine ?? "",
    firstSpeaker: character.conversationPolicy.firstSpeaker,
    responseStyle: character.conversationPolicy.responseStyle,
    silenceFollowUpEnabled:
      character.conversationPolicy.silenceFollowUp.enabled,
    providerProfileId: character.realtimeModelProfile.id,
    voiceProfileId: character.voiceProfile.id,
    avatarUrl: character.visualProfile.avatarUrl,
    accentColor: character.visualProfile.accentColor,
    visualBackground: character.visualProfile.background,
  };
}

export function buildCreateCharacterRequest(
  form: CharacterFormValue,
):
  { ok: true; value: CreateCharacterRequest } | { ok: false; message: string } {
  const advancedInstructions = form.advancedInstructions.trim();
  const customPrompt = form.customPrompt.trim();
  const candidate = {
    name: form.name,
    description: form.description,
    persona: {
      definitionMode: form.personaMode,
      ...(customPrompt ? { customPrompt } : {}),
      background: form.background,
      personalityTraits: splitLines(form.personalityTraits),
      relationship: form.relationship,
      speakingStyle: form.speakingStyle,
      emotionalStyle: form.emotionalStyle,
      conversationGoals: splitLines(form.conversationGoals),
      sampleLines: splitLines(form.sampleLines),
      ...(advancedInstructions ? { advancedInstructions } : {}),
    },
    openingLine: form.openingLine.trim() || null,
    realtimeModelProfileId: form.providerProfileId,
    voiceProfileId: form.voiceProfileId,
    conversationPolicy: {
      firstSpeaker: form.firstSpeaker,
      responseStyle: form.responseStyle,
      silenceFollowUp: {
        enabled: form.silenceFollowUpEnabled,
        delayMs: 12_000,
        maxConsecutivePrompts: 1 as const,
      },
    },
    visualProfile: {
      avatarUrl: form.avatarUrl,
      accentColor: form.accentColor,
      background: form.visualBackground,
      animationStyle: "subtle" as const,
    },
  };

  const parsed = createCharacterRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, message: getCharacterFormError(form) };
  }
  return { ok: true, value: parsed.data };
}

export function mapRuntimeToLaunchOptions(
  runtime: CharacterRuntimeResponse,
): RuntimeLaunchMapping {
  const provider = runtime.realtime.provider;
  if (provider !== "qwen" && provider !== "doubao") {
    return { ok: false, message: "当前浏览器暂不支持这个角色的实时模型。" };
  }

  const model =
    provider === "qwen"
      ? qwenRealtimeModelSchema.safeParse(runtime.realtime.model)
      : doubaoRealtimeModelSchema.safeParse(runtime.realtime.model);
  if (!model.success) {
    return { ok: false, message: "这个角色的实时模型暂不可用。" };
  }

  return {
    ok: true,
    provider,
    model: model.data,
    value: {
      characterId: runtime.character.id,
      voice: runtime.realtime.voice,
      instructions: runtime.realtime.instructions,
      assistantStarts: runtime.realtime.firstSpeaker === "assistant",
      ...(runtime.realtime.openingLine
        ? { openingText: runtime.realtime.openingLine }
        : {}),
    },
  };
}

export type CharacterOperation =
  | "list"
  | "detail"
  | "save"
  | "copy"
  | "share"
  | "restore"
  | "delete"
  | "runtime";

export function presentCharacterError(
  error: unknown,
  operation: CharacterOperation,
): string {
  if (!(error instanceof CharacterApiError)) {
    return "网络连接失败，请稍后重试。";
  }

  if (error.status === 403) return "你没有执行这个操作的权限。";
  if (error.status === 404) return "这个角色不存在或你无法访问。";
  if (error.code === "CHARACTER_AVATAR_INVALID") {
    return "上传的角色形象已失效，请重新上传。";
  }
  if (error.code === "CHARACTER_AVATAR_UNAVAILABLE") {
    return "暂时无法保存上传的角色形象，请稍后重试。";
  }
  if (error.status === 409) {
    return operation === "save" || operation === "share"
      ? "角色已在其他页面更新，请重新打开后再修改。"
      : "角色状态已经变化，请刷新后重试。";
  }
  if (error.status === 503) return "角色服务暂时不可用，请稍后重试。";
  if (error.code === "INVALID_CHARACTER_RESPONSE") {
    return "角色服务返回的数据格式不正确。";
  }
  return operation === "list"
    ? "暂时无法读取角色，请稍后重试。"
    : "操作没有完成，请稍后重试。";
}

function splitLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function getCharacterFormError(form: CharacterFormValue): string {
  if (!form.name.trim()) return "请输入角色名称。";
  if (form.personaMode === "custom_prompt" && !form.customPrompt.trim())
    return "请输入完整的角色 Prompt。";
  if (!form.providerProfileId || !form.voiceProfileId)
    return "请选择实时模型和角色声音。";
  return "请检查角色卡中内容的长度和格式。";
}
