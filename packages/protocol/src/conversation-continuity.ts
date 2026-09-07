import { z } from "zod";
import {
  conversationSummarySchema,
  conversationWriterSchema,
  conversationMessageSchema,
} from "./conversations.js";
import { firstSpeakerSchema, realtimeProviderSchema } from "./characters.js";

export const conversationAnalysisStateSchema = z.enum([
  "not_started",
  "processing",
  "completed",
  "not_configured",
  "failed",
  "not_applicable",
]);
export const conversationContinuityStatusSchema = z.object({
  conversation: conversationSummarySchema,
  connectionState: z.enum([
    "connecting",
    "connected",
    "recovering",
    "interrupted",
    "completed",
  ]),
  writerClientId: z.uuid().nullable(),
  writerEpoch: z.number().int().nonnegative(),
  leaseExpiresAt: z.iso.datetime().nullable(),
  lastActivityAt: z.iso.datetime().nullable(),
  lastSavedAt: z.iso.datetime().nullable(),
  connectedDurationMs: z.number().int().nonnegative(),
  finalizedAt: z.iso.datetime().nullable(),
  hasConnected: z.boolean(),
  endRequestId: z.uuid().nullable(),
  endTargetSequence: z.number().int().nonnegative().nullable(),
  isOwner: z.boolean(),
  canResume: z.boolean(),
  canFinish: z.boolean(),
  unavailableReason: z
    .enum(["in_use", "character_unavailable", "completed"])
    .nullable(),
  summary: z.object({
    state: conversationAnalysisStateSchema,
    content: z.string().nullable(),
  }),
  memory: z.object({
    state: conversationAnalysisStateSchema,
    activeCount: z.number().int().nonnegative(),
    suggestedCount: z.number().int().nonnegative(),
  }),
});
export type ConversationContinuityStatus = z.infer<
  typeof conversationContinuityStatusSchema
>;
export const prepareConversationRequestSchema = z
  .object({
    clientId: z.uuid(),
    requestId: z.uuid(),
    intent: z.enum(["connect", "finish"]),
  })
  .strict();
export type PrepareConversationRequest = z.infer<
  typeof prepareConversationRequestSchema
>;
export const conversationRecoveryRealtimeSchema = z.object({
  provider: realtimeProviderSchema,
  realtimeModelProfileId: z.uuid(),
  model: z.string(),
  voice: z.string(),
  firstSpeaker: firstSpeakerSchema,
  openingLine: z.string().nullable(),
});
export const prepareConversationResponseSchema = z.object({
  status: conversationContinuityStatusSchema,
  writer: conversationWriterSchema,
  launch: z.enum(["initial", "resume", "finish"]),
  realtime: conversationRecoveryRealtimeSchema.nullable(),
});
export type PrepareConversationResponse = z.infer<
  typeof prepareConversationResponseSchema
>;
export const conversationStatusQuerySchema = z
  .object({ clientId: z.uuid().optional(), requestId: z.uuid().optional() })
  .strict();
export const conversationOverviewQuerySchema = z
  .object({ clientId: z.uuid().optional(), characterId: z.uuid().optional() })
  .strict();
export const conversationOverviewResponseSchema = z.object({
  pending: z.array(conversationContinuityStatusSchema),
  pendingCount: z.number().int().nonnegative(),
  recent: z.array(conversationContinuityStatusSchema),
});
export type ConversationOverviewResponse = z.infer<
  typeof conversationOverviewResponseSchema
>;
export const conversationHeartbeatRequestSchema = z
  .object({ writer: conversationWriterSchema })
  .strict();
export const completeConversationResponseSchema = z.object({
  conversation: conversationSummarySchema,
  status: conversationContinuityStatusSchema,
});
export const conversationContinuityDetailResponseSchema = z.object({
  conversation: conversationSummarySchema,
  messages: z.array(conversationMessageSchema),
  continuity: conversationContinuityStatusSchema,
});
