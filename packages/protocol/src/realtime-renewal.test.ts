import { describe, expect, it } from "vitest";
import {
  realtimeRenewalClientFrameSchema,
  realtimeRenewalServerFrameSchema,
} from "./realtime-renewal.js";

describe("realtime renewal frames", () => {
  it("accepts only the bounded local handshake envelopes", () => {
    for (const type of ["relay.renewal_prepare", "relay.renewal_cancel"]) {
      expect(
        realtimeRenewalClientFrameSchema.safeParse({
          type,
          event_id: "renew-1",
        }).success,
      ).toBe(true);
      expect(
        realtimeRenewalClientFrameSchema.safeParse({ type, event_id: "" })
          .success,
      ).toBe(false);
      expect(
        realtimeRenewalClientFrameSchema.safeParse({
          type,
          event_id: "renew-1",
          instructions: "伪造角色",
        }).success,
      ).toBe(false);
    }
    expect(
      realtimeRenewalServerFrameSchema.safeParse({
        type: "relay.renewal_due",
        reason: "connection_age",
        remainingMs: 120_000,
      }).success,
    ).toBe(true);
    expect(
      realtimeRenewalServerFrameSchema.safeParse({
        type: "relay.renewal_due",
        reason: "context_refresh",
        remainingMs: -1,
      }).success,
    ).toBe(false);
    expect(
      realtimeRenewalServerFrameSchema.safeParse({
        type: "relay.renewal_due",
        reason: "provider_switch",
        remainingMs: 1,
      }).success,
    ).toBe(false);
    for (const type of ["relay.renewal_ready", "relay.renewal_deferred"]) {
      expect(
        realtimeRenewalServerFrameSchema.safeParse({
          type,
          event_id: "renew-1",
        }).success,
      ).toBe(true);
    }
    expect(
      realtimeRenewalClientFrameSchema.safeParse({
        type: "relay.renewal_ready",
        event_id: "renew-1",
      }).success,
    ).toBe(false);
  });
});
