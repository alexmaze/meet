import { z } from "zod";

export const doubaoRealtimeModelSchema = z.literal("1.2.6.1");

export type DoubaoRealtimeModel = z.infer<typeof doubaoRealtimeModelSchema>;

export const doubaoEventSchema = z
  .object({
    event_id: z.string().optional(),
    type: z.string().min(1),
  })
  .passthrough();

export type DoubaoEvent = z.infer<typeof doubaoEventSchema>;

export const doubaoPcmBase64Schema = z.base64().min(1);

export const doubaoInputAudioAppendEventSchema = z
  .object({
    event_id: z.string().min(1),
    type: z.literal("input_audio_buffer.append"),
    audio: doubaoPcmBase64Schema,
  })
  .strict();

export const doubaoInputAudioCommitEventSchema = z
  .object({
    event_id: z.string().min(1),
    type: z.literal("input_audio_buffer.commit"),
  })
  .strict();

export const doubaoResponseCancelEventSchema = z
  .object({
    event_id: z.string().min(1),
    type: z.literal("response.cancel"),
  })
  .strict();

export const doubaoSessionCloseEventSchema = z
  .object({
    event_id: z.string().min(1),
    type: z.literal("session.close"),
  })
  .strict();

export const doubaoSpeechTextCommitEventSchema = z
  .object({
    event_id: z.string().min(1),
    type: z.literal("speech_text_buffer.commit"),
    speech_id: z.string().min(1),
    text: z.string().trim().min(1),
  })
  .strict();

export const doubaoSessionCreatedEventSchema = doubaoEventSchema.extend({
  type: z.literal("session.created"),
  session: z
    .object({
      id: z.string().min(1),
    })
    .passthrough(),
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

export const doubaoOutputTextDeltaEventSchema = doubaoEventSchema.extend({
  type: z.literal("response.output_text.delta"),
  response_id: z.string().min(1).optional(),
  delta: z.string(),
});

export const doubaoOutputTextDoneEventSchema = doubaoEventSchema.extend({
  type: z.literal("response.output_text.done"),
  response_id: z.string().min(1).optional(),
  text: z.string().optional(),
});

export const doubaoOutputAudioStartedEventSchema = doubaoEventSchema.extend({
  type: z.literal("response.output_audio.started"),
  question_id: z.string().optional(),
  response_id: z.string().optional(),
});

export const doubaoOutputAudioDeltaEventSchema = doubaoEventSchema.extend({
  type: z.literal("response.output_audio.delta"),
  question_id: z.string().optional(),
  response_id: z.string().min(1).optional(),
  delta: doubaoPcmBase64Schema,
});

export const doubaoOutputAudioDoneEventSchema = doubaoEventSchema.extend({
  type: z.literal("response.output_audio.done"),
  question_id: z.string().optional(),
  response_id: z.string().min(1),
  status_code: z.union([z.string(), z.number()]).optional(),
});

export const doubaoResponseCanceledEventSchema = doubaoEventSchema.extend({
  type: z.literal("response.canceled"),
});

export const doubaoErrorEventSchema = doubaoEventSchema.extend({
  type: z.literal("error"),
  status_code: z.union([z.string(), z.number()]).optional(),
  code: z.union([z.string(), z.number()]).optional(),
  message: z.string().optional(),
});

export function parseDoubaoEvent(input: string): DoubaoEvent {
  return doubaoEventSchema.parse(JSON.parse(input) as unknown);
}
