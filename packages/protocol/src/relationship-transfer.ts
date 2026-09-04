import { z } from "zod";

import {
  conversationMessageRoleSchema,
  conversationMessageStatusSchema,
  conversationModeSchema,
  conversationStatusSchema,
} from "./conversations.js";
import { memoryStatusSchema } from "./memories.js";
import { realtimeProviderSchema } from "./characters.js";

export const CHARACTER_RELATIONSHIP_TRANSFER_SCHEMA_VERSION =
  "meet-character-relationship-v1" as const;
export const CHARACTER_RELATIONSHIP_TRANSFER_MAX_BYTES = 25 * 1024 * 1024;

const transferMessageSchema = z
  .object({
    sequence: z.number().int().positive(),
    role: conversationMessageRoleSchema,
    status: conversationMessageStatusSchema,
    text: z.string().trim().min(1).max(20_000),
    createdAt: z.iso.datetime(),
  })
  .strict();

const transferSummarySchema = z
  .object({
    content: z.string().trim().min(1).max(100_000),
    sourceMessageCount: z.number().int().nonnegative(),
    sourceLastSequence: z.number().int().nonnegative(),
    analyzerModel: z.string().trim().min(1).max(120),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const transferConversationSchema = z
  .object({
    sourceId: z.uuid(),
    mode: conversationModeSchema,
    sourceStatus: conversationStatusSchema,
    provider: realtimeProviderSchema,
    model: z.string().trim().min(1).max(120),
    voice: z.string().trim().min(1).max(120),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().nullable(),
    updatedAt: z.iso.datetime(),
    messages: z.array(transferMessageSchema).max(20_000),
    summary: transferSummarySchema.nullable(),
  })
  .strict()
  .superRefine((conversation, context) => {
    let previousSequence = 0;
    for (const [index, message] of conversation.messages.entries()) {
      if (message.sequence <= previousSequence) {
        context.addIssue({
          code: "custom",
          path: ["messages", index, "sequence"],
          message: "消息序号必须严格递增。",
        });
      }
      previousSequence = message.sequence;
    }
    if (
      conversation.sourceStatus === "completed" &&
      conversation.endedAt === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["endedAt"],
        message: "已完成通话必须包含结束时间。",
      });
    }
  });

const transferMemorySchema = z
  .object({
    sourceConversationId: z.uuid().nullable(),
    content: z.string().trim().min(1).max(1_000),
    sourceExcerpt: z.string().trim().min(1).max(600),
    confidence: z.number().min(0).max(1),
    analyzerModel: z.string().trim().min(1).max(120).nullable(),
    status: memoryStatusSchema,
    reviewedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const characterRelationshipTransferPayloadSchema = z
  .object({
    transferId: z.uuid(),
    exportedAt: z.iso.datetime(),
    character: z
      .object({
        name: z.string().trim().min(1).max(80),
        systemKey: z.string().trim().min(1).max(120).nullable(),
      })
      .strict(),
    conversations: z.array(transferConversationSchema).max(1_000),
    memories: z.array(transferMemorySchema).max(5_000),
  })
  .strict()
  .superRefine((payload, context) => {
    const sourceIds = new Set<string>();
    for (const [index, conversation] of payload.conversations.entries()) {
      if (sourceIds.has(conversation.sourceId)) {
        context.addIssue({
          code: "custom",
          path: ["conversations", index, "sourceId"],
          message: "同一迁移包不能重复包含一条来源通话。",
        });
      }
      sourceIds.add(conversation.sourceId);
    }
  });

export type CharacterRelationshipTransferPayload = z.infer<
  typeof characterRelationshipTransferPayloadSchema
>;

export const characterRelationshipTransferPackageSchema = z
  .object({
    kind: z.literal("meet-character-relationship-transfer"),
    schemaVersion: z.literal(CHARACTER_RELATIONSHIP_TRANSFER_SCHEMA_VERSION),
    payload: characterRelationshipTransferPayloadSchema,
    integritySha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type CharacterRelationshipTransferPackage = z.infer<
  typeof characterRelationshipTransferPackageSchema
>;

export const relationshipTransferCharacterParamsSchema = z
  .object({ characterId: z.uuid() })
  .strict();

export const relationshipTransferImportQuerySchema = z
  .object({
    confirmCharacterMismatch: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true"),
  })
  .strict();

export const relationshipTransferImportResultSchema = z
  .object({
    transferId: z.uuid(),
    targetCharacterId: z.uuid(),
    importedConversations: z.number().int().nonnegative(),
    skippedConversations: z.number().int().nonnegative(),
    importedMemories: z.number().int().nonnegative(),
    skippedMemories: z.number().int().nonnegative(),
    wasAlreadyImported: z.boolean(),
  })
  .strict();

export type RelationshipTransferImportResult = z.infer<
  typeof relationshipTransferImportResultSchema
>;

export const relationshipTransferImportResponseSchema = z
  .object({ result: relationshipTransferImportResultSchema })
  .strict();
