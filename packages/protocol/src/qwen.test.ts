import { describe, expect, it } from "vitest";

import { parseQwenServerEvent, qwenSessionUpdateEventSchema } from "./qwen.js";

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
});
