import { describe, expect, it } from "vitest";

import {
  doubaoInputAudioAppendEventSchema,
  doubaoOutputAudioDeltaEventSchema,
  doubaoRealtimeModelSchema,
  doubaoSessionCloseEventSchema,
  doubaoSpeechTextCommitEventSchema,
  parseDoubaoEvent,
} from "./doubao.js";

describe("Doubao realtime protocol", () => {
  it("accepts the fixed Seeduplex model and PCM events", () => {
    expect(doubaoRealtimeModelSchema.parse("1.2.6.1")).toBe("1.2.6.1");
    expect(
      doubaoInputAudioAppendEventSchema.safeParse({
        event_id: "event_audio",
        type: "input_audio_buffer.append",
        audio: "AAE=",
      }).success,
    ).toBe(true);
    expect(
      doubaoOutputAudioDeltaEventSchema.safeParse({
        type: "response.output_audio.delta",
        delta: "AAE=",
      }).success,
    ).toBe(true);
    expect(
      doubaoSpeechTextCommitEventSchema.safeParse({
        event_id: "event_greeting",
        type: "speech_text_buffer.commit",
        speech_id: "speech_greeting",
        text: "你好。",
      }).success,
    ).toBe(true);
  });

  it("accepts administrator-configured model ids and rejects close events without an id", () => {
    expect(doubaoRealtimeModelSchema.safeParse("latest").success).toBe(true);
    expect(
      doubaoSessionCloseEventSchema.safeParse({ type: "session.close" })
        .success,
    ).toBe(false);
  });

  it("parses passthrough server events", () => {
    expect(
      parseDoubaoEvent(
        JSON.stringify({ type: "response.done", usage: { total_tokens: 3 } }),
      ),
    ).toMatchObject({ type: "response.done" });
  });
});
