import { z } from "zod";

export const characterVisibilitySchema = z.enum([
  "builtin",
  "family",
  "private",
]);

export type CharacterVisibility = z.infer<typeof characterVisibilitySchema>;

const trimmedText = (maximum: number) => z.string().trim().min(1).max(maximum);

export const personaDefinitionSchema = z
  .object({
    background: trimmedText(4_000),
    personalityTraits: z.array(trimmedText(120)).min(1).max(12),
    relationship: trimmedText(1_000),
    speakingStyle: trimmedText(1_000),
    emotionalStyle: trimmedText(1_000),
    conversationGoals: z.array(trimmedText(500)).min(1).max(8),
    sampleLines: z.array(trimmedText(500)).min(1).max(12),
    advancedInstructions: trimmedText(4_000).optional(),
  })
  .strict()
  .refine(
    (persona) => {
      const values = [
        persona.background,
        ...persona.personalityTraits,
        persona.relationship,
        persona.speakingStyle,
        persona.emotionalStyle,
        ...persona.conversationGoals,
        ...persona.sampleLines,
        persona.advancedInstructions ?? "",
      ];
      return values.reduce((total, value) => total + value.length, 0) <= 10_000;
    },
    { message: "角色人设总长度不能超过 10000 个字符。" },
  );

export type PersonaDefinition = z.infer<typeof personaDefinitionSchema>;

export const firstSpeakerSchema = z.enum(["assistant", "user"]);
export const responseStyleSchema = z.enum(["concise", "adaptive", "detailed"]);

export const conversationPolicySchema = z
  .object({
    firstSpeaker: firstSpeakerSchema,
    responseStyle: responseStyleSchema,
    silenceFollowUp: z
      .object({
        enabled: z.boolean(),
        delayMs: z.number().int().min(10_000).max(15_000),
        maxConsecutivePrompts: z.literal(1),
      })
      .strict(),
  })
  .strict();

export type ConversationPolicy = z.infer<typeof conversationPolicySchema>;

export const characterBackgroundSchema = z.enum([
  "neutral",
  "aurora",
  "classroom",
  "sunset",
]);

// 头像只接受站内绝对路径；媒体上传接入后仍由 API 返回站内路径。
export const characterAvatarPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^\/avatars\/[A-Za-z0-9_-]+\.svg$/);

export const visualProfileSchema = z
  .object({
    avatarUrl: characterAvatarPathSchema,
    accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    background: characterBackgroundSchema,
    animationStyle: z.literal("subtle"),
  })
  .strict();

export type VisualProfile = z.infer<typeof visualProfileSchema>;

export const realtimeProviderSchema = z.enum([
  "qwen",
  "doubao",
  "openai",
  "gemini",
  "elevenlabs",
]);

export type RealtimeProviderKind = z.infer<typeof realtimeProviderSchema>;

export const providerCapabilitiesSchema = z
  .object({
    audioInput: z.boolean(),
    textInput: z.boolean(),
    imageInput: z.boolean(),
  })
  .strict();

export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

export const providerProfileSchema = z
  .object({
    id: z.uuid(),
    provider: realtimeProviderSchema,
    model: trimmedText(120),
    displayName: trimmedText(120),
    capabilities: providerCapabilitiesSchema,
  })
  .strict();

export type ProviderProfile = z.infer<typeof providerProfileSchema>;

export const voiceProfileTypeSchema = z.enum(["preset", "cloned"]);
export const voicePaceSchema = z.enum(["slow", "normal", "fast"]);
export const voiceLevelSchema = z.enum(["low", "medium", "high"]);

export const voiceStyleSchema = z
  .object({
    pace: voicePaceSchema.optional(),
    energy: voiceLevelSchema.optional(),
    warmth: voiceLevelSchema.optional(),
    emotionInstruction: trimmedText(1_000).optional(),
  })
  .strict();

export type VoiceStyle = z.infer<typeof voiceStyleSchema>;

export const voiceProfileSchema = z
  .object({
    id: z.uuid(),
    providerProfileId: z.uuid(),
    type: voiceProfileTypeSchema,
    providerVoiceId: trimmedText(120),
    displayName: trimmedText(120),
    style: voiceStyleSchema,
  })
  .strict();

export type VoiceProfile = z.infer<typeof voiceProfileSchema>;

export const characterPermissionsSchema = z
  .object({
    canEdit: z.boolean(),
    canDelete: z.boolean(),
    canCopy: z.boolean(),
    canShare: z.boolean(),
    canRestore: z.boolean(),
  })
  .strict();

export type CharacterPermissions = z.infer<typeof characterPermissionsSchema>;

export const characterSummarySchema = z
  .object({
    id: z.uuid(),
    systemKey: trimmedText(120).nullable(),
    systemVersion: z.number().int().positive().nullable(),
    visibility: characterVisibilitySchema,
    name: trimmedText(80),
    description: trimmedText(600),
    revision: z.number().int().positive(),
    visualProfile: visualProfileSchema,
    voiceProfile: voiceProfileSchema,
    permissions: characterPermissionsSchema,
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type CharacterSummary = z.infer<typeof characterSummarySchema>;

export const characterSchema = characterSummarySchema
  .omit({ voiceProfile: true, permissions: true, updatedAt: true })
  .extend({
    persona: personaDefinitionSchema,
    openingLine: trimmedText(500).nullable(),
    conversationPolicy: conversationPolicySchema,
    providerProfile: providerProfileSchema,
    voiceProfile: voiceProfileSchema,
    permissions: characterPermissionsSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type Character = z.infer<typeof characterSchema>;

const editableCharacterFields = {
  name: trimmedText(80),
  description: trimmedText(600),
  persona: personaDefinitionSchema,
  openingLine: trimmedText(500).nullable(),
  providerProfileId: z.uuid(),
  voiceProfileId: z.uuid(),
  conversationPolicy: conversationPolicySchema,
  visualProfile: visualProfileSchema,
};

// owner、visibility、systemKey、systemVersion 和账号类型均由服务端派生。
export const createCharacterRequestSchema = z
  .object(editableCharacterFields)
  .strict();

export type CreateCharacterRequest = z.infer<
  typeof createCharacterRequestSchema
>;

export const updateCharacterRequestSchema = z
  .object({
    revision: z.number().int().positive(),
    name: editableCharacterFields.name.optional(),
    description: editableCharacterFields.description.optional(),
    persona: editableCharacterFields.persona.optional(),
    openingLine: editableCharacterFields.openingLine.optional(),
    providerProfileId: editableCharacterFields.providerProfileId.optional(),
    voiceProfileId: editableCharacterFields.voiceProfileId.optional(),
    conversationPolicy: editableCharacterFields.conversationPolicy.optional(),
    visualProfile: editableCharacterFields.visualProfile.optional(),
  })
  .strict()
  .refine(
    ({ revision: _revision, ...changes }) =>
      Object.values(changes).some((value) => value !== undefined),
    { message: "至少需要修改一个角色字段。" },
  );

export type UpdateCharacterRequest = z.infer<
  typeof updateCharacterRequestSchema
>;

export const updateCharacterVisibilityRequestSchema = z
  .object({
    revision: z.number().int().positive(),
    visibility: z.enum(["private", "family"]),
  })
  .strict();

export type UpdateCharacterVisibilityRequest = z.infer<
  typeof updateCharacterVisibilityRequestSchema
>;

export const deleteCharacterRequestSchema = z
  .object({
    revision: z.number().int().positive(),
  })
  .strict();

export const emptyCharacterActionRequestSchema = z.object({}).strict();

export const characterIdParamsSchema = z
  .object({
    characterId: z.uuid(),
  })
  .strict();

export const characterListResponseSchema = z
  .object({ characters: z.array(characterSummarySchema) })
  .strict();

export const characterResponseSchema = z
  .object({ character: characterSchema })
  .strict();

export const characterCatalogResponseSchema = z
  .object({
    providers: z.array(providerProfileSchema),
    voices: z.array(voiceProfileSchema),
  })
  .strict();

export const deleteCharacterResponseSchema = z
  .object({ ok: z.literal(true) })
  .strict();

export const characterRuntimeResponseSchema = z
  .object({
    character: characterSummarySchema,
    realtime: z
      .object({
        provider: realtimeProviderSchema,
        model: trimmedText(120),
        voice: trimmedText(120),
        instructions: trimmedText(16_000),
        firstSpeaker: firstSpeakerSchema,
      })
      .strict(),
  })
  .strict();

export type CharacterRuntimeResponse = z.infer<
  typeof characterRuntimeResponseSchema
>;
