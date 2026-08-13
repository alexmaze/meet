import { z } from "zod";

export const CONVERSATION_FINALIZE_QUEUE = "conversation.finalize";
export const CONVERSATION_CHECKPOINT_QUEUE = "conversation.checkpoint";
export const MEMORY_EXTRACT_QUEUE = "memory.extract";
export const MEMORY_INDEX_SYNC_QUEUE = "memory.index.sync";
export const CONVERSATION_FINALIZE_DEAD_LETTER_QUEUE =
  "conversation.finalize.failed";
export const CONVERSATION_CHECKPOINT_DEAD_LETTER_QUEUE =
  "conversation.checkpoint.failed";
export const MEMORY_EXTRACT_DEAD_LETTER_QUEUE = "memory.extract.failed";
export const MEMORY_INDEX_SYNC_DEAD_LETTER_QUEUE = "memory.index.sync.failed";
export const MEDIA_EXPIRE_QUEUE = "media.expire";
export const MEDIA_EXPIRE_DEAD_LETTER_QUEUE = "media.expire.failed";

const completedConversationJobSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(200),
    conversationId: z.uuid(),
    userId: z.uuid(),
    completedSequence: z.number().int().nonnegative(),
    workItemId: z.uuid().optional(),
    modelProfileId: z.uuid().optional(),
  })
  .strict();

export const conversationFinalizeJobSchema = completedConversationJobSchema;
export type ConversationFinalizeJob = z.infer<
  typeof conversationFinalizeJobSchema
>;

export const conversationCheckpointJobSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(200),
    checkpointId: z.uuid(),
    conversationId: z.uuid(),
    userId: z.uuid(),
    targetSequence: z.number().int().positive(),
    modelProfileId: z.uuid(),
  })
  .strict();
export type ConversationCheckpointJob = z.infer<
  typeof conversationCheckpointJobSchema
>;

export const memoryExtractJobSchema = completedConversationJobSchema;
export type MemoryExtractJob = z.infer<typeof memoryExtractJobSchema>;

export const memoryIndexSyncJobSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(200),
    memoryId: z.uuid(),
  })
  .strict();
export type MemoryIndexSyncJob = z.infer<typeof memoryIndexSyncJobSchema>;

export const mediaExpireJobSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(300),
    mediaId: z.uuid(),
    objectKey: z.string().trim().min(1).max(512),
    reason: z.enum(["expired", "user_deleted"]),
    notBefore: z.iso.datetime(),
    expectedExpiresAt: z.iso.datetime().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.reason !== "expired" || value.expectedExpiresAt !== undefined,
    { message: "Expired media jobs require the expected expiry timestamp." },
  );
export type MediaExpireJob = z.infer<typeof mediaExpireJobSchema>;
