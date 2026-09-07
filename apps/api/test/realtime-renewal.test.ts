import type { RealtimeRenewalServerFrame } from "@meet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RealtimeRenewalController,
  REALTIME_RENEWAL_CONTEXT_USER_TURNS,
  REALTIME_RENEWAL_LEASE_MS,
  REALTIME_RENEWAL_MAX_SESSION_MS,
  REALTIME_RENEWAL_QUIET_MS,
  REALTIME_RENEWAL_WARNING_MS,
} from "../src/realtime-renewal.js";

afterEach(() => vi.useRealTimers());

function setup(provider: "qwen" | "doubao" = "qwen") {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const frames: RealtimeRenewalServerFrame[] = [];
  let extraSafe = true;
  const controller = new RealtimeRenewalController({
    provider,
    sendClientFrame: (frame) => frames.push(frame),
    isSafeToRenew: () => extraSafe,
  });
  return {
    controller,
    frames,
    ready: () => controller.markSessionReady(),
    setSafe: (value: boolean) => {
      extraSafe = value;
    },
    prepare: (event_id = "prepare-1") =>
      controller.handleClientFrame({ type: "relay.renewal_prepare", event_id }),
    cancel: (event_id = "prepare-1") =>
      controller.handleClientFrame({ type: "relay.renewal_cancel", event_id }),
    provider: (event: Record<string, unknown>) =>
      controller.observeProviderEvent(event),
  };
}

function completeQwenTurn(controller: RealtimeRenewalController, id: string) {
  controller.observeProviderEvent({
    type: "input_audio_buffer.speech_started",
    item_id: id,
  });
  controller.observeProviderEvent({
    type: "input_audio_buffer.speech_stopped",
    item_id: id,
    reason: "turn_detected",
  });
  controller.observeProviderEvent({
    type: "input_audio_buffer.committed",
    item_id: id,
  });
  controller.observeProviderEvent({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: id,
    event_id: `asr-${id}`,
    transcript: "今天在公园里散步。",
  });
  controller.observeProviderEvent({
    type: "response.created",
    response: { id: `r-${id}` },
  });
  controller.observeProviderEvent({
    type: "response.done",
    response: { id: `r-${id}`, status: "completed" },
  });
}

describe("real-time transport renewal agreement", () => {
  it("an idless transcription delta shares the sole known utterance barrier", () => {
    const s = setup();
    s.ready();
    vi.advanceTimersByTime(REALTIME_RENEWAL_WARNING_MS);
    s.provider({ type: "input_audio_buffer.speech_started", item_id: "known" });
    s.provider({
      type: "conversation.item.input_audio_transcription.delta",
      text: "部分转写",
    });
    s.provider({
      type: "input_audio_buffer.speech_stopped",
      item_id: "known",
      reason: "turn_detected",
    });
    s.provider({ type: "input_audio_buffer.committed", item_id: "known" });
    s.provider({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "known",
      event_id: "asr-known",
      transcript: "完整转写",
    });
    s.provider({
      type: "response.created",
      response: { id: "response-known" },
    });
    s.provider({ type: "response.done", response: { id: "response-known" } });
    s.prepare();
    vi.advanceTimersByTime(REALTIME_RENEWAL_QUIET_MS);
    expect(s.frames.at(-1)).toEqual({
      type: "relay.renewal_ready",
      event_id: "prepare-1",
    });
  });

  it("keeps an unresolved valid Qwen utterance blocked after transcription failure", () => {
    const s = setup();
    s.ready();
    vi.advanceTimersByTime(REALTIME_RENEWAL_WARNING_MS);
    s.provider({
      type: "input_audio_buffer.speech_started",
      item_id: "failed",
    });
    s.provider({
      type: "input_audio_buffer.speech_stopped",
      item_id: "failed",
      reason: "turn_detected",
    });
    s.provider({
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "failed",
    });
    s.prepare();
    expect(s.frames.at(-1)).toEqual({
      type: "relay.renewal_deferred",
      event_id: "prepare-1",
    });
  });

  it("an early Qwen final ASR does not end speech, and a late stop does not create another pending response", () => {
    const s = setup();
    s.ready();
    vi.advanceTimersByTime(REALTIME_RENEWAL_WARNING_MS);
    s.provider({ type: "input_audio_buffer.speech_started", item_id: "s" });
    s.provider({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "s",
      event_id: "asr",
      transcript: "还没完全停下",
    });
    s.prepare("still-speaking");
    expect(s.frames.at(-1)?.type).toBe("relay.renewal_deferred");
    s.provider({ type: "input_audio_buffer.committed", item_id: "s" });
    s.provider({ type: "response.created", response: { id: "r" } });
    s.provider({ type: "response.done", response: { id: "r" } });
    s.provider({
      type: "input_audio_buffer.speech_stopped",
      item_id: "s",
      reason: "turn_detected",
    });
    s.prepare("fully-finished");
    vi.advanceTimersByTime(REALTIME_RENEWAL_QUIET_MS);
    expect(s.frames.at(-1)).toEqual({
      type: "relay.renewal_ready",
      event_id: "fully-finished",
    });
  });

  it("an old response terminal cannot satisfy a newer user utterance", () => {
    const s = setup();
    s.ready();
    vi.advanceTimersByTime(REALTIME_RENEWAL_WARNING_MS);
    s.provider({ type: "response.created", response: { id: "old" } });
    s.provider({ type: "input_audio_buffer.speech_started", item_id: "new" });
    s.provider({
      type: "input_audio_buffer.speech_stopped",
      item_id: "new",
      reason: "turn_detected",
    });
    s.provider({ type: "input_audio_buffer.committed", item_id: "new" });
    s.provider({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "new",
      event_id: "new-asr",
      transcript: "再聊一个事情",
    });
    s.provider({
      type: "response.done",
      response: { id: "old", status: "cancelled" },
    });
    s.prepare("waiting-new");
    expect(s.frames.at(-1)).toEqual({
      type: "relay.renewal_deferred",
      event_id: "waiting-new",
    });
    s.provider({ type: "response.created", response: { id: "new-response" } });
    s.provider({ type: "response.done", response: { id: "new-response" } });
    s.prepare("finished-new");
    vi.advanceTimersByTime(REALTIME_RENEWAL_QUIET_MS);
    expect(s.frames.at(-1)).toEqual({
      type: "relay.renewal_ready",
      event_id: "finished-new",
    });
  });

  it("a response observed before a Qwen audio commit cannot satisfy the new utterance", () => {
    const s = setup();
    s.ready();
    vi.advanceTimersByTime(REALTIME_RENEWAL_WARNING_MS);
    s.provider({ type: "input_audio_buffer.speech_started", item_id: "s" });
    s.provider({
      type: "input_audio_buffer.speech_stopped",
      item_id: "s",
      reason: "turn_detected",
    });
    s.provider({ type: "response.created", response: { id: "old-late" } });
    s.provider({ type: "input_audio_buffer.committed", item_id: "s" });
    s.provider({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "s",
      event_id: "asr",
      transcript: "新的问题",
    });
    s.provider({ type: "response.done", response: { id: "old-late" } });
    s.prepare("not-yet");
    expect(s.frames.at(-1)?.type).toBe("relay.renewal_deferred");
  });

  it.each(["audio-first", "response-first"])(
    "Doubao requires both audio and response completion (%s)",
    (order) => {
      const s = setup("doubao");
      s.ready();
      vi.advanceTimersByTime(REALTIME_RENEWAL_WARNING_MS);
      s.provider({ type: "response.output_text.delta", delta: "你好" });
      s.provider({ type: "response.output_audio.started", response_id: "r" });
      const audioDone = {
        type: "response.output_audio.done",
        response_id: "r",
      };
      const responseDone = { type: "response.done" };
      s.provider(order === "audio-first" ? audioDone : responseDone);
      s.prepare("half-done");
      expect(s.frames.at(-1)?.type).toBe("relay.renewal_deferred");
      s.provider(order === "audio-first" ? responseDone : audioDone);
      s.prepare("done");
      vi.advanceTimersByTime(REALTIME_RENEWAL_QUIET_MS);
      expect(s.frames.at(-1)).toEqual({
        type: "relay.renewal_ready",
        event_id: "done",
      });
    },
  );

  it("warns at 28 minutes from construction even when the handshake was delayed", () => {
    const s = setup();
    vi.advanceTimersByTime(REALTIME_RENEWAL_WARNING_MS + 10_000);
    expect(s.frames).toEqual([]);
    s.ready();
    expect(s.frames).toEqual([
      {
        type: "relay.renewal_due",
        reason: "connection_age",
        remainingMs: 110_000,
      },
    ]);
    s.ready();
    expect(s.frames).toHaveLength(1);
  });

  it("rejects unsolicited preparation and waits a full quiet window before ready", () => {
    const s = setup();
    s.ready();
    s.prepare("early");
    expect(s.frames.at(-1)).toEqual({
      type: "relay.renewal_deferred",
      event_id: "early",
    });
    vi.advanceTimersByTime(REALTIME_RENEWAL_WARNING_MS);
    s.prepare();
    vi.advanceTimersByTime(REALTIME_RENEWAL_QUIET_MS - 1);
    expect(s.frames.at(-1)?.type).toBe("relay.renewal_due");
    vi.advanceTimersByTime(1);
    expect(s.frames.at(-1)).toEqual({
      type: "relay.renewal_ready",
      event_id: "prepare-1",
    });
  });

  it("defers on speech, waits for a late final ASR even after response.done", () => {
    const s = setup();
    s.ready();
    vi.advanceTimersByTime(REALTIME_RENEWAL_WARNING_MS);
    s.prepare("interrupted-prepare");
    s.provider({
      type: "input_audio_buffer.speech_started",
      item_id: "speech-1",
    });
    expect(s.frames.at(-1)).toEqual({
      type: "relay.renewal_deferred",
      event_id: "interrupted-prepare",
    });
    s.provider({
      type: "input_audio_buffer.speech_stopped",
      item_id: "speech-1",
      reason: "turn_detected",
    });
    s.provider({ type: "input_audio_buffer.committed", item_id: "speech-1" });
    s.provider({ type: "response.created", response: { id: "response-1" } });
    s.provider({
      type: "response.done",
      response: { id: "response-1", status: "completed" },
    });
    s.prepare("before-final-asr");
    expect(s.frames.at(-1)).toEqual({
      type: "relay.renewal_deferred",
      event_id: "before-final-asr",
    });
    s.provider({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "speech-1",
      event_id: "asr-1",
      transcript: "刚才的最后一句。",
    });
    s.prepare("after-final-asr");
    vi.advanceTimersByTime(REALTIME_RENEWAL_QUIET_MS);
    expect(s.frames.at(-1)).toEqual({
      type: "relay.renewal_ready",
      event_id: "after-final-asr",
    });
  });

  it("invalid speech and failed ASR release their own barriers without counting a turn", () => {
    const s = setup();
    s.ready();
    vi.advanceTimersByTime(REALTIME_RENEWAL_WARNING_MS);
    s.provider({ type: "input_audio_buffer.speech_started", item_id: "noise" });
    s.provider({
      type: "input_audio_buffer.speech_stopped",
      item_id: "noise",
      reason: "turn_invalid",
    });
    s.prepare("after-noise");
    vi.advanceTimersByTime(REALTIME_RENEWAL_QUIET_MS);
    expect(s.frames.at(-1)).toEqual({
      type: "relay.renewal_ready",
      event_id: "after-noise",
    });
    s.cancel("after-noise");
    s.provider({
      type: "input_audio_buffer.speech_started",
      item_id: "failed",
    });
    s.provider({
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "failed",
    });
    s.provider({
      type: "input_audio_buffer.speech_stopped",
      item_id: "failed",
      reason: "turn_invalid",
    });
    s.prepare("after-failure");
    vi.advanceTimersByTime(REALTIME_RENEWAL_QUIET_MS);
    expect(s.frames.at(-1)).toEqual({
      type: "relay.renewal_ready",
      event_id: "after-failure",
    });
  });

  it("counts completed unique user utterances for context refresh, excluding invalid noise", () => {
    const s = setup();
    s.ready();
    for (
      let index = 0;
      index < REALTIME_RENEWAL_CONTEXT_USER_TURNS - 1;
      index++
    ) {
      completeQwenTurn(s.controller, String(index));
    }
    s.provider({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "0",
      event_id: "asr-duplicate",
      transcript: "重复事件",
    });
    s.provider({ type: "input_audio_buffer.speech_started", item_id: "noise" });
    s.provider({
      type: "input_audio_buffer.speech_stopped",
      item_id: "noise",
      reason: "turn_invalid",
    });
    s.provider({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "noise",
      event_id: "asr-noise",
      transcript: "嗯",
    });
    s.provider({
      type: "input_audio_buffer.speech_started",
      item_id: "early-noise",
    });
    s.provider({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "early-noise",
      event_id: "asr-early-noise",
      transcript: "嗯",
    });
    s.provider({
      type: "input_audio_buffer.speech_stopped",
      item_id: "early-noise",
      reason: "turn_invalid",
    });
    expect(s.frames).toEqual([]);
    completeQwenTurn(s.controller, "final");
    expect(s.frames).toEqual([
      {
        type: "relay.renewal_due",
        reason: "context_refresh",
        remainingMs: REALTIME_RENEWAL_MAX_SESSION_MS,
      },
    ]);
    s.prepare();
    vi.advanceTimersByTime(REALTIME_RENEWAL_QUIET_MS);
    expect(s.frames.at(-1)?.type).toBe("relay.renewal_ready");
  });

  it("checks teaching readiness again at the end of the quiet window", () => {
    const s = setup();
    s.ready();
    vi.advanceTimersByTime(REALTIME_RENEWAL_WARNING_MS);
    s.prepare();
    s.setSafe(false);
    vi.advanceTimersByTime(REALTIME_RENEWAL_QUIET_MS);
    expect(s.frames.at(-1)).toEqual({
      type: "relay.renewal_deferred",
      event_id: "prepare-1",
    });
    s.prepare("still-teaching");
    expect(s.frames.at(-1)).toEqual({
      type: "relay.renewal_deferred",
      event_id: "still-teaching",
    });
  });

  it("ordinary client activity revokes ready and preparation without consuming the event", () => {
    const s = setup();
    s.ready();
    vi.advanceTimersByTime(REALTIME_RENEWAL_WARNING_MS);
    s.prepare();
    vi.advanceTimersByTime(REALTIME_RENEWAL_QUIET_MS);
    s.controller.observeClientEvent({
      type: "input_audio_buffer.append",
      audio: "AAA=",
    });
    expect(s.frames.at(-1)).toEqual({
      type: "relay.renewal_deferred",
      event_id: "prepare-1",
    });
    s.prepare("next");
    s.controller.observeClientEvent({
      type: "relay.teaching.request",
      event_id: "request",
    });
    vi.advanceTimersByTime(REALTIME_RENEWAL_QUIET_MS);
    expect(s.frames.at(-1)).toEqual({
      type: "relay.renewal_deferred",
      event_id: "next",
    });
  });

  it("expires leases, ignores duplicate requests, and prevents an old cancel from cancelling a new request", () => {
    const s = setup();
    s.ready();
    vi.advanceTimersByTime(REALTIME_RENEWAL_WARNING_MS);
    s.prepare();
    s.prepare();
    vi.advanceTimersByTime(REALTIME_RENEWAL_QUIET_MS);
    expect(
      s.frames.filter((frame) => frame.type === "relay.renewal_ready"),
    ).toHaveLength(1);
    vi.advanceTimersByTime(REALTIME_RENEWAL_LEASE_MS);
    expect(s.frames.at(-1)).toEqual({
      type: "relay.renewal_deferred",
      event_id: "prepare-1",
    });
    s.prepare();
    expect(s.frames.at(-1)?.type).toBe("relay.renewal_deferred");
    s.prepare("new");
    s.cancel("prepare-1");
    vi.advanceTimersByTime(REALTIME_RENEWAL_QUIET_MS);
    expect(s.frames.at(-1)).toEqual({
      type: "relay.renewal_ready",
      event_id: "new",
    });
  });

  it("cancel and disposal remove every scheduled ready/warning", () => {
    const s = setup();
    s.ready();
    vi.advanceTimersByTime(REALTIME_RENEWAL_WARNING_MS);
    s.prepare();
    s.cancel();
    s.prepare("second");
    s.controller.dispose();
    const count = s.frames.length;
    vi.advanceTimersByTime(REALTIME_RENEWAL_MAX_SESSION_MS);
    expect(s.frames).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not grant a ready lease after the relay hard deadline", () => {
    const s = setup();
    s.ready();
    vi.advanceTimersByTime(REALTIME_RENEWAL_MAX_SESSION_MS - 100);
    s.prepare();
    vi.advanceTimersByTime(REALTIME_RENEWAL_QUIET_MS);
    expect(s.frames.at(-1)).toEqual({
      type: "relay.renewal_deferred",
      event_id: "prepare-1",
    });
  });

  it("Doubao waits for ASR and its response even without response IDs", () => {
    const s = setup("doubao");
    s.ready();
    vi.advanceTimersByTime(REALTIME_RENEWAL_WARNING_MS);
    s.provider({ type: "conversation.item.input_audio_transcription.started" });
    s.provider({
      type: "conversation.item.input_audio_transcription.completed",
      event_id: "asr",
      transcript: "说完了",
    });
    s.prepare("before-response");
    expect(s.frames.at(-1)?.type).toBe("relay.renewal_deferred");
    s.provider({ type: "response.output_text.delta", delta: "听到了" });
    s.prepare("during-response");
    expect(s.frames.at(-1)?.type).toBe("relay.renewal_deferred");
    s.provider({ type: "response.done" });
    s.prepare("finished");
    vi.advanceTimersByTime(REALTIME_RENEWAL_QUIET_MS);
    expect(s.frames.at(-1)).toEqual({
      type: "relay.renewal_ready",
      event_id: "finished",
    });
  });
});
