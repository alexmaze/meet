import { z } from "zod";

import {
  firstSpeakerSchema,
  realtimeProviderSchema,
  visualProfileSchema,
} from "./characters.js";

export const contextPolicyVersionSchema = z.enum(["context-v1"]);
export type ContextPolicyVersion = z.infer<typeof contextPolicyVersionSchema>;
export const CURRENT_CONTEXT_POLICY_VERSION: ContextPolicyVersion =
  "context-v1";

export const conversationModeSchema = z.enum(["normal", "temporary"]);
export type ConversationMode = z.infer<typeof conversationModeSchema>;

export const conversationStatusSchema = z.enum(["active", "completed"]);
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;

export const conversationMessageRoleSchema = z.enum(["user", "assistant"]);
export const conversationMessageStatusSchema = z.enum([
  "completed",
  "interrupted",
]);

export const conversationCharacterSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(80),
  visualProfile: visualProfileSchema,
});

export const conversationSummarySchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  character: conversationCharacterSchema,
  mode: conversationModeSchema,
  status: conversationStatusSchema,
  messageCount: z.number().int().nonnegative(),
  lastSequence: z.number().int().nonnegative(),
  provider: z.string().min(1),
  model: z.string().min(1),
  voice: z.string().min(1),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});

export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const conversationMessageSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  sequence: z.number().int().positive(),
  role: conversationMessageRoleSchema,
  status: conversationMessageStatusSchema,
  text: z.string().trim().min(1).max(20_000),
  providerEventId: z.string().min(1).max(200).nullable(),
  createdAt: z.iso.datetime(),
});

export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export const conversationRuntimeSnapshotSchema = z
  .object({
    characterRevision: z.number().int().positive(),
    realtimeModelProfileId: z.uuid(),
    provider: realtimeProviderSchema,
    model: z.string().trim().min(1).max(120),
    voice: z.string().trim().min(1).max(120),
    instructions: z.string().trim().min(1).max(16_000),
    firstSpeaker: firstSpeakerSchema,
    openingLine: z.string().trim().min(1).max(500).nullable(),
    contextPolicyVersion: contextPolicyVersionSchema,
  })
  .strict();

export type ConversationRuntimeSnapshot = z.infer<
  typeof conversationRuntimeSnapshotSchema
>;

export const createConversationRequestSchema = z
  .object({
    id: z.uuid(),
    characterId: z.uuid(),
    mode: conversationModeSchema,
  })
  .strict();

export type CreateConversationRequest = z.infer<
  typeof createConversationRequestSchema
>;

export const conversationResponseSchema = z.object({
  conversation: conversationSummarySchema,
});

export const conversationListQuerySchema = z
  .object({
    userId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const conversationListResponseSchema = z.object({
  conversations: z.array(conversationSummarySchema),
});

export const conversationIdParamsSchema = z
  .object({ conversationId: z.uuid() })
  .strict();

export const conversationRealtimeQuerySchema = z
  .object({ conversationId: z.uuid() })
  .strict();

export const appendConversationMessagesRequestSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            id: z.uuid(),
            sequence: z.number().int().positive(),
            role: conversationMessageRoleSchema,
            status: conversationMessageStatusSchema.default("completed"),
            text: z.string().trim().min(1).max(20_000),
            providerEventId: z
              .string()
              .min(1)
              .max(200)
              .nullable()
              .default(null),
            createdAt: z.iso.datetime(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

export type AppendConversationMessagesRequest = z.infer<
  typeof appendConversationMessagesRequestSchema
>;

export const appendConversationMessagesResponseSchema = z.object({
  acknowledgedSequence: z.number().int().nonnegative(),
});

export const completeConversationRequestSchema = z
  .object({ lastSequence: z.number().int().nonnegative() })
  .strict();

export const conversationDetailResponseSchema = z.object({
  conversation: conversationSummarySchema,
  messages: z.array(conversationMessageSchema),
});

export const deleteConversationResponseSchema = z.object({
  ok: z.literal(true),
});
