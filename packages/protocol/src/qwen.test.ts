import { describe, expect, it } from "vitest";

import {
  parseQwenServerEvent,
  qwenAssistantTranscriptDeltaSchema,
  qwenAssistantTranscriptDoneSchema,
  qwenInputAudioBufferCommittedEventSchema,
  qwenInputAudioBufferAppendEventSchema,
  qwenResponseAudioDeltaEventSchema,
  qwenResponseCancelEventSchema,
  qwenResponseContentPartAddedEventSchema,
  qwenResponseCreateEventSchema,
  qwenResponseCreatedEventSchema,
  qwenResponseDoneEventSchema,
  qwenSessionUpdateEventSchema,
  qwenSpeechStartedEventSchema,
  qwenSpeechStoppedEventSchema,
  qwenUserTextItemCreateEventSchema,
} from "./qwen.js";

describe("Qwen realtime protocol", () => {
  it("preserves provider-specific fields on server events", () => {
    const event = parseQwenServerEvent(
      JSON.stringify({
        event_id: "event_1",
        type: "response.audio_transcript.delta",
        delta: "你好",
      }),
    );

    expect(event.type).toBe("response.audio_transcript.delta");
    expect(event.delta).toBe("你好");
  });

  it("preserves WebSocket PCM chunks when parsing server events", () => {
    const event = parseQwenServerEvent(
      JSON.stringify({
        event_id: "event_audio_1",
        type: "response.audio.delta",
        response_id: "resp_1",
        item_id: "item_1",
        output_index: 0,
        content_index: 0,
        delta: "AQIDBA==",
      }),
    );
    const parsed = qwenResponseAudioDeltaEventSchema.parse(event);

    expect(parsed.response_id).toBe("resp_1");
    expect(parsed.delta).toBe("AQIDBA==");
  });

  it("rejects malformed events", () => {
    expect(() => parseQwenServerEvent('{"delta":"你好"}')).toThrow();
  });

  it("validates the Audio 3.0 smart-turn session update", () => {
    const result = qwenSessionUpdateEventSchema.safeParse({
      event_id: "event_2",
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice: "longanqian",
        input_audio_format: "pcm",
        output_audio_format: "pcm",
        instructions: "自然地和用户聊天。",
        max_history_turns: 50,
        turn_detection: {
          type: "smart_turn",
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects Omni-only session fields", () => {
    const result = qwenSessionUpdateEventSchema.safeParse({
      event_id: "event_3",
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice: "longanqian",
        input_audio_format: "pcm",
        output_audio_format: "pcm",
        instructions: "自然地和用户聊天。",
        max_history_turns: 50,
        smooth_output: false,
        turn_detection: {
          type: "smart_turn",
          prefix_padding_ms: 500,
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts the documented modality order", () => {
    const result = qwenSessionUpdateEventSchema.safeParse({
      event_id: "event_4",
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: "longanqian",
        input_audio_format: "pcm",
        output_audio_format: "pcm",
        instructions: "自然地和用户聊天。",
        max_history_turns: 50,
        turn_detection: { type: "smart_turn" },
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects manual turn detection for WebRTC", () => {
    const result = qwenSessionUpdateEventSchema.safeParse({
      event_id: "event_5",
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice: "longanqian",
        input_audio_format: "pcm",
        output_audio_format: "pcm",
        instructions: "自然地和用户聊天。",
        max_history_turns: 50,
        turn_detection: null,
      },
    });

    expect(result.success).toBe(false);
  });

  it("validates the synthetic user message used to trigger an opening", () => {
    expect(
      qwenUserTextItemCreateEventSchema.safeParse({
        event_id: "event_opening_item",
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "请自然地向用户打招呼。",
            },
          ],
        },
      }).success,
    ).toBe(true);

    expect(
      qwenResponseCreateEventSchema.safeParse({
        event_id: "event_opening_response",
        type: "response.create",
      }).success,
    ).toBe(true);
  });

  it("validates PCM input chunks and explicit response cancellation", () => {
    expect(
      qwenInputAudioBufferAppendEventSchema.safeParse({
        event_id: "event_audio_input",
        type: "input_audio_buffer.append",
        audio: "AQIDBA==",
      }).success,
    ).toBe(true);
    expect(
      qwenInputAudioBufferAppendEventSchema.safeParse({
        event_id: "event_audio_input_empty",
        type: "input_audio_buffer.append",
        audio: "",
      }).success,
    ).toBe(false);
    expect(
      qwenInputAudioBufferAppendEventSchema.safeParse({
        event_id: "event_audio_input_invalid",
        type: "input_audio_buffer.append",
        audio: "不是 Base64",
      }).success,
    ).toBe(false);
    expect(
      qwenResponseCancelEventSchema.safeParse({
        event_id: "event_cancel",
        type: "response.cancel",
      }).success,
    ).toBe(true);
  });

  it("correlates WebSocket audio content and PCM deltas by response", () => {
    expect(
      qwenResponseContentPartAddedEventSchema.safeParse({
        event_id: "event_part",
        type: "response.content_part.added",
        response_id: "resp_new",
        item_id: "item_new",
        output_index: 0,
        content_index: 0,
        part: {
          type: "audio",
          text: "",
        },
      }).success,
    ).toBe(true);
    expect(
      qwenResponseAudioDeltaEventSchema.safeParse({
        event_id: "event_delta",
        type: "response.audio.delta",
        response_id: "resp_new",
        item_id: "item_new",
        output_index: 0,
        content_index: 0,
        delta: "AQIDBA==",
      }).success,
    ).toBe(true);
    expect(
      qwenResponseContentPartAddedEventSchema.safeParse({
        type: "response.content_part.added",
        response_id: "resp_text",
        item_id: "item_text",
        output_index: 0,
        content_index: 0,
        part: {
          type: "text",
          text: "",
        },
      }).success,
    ).toBe(true);
    expect(
      qwenResponseAudioDeltaEventSchema.safeParse({
        type: "response.audio.delta",
        response_id: "resp_new",
        item_id: "item_new",
        output_index: 0,
        content_index: -1,
        delta: "AQIDBA==",
      }).success,
    ).toBe(false);
  });

  it("distinguishes valid and rejected smart-turn speech", () => {
    expect(
      qwenSpeechStartedEventSchema.safeParse({
        type: "input_audio_buffer.speech_started",
        item_id: "item_started",
      }).success,
    ).toBe(true);
    expect(
      qwenSpeechStartedEventSchema.safeParse({
        type: "input_audio_buffer.speech_started",
      }).success,
    ).toBe(false);
    expect(
      qwenSpeechStoppedEventSchema.safeParse({
        type: "input_audio_buffer.speech_stopped",
        item_id: "item_valid",
      }).success,
    ).toBe(true);
    expect(
      qwenSpeechStoppedEventSchema.safeParse({
        type: "input_audio_buffer.speech_stopped",
        item_id: "item_invalid",
        reason: "turn_invalid",
      }).success,
    ).toBe(true);
    expect(
      qwenInputAudioBufferCommittedEventSchema.safeParse({
        type: "input_audio_buffer.committed",
        item_id: "item_valid",
        previous_item_id: "item_previous",
      }).success,
    ).toBe(true);
    expect(
      qwenSpeechStoppedEventSchema.safeParse({
        type: "input_audio_buffer.speech_stopped",
        item_id: "item_unknown",
        reason: "unknown_reason",
      }).success,
    ).toBe(false);
  });

  it("validates completed, interrupted, manually cancelled, and failed responses", () => {
    const events = [
      {
        type: "response.done",
        response: { id: "resp_completed", status: "completed" },
      },
      {
        type: "response.done",
        response: {
          id: "resp_interrupted",
          status: "cancelled",
          status_details: { reason: "turn_detected" },
        },
      },
      {
        type: "response.done",
        response: {
          id: "resp_manual",
          status: "cancelled",
          status_details: { reason: "client_cancelled" },
        },
      },
      {
        type: "response.done",
        response: {
          id: "resp_failed",
          status: "failed",
          status_details: { reason: "provider_error" },
        },
      },
    ];

    expect(
      events.every(
        (event) => qwenResponseDoneEventSchema.safeParse(event).success,
      ),
    ).toBe(true);
    expect(
      qwenResponseDoneEventSchema.safeParse({
        type: "response.done",
        response: {
          id: "resp_unknown",
          status: "cancelled",
          status_details: { reason: "unknown_reason" },
        },
      }).success,
    ).toBe(false);
    expect(
      qwenResponseDoneEventSchema.safeParse({
        type: "response.done",
        response: { status: "completed" },
      }).success,
    ).toBe(false);
  });

  it("correlates a created response with its audio transcript deltas", () => {
    expect(
      qwenResponseCreatedEventSchema.safeParse({
        type: "response.created",
        response: {
          id: "resp_new",
          status: "in_progress",
          output: [],
        },
      }).success,
    ).toBe(true);
    expect(
      qwenAssistantTranscriptDeltaSchema.safeParse({
        type: "response.audio_transcript.delta",
        response_id: "resp_new",
        delta: "你好",
      }).success,
    ).toBe(true);
    expect(
      qwenAssistantTranscriptDeltaSchema.safeParse({
        type: "response.audio_transcript.delta",
        delta: "缺少响应标识",
      }).success,
    ).toBe(false);
    expect(
      qwenAssistantTranscriptDoneSchema.safeParse({
        type: "response.audio_transcript.done",
        response_id: "resp_new",
        transcript: "你好",
      }).success,
    ).toBe(true);
    expect(
      qwenAssistantTranscriptDoneSchema.safeParse({
        type: "response.audio_transcript.done",
        transcript: "缺少响应标识",
      }).success,
    ).toBe(false);
  });
});
