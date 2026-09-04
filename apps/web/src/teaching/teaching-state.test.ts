import { describe, expect, it } from "vitest";

import {
  initialTeachingCallState,
  parseTeachingRelayFrame,
  reduceTeachingCallState,
  resolveCallTeachingChoice,
  teachingAudioGateAckFrame,
  teachingMuteFrame,
  teachingRequestFrame,
  teachingStateFromRelayFrame,
} from "./teaching-state.js";

describe("teaching relay state", () => {
  it("strictly accepts only consistent shared server-control frames", () => {
    const parsed = parseTeachingRelayFrame({
      type: "relay.teaching.state",
      revision: 0,
      state: "available",
      canRequest: true,
      canMute: true,
    });
    expect(parsed.kind).toBe("state");
    if (parsed.kind === "state") {
      expect(teachingStateFromRelayFrame(parsed.frame)).toEqual({
        revision: 0,
        state: "available",
        canRequest: true,
        canMute: true,
      });
    }

    expect(
      parseTeachingRelayFrame({
        type: "relay.teaching.state",
        revision: 1,
        state: "available",
        canRequest: false,
        canMute: true,
      }),
    ).toEqual({ kind: "invalid" });
    expect(
      parseTeachingRelayFrame({
        type: "relay.teaching.state",
        revision: 1,
        state: "muted",
        canRequest: false,
        canMute: false,
        hiddenPrompt: "must not cross the boundary",
      }),
    ).toEqual({ kind: "invalid" });
    expect(parseTeachingRelayFrame({ type: "relay.teaching.future" })).toEqual({
      kind: "invalid",
    });
    expect(parseTeachingRelayFrame({ type: "relay.ready" })).toEqual({
      kind: "not_teaching",
    });
  });

  it("requires a positive audio-gate revision", () => {
    expect(
      parseTeachingRelayFrame({
        type: "relay.teaching.audio_gate",
        revision: 1,
        open: false,
      }),
    ).toMatchObject({ kind: "audio_gate" });
    expect(
      parseTeachingRelayFrame({
        type: "relay.teaching.audio_gate",
        revision: 0,
        open: false,
      }),
    ).toEqual({ kind: "invalid" });
  });

  it("builds the exact narrow client controls", () => {
    expect(teachingRequestFrame(" event_request ")).toEqual({
      type: "relay.teaching.request",
      event_id: "event_request",
    });
    expect(teachingMuteFrame("event_mute")).toEqual({
      type: "relay.teaching.mute",
      event_id: "event_mute",
    });
    expect(teachingAudioGateAckFrame("event_ack", 4)).toEqual({
      type: "relay.teaching.audio_gate_ack",
      event_id: "event_ack",
      revision: 4,
    });
    expect(() => teachingAudioGateAckFrame("event_ack", 0)).toThrow(
      "INVALID_TEACHING_AUDIO_GATE_REVISION",
    );
  });

  it("keeps optimistic state at revision zero and ignores stale relay state", () => {
    const optimistic = initialTeachingCallState(
      {
        enabled: true,
        providerCapability: "dynamic_instructions_next_safe_turn",
        subject: "english",
        difficulty: "starter",
        triggerMode: "gentle",
        disclosureVersion: "teaching-disclosure-v1",
        configurationRevision: 3,
      },
      "enabled",
    );
    const next = {
      revision: 2,
      state: "active",
      canRequest: false,
      canMute: true,
    } as const;
    expect(reduceTeachingCallState(optimistic, next)).toEqual(next);
    expect(reduceTeachingCallState(next, { ...optimistic, revision: 1 })).toBe(
      next,
    );
  });

  it("forces child temporary conversations to chat-only before any call work", () => {
    expect(resolveCallTeachingChoice("child", "temporary", "enabled")).toBe(
      "chat_only",
    );
    expect(resolveCallTeachingChoice("child", "normal", "enabled")).toBe(
      "enabled",
    );
    expect(resolveCallTeachingChoice("adult", "normal", "enabled")).toBe(
      undefined,
    );
  });
});
