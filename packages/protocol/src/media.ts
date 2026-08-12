import { z } from "zod";

export const CHARACTER_AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const characterAvatarContentTypeSchema = z.enum([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
export type CharacterAvatarContentType = z.infer<
  typeof characterAvatarContentTypeSchema
>;

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

export const characterAvatarUploadResponseSchema = z
  .object({
    media: mediaObjectSchema,
    avatarUrl: z
      .string()
      .regex(
        /^\/api\/media\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/content$/,
      ),
  })
  .strict();

export type CharacterAvatarUploadResponse = z.infer<
  typeof characterAvatarUploadResponseSchema
>;
