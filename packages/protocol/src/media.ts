import { z } from "zod";

export const mediaObjectKindSchema = z.enum([
  "call_recording",
  "conversation_image",
  "character_avatar",
  "avatar_preview",
]);
export type MediaObjectKind = z.infer<typeof mediaObjectKindSchema>;

export const mediaRetentionSchema = z.enum(["temporary", "retained"]);
export type MediaRetention = z.infer<typeof mediaRetentionSchema>;

export const mediaObjectSchema = z.object({
  id: z.uuid(),
  ownerUserId: z.uuid(),
  conversationId: z.uuid().nullable(),
  kind: mediaObjectKindSchema,
  contentType: z.string().trim().min(1).max(160),
  sizeBytes: z.number().int().nonnegative(),
  retention: mediaRetentionSchema,
  expiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type MediaObjectMetadata = z.infer<typeof mediaObjectSchema>;

export const mediaIdParamsSchema = z.object({ mediaId: z.uuid() }).strict();

export const mediaObjectResponseSchema = z.object({
  media: mediaObjectSchema,
});
