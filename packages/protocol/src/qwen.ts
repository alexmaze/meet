import { z } from "zod";

export const qwenRealtimeModelSchema = z.enum([
  "qwen-audio-3.0-realtime-plus",
  "qwen-audio-3.0-realtime-flash",
]);

export type QwenRealtimeModel = z.infer<typeof qwenRealtimeModelSchema>;

export const qwenRealtimeRegionSchema = z.literal("cn-beijing");

export type QwenRealtimeRegion = z.infer<typeof qwenRealtimeRegionSchema>;

export const qwenRealtimePublicConfigSchema = z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
  region: qwenRealtimeRegionSchema,
  model: qwenRealtimeModelSchema,
  availableModels: z.array(qwenRealtimeModelSchema),
  voice: z.string().min(1),
  defaultInstructions: z.string().min(1),
});

export type QwenRealtimePublicConfig = z.infer<
  typeof qwenRealtimePublicConfigSchema
>;

export const qwenServerEventSchema = z
  .object({
    event_id: z.string().optional(),
    type: z.string().min(1),
  })
  .passthrough();

export type QwenServerEvent = z.infer<typeof qwenServerEventSchema>;

export const qwenInputTranscriptionDeltaSchema = qwenServerEventSchema.extend({
  type: z.literal("conversation.item.input_audio_transcription.delta"),
  text: z.string().optional(),
  stash: z.string().optional(),
});

export const qwenInputTranscriptionCompletedSchema =
  qwenServerEventSchema.extend({
    type: z.literal("conversation.item.input_audio_transcription.completed"),
    transcript: z.string().optional(),
    text: z.string().optional(),
  });

export const qwenAssistantTranscriptDeltaSchema = qwenServerEventSchema.extend({
  type: z.literal("response.audio_transcript.delta"),
  delta: z.string(),
});

export const qwenAssistantTranscriptDoneSchema = qwenServerEventSchema.extend({
  type: z.literal("response.audio_transcript.done"),
  transcript: z.string().optional(),
});

export const qwenErrorEventSchema = qwenServerEventSchema.extend({
  type: z.literal("error"),
  error: z
    .object({
      type: z.string().optional(),
      code: z.string().optional(),
      message: z.string().optional(),
    })
    .passthrough()
    .optional(),
});

export const qwenSessionUpdateEventSchema = z.object({
  event_id: z.string().min(1),
  type: z.literal("session.update"),
  session: z
    .object({
      modalities: z.union([
        z.tuple([z.literal("audio"), z.literal("text")]),
        z.tuple([z.literal("text"), z.literal("audio")]),
      ]),
      voice: z.string().min(1),
      input_audio_format: z.literal("pcm"),
      output_audio_format: z.literal("pcm"),
      instructions: z.string().min(1),
      max_history_turns: z.number().int().min(1).max(50),
      turn_detection: z
        .object({
          type: z.literal("smart_turn"),
        })
        .strict(),
    })
    .strict(),
});

export type QwenSessionUpdateEvent = z.infer<
  typeof qwenSessionUpdateEventSchema
>;

export function parseQwenServerEvent(input: string): QwenServerEvent {
  return qwenServerEventSchema.parse(JSON.parse(input) as unknown);
}
