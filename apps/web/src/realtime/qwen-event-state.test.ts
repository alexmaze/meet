import { describe, expect, it } from "vitest";

import { initialQwenProjection, projectQwenEvent } from "./qwen-event-state.js";

describe("Qwen conversation projection", () => {
  it("assembles assistant transcript deltas and commits on response.done", () => {
    const started = projectQwenEvent(initialQwenProjection, {
      type: "response.created",
      response: { id: "resp_assistant", status: "in_progress" },
    }).state;
    const first = projectQwenEvent(started, {
      type: "response.audio_transcript.delta",
      response_id: "resp_assistant",
      delta: "你",
    }).state;
    const second = projectQwenEvent(first, {
      type: "response.audio_transcript.delta",
      response_id: "resp_assistant",
      delta: "好",
    }).state;
    const done = projectQwenEvent(second, {
      type: "response.done",
      response: { id: "resp_assistant", status: "completed" },
    });

    expect(done.commits).toEqual([{ speaker: "assistant", text: "你好" }]);
    expect(done.state.responseActive).toBe(false);
  });

  it("ignores a late done event from an older response", () => {
    const active = projectQwenEvent(initialQwenProjection, {
      type: "response.created",
      response: { id: "resp_new", status: "in_progress" },
    }).state;
    const result = projectQwenEvent(active, {
      type: "response.done",
      response: {
        id: "resp_old",
        status: "cancelled",
        status_details: { reason: "turn_detected" },
      },
    });

    expect(result.state.responseActive).toBe(true);
    expect(result.state.activeResponseId).toBe("resp_new");
    expect(result.state.activity).toBe("assistant_speaking");
  });

  it("lets smart_turn decide whether speech should interrupt an active response", () => {
    const active = {
      ...initialQwenProjection,
      activity: "assistant_speaking" as const,
      responseActive: true,
    };
    const result = projectQwenEvent(active, {
      type: "input_audio_buffer.speech_started",
      item_id: "item_interrupt",
    });

    expect(result.state.activity).toBe("user_speaking");
    expect(result.state.responseActive).toBe(true);
  });

  it("restores assistant activity when smart_turn rejects background speech", () => {
    const active = {
      ...initialQwenProjection,
      activity: "user_speaking" as const,
      responseActive: true,
    };
    const result = projectQwenEvent(active, {
      type: "input_audio_buffer.speech_stopped",
      item_id: "item_background",
      reason: "turn_invalid",
    });

    expect(result.state.activity).toBe("assistant_speaking");
    expect(result.state.responseActive).toBe(true);
  });

  it("returns to listening when smart_turn rejects speech without an active response", () => {
    const result = projectQwenEvent(
      {
        ...initialQwenProjection,
        activity: "user_speaking",
      },
      {
        type: "input_audio_buffer.speech_stopped",
        item_id: "item_background_without_response",
        reason: "turn_invalid",
      },
    );

    expect(result.state.activity).toBe("listening");
  });

  it("keeps showing user speech when smart_turn cancels an interrupted response", () => {
    const speaking = {
      ...initialQwenProjection,
      activity: "user_speaking" as const,
      responseActive: true,
      activeResponseId: "resp_interrupted",
    };
    const result = projectQwenEvent(speaking, {
      type: "response.done",
      response: {
        id: "resp_interrupted",
        status: "cancelled",
        status_details: { reason: "turn_detected" },
      },
    });

    expect(result.state.activity).toBe("user_speaking");
    expect(result.state.responseActive).toBe(false);
  });

  it("shows committed and in-progress user transcription together", () => {
    const result = projectQwenEvent(initialQwenProjection, {
      type: "conversation.item.input_audio_transcription.delta",
      text: "帮我算",
      stash: "一下",
    });

    expect(result.state.userDraft).toBe("帮我算一下");
  });

  it("does not add ambient audio transcription to the conversation", () => {
    const result = projectQwenEvent(initialQwenProjection, {
      type: "conversation.item.ambient_audio_transcription.completed",
      transcript: "电视里的声音",
    });

    expect(result.commits).toEqual([]);
    expect(result.state).toEqual(initialQwenProjection);
  });

  it("ignores transcript delta and done events for a non-active response", () => {
    const active = {
      ...initialQwenProjection,
      activity: "assistant_speaking" as const,
      responseActive: true,
      activeResponseId: "response-b",
      assistantDraft: "B",
    };
    const afterDelta = projectQwenEvent(active, {
      type: "response.audio_transcript.delta",
      response_id: "response-a",
      delta: "A旧字幕",
    }).state;
    const afterTranscriptDone = projectQwenEvent(afterDelta, {
      type: "response.audio_transcript.done",
      response_id: "response-a",
      transcript: "A完整旧字幕",
    }).state;
    const afterResponseDone = projectQwenEvent(afterTranscriptDone, {
      type: "response.done",
      response: { id: "response-a", status: "completed" },
    });

    expect(afterResponseDone.state).toEqual(active);
    expect(afterResponseDone.commits).toEqual([]);
  });
});
