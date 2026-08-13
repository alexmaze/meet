import { z } from "zod";

const trimmed = (maximum: number) => z.string().trim().min(1).max(maximum);

export const modelConnectionAdapterSchema = z.enum([
  "qwen_realtime",
  "doubao_realtime",
  "openai_chat_completions",
]);
export type ModelConnectionAdapter = z.infer<
  typeof modelConnectionAdapterSchema
>;

export const modelProfileKindSchema = z.enum(["realtime_voice", "text"]);
export type ModelProfileKind = z.infer<typeof modelProfileKindSchema>;

export const modelConfigurationStatusSchema = z.enum([
  "draft",
  "enabled",
  "disabled",
]);
export type ModelConfigurationStatus = z.infer<
  typeof modelConfigurationStatusSchema
>;

export const modelPurposeSchema = z.enum([
  "realtime_default",
  "conversation_summary",
  "memory_extraction",
]);
export type ModelPurpose = z.infer<typeof modelPurposeSchema>;

export const textCompatibilityPresetSchema = z.enum(["standard", "dashscope"]);
export type TextCompatibilityPreset = z.infer<
  typeof textCompatibilityPresetSchema
>;

export const modelConnectionSchema = z
  .object({
    id: z.uuid(),
    adapter: modelConnectionAdapterSchema,
    displayName: trimmed(120),
    endpoint: z.url(),
    compatibilityPreset: textCompatibilityPresetSchema.nullable(),
    status: modelConfigurationStatusSchema,
    hasCredential: z.boolean(),
    hasPendingChanges: z.boolean(),
    revision: z.number().int().positive(),
    verifiedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type ModelConnection = z.infer<typeof modelConnectionSchema>;

export const createModelConnectionRequestSchema = z
  .object({
    adapter: modelConnectionAdapterSchema,
    displayName: trimmed(120),
    endpoint: z.url(),
    apiKey: trimmed(8_000),
    compatibilityPreset: textCompatibilityPresetSchema.optional(),
  })
  .strict();
export type CreateModelConnectionRequest = z.infer<
  typeof createModelConnectionRequestSchema
>;

export const updateModelConnectionRequestSchema = z
  .object({
    revision: z.number().int().positive(),
    displayName: trimmed(120).optional(),
    endpoint: z.url().optional(),
    apiKey: z.string().trim().max(8_000).optional(),
    compatibilityPreset: textCompatibilityPresetSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.displayName !== undefined ||
      value.endpoint !== undefined ||
      value.apiKey !== undefined ||
      value.compatibilityPreset !== undefined,
    { message: "至少需要修改一个连接字段。" },
  );
export type UpdateModelConnectionRequest = z.infer<
  typeof updateModelConnectionRequestSchema
>;

export const modelProfileSchema = z
  .object({
    id: z.uuid(),
    connectionId: z.uuid().nullable(),
    kind: modelProfileKindSchema,
    provider: z.enum(["qwen", "doubao", "openai_compatible"]),
    model: trimmed(160),
    displayName: trimmed(120),
    status: modelConfigurationStatusSchema,
    revision: z.number().int().positive(),
    verifiedAt: z.iso.datetime().nullable(),
    referenceCount: z.number().int().nonnegative(),
    characterReferenceCount: z.number().int().nonnegative(),
    purposeReferenceCount: z.number().int().nonnegative(),
    queuedReferenceCount: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type ModelProfile = z.infer<typeof modelProfileSchema>;

export const createModelProfileRequestSchema = z
  .object({
    connectionId: z.uuid(),
    kind: modelProfileKindSchema,
    model: trimmed(160),
    displayName: trimmed(120),
  })
  .strict();
export type CreateModelProfileRequest = z.infer<
  typeof createModelProfileRequestSchema
>;

export const updateModelProfileRequestSchema = z
  .object({
    revision: z.number().int().positive(),
    model: trimmed(160).optional(),
    displayName: trimmed(120).optional(),
    status: modelConfigurationStatusSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.model !== undefined ||
      value.displayName !== undefined ||
      value.status !== undefined,
    { message: "至少需要修改一个模型字段。" },
  );
export type UpdateModelProfileRequest = z.infer<
  typeof updateModelProfileRequestSchema
>;

export const managedVoiceProfileSchema = z
  .object({
    id: z.uuid(),
    modelProfileId: z.uuid(),
    providerVoiceId: trimmed(160),
    displayName: trimmed(120),
    source: z.enum(["builtin", "custom"]),
    status: modelConfigurationStatusSchema,
    revision: z.number().int().positive(),
    verifiedAt: z.iso.datetime().nullable(),
  })
  .strict();
export type ManagedVoiceProfile = z.infer<typeof managedVoiceProfileSchema>;

export const createManagedVoiceRequestSchema = z
  .object({
    providerVoiceId: trimmed(160),
    displayName: trimmed(120),
  })
  .strict();

export const modelBindingSchema = z
  .object({
    purpose: modelPurposeSchema,
    modelProfileId: z.uuid().nullable(),
  })
  .strict();
export type ModelBinding = z.infer<typeof modelBindingSchema>;

export const updateModelBindingRequestSchema = z
  .object({ modelProfileId: z.uuid() })
  .strict();

export const modelSettingsResponseSchema = z
  .object({
    connections: z.array(modelConnectionSchema),
    models: z.array(modelProfileSchema),
    voices: z.array(managedVoiceProfileSchema),
    bindings: z.array(modelBindingSchema),
    work: z
      .object({
        waiting: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type ModelSettingsResponse = z.infer<typeof modelSettingsResponseSchema>;

export const modelSettingsIdParamsSchema = z.object({ id: z.uuid() }).strict();

export const testModelProfileRequestSchema = z
  .object({ voiceProfileId: z.uuid().optional() })
  .strict();
