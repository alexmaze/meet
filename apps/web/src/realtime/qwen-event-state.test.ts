import { describe, expect, it } from "vitest";

import { initialQwenProjection, projectQwenEvent } from "./qwen-event-state.js";

describe("Qwen conversation projection", () => {
  it("assembles assistant transcript deltas and commits on response.done", () => {
    const started = projectQwenEvent(initialQwenProjection, {
      type: "response.created",
    }).state;
    const first = projectQwenEvent(started, {
      type: "response.audio_transcript.delta",
      delta: "你",
    }).state;
    const second = projectQwenEvent(first, {
      type: "response.audio_transcript.delta",
      delta: "好",
    }).state;
    const done = projectQwenEvent(second, { type: "response.done" });

    expect(done.commits).toEqual([{ speaker: "assistant", text: "你好" }]);
    expect(done.state.responseActive).toBe(false);
  });

  it("lets smart_turn decide whether speech should interrupt an active response", () => {
    const active = {
      ...initialQwenProjection,
      activity: "assistant_speaking" as const,
      responseActive: true,
    };
    const result = projectQwenEvent(active, {
      type: "input_audio_buffer.speech_started",
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
    };
    const result = projectQwenEvent(speaking, {
      type: "response.done",
      response: {
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
});
