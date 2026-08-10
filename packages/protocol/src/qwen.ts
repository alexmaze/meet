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

export const qwenSpeechStartedEventSchema = qwenServerEventSchema.extend({
  type: z.literal("input_audio_buffer.speech_started"),
  item_id: z.string().min(1),
});

export const qwenSpeechStoppedEventSchema = qwenServerEventSchema.extend({
  type: z.literal("input_audio_buffer.speech_stopped"),
  item_id: z.string().min(1),
  reason: z.literal("turn_invalid").optional(),
});

export const qwenInputAudioBufferCommittedEventSchema =
  qwenServerEventSchema.extend({
    type: z.literal("input_audio_buffer.committed"),
    item_id: z.string().min(1),
    previous_item_id: z.string().min(1).optional(),
  });

export type QwenInputAudioBufferCommittedEvent = z.infer<
  typeof qwenInputAudioBufferCommittedEventSchema
>;

const qwenResponseDoneResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      id: z.string().min(1),
      status: z.literal("completed"),
    })
    .passthrough(),
  z
    .object({
      id: z.string().min(1),
      status: z.literal("cancelled"),
      status_details: z
        .object({
          reason: z.enum(["turn_detected", "client_cancelled"]),
        })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      id: z.string().min(1),
      status: z.literal("failed"),
      status_details: z.object({}).passthrough().optional(),
    })
    .passthrough(),
]);

export const qwenResponseDoneEventSchema = qwenServerEventSchema.extend({
  type: z.literal("response.done"),
  response: qwenResponseDoneResponseSchema,
});

export const qwenResponseCreatedEventSchema = qwenServerEventSchema.extend({
  type: z.literal("response.created"),
  response: z
    .object({
      id: z.string().min(1),
    })
    .passthrough(),
});

export const qwenResponseContentPartAddedEventSchema =
  qwenServerEventSchema.extend({
    type: z.literal("response.content_part.added"),
    response_id: z.string().min(1),
    item_id: z.string().min(1),
    output_index: z.number().int().nonnegative(),
    content_index: z.number().int().nonnegative(),
    part: z
      .object({
        type: z.enum(["audio", "text"]),
        text: z.string(),
      })
      .passthrough(),
  });

export type QwenResponseContentPartAddedEvent = z.infer<
  typeof qwenResponseContentPartAddedEventSchema
>;

export const qwenPcmBase64Schema = z.base64().min(1);

export const qwenResponseAudioDeltaEventSchema = qwenServerEventSchema.extend({
  type: z.literal("response.audio.delta"),
  response_id: z.string().min(1),
  item_id: z.string().min(1),
  output_index: z.number().int().nonnegative(),
  content_index: z.number().int().nonnegative(),
  delta: qwenPcmBase64Schema,
});

export type QwenResponseAudioDeltaEvent = z.infer<
  typeof qwenResponseAudioDeltaEventSchema
>;

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
  response_id: z.string().min(1),
  delta: z.string(),
});

export const qwenAssistantTranscriptDoneSchema = qwenServerEventSchema.extend({
  type: z.literal("response.audio_transcript.done"),
  response_id: z.string().min(1),
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

export const qwenInputAudioBufferAppendEventSchema = z
  .object({
    event_id: z.string().min(1),
    type: z.literal("input_audio_buffer.append"),
    audio: qwenPcmBase64Schema,
  })
  .strict();

export type QwenInputAudioBufferAppendEvent = z.infer<
  typeof qwenInputAudioBufferAppendEventSchema
>;

export const qwenUserTextItemCreateEventSchema = z.object({
  event_id: z.string().min(1),
  type: z.literal("conversation.item.create"),
  item: z
    .object({
      type: z.literal("message"),
      role: z.literal("user"),
      content: z.tuple([
        z
          .object({
            type: z.literal("input_text"),
            text: z.string().min(1),
          })
          .strict(),
      ]),
    })
    .strict(),
});

export const qwenResponseCreateEventSchema = z
  .object({
    event_id: z.string().min(1),
    type: z.literal("response.create"),
  })
  .strict();

export const qwenResponseCancelEventSchema = z
  .object({
    event_id: z.string().min(1),
    type: z.literal("response.cancel"),
  })
  .strict();

export type QwenResponseCancelEvent = z.infer<
  typeof qwenResponseCancelEventSchema
>;

export function parseQwenServerEvent(input: string): QwenServerEvent {
  return qwenServerEventSchema.parse(JSON.parse(input) as unknown);
}
