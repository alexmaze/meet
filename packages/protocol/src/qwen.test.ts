import { describe, expect, it } from "vitest";

import {
  QWEN_REALTIME_MAX_EVENT_TYPE_CHARACTERS,
  QWEN_REALTIME_MAX_IDENTIFIER_CHARACTERS,
  parseQwenServerEvent,
  qwenAssistantTranscriptDeltaSchema,
  qwenAssistantTranscriptDoneSchema,
  qwenInputAudioBufferCommittedEventSchema,
  qwenInputAudioBufferAppendEventSchema,
  qwenLiveConversationItemCreatedEventSchema,
  qwenLiveResponseContentPartAddedEventSchema,
  qwenLiveResponseContentPartDoneEventSchema,
  qwenLiveResponseDoneEventSchema,
  qwenLiveResponseOutputItemAddedEventSchema,
  qwenLiveResponseOutputItemDoneEventSchema,
  qwenLiveResponseCreateEventSchema,
  qwenLiveSessionCreatedEventSchema,
  qwenLiveSessionUpdatePatchSchema,
  qwenLiveSessionUpdatedEventSchema,
  qwenLiveUserTextItemCreateEventSchema,
  qwenResponseAudioDeltaEventSchema,
  qwenResponseCancelEventSchema,
  qwenResponseContentPartAddedEventSchema,
  qwenResponseCreateEventSchema,
  qwenResponseCreatedEventSchema,
  qwenResponseDoneEventSchema,
  qwenResponseTextDeltaEventSchema,
  qwenResponseTextDoneEventSchema,
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

  it("bounds event, response, and item identifiers used by live probes", () => {
    expect(() =>
      parseQwenServerEvent(
        JSON.stringify({
          event_id: "e".repeat(QWEN_REALTIME_MAX_IDENTIFIER_CHARACTERS + 1),
          type: "session.created",
        }),
      ),
    ).toThrow();
    expect(() =>
      parseQwenServerEvent(
        JSON.stringify({
          event_id: "event_1",
          type: "t".repeat(QWEN_REALTIME_MAX_EVENT_TYPE_CHARACTERS + 1),
        }),
      ),
    ).toThrow();
    expect(
      qwenResponseCreatedEventSchema.safeParse({
        event_id: "event_response_created",
        type: "response.created",
        response: {
          id: "r".repeat(QWEN_REALTIME_MAX_IDENTIFIER_CHARACTERS + 1),
        },
      }).success,
    ).toBe(false);
    expect(
      qwenLiveConversationItemCreatedEventSchema.safeParse({
        event_id: "event_item_created",
        type: "conversation.item.created",
        item: {
          id: "i".repeat(QWEN_REALTIME_MAX_IDENTIFIER_CHARACTERS + 1),
          object: "realtime.item",
          type: "message",
          status: "completed",
          role: "user",
          content: [],
        },
      }).success,
    ).toBe(false);
  });

  it("accepts complete and staged live session acknowledgements", () => {
    const session = {
      id: "sess_live_1",
      object: "realtime.session",
      model: "qwen-audio-3.0-realtime-plus",
      modalities: ["text", "audio"],
      voice: "longanqian",
      turn_detection: { type: "smart_turn" },
    };

    expect(
      qwenLiveSessionCreatedEventSchema.safeParse({
        event_id: "event_session_created",
        type: "session.created",
        session,
      }).success,
    ).toBe(true);
    expect(
      qwenLiveSessionUpdatedEventSchema.safeParse({
        event_id: "event_session_updated",
        type: "session.updated",
        session: { ...session, instructions: "固定基础指令" },
      }).success,
    ).toBe(true);
    expect(
      qwenLiveSessionUpdatedEventSchema.safeParse({
        event_id: "event_missing_instructions",
        type: "session.updated",
        session,
      }).success,
    ).toBe(true);
    expect(
      qwenLiveSessionUpdatedEventSchema.safeParse({
        event_id: "event_empty_instructions",
        type: "session.updated",
        session: { ...session, instructions: "" },
      }).success,
    ).toBe(true);
    for (const instructions of [42, null, []]) {
      expect(
        qwenLiveSessionUpdatedEventSchema.safeParse({
          event_id: "event_invalid_instructions",
          type: "session.updated",
          session: { ...session, instructions },
        }).success,
      ).toBe(false);
    }
    expect(
      qwenLiveSessionUpdatedEventSchema.safeParse({
        event_id: "event_complete_staged_snapshot",
        type: "session.updated",
        session: {
          ...session,
          input_audio_format: "pcm",
          output_audio_format: "pcm",
          max_history_turns: 1,
          instructions: "固定基础指令",
        },
      }).success,
    ).toBe(true);
    expect(
      qwenLiveConversationItemCreatedEventSchema.safeParse({
        event_id: "event_item_created",
        type: "conversation.item.created",
        item: {
          id: "item_user_1",
          object: "realtime.item",
          type: "message",
          status: "completed",
          role: "user",
          content: [{ type: "input_text", text: "固定测试输入" }],
        },
      }).success,
    ).toBe(true);
    expect(
      qwenLiveConversationItemCreatedEventSchema.safeParse({
        type: "conversation.item.created",
        item: {
          id: "item_user_1",
          object: "realtime.item",
          type: "message",
          status: "completed",
          role: "user",
          content: [],
        },
      }).success,
    ).toBe(false);
  });

  it("accepts a null or missing previous item id on the first live item ACK", () => {
    const item = {
      id: "item_user_1",
      object: "realtime.item",
      type: "message",
      status: "completed",
      role: "user",
      content: [{ type: "input_text", text: "固定测试输入" }],
    };

    for (const previousItem of [
      {},
      { previous_item_id: null },
      { previous_item_id: "item_previous" },
    ]) {
      expect(
        qwenLiveConversationItemCreatedEventSchema.safeParse({
          event_id: "event_item_created",
          type: "conversation.item.created",
          ...previousItem,
          item,
        }).success,
      ).toBe(true);
    }

    for (const previous_item_id of [0, false, {}, []]) {
      expect(
        qwenLiveConversationItemCreatedEventSchema.safeParse({
          event_id: "event_item_created",
          type: "conversation.item.created",
          previous_item_id,
          item,
        }).success,
      ).toBe(false);
    }
  });

  it.each([{ modalities: ["text"] }, { instructions: "固定基础指令" }])(
    "accepts one official live session field without client event_id",
    (session) => {
      expect(
        qwenLiveSessionUpdatePatchSchema.safeParse({
          type: "session.update",
          session,
        }).success,
      ).toBe(true);
    },
  );

  it("rejects client event_id and multi-field live session patches", () => {
    expect(
      qwenLiveSessionUpdatePatchSchema.safeParse({
        event_id: "undocumented_client_event",
        type: "session.update",
        session: { voice: "longanqian" },
      }).success,
    ).toBe(false);
    expect(
      qwenLiveSessionUpdatePatchSchema.safeParse({
        type: "session.update",
        session: { voice: "longanqian", modalities: ["text"] },
      }).success,
    ).toBe(false);
  });

  it.each([
    { voice: "longanqian" },
    { input_audio_format: "pcm" },
    { output_audio_format: "pcm" },
    { turn_detection: { type: "smart_turn" } },
    { max_history_turns: 1 },
    { modalities: ["audio", "text"] },
    { instructions: "" },
  ])("rejects non-probe singleton live session patches", (session) => {
    expect(
      qwenLiveSessionUpdatePatchSchema.safeParse({
        type: "session.update",
        session,
      }).success,
    ).toBe(false);
  });

  it("validates official live text item and response shapes without client event_id", () => {
    expect(
      qwenLiveUserTextItemCreateEventSchema.safeParse({
        type: "conversation.item.create",
        item: {
          id: "item_live_text",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "固定文本" }],
        },
      }).success,
    ).toBe(true);
    expect(
      qwenLiveResponseCreateEventSchema.safeParse({
        type: "response.create",
        response: { modalities: ["text"] },
      }).success,
    ).toBe(true);
    expect(
      qwenLiveResponseCreateEventSchema.safeParse({
        event_id: "undocumented_client_event",
        type: "response.create",
        response: { modalities: ["text"] },
      }).success,
    ).toBe(false);
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

  it("accepts the documented Qwen-Audio text-only output modality", () => {
    const result = qwenSessionUpdateEventSchema.safeParse({
      event_id: "event_text_only",
      type: "session.update",
      session: {
        modalities: ["text"],
        voice: "longanqian",
        input_audio_format: "pcm",
        output_audio_format: "pcm",
        instructions: "只返回文本。",
        max_history_turns: 1,
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
          id: "item_opening_request",
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
      qwenUserTextItemCreateEventSchema.safeParse({
        event_id: "event_opening_item",
        type: "conversation.item.create",
        item: {
          id: "i".repeat(QWEN_REALTIME_MAX_IDENTIFIER_CHARACTERS + 1),
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "测试" }],
        },
      }).success,
    ).toBe(false);

    expect(
      qwenResponseCreateEventSchema.safeParse({
        event_id: "event_opening_response",
        type: "response.create",
        response: { modalities: ["text"] },
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

  it("requires consistent token details for billable live response evidence", () => {
    const event = {
      event_id: "event_usage",
      type: "response.done",
      response: {
        id: "resp_usage",
        status: "completed",
        modalities: ["text"],
        usage: {
          total_tokens: 16,
          input_tokens: 10,
          output_tokens: 6,
          input_tokens_details: { text_tokens: 10 },
          output_tokens_details: { text_tokens: 6, audio_tokens: 0 },
        },
      },
    };

    expect(qwenLiveResponseDoneEventSchema.safeParse(event).success).toBe(true);
    expect(
      qwenLiveResponseDoneEventSchema.safeParse({
        ...event,
        response: {
          ...event.response,
          usage: { ...event.response.usage, total_tokens: 15 },
        },
      }).success,
    ).toBe(false);
    expect(
      qwenLiveResponseDoneEventSchema.safeParse({
        ...event,
        response: {
          ...event.response,
          usage: {
            ...event.response.usage,
            output_tokens_details: { text_tokens: 2, audio_tokens: 4 },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      qwenLiveResponseDoneEventSchema.safeParse({
        ...event,
        response: { ...event.response, modalities: ["text", "audio"] },
      }).success,
    ).toBe(false);
    expect(
      qwenLiveResponseDoneEventSchema.safeParse({
        ...event,
        response: { id: "resp_usage", status: "completed" },
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

  it("validates Qwen-Audio text-only response events with full correlation fields", () => {
    const common = {
      event_id: "event_text",
      response_id: "resp_text",
      item_id: "item_text",
      output_index: 0,
      content_index: 0,
    };
    expect(
      qwenResponseTextDeltaEventSchema.safeParse({
        ...common,
        type: "response.text.delta",
        delta: "你好",
      }).success,
    ).toBe(true);
    expect(
      qwenResponseTextDoneEventSchema.safeParse({
        ...common,
        type: "response.text.done",
        text: "你好",
      }).success,
    ).toBe(true);
    expect(
      qwenResponseTextDeltaEventSchema.safeParse({
        ...common,
        type: "response.text.delta",
        item_id: undefined,
        delta: "缺少消息标识",
      }).success,
    ).toBe(false);
  });

  it("strictly validates the four harmless live text response lifecycle events", () => {
    const common = {
      event_id: "event_meta",
      response_id: "resp_text",
      item_id: "item_text",
      output_index: 0,
      content_index: 0,
    };
    const addedItem = {
      id: "item_text",
      object: "realtime.item",
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
    };
    const completedItem = {
      ...addedItem,
      status: "completed",
      content: [{ type: "text", text: "A7K2" }],
    };

    expect(
      qwenLiveResponseOutputItemAddedEventSchema.safeParse({
        event_id: common.event_id,
        type: "response.output_item.added",
        response_id: common.response_id,
        output_index: common.output_index,
        item: addedItem,
      }).success,
    ).toBe(true);
    expect(
      qwenLiveResponseContentPartAddedEventSchema.safeParse({
        ...common,
        type: "response.content_part.added",
        part: { type: "text", text: "" },
      }).success,
    ).toBe(true);
    expect(
      qwenLiveResponseContentPartDoneEventSchema.safeParse({
        ...common,
        type: "response.content_part.done",
        part: { type: "text", text: "A7K2" },
      }).success,
    ).toBe(true);
    expect(
      qwenLiveResponseOutputItemDoneEventSchema.safeParse({
        event_id: common.event_id,
        type: "response.output_item.done",
        response_id: common.response_id,
        output_index: common.output_index,
        item: completedItem,
      }).success,
    ).toBe(true);

    expect(
      qwenLiveResponseContentPartAddedEventSchema.safeParse({
        ...common,
        type: "response.content_part.added",
        response_id: "r".repeat(QWEN_REALTIME_MAX_IDENTIFIER_CHARACTERS + 1),
        part: { type: "text", text: "" },
      }).success,
    ).toBe(false);
    expect(
      qwenLiveResponseContentPartDoneEventSchema.safeParse({
        ...common,
        type: "response.content_part.done",
        part: { type: "audio", text: "" },
      }).success,
    ).toBe(false);
    expect(
      qwenLiveResponseOutputItemAddedEventSchema.safeParse({
        event_id: common.event_id,
        type: "response.output_item.added",
        response_id: common.response_id,
        output_index: common.output_index,
        item: { ...addedItem, type: "function_call" },
      }).success,
    ).toBe(false);
  });
});
