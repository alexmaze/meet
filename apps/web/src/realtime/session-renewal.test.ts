import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealtimeRenewalClientFrame } from "@meet/protocol";
import { SessionRenewal } from "./session-renewal.js";

function harness() {
  vi.useFakeTimers();
  const sent: RealtimeRenewalClientFrame[] = [];
  const state = { safe: true };
  const flushRecords = vi.fn(async (): Promise<void> => undefined);
  const renew = vi.fn();
  const notice = vi.fn();
  const renewal = new SessionRenewal({
    now: () => Date.now(),
    schedule: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      return { cancel: () => clearTimeout(timer) };
    },
    isSafe: () => state.safe,
    send: (frame) => sent.push(frame),
    flushRecords,
    renew,
    notice,
  });
  const due = () =>
    renewal.handleFrame({
      type: "relay.renewal_due",
      reason: "connection_age",
      remainingMs: 120_000,
    });
  const prepare = async () => {
    due();
    await vi.advanceTimersByTimeAsync(750);
    const frame = sent.find((frame) => frame.type === "relay.renewal_prepare");
    expect(frame).toBeDefined();
    return frame!.event_id;
  };
  return { renewal, state, sent, flushRecords, renew, notice, due, prepare };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("voluntary session renewal", () => {
  it("requires a quiet boundary, matching relay ACK and durable records", async () => {
    const h = harness();
    const id = await h.prepare();
    expect(h.renew).not.toHaveBeenCalled();
    h.renewal.handleFrame({ type: "relay.renewal_ready", event_id: "stale" });
    expect(h.flushRecords).not.toHaveBeenCalled();
    h.renewal.handleFrame({ type: "relay.renewal_ready", event_id: id });
    h.renewal.handleFrame({ type: "relay.renewal_ready", event_id: id });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.flushRecords).toHaveBeenCalledTimes(1);
    expect(h.renew).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps waiting while playback, speech or teaching is busy", async () => {
    const h = harness();
    h.state.safe = false;
    h.due();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.sent).toEqual([]);
    h.state.safe = true;
    h.renewal.activity();
    await vi.advanceTimersByTimeAsync(749);
    expect(h.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sent[0]?.type).toBe("relay.renewal_prepare");
  });

  it("cancels before forwarding a new speech packet without losing it", async () => {
    const h = harness();
    const id = await h.prepare();
    expect(h.renewal.allowMicrophonePacket(new Int16Array(320))).toBe(false);
    expect(h.renewal.allowMicrophonePacket(new Int16Array([700, -700]))).toBe(
      true,
    );
    expect(h.sent.at(-1)).toEqual({
      type: "relay.renewal_cancel",
      event_id: id,
    });
    h.renewal.handleFrame({ type: "relay.renewal_ready", event_id: id });
    expect(h.renew).not.toHaveBeenCalled();
  });

  it("keeps the original call usable if saving records fails", async () => {
    const h = harness();
    h.flushRecords.mockRejectedValueOnce(new Error("offline"));
    const id = await h.prepare();
    h.renewal.handleFrame({ type: "relay.renewal_ready", event_id: id });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.renew).not.toHaveBeenCalled();
    expect(h.sent.at(-1)?.type).toBe("relay.renewal_cancel");
    expect(h.renewal.allowMicrophonePacket(new Int16Array(320))).toBe(true);
  });

  it.each(["activity", "reset"] as const)(
    "ignores late saves after %s",
    async (action) => {
      const h = harness();
      let resolve!: () => void;
      h.flushRecords.mockImplementationOnce(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      );
      const id = await h.prepare();
      h.renewal.handleFrame({ type: "relay.renewal_ready", event_id: id });
      h.renewal[action]();
      resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.renew).not.toHaveBeenCalled();
    },
  );

  it("rechecks playback after asynchronous saving", async () => {
    const h = harness();
    h.flushRecords.mockImplementationOnce(async () => {
      h.state.safe = false;
    });
    const id = await h.prepare();
    h.renewal.handleFrame({ type: "relay.renewal_ready", event_id: id });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.renew).not.toHaveBeenCalled();
    expect(h.sent.at(-1)?.type).toBe("relay.renewal_cancel");
  });

  it("releases a lost ACK and retries with a fresh request id", async () => {
    const h = harness();
    const id = await h.prepare();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.sent.at(-1)).toEqual({
      type: "relay.renewal_cancel",
      event_id: id,
    });
    expect(h.renewal.allowMicrophonePacket(new Int16Array(320))).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.sent.at(-1)?.type).toBe("relay.renewal_prepare");
    expect(h.sent.at(-1)?.event_id).not.toBe(id);
  });

  it("handles relay deferral without echoing cancel or duplicating due", async () => {
    const h = harness();
    const id = await h.prepare();
    h.due();
    expect(h.sent).toHaveLength(1);
    h.renewal.handleFrame({ type: "relay.renewal_deferred", event_id: id });
    expect(h.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.sent).toHaveLength(2);
  });

  it("ignores malformed or foreign control frames", () => {
    const h = harness();
    expect(
      h.renewal.handleFrame({ type: "relay.renewal_due", remainingMs: -1 }),
    ).toBe(false);
    expect(h.renewal.handleFrame({ type: "response.done" })).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
