import { z } from "zod";

export const QWEN_REALTIME_MAX_IDENTIFIER_CHARACTERS = 256;
export const QWEN_REALTIME_MAX_EVENT_TYPE_CHARACTERS = 128;

const qwenRealtimeIdentifierSchema = z
  .string()
  .min(1)
  .max(QWEN_REALTIME_MAX_IDENTIFIER_CHARACTERS);
const qwenRealtimeEventTypeSchema = z
  .string()
  .min(1)
  .max(QWEN_REALTIME_MAX_EVENT_TYPE_CHARACTERS);

export const qwenRealtimeModelSchema = z.string().trim().min(1).max(160);
export const knownQwenRealtimeModels = [
  "qwen-audio-3.0-realtime-plus",
  "qwen-audio-3.0-realtime-flash",
] as const;

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
    event_id: qwenRealtimeIdentifierSchema.optional(),
    type: qwenRealtimeEventTypeSchema,
  })
  .passthrough();

export type QwenServerEvent = z.infer<typeof qwenServerEventSchema>;

const qwenLiveServerEventEnvelopeSchema = z
  .object({
    event_id: qwenRealtimeIdentifierSchema,
  })
  .passthrough();

const qwenLiveSessionSnapshotSchema = z
  .object({
    id: qwenRealtimeIdentifierSchema,
    object: z.literal("realtime.session"),
    model: qwenRealtimeModelSchema,
    modalities: z.array(z.enum(["text", "audio"])).min(1),
    voice: z.string().min(1),
    input_audio_format: z.literal("pcm").optional(),
    output_audio_format: z.literal("pcm").optional(),
    max_history_turns: z.number().int().min(1).max(50).optional(),
    instructions: z.string().optional(),
    turn_detection: z
      .object({
        type: z.enum(["server_vad", "smart_turn"]),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * Provider events used by the live teaching probe deliberately require the
 * server-generated event id and the fields needed to bind evidence to the
 * expected Qwen session. Unknown Provider fields remain forward-compatible.
 */
export const qwenLiveSessionCreatedEventSchema =
  qwenLiveServerEventEnvelopeSchema.extend({
    type: z.literal("session.created"),
    session: qwenLiveSessionSnapshotSchema,
  });

export const qwenLiveSessionUpdatedEventSchema =
  qwenLiveServerEventEnvelopeSchema.extend({
    type: z.literal("session.updated"),
    session: qwenLiveSessionSnapshotSchema,
  });

export const qwenLiveConversationItemCreatedEventSchema =
  qwenLiveServerEventEnvelopeSchema.extend({
    type: z.literal("conversation.item.created"),
    previous_item_id: qwenRealtimeIdentifierSchema.nullable().optional(),
    item: z
      .object({
        id: qwenRealtimeIdentifierSchema,
        object: z.literal("realtime.item"),
        type: z.literal("message"),
        status: z.enum(["in_progress", "completed"]),
        role: z.enum(["system", "user", "assistant"]),
        content: z.array(z.object({ type: z.string().min(1) }).passthrough()),
      })
      .passthrough(),
  });

export const qwenSpeechStartedEventSchema = qwenServerEventSchema.extend({
  type: z.literal("input_audio_buffer.speech_started"),
  item_id: qwenRealtimeIdentifierSchema,
});

export const qwenSpeechStoppedEventSchema = qwenServerEventSchema.extend({
  type: z.literal("input_audio_buffer.speech_stopped"),
  item_id: qwenRealtimeIdentifierSchema,
  reason: z.literal("turn_invalid").optional(),
});

export const qwenInputAudioBufferCommittedEventSchema =
  qwenServerEventSchema.extend({
    type: z.literal("input_audio_buffer.committed"),
    item_id: qwenRealtimeIdentifierSchema,
    previous_item_id: qwenRealtimeIdentifierSchema.optional(),
  });

export type QwenInputAudioBufferCommittedEvent = z.infer<
  typeof qwenInputAudioBufferCommittedEventSchema
>;

const qwenResponseDoneResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      id: qwenRealtimeIdentifierSchema,
      status: z.literal("completed"),
    })
    .passthrough(),
  z
    .object({
      id: qwenRealtimeIdentifierSchema,
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
      id: qwenRealtimeIdentifierSchema,
      status: z.literal("failed"),
      status_details: z.object({}).passthrough().optional(),
    })
    .passthrough(),
]);

const qwenTokenCountSchema = z.number().int().nonnegative().safe();

export const qwenLiveResponseUsageSchema = z
  .object({
    total_tokens: qwenTokenCountSchema,
    input_tokens: qwenTokenCountSchema,
    output_tokens: qwenTokenCountSchema,
    input_tokens_details: z
      .object({
        text_tokens: qwenTokenCountSchema,
        audio_tokens: z.literal(0).optional(),
      })
      .passthrough(),
    output_tokens_details: z
      .object({
        text_tokens: qwenTokenCountSchema,
        audio_tokens: z.literal(0).optional(),
      })
      .passthrough(),
  })
  .passthrough()
  .superRefine((usage, context) => {
    if (usage.total_tokens !== usage.input_tokens + usage.output_tokens) {
      context.addIssue({
        code: "custom",
        message: "total_tokens does not match input_tokens + output_tokens.",
      });
    }
    if (
      usage.input_tokens !==
      usage.input_tokens_details.text_tokens +
        (usage.input_tokens_details.audio_tokens ?? 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "input token details do not match input_tokens.",
      });
    }
    if (
      usage.output_tokens !==
      usage.output_tokens_details.text_tokens +
        (usage.output_tokens_details.audio_tokens ?? 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "output token details do not match output_tokens.",
      });
    }
  });

export const qwenResponseDoneEventSchema = qwenServerEventSchema.extend({
  type: z.literal("response.done"),
  response: qwenResponseDoneResponseSchema,
});

/** Stricter response.done used only when collecting billable live evidence. */
export const qwenLiveResponseDoneEventSchema = z
  .object({
    event_id: qwenRealtimeIdentifierSchema,
    type: z.literal("response.done"),
    response: z
      .object({
        id: qwenRealtimeIdentifierSchema,
        status: z.literal("completed"),
        modalities: z.tuple([z.literal("text")]),
        usage: qwenLiveResponseUsageSchema,
      })
      .passthrough(),
  })
  .passthrough();

export type QwenLiveResponseUsage = z.infer<typeof qwenLiveResponseUsageSchema>;

export const qwenResponseCreatedEventSchema = qwenServerEventSchema.extend({
  type: z.literal("response.created"),
  response: z
    .object({
      id: qwenRealtimeIdentifierSchema,
      modalities: z
        .array(z.enum(["text", "audio"]))
        .min(1)
        .optional(),
    })
    .passthrough(),
});

export const qwenResponseContentPartAddedEventSchema =
  qwenServerEventSchema.extend({
    type: z.literal("response.content_part.added"),
    response_id: qwenRealtimeIdentifierSchema,
    item_id: qwenRealtimeIdentifierSchema,
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
  response_id: qwenRealtimeIdentifierSchema,
  item_id: qwenRealtimeIdentifierSchema,
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
  response_id: qwenRealtimeIdentifierSchema,
  delta: z.string(),
});

export const qwenAssistantTranscriptDoneSchema = qwenServerEventSchema.extend({
  type: z.literal("response.audio_transcript.done"),
  response_id: qwenRealtimeIdentifierSchema,
  transcript: z.string().optional(),
});

/** Text-only output events documented by Qwen-Audio Realtime. */
export const qwenResponseTextDeltaEventSchema = qwenServerEventSchema.extend({
  type: z.literal("response.text.delta"),
  response_id: qwenRealtimeIdentifierSchema,
  item_id: qwenRealtimeIdentifierSchema,
  output_index: z.number().int().nonnegative(),
  content_index: z.number().int().nonnegative(),
  delta: z.string(),
});

export const qwenResponseTextDoneEventSchema = qwenServerEventSchema.extend({
  type: z.literal("response.text.done"),
  response_id: qwenRealtimeIdentifierSchema,
  item_id: qwenRealtimeIdentifierSchema,
  output_index: z.number().int().nonnegative(),
  content_index: z.number().int().nonnegative(),
  text: z.string(),
});

const qwenLiveResponseIndexSchema = z.number().int().nonnegative().safe();

const qwenLiveResponseTextPartSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .passthrough();

/** Harmless text-only response lifecycle events accepted by the live probe. */
export const qwenLiveResponseOutputItemAddedEventSchema =
  qwenLiveServerEventEnvelopeSchema.extend({
    type: z.literal("response.output_item.added"),
    response_id: qwenRealtimeIdentifierSchema,
    output_index: qwenLiveResponseIndexSchema,
    item: z
      .object({
        id: qwenRealtimeIdentifierSchema,
        object: z.literal("realtime.item"),
        type: z.literal("message"),
        status: z.literal("in_progress"),
        role: z.literal("assistant"),
        content: z.array(z.never()).length(0),
      })
      .passthrough(),
  });

export const qwenLiveResponseContentPartAddedEventSchema =
  qwenLiveServerEventEnvelopeSchema.extend({
    type: z.literal("response.content_part.added"),
    response_id: qwenRealtimeIdentifierSchema,
    item_id: qwenRealtimeIdentifierSchema,
    output_index: qwenLiveResponseIndexSchema,
    content_index: qwenLiveResponseIndexSchema,
    part: z
      .object({
        type: z.literal("text"),
        text: z.literal(""),
      })
      .passthrough(),
  });

export const qwenLiveResponseContentPartDoneEventSchema =
  qwenLiveServerEventEnvelopeSchema.extend({
    type: z.literal("response.content_part.done"),
    response_id: qwenRealtimeIdentifierSchema,
    item_id: qwenRealtimeIdentifierSchema,
    output_index: qwenLiveResponseIndexSchema,
    content_index: qwenLiveResponseIndexSchema,
    part: qwenLiveResponseTextPartSchema,
  });

export const qwenLiveResponseOutputItemDoneEventSchema =
  qwenLiveServerEventEnvelopeSchema.extend({
    type: z.literal("response.output_item.done"),
    response_id: qwenRealtimeIdentifierSchema,
    output_index: qwenLiveResponseIndexSchema,
    item: z
      .object({
        id: qwenRealtimeIdentifierSchema,
        object: z.literal("realtime.item"),
        type: z.literal("message"),
        status: z.literal("completed"),
        role: z.literal("assistant"),
        content: z.tuple([qwenLiveResponseTextPartSchema]),
      })
      .passthrough(),
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
  event_id: qwenRealtimeIdentifierSchema,
  type: z.literal("session.update"),
  session: z
    .object({
      modalities: z.union([
        z.tuple([z.literal("text")]),
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

/**
 * Official Qwen-Audio WebSocket client shape used by the isolated live probe.
 * The isolated text-only probe sends only its two documented singleton
 * controls. Each event deliberately has no client event_id, so a rejected
 * update remains attributable to one fixed stage.
 */
export const qwenLiveSessionUpdatePatchSchema = z
  .object({
    type: z.literal("session.update"),
    session: z.union([
      z
        .object({
          modalities: z.tuple([z.literal("text")]),
        })
        .strict(),
      z.object({ instructions: z.string().min(1) }).strict(),
    ]),
  })
  .strict();

export type QwenLiveSessionUpdatePatch = z.infer<
  typeof qwenLiveSessionUpdatePatchSchema
>;

export type QwenSessionUpdateEvent = z.infer<
  typeof qwenSessionUpdateEventSchema
>;

export const qwenInputAudioBufferAppendEventSchema = z
  .object({
    event_id: qwenRealtimeIdentifierSchema,
    type: z.literal("input_audio_buffer.append"),
    audio: qwenPcmBase64Schema,
  })
  .strict();

export type QwenInputAudioBufferAppendEvent = z.infer<
  typeof qwenInputAudioBufferAppendEventSchema
>;

export const qwenUserTextItemCreateEventSchema = z.object({
  event_id: qwenRealtimeIdentifierSchema,
  type: z.literal("conversation.item.create"),
  item: z
    .object({
      id: qwenRealtimeIdentifierSchema.optional(),
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
    event_id: qwenRealtimeIdentifierSchema,
    type: z.literal("response.create"),
    response: z
      .object({
        modalities: z.union([
          z.tuple([z.literal("text")]),
          z.tuple([z.literal("audio"), z.literal("text")]),
          z.tuple([z.literal("text"), z.literal("audio")]),
        ]),
      })
      .strict()
      .optional(),
  })
  .strict();

export const qwenLiveUserTextItemCreateEventSchema =
  qwenUserTextItemCreateEventSchema.omit({ event_id: true }).strict();

export const qwenLiveResponseCreateEventSchema = qwenResponseCreateEventSchema
  .omit({ event_id: true })
  .strict();

export const qwenResponseCancelEventSchema = z
  .object({
    event_id: qwenRealtimeIdentifierSchema,
    type: z.literal("response.cancel"),
  })
  .strict();

export type QwenResponseCancelEvent = z.infer<
  typeof qwenResponseCancelEventSchema
>;

export function parseQwenServerEvent(input: string): QwenServerEvent {
  return qwenServerEventSchema.parse(JSON.parse(input) as unknown);
}
