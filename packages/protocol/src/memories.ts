import { z } from "zod";

import { conversationCharacterSchema } from "./conversations.js";

export const memoryStatusSchema = z.enum([
  "active",
  "suggested",
  "rejected",
  "deleted",
]);
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;

export const characterMemorySchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  character: conversationCharacterSchema,
  sourceConversationId: z.uuid().nullable(),
  sourceExcerpt: z.string().trim().min(1).max(600),
  content: z.string().trim().min(1).max(1_000),
  confidence: z.number().min(0).max(1),
  status: memoryStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  reviewedAt: z.iso.datetime().nullable(),
});
export type CharacterMemory = z.infer<typeof characterMemorySchema>;

export const memoryListQuerySchema = z
  .object({
    userId: z.uuid().optional(),
    status: z.enum(["active", "suggested"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

export const memoryListResponseSchema = z.object({
  memories: z.array(characterMemorySchema),
});

export const memoryIdParamsSchema = z.object({ memoryId: z.uuid() }).strict();

export const reviewMemoryRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept") }).strict(),
  z
    .object({
      action: z.literal("edit"),
      content: z.string().trim().min(1).max(1_000),
    })
    .strict(),
  z.object({ action: z.literal("reject") }).strict(),
  z.object({ action: z.literal("delete") }).strict(),
]);
export type ReviewMemoryRequest = z.infer<typeof reviewMemoryRequestSchema>;

export const memoryResponseSchema = z.object({
  memory: characterMemorySchema,
});

export const mem0DiagnosticsQuerySchema = z
  .object({
    userId: z.uuid().optional(),
    characterId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

export const mem0DiagnosticItemSchema = z.object({
  memoryId: z.uuid(),
  character: conversationCharacterSchema,
  content: z.string(),
  memoryStatus: memoryStatusSchema,
  expectedInMem0: z.boolean(),
  indexStatus: z.enum(["not_indexed", "pending", "synced", "failed"]),
  externalId: z.string().nullable(),
  indexRevision: z.string().nullable(),
  attemptCount: z.number().int().nonnegative(),
  lastErrorCode: z.string().nullable(),
  syncedAt: z.iso.datetime().nullable(),
  existsInMem0: z.boolean(),
  mem0Content: z.string().nullable(),
  contentMatches: z.boolean().nullable(),
});

export const mem0OrphanItemSchema = z.object({
  externalId: z.string(),
  localMemoryId: z.string().nullable(),
  content: z.string(),
});

export const mem0DiagnosticsResponseSchema = z.object({
  enabled: z.boolean(),
  indexRevision: z.string().nullable(),
  items: z.array(mem0DiagnosticItemSchema),
  orphaned: z.array(mem0OrphanItemSchema),
});
export type Mem0DiagnosticsResponse = z.infer<
  typeof mem0DiagnosticsResponseSchema
>;

export const mem0SearchRequestSchema = z
  .object({
    userId: z.uuid().optional(),
    characterId: z.uuid(),
    query: z.string().trim().min(1).max(1_000),
    limit: z.number().int().min(1).max(20).default(8),
    threshold: z.number().min(0).max(1).default(0),
  })
  .strict();

export const mem0SearchResponseSchema = z.object({
  indexRevision: z.string().nullable(),
  results: z.array(
    z.object({
      externalId: z.string(),
      localMemoryId: z.string().nullable(),
      content: z.string(),
      score: z.number().nullable(),
    }),
  ),
});
export type Mem0SearchResponse = z.infer<typeof mem0SearchResponseSchema>;
