import { describe, expect, it } from "vitest";

import {
  doubaoEventSchema,
  doubaoInputAudioAppendEventSchema,
  doubaoInputAudioCommittedEventSchema,
  doubaoOutputAudioDeltaEventSchema,
  doubaoOutputTextDeltaEventSchema,
  doubaoRealtimeModelSchema,
  doubaoResponseDoneEventSchema,
  doubaoSessionCloseEventSchema,
  doubaoSessionClosedEventSchema,
  doubaoSessionCreatedEventSchema,
  doubaoSessionUpdatedEventSchema,
  doubaoSpeechTextCommitEventSchema,
  doubaoUserTranscriptionFailedEventSchema,
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

  it("validates full-duplex ACK and terminal server events", () => {
    const session = {
      id: "dialog-1",
      type: "realtime",
      model: "1.2.6.1",
      instructions: "固定完整指令",
      audio: {
        input: { format: { type: "pcm", rate: 16_000 } },
        output: {
          format: { type: "pcm_s16le", rate: 24_000 },
          voice: "zh_female_vv_jupiter_bigtts",
          speed: 0,
          loudness: 0,
        },
      },
    };
    expect(
      doubaoSessionUpdatedEventSchema.safeParse({
        event_id: "provider-generated-id",
        type: "session.updated",
        session: { ...session, future_field: true },
      }).success,
    ).toBe(true);
    expect(
      doubaoSessionUpdatedEventSchema.safeParse({
        event_id: "provider-bare-ack",
        type: "session.updated",
      }).success,
    ).toBe(false);
    expect(
      doubaoInputAudioCommittedEventSchema.safeParse({
        event_id: "provider-commit-id",
        type: "input_audio_buffer.committed",
      }).success,
    ).toBe(true);
    expect(
      doubaoSessionClosedEventSchema.safeParse({ type: "session.closed" })
        .success,
    ).toBe(true);
    expect(
      doubaoResponseDoneEventSchema.safeParse({
        event_id: "provider-response-done",
        type: "response.done",
        response_id: "response-1",
        status: "completed",
        usage: { total_tokens: 3 },
      }).success,
    ).toBe(true);
    expect(
      doubaoResponseDoneEventSchema.safeParse({
        type: "response.done",
        usage: { total_tokens: 3 },
      }).success,
    ).toBe(false);
  });

  it("accepts the documented nested transcription failure envelope", () => {
    expect(
      doubaoUserTranscriptionFailedEventSchema.safeParse({
        event_id: "event-asr-failed",
        type: "conversation.item.input_audio_transcription.failed",
        item_id: "item-1",
        error: {
          type: "transcription_error",
          code: "audio_unintelligible",
          message: "The audio could not be transcribed.",
          param: null,
        },
      }).success,
    ).toBe(true);
  });

  it("rejects oversized inbound event and provider entity identifiers", () => {
    expect(
      doubaoEventSchema.safeParse({
        event_id: "e".repeat(161),
        type: "future.event",
      }).success,
    ).toBe(false);
    expect(doubaoEventSchema.safeParse({ type: "t".repeat(161) }).success).toBe(
      false,
    );
    expect(
      doubaoSessionCreatedEventSchema.safeParse({
        type: "session.created",
        session: { id: "s".repeat(257) },
      }).success,
    ).toBe(false);
    expect(
      doubaoOutputTextDeltaEventSchema.safeParse({
        type: "response.output_text.delta",
        response_id: "r".repeat(257),
        delta: "x",
      }).success,
    ).toBe(false);
    expect(
      doubaoOutputAudioDeltaEventSchema.safeParse({
        type: "response.output_audio.delta",
        question_id: "q".repeat(257),
        response_id: "response-1",
        delta: "AAE=",
      }).success,
    ).toBe(false);
  });
});
