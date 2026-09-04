import { z } from "zod";

const doubaoEventIdSchema = z.string().min(1).max(160);
const doubaoEntityIdSchema = z.string().min(1).max(256);

export const doubaoRealtimeModelSchema = z.string().trim().min(1).max(160);

export type DoubaoRealtimeModel = z.infer<typeof doubaoRealtimeModelSchema>;

const doubaoLiveSessionConfigSchema = z
  .object({
    type: z.literal("realtime"),
    model: doubaoRealtimeModelSchema,
    instructions: z.string().min(1).max(12_000),
    audio: z
      .object({
        input: z
          .object({
            format: z
              .object({
                type: z.literal("pcm"),
                rate: z.number().int().positive(),
              })
              .passthrough(),
          })
          .passthrough(),
        output: z
          .object({
            format: z
              .object({
                type: z.literal("pcm_s16le"),
                rate: z.number().int().positive(),
              })
              .passthrough(),
            voice: z.string().min(1).max(160),
            speed: z.number().finite(),
            loudness: z.number().finite(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export const doubaoEventSchema = z
  .object({
    event_id: doubaoEventIdSchema.optional(),
    type: z.string().min(1).max(160),
  })
  .passthrough();

export type DoubaoEvent = z.infer<typeof doubaoEventSchema>;

export const doubaoPcmBase64Schema = z.base64().min(1);

export const doubaoInputAudioAppendEventSchema = z
  .object({
    event_id: doubaoEventIdSchema,
    type: z.literal("input_audio_buffer.append"),
    audio: doubaoPcmBase64Schema,
  })
  .strict();

export const doubaoInputAudioCommitEventSchema = z
  .object({
    event_id: doubaoEventIdSchema,
    type: z.literal("input_audio_buffer.commit"),
  })
  .strict();

export const doubaoResponseCancelEventSchema = z
  .object({
    event_id: doubaoEventIdSchema,
    type: z.literal("response.cancel"),
  })
  .strict();

export const doubaoSessionCloseEventSchema = z
  .object({
    event_id: doubaoEventIdSchema,
    type: z.literal("session.close"),
  })
  .strict();

export const doubaoSpeechTextCommitEventSchema = z
  .object({
    event_id: doubaoEventIdSchema,
    type: z.literal("speech_text_buffer.commit"),
    speech_id: doubaoEntityIdSchema,
    text: z.string().trim().min(1),
  })
  .strict();

export const doubaoSessionCreatedEventSchema = doubaoEventSchema.extend({
  type: z.literal("session.created"),
  session: z
    .object({
      id: doubaoEntityIdSchema,
    })
    .passthrough(),
});

/**
 * Strict evidence shape for the isolated teaching probe. The current Provider
 * examples may emit a bare ACK; that shape intentionally fails closed because
 * it cannot bind an applied revision to a complete session snapshot.
 */
export const doubaoSessionUpdatedEventSchema = doubaoEventSchema.extend({
  event_id: doubaoEventIdSchema,
  type: z.literal("session.updated"),
  session: doubaoLiveSessionConfigSchema.extend({
    id: doubaoEntityIdSchema,
  }),
});

export const doubaoSessionClosedEventSchema = doubaoEventSchema.extend({
  type: z.literal("session.closed"),
});

export const doubaoInputAudioCommittedEventSchema = doubaoEventSchema.extend({
  type: z.literal("input_audio_buffer.committed"),
});

export const doubaoUserTranscriptionStartedEventSchema =
  doubaoEventSchema.extend({
    type: z.literal("conversation.item.input_audio_transcription.started"),
  });

export const doubaoUserTranscriptionDeltaEventSchema = doubaoEventSchema.extend(
  {
    type: z.literal("conversation.item.input_audio_transcription.delta"),
    delta: z.string().optional(),
    text: z.string().optional(),
  },
);

export const doubaoUserTranscriptionCompletedEventSchema =
  doubaoEventSchema.extend({
    type: z.literal("conversation.item.input_audio_transcription.completed"),
    transcript: z.string().optional(),
    text: z.string().optional(),
  });

export const doubaoUserTranscriptionFailedEventSchema =
  doubaoEventSchema.extend({
    type: z.literal("conversation.item.input_audio_transcription.failed"),
    error: z
      .object({
        type: z.string().max(160).optional(),
        code: z.union([z.string().max(160), z.number()]).optional(),
        message: z.string().optional(),
        param: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
  });

export const doubaoOutputTextDeltaEventSchema = doubaoEventSchema.extend({
  type: z.literal("response.output_text.delta"),
  response_id: doubaoEntityIdSchema.optional(),
  delta: z.string(),
});

export const doubaoOutputTextDoneEventSchema = doubaoEventSchema.extend({
  type: z.literal("response.output_text.done"),
  response_id: doubaoEntityIdSchema.optional(),
  text: z.string().optional(),
});

export const doubaoOutputAudioStartedEventSchema = doubaoEventSchema.extend({
  type: z.literal("response.output_audio.started"),
  question_id: z.string().max(256).optional(),
  response_id: z.string().max(256).optional(),
});

export const doubaoOutputAudioDeltaEventSchema = doubaoEventSchema.extend({
  type: z.literal("response.output_audio.delta"),
  question_id: z.string().max(256).optional(),
  response_id: doubaoEntityIdSchema.optional(),
  delta: doubaoPcmBase64Schema,
});

export const doubaoOutputAudioDoneEventSchema = doubaoEventSchema.extend({
  type: z.literal("response.output_audio.done"),
  question_id: z.string().max(256).optional(),
  response_id: doubaoEntityIdSchema,
  status_code: z.union([z.string(), z.number()]).optional(),
});

export const doubaoResponseCanceledEventSchema = doubaoEventSchema.extend({
  type: z.literal("response.canceled"),
});

/**
 * Strict evidence shape for the isolated teaching probe. A usage-only
 * response.done cannot prove which response finished or that it succeeded.
 */
export const doubaoResponseDoneEventSchema = doubaoEventSchema.extend({
  event_id: doubaoEventIdSchema,
  type: z.literal("response.done"),
  response_id: doubaoEntityIdSchema,
  status: z.enum(["completed", "failed", "cancelled", "incomplete"]),
  usage: z.record(z.string(), z.unknown()).optional(),
});

export const doubaoErrorEventSchema = doubaoEventSchema.extend({
  type: z.literal("error"),
  status_code: z.union([z.string(), z.number()]).optional(),
  code: z.union([z.string().max(160), z.number()]).optional(),
  message: z.string().optional(),
  error: z
    .object({
      type: z.string().max(160).optional(),
      code: z.union([z.string().max(160), z.number()]).optional(),
      message: z.string().optional(),
      param: z.unknown().optional(),
    })
    .passthrough()
    .optional(),
});

export function parseDoubaoEvent(input: string): DoubaoEvent {
  return doubaoEventSchema.parse(JSON.parse(input) as unknown);
}
