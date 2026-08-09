import { z } from "zod";

export const realtimeConnectionStateSchema = z.enum([
  "idle",
  "requesting_microphone",
  "connecting",
  "configuring",
  "active",
  "reconnecting",
  "paused",
  "closed",
  "error",
]);

export type RealtimeConnectionState = z.infer<
  typeof realtimeConnectionStateSchema
>;

export const realtimeActivitySchema = z.enum([
  "idle",
  "listening",
  "user_speaking",
  "thinking",
  "assistant_speaking",
]);

export type RealtimeActivity = z.infer<typeof realtimeActivitySchema>;

export const transcriptSpeakerSchema = z.enum(["user", "assistant"]);

export const transcriptSegmentSchema = z.object({
  id: z.string().min(1),
  speaker: transcriptSpeakerSchema,
  text: z.string().min(1),
  createdAt: z.string().datetime(),
});

export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

export const realtimeErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  recoverable: z.boolean(),
  requestId: z.string().optional(),
});

export type RealtimeError = z.infer<typeof realtimeErrorSchema>;
