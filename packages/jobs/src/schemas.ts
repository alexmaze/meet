import { z } from "zod";

export const CONVERSATION_FINALIZE_QUEUE = "conversation.finalize";
export const MEMORY_EXTRACT_QUEUE = "memory.extract";
export const CONVERSATION_FINALIZE_DEAD_LETTER_QUEUE =
  "conversation.finalize.failed";
export const MEMORY_EXTRACT_DEAD_LETTER_QUEUE = "memory.extract.failed";

const completedConversationJobSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(200),
    conversationId: z.uuid(),
    userId: z.uuid(),
    completedSequence: z.number().int().nonnegative(),
  })
  .strict();

export const conversationFinalizeJobSchema = completedConversationJobSchema;
export type ConversationFinalizeJob = z.infer<
  typeof conversationFinalizeJobSchema
>;

export const memoryExtractJobSchema = completedConversationJobSchema;
export type MemoryExtractJob = z.infer<typeof memoryExtractJobSchema>;
