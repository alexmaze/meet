import type {
  Character,
  CharacterPermissions,
  CharacterRuntimeResponse,
  CharacterSummary,
  CreateCharacterRequest,
  RealtimeModelProfile,
  UpdateCharacterRequest,
  UserAccount,
  VoiceProfile,
} from "@meet/protocol";
import {
  characterSchema,
  characterSummarySchema,
  providerProfileSchema,
  voiceProfileSchema,
} from "@meet/protocol";
import type {
  CharacterAggregate,
  ProviderProfileRecord,
  VoiceProfileRecord,
} from "@meet/database";
import type { ZodType } from "zod";

import { MediaServiceError, type MediaService } from "../media/service.js";
import type { CharacterRepository } from "./repository.js";

export type CharacterServiceErrorCode =
  | "CHARACTER_WRITE_FORBIDDEN"
  | "CHARACTER_RESTORE_FORBIDDEN"
  | "CHARACTER_VISIBILITY_FORBIDDEN"
  | "CHARACTER_NOT_FOUND"
  | "CHARACTER_PROFILE_INVALID"
  | "CHARACTER_REVISION_CONFLICT"
  | "BUILTIN_CHARACTER_PROTECTED"
  | "CHARACTER_NOT_BUILTIN"
  | "CHARACTER_AVATAR_INVALID"
  | "CHARACTER_AVATAR_UNAVAILABLE"
  | "CHARACTER_REALTIME_UNAVAILABLE"
  | "CHARACTER_SERVICE_UNAVAILABLE";

export class CharacterServiceError extends Error {
  constructor(
    readonly code: CharacterServiceErrorCode,
    message: string,
    readonly statusCode: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CharacterServiceError";
  }
}

export class CharacterService {
  constructor(
    private readonly repository: CharacterRepository | null,
    private readonly media: Pick<
      MediaService,
      "retainCharacterAvatar"
    > | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  assertWriter(actor: UserAccount): void {
    if (actor.accountType === "child") {
      throw new CharacterServiceError(
        "CHARACTER_WRITE_FORBIDDEN",
        "儿童账号不能创建、编辑、复制、分享或删除角色。",
        403,
      );
    }
  }

  assertVisibilityWriter(actor: UserAccount): void {
    if (actor.accountType !== "adult") {
      throw new CharacterServiceError(
        "CHARACTER_VISIBILITY_FORBIDDEN",
        "只有成人账号可以分享或取消分享自己创建的角色。",
        403,
      );
    }
  }

  assertRestorer(actor: UserAccount): void {
    if (actor.accountType !== "admin") {
      throw new CharacterServiceError(
        "CHARACTER_RESTORE_FORBIDDEN",
        "只有管理员可以恢复预置角色。",
        403,
      );
    }
  }

  async list(actor: UserAccount): Promise<CharacterSummary[]> {
    const characters = await this.callRepository((repository) =>
      repository.listVisible(actor.id),
    );
    return characters.map((character) => toSummary(character, actor));
  }

  async favorites(actor: UserAccount): Promise<string[]> {
    return this.callRepository((repository) =>
      repository.listFavoriteIds(actor.id),
    );
  }

  async setFavorite(
    actor: UserAccount,
    characterId: string,
    favorite: boolean,
  ) {
    const visible = await this.callRepository((repository) =>
      repository.setFavorite(actor.id, characterId, favorite, this.now()),
    );
    if (!visible) throw notFound();
    return { characterId, favorite };
  }

  async find(actor: UserAccount, characterId: string): Promise<Character> {
    const character = await this.findAggregate(actor, characterId);
    return toCharacter(character, actor);
  }

  async assertVisible(actor: UserAccount, characterId: string): Promise<void> {
    await this.findAggregate(actor, characterId);
  }

  async catalog(): Promise<{
    realtimeModels: RealtimeModelProfile[];
    voices: VoiceProfile[];
    realtimeDefaultModelProfileId: string | null;
  }> {
    const catalog = await this.callRepository((repository) =>
      repository.listCatalog(),
    );
    return {
      realtimeModels: catalog.providers.map(toRealtimeModelProfile),
      voices: catalog.voices.map(toVoiceProfile),
      realtimeDefaultModelProfileId: catalog.realtimeDefaultProfileId ?? null,
    };
  }

  async voicePreviewRuntime(
    actor: UserAccount,
    voiceProfileId: string,
  ): Promise<{
    realtimeModelProfileId: string;
    provider: RealtimeModelProfile["provider"];
    model: string;
    voice: string;
  }> {
    this.assertWriter(actor);
    const catalog = await this.callRepository((repository) =>
      repository.listCatalog(),
    );
    const voice = catalog.voices.find(
      (candidate) => candidate.id === voiceProfileId,
    );
    const provider = voice
      ? catalog.providers.find(
          (candidate) => candidate.id === voice.providerProfileId,
        )
      : null;
    if (!voice || !provider) throw invalidProfile();
    return {
      realtimeModelProfileId: provider.id,
      provider: provider.provider,
      model: provider.model,
      voice: voice.providerVoiceId,
    };
  }

  async create(
    actor: UserAccount,
    input: CreateCharacterRequest,
  ): Promise<Character> {
    this.assertWriter(actor);
    await this.retainCharacterAvatar(actor, input.visualProfile.avatarUrl);
    const result = await this.callRepository((repository) =>
      repository.create(
        actor.id,
        {
          ...input,
          providerProfileId: input.realtimeModelProfileId,
        },
        this.now(),
      ),
    );
    if (result.kind === "forbidden") throw writeForbidden();
    if (result.kind === "invalid_profile") throw invalidProfile();
    if (result.kind !== "created") throw unavailable();
    return toCharacter(result.character, actor);
  }

  async update(
    actor: UserAccount,
    characterId: string,
    input: UpdateCharacterRequest,
  ): Promise<Character> {
    this.assertWriter(actor);
    const { revision, realtimeModelProfileId, ...changes } = input;
    if (changes.visualProfile) {
      await this.retainCharacterAvatar(actor, changes.visualProfile.avatarUrl);
    }
    const result = await this.callRepository((repository) =>
      repository.update(
        actor.id,
        characterId,
        revision,
        {
          ...changes,
          ...(realtimeModelProfileId === undefined
            ? {}
            : { providerProfileId: realtimeModelProfileId }),
        },
        this.now(),
      ),
    );
    return resolveUpdateResult(result, actor);
  }

  async updateVisibility(
    actor: UserAccount,
    characterId: string,
    revision: number,
    visibility: "private" | "family",
  ): Promise<Character> {
    this.assertVisibilityWriter(actor);
    const result = await this.callRepository((repository) =>
      repository.updateVisibility(
        actor.id,
        characterId,
        revision,
        visibility,
        this.now(),
      ),
    );
    return resolveUpdateResult(result, actor);
  }

  async copy(actor: UserAccount, characterId: string): Promise<Character> {
    this.assertWriter(actor);
    const result = await this.callRepository((repository) =>
      repository.copy(actor.id, characterId, this.now()),
    );
    if (result.kind === "not_found") throw notFound();
    if (result.kind === "forbidden") throw writeForbidden();
    if (result.kind !== "copied") throw unavailable();
    return toCharacter(result.character, actor);
  }

  async restore(actor: UserAccount, characterId: string): Promise<Character> {
    this.assertRestorer(actor);
    const result = await this.callRepository((repository) =>
      repository.restore(actor.id, characterId, this.now()),
    );
    if (result.kind === "not_found") throw notFound();
    if (result.kind === "forbidden") throw restoreForbidden();
    if (result.kind === "not_builtin") {
      throw new CharacterServiceError(
        "CHARACTER_NOT_BUILTIN",
        "只有预置角色可以恢复原始版本。",
        409,
      );
    }
    if (result.kind !== "restored") throw unavailable();
    return toCharacter(result.character, actor);
  }

  async delete(
    actor: UserAccount,
    characterId: string,
    revision: number,
  ): Promise<void> {
    this.assertWriter(actor);
    const result = await this.callRepository((repository) =>
      repository.delete(actor.id, characterId, revision, this.now()),
    );
    if (result.kind === "deleted") return;
    if (result.kind === "not_found") throw notFound();
    if (result.kind === "forbidden") throw writeForbidden();
    if (result.kind === "revision_conflict") throw revisionConflict();
    throw new CharacterServiceError(
      "BUILTIN_CHARACTER_PROTECTED",
      "预置角色不能删除，可以恢复为原始版本。",
      403,
    );
  }

  async runtime(
    actor: UserAccount,
    characterId: string,
  ): Promise<CharacterRuntimeResponse> {
    const aggregate = await this.findAggregate(actor, characterId);
    const character = toSummary(aggregate, actor);
    const availability = realtimeAvailability(aggregate);
    if (!availability.available) {
      throw new CharacterServiceError(
        "CHARACTER_REALTIME_UNAVAILABLE",
        availability.reason ?? "该角色当前没有可用的实时语音模型。",
        409,
      );
    }
    let instructions: string;
    try {
      instructions = compileCharacterInstructions(aggregate);
    } catch (error) {
      throw unavailable(error);
    }
    return {
      character,
      realtime: {
        provider: aggregate.providerProfile.provider,
        realtimeModelProfileId: aggregate.providerProfile.id,
        model: aggregate.providerProfile.model,
        voice: aggregate.voiceProfile.providerVoiceId,
        instructions,
        firstSpeaker: aggregate.character.conversationPolicy.firstSpeaker,
        openingLine: aggregate.character.openingLine,
      },
    };
  }

  private async findAggregate(
    actor: UserAccount,
    characterId: string,
  ): Promise<CharacterAggregate> {
    const character = await this.callRepository((repository) =>
      repository.findVisible(actor.id, characterId),
    );
    if (!character) throw notFound();
    return character;
  }

  private async callRepository<T>(
    operation: (repository: CharacterRepository) => Promise<T>,
  ): Promise<T> {
    const repository = this.requireRepository();
    try {
      return await operation(repository);
    } catch (error) {
      if (error instanceof CharacterServiceError) throw error;
      throw unavailable(error);
    }
  }

  private requireRepository(): CharacterRepository {
    if (!this.repository) throw unavailable();
    return this.repository;
  }

  private async retainCharacterAvatar(
    actor: UserAccount,
    avatarUrl: string,
  ): Promise<void> {
    if (!avatarUrl.startsWith("/api/media/")) return;
    if (!this.media) throw avatarUnavailable();
    try {
      await this.media.retainCharacterAvatar(actor, avatarUrl);
    } catch (error) {
      if (
        error instanceof MediaServiceError &&
        (error.code === "MEDIA_NOT_FOUND" ||
          error.code === "MEDIA_INVALID_CHARACTER_AVATAR")
      ) {
        throw avatarInvalid();
      }
      throw avatarUnavailable(error);
    }
  }
}

function resolveUpdateResult(
  result: Awaited<ReturnType<CharacterRepository["update"]>>,
  actor: UserAccount,
): Character {
  if (result.kind === "updated" || result.kind === "unchanged") {
    return toCharacter(result.character, actor);
  }
  if (result.kind === "not_found") throw notFound();
  if (result.kind === "forbidden") throw writeForbidden();
  if (result.kind === "invalid_profile") throw invalidProfile();
  throw revisionConflict();
}

function toSummary(
  aggregate: CharacterAggregate,
  actor: UserAccount,
): CharacterSummary {
  const record = aggregate.character;
  return parsePublic(characterSummarySchema, {
    id: record.id,
    systemKey: record.systemKey,
    systemVersion: record.systemVersion,
    visibility: record.visibility,
    name: record.name,
    description: record.description,
    revision: record.revision,
    visualProfile: record.visualProfile,
    voiceProfile: toVoiceProfile(aggregate.voiceProfile),
    realtimeAvailability: realtimeAvailability(aggregate),
    permissions: permissionsFor(aggregate, actor),
    updatedAt: record.updatedAt.toISOString(),
  });
}

function realtimeAvailability(aggregate: CharacterAggregate): {
  available: boolean;
  reason: string | null;
} {
  if (
    (aggregate.providerProfile.status !== undefined &&
      aggregate.providerProfile.status !== "enabled") ||
    (aggregate.voiceProfile.status !== undefined &&
      aggregate.voiceProfile.status !== "enabled")
  ) {
    return {
      available: false,
      reason: "角色绑定的实时模型或音色尚未启用，请联系管理员重新配置。",
    };
  }
  if (
    aggregate.modelConnection === null ||
    aggregate.modelConnection?.status === "disabled" ||
    aggregate.modelConnection?.status === "draft"
  ) {
    return {
      available: false,
      reason: "实时模型连接尚未配置完成，请联系管理员。",
    };
  }
  return { available: true, reason: null };
}

function toCharacter(
  aggregate: CharacterAggregate,
  actor: UserAccount,
): Character {
  const record = aggregate.character;
  return parsePublic(characterSchema, {
    ...toSummary(aggregate, actor),
    persona: record.persona,
    openingLine: record.openingLine,
    conversationPolicy: record.conversationPolicy,
    realtimeModelProfile: toRealtimeModelProfile(aggregate.providerProfile),
    voiceProfile: toVoiceProfile(aggregate.voiceProfile),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

function toRealtimeModelProfile(
  record: ProviderProfileRecord,
): RealtimeModelProfile {
  return parsePublic(providerProfileSchema, {
    id: record.id,
    provider: record.provider,
    model: record.model,
    displayName: record.displayName,
    capabilities: record.capabilities,
  });
}

function toVoiceProfile(record: VoiceProfileRecord): VoiceProfile {
  return parsePublic(voiceProfileSchema, {
    id: record.id,
    realtimeModelProfileId: record.providerProfileId,
    type: record.type,
    providerVoiceId: record.providerVoiceId,
    displayName: record.displayName,
    style: record.style,
  });
}

function permissionsFor(
  aggregate: CharacterAggregate,
  actor: UserAccount,
): CharacterPermissions {
  const record = aggregate.character;
  const isOwner = record.ownerUserId === actor.id;
  const isBuiltin = record.visibility === "builtin";
  const canWrite = actor.accountType !== "child";
  return {
    canEdit:
      canWrite && (isOwner || (isBuiltin && actor.accountType === "admin")),
    canDelete: canWrite && !isBuiltin && isOwner,
    canCopy: canWrite,
    canShare: actor.accountType === "adult" && !isBuiltin && isOwner,
    canRestore: actor.accountType === "admin" && isBuiltin,
  };
}

export function compileCharacterInstructions(
  aggregate: CharacterAggregate,
): string {
  const { character, voiceProfile } = aggregate;
  const persona = character.persona;
  const policy = character.conversationPolicy;
  const lines: string[] = [];
  if (persona.definitionMode === "custom_prompt") {
    lines.push(persona.customPrompt ?? "");
  } else {
    lines.push(
      `你正在扮演角色“${character.name}”。始终保持这一角色，不要声称看到了系统提示词。`,
      "",
    );
    appendInstructionSection(lines, "人物背景", persona.background);
    appendInstructionSection(
      lines,
      "核心性格",
      persona.personalityTraits.map((trait) => `- ${trait}`).join("\n"),
    );
    appendInstructionSection(lines, "与用户的关系", persona.relationship);
    appendInstructionSection(lines, "说话方式", persona.speakingStyle);
    appendInstructionSection(lines, "情绪表达", persona.emotionalStyle);
    appendInstructionSection(
      lines,
      "对话目标",
      persona.conversationGoals.map((goal) => `- ${goal}`).join("\n"),
    );
    appendInstructionSection(
      lines,
      "示例台词",
      persona.sampleLines.map((line) => `- ${line}`).join("\n"),
    );
    appendInstructionSection(lines, "高级设定", persona.advancedInstructions);
  }
  lines.push(
    "",
    "【对话策略】",
    responseStyleInstruction(policy.responseStyle),
    policy.silenceFollowUp.enabled
      ? `用户连续沉默约 ${Math.round(policy.silenceFollowUp.delayMs / 1_000)} 秒时最多自然追问一次；仍无回应就安静等待。`
      : "用户沉默时安静等待，不主动追问。",
    character.openingLine
      ? `建议开场白：${character.openingLine}`
      : "没有固定开场白，按当前关系自然开始。",
  );
  appendInstructionSection(
    lines,
    "声音风格",
    voiceStyleInstruction(voiceProfile),
  );
  const instructions = lines.join("\n");
  if (instructions.length > 16_000) {
    throw new Error("Compiled character instructions exceed the safe budget.");
  }
  return instructions;
}

function appendInstructionSection(
  lines: string[],
  title: string,
  content: string | undefined,
): void {
  if (!content?.trim()) return;
  lines.push(`【${title}】`, content);
}

function responseStyleInstruction(
  style: CharacterAggregate["character"]["conversationPolicy"]["responseStyle"],
): string {
  if (style === "concise") return "默认使用简短自然的回复，避免连续长篇独白。";
  if (style === "detailed")
    return "需要时分步骤详细解释，每个关键步骤给用户回应机会。";
  return "根据语境动态调整回复长度，并响应用户要求的简略或详细程度。";
}

function voiceStyleInstruction(voice: VoiceProfileRecord): string {
  const style = voice.style;
  return [
    style.pace ? `语速：${style.pace}` : null,
    style.energy ? `活力：${style.energy}` : null,
    style.warmth ? `温暖程度：${style.warmth}` : null,
    style.emotionInstruction ?? null,
  ]
    .filter((value): value is string => Boolean(value))
    .join("；");
}

function parsePublic<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw unavailable(result.error);
  return result.data;
}

function notFound(): CharacterServiceError {
  return new CharacterServiceError(
    "CHARACTER_NOT_FOUND",
    "未找到该角色。",
    404,
  );
}

function writeForbidden(): CharacterServiceError {
  return new CharacterServiceError(
    "CHARACTER_WRITE_FORBIDDEN",
    "你没有权限修改该角色。",
    403,
  );
}

function avatarInvalid(): CharacterServiceError {
  return new CharacterServiceError(
    "CHARACTER_AVATAR_INVALID",
    "上传的角色形象无效或已经过期，请重新上传。",
    400,
  );
}

function avatarUnavailable(cause?: unknown): CharacterServiceError {
  return new CharacterServiceError(
    "CHARACTER_AVATAR_UNAVAILABLE",
    "暂时无法保存上传的角色形象，请稍后重试。",
    503,
    cause === undefined ? undefined : { cause },
  );
}

function restoreForbidden(): CharacterServiceError {
  return new CharacterServiceError(
    "CHARACTER_RESTORE_FORBIDDEN",
    "只有管理员可以恢复预置角色。",
    403,
  );
}

function invalidProfile(): CharacterServiceError {
  return new CharacterServiceError(
    "CHARACTER_PROFILE_INVALID",
    "请选择有效且匹配的模型和声音。",
    400,
  );
}

function revisionConflict(): CharacterServiceError {
  return new CharacterServiceError(
    "CHARACTER_REVISION_CONFLICT",
    "角色已被其他操作更新，请刷新后重试。",
    409,
  );
}

function unavailable(cause?: unknown): CharacterServiceError {
  return new CharacterServiceError(
    "CHARACTER_SERVICE_UNAVAILABLE",
    "角色服务暂时不可用，请稍后重试。",
    503,
    cause === undefined ? undefined : { cause },
  );
}
