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
