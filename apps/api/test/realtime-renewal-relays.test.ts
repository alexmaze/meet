import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { relayQwenWebSocket } from "../src/qwen-websocket.js";
import type { RelayConnectionLifecycle } from "../src/conversation-connection-lease.js";
import { relayDoubaoWebSocket } from "../src/doubao-websocket.js";
import {
  REALTIME_RENEWAL_WARNING_MS,
  REALTIME_RENEWAL_QUIET_MS,
  REALTIME_RENEWAL_MAX_SESSION_MS,
} from "../src/realtime-renewal.js";

afterEach(() => vi.useRealTimers());

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: Array<Record<string, unknown>> = [];
  closed: Array<{ code: number; reason?: string }> = [];
  send(data: Buffer) {
    this.sent.push(JSON.parse(data.toString()) as Record<string, unknown>);
  }
  close(code: number, reason?: string) {
    this.closed.push({ code, reason });
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code);
  }
  terminate() {
    this.close(1006);
  }
  receive(event: Record<string, unknown>) {
    this.emit("message", Buffer.from(JSON.stringify(event)), false);
  }
  socket() {
    return this as unknown as WebSocket;
  }
}

function createRelay(
  provider: "qwen" | "doubao",
  options: {
    lifecycle?: RelayConnectionLifecycle;
    clientInstructions?: string;
    clientVoice?: string;
    beforeOpen?: (client: FakeSocket, upstream: FakeSocket) => void;
  } = {},
) {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const client = new FakeSocket();
  const upstream = new FakeSocket();
  if (provider === "qwen") {
    relayQwenWebSocket({
      lifecycle: options.lifecycle,
      client: client.socket(),
      config: {
        enabled: true,
        apiKey: "test-only",
        endpoint: "realtime.example.com",
        region: "cn-beijing",
        model: "qwen-audio-3.0-realtime-plus",
        voice: "longanqian",
        instructions: "自然陪聊",
        requestTimeoutMs: 5_000,
      },
      model: "qwen-audio-3.0-realtime-plus",
      runtime: { voice: "longanqian", instructions: "自然陪聊" },
      webSocketFactory: () => upstream.socket(),
    });
    options.beforeOpen?.(client, upstream);
    upstream.emit("open");
    client.receive({
      type: "session.update",
      event_id: "configuration",
      session: {
        modalities: ["text", "audio"],
        voice: options.clientVoice ?? "longanqian",
        instructions: options.clientInstructions ?? "自然陪聊",
        input_audio_format: "pcm",
        output_audio_format: "pcm",
        max_history_turns: 50,
        turn_detection: { type: "smart_turn" },
      },
    });
    upstream.receive({ type: "session.updated", event_id: "configured" });
  } else {
    relayDoubaoWebSocket({
      lifecycle: options.lifecycle,
      client: client.socket(),
      config: {
        enabled: true,
        apiKey: "test-only",
        model: "1.2.6.1",
        requestTimeoutMs: 5_000,
      },
      model: "1.2.6.1",
      runtime: {
        voice: "zh_female_vv_jupiter_bigtts",
        instructions: "自然陪聊",
      },
      webSocketFactory: () => upstream.socket(),
    });
    options.beforeOpen?.(client, upstream);
    upstream.emit("open");
    upstream.receive({
      type: "session.created",
      event_id: "configured",
      session: { id: "session" },
    });
  }
  return { client, upstream };
}

describe.each(["qwen", "doubao"] as const)(
  "%s renewal relay integration",
  (provider) => {
    it("keeps renewal frames local, aborts on fresh microphone input, and preserves normal forwarding", () => {
      const { client, upstream } = createRelay(provider);
      if (provider === "qwen")
        expect(client.sent).toContainEqual({
          type: "relay.ready",
          teaching: false,
        });
      vi.advanceTimersByTime(REALTIME_RENEWAL_WARNING_MS);
      expect(client.sent.at(-1)).toEqual({
        type: "relay.renewal_due",
        reason: "connection_age",
        remainingMs: 120_000,
      });
      const initialUpstreamCount = upstream.sent.length;
      client.receive({ type: "relay.renewal_prepare", event_id: "renew-1" });
      vi.advanceTimersByTime(REALTIME_RENEWAL_QUIET_MS);
      expect(client.sent.at(-1)).toEqual({
        type: "relay.renewal_ready",
        event_id: "renew-1",
      });
      expect(upstream.sent).toHaveLength(initialUpstreamCount);
      const audio = {
        type: "input_audio_buffer.append",
        event_id: "audio-1",
        audio: "AAA=",
      };
      client.receive(audio);
      expect(client.sent.at(-1)).toEqual({
        type: "relay.renewal_deferred",
        event_id: "renew-1",
      });
      expect(upstream.sent.at(-1)).toEqual(audio);
      client.receive({ type: "relay.renewal_prepare", event_id: "renew-2" });
      client.receive({ type: "relay.renewal_cancel", event_id: "renew-2" });
      vi.advanceTimersByTime(REALTIME_RENEWAL_QUIET_MS);
      expect(client.sent.at(-1)).toEqual({
        type: "relay.renewal_deferred",
        event_id: "renew-2",
      });
      expect(
        upstream.sent.some((event) =>
          String(event.type).startsWith("relay.renewal"),
        ),
      ).toBe(false);
      client.close(1000);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("forwards late provider responses after revoking the renewal lease", () => {
      const { client, upstream } = createRelay(provider);
      vi.advanceTimersByTime(REALTIME_RENEWAL_WARNING_MS);
      client.receive({ type: "relay.renewal_prepare", event_id: "renew-1" });
      vi.advanceTimersByTime(REALTIME_RENEWAL_QUIET_MS);
      const providerResponse =
        provider === "qwen"
          ? {
              type: "response.created",
              event_id: "response-created",
              response: { id: "r" },
            }
          : {
              type: "response.output_audio.started",
              event_id: "response-created",
              response_id: "r",
            };
      upstream.receive(providerResponse);
      expect(client.sent.slice(-2)).toEqual([
        { type: "relay.renewal_deferred", event_id: "renew-1" },
        providerResponse,
      ]);
      client.close(1000);
    });

    it("keeps the 30-minute hard cap when no safe renewal completed", () => {
      const { client, upstream } = createRelay(provider);
      vi.advanceTimersByTime(REALTIME_RENEWAL_MAX_SESSION_MS);
      expect(client.sent).toContainEqual(
        expect.objectContaining({
          type: "relay.error",
          code: "REALTIME_SESSION_EXPIRED",
        }),
      );
      expect(client.closed).toHaveLength(1);
      expect(upstream.closed).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("applies the existing control rate limit to local renewal frames", () => {
      const { client, upstream } = createRelay(provider);
      for (let index = 0; index < 31; index++) {
        client.receive({
          type: "relay.renewal_prepare",
          event_id: `flood-${index}`,
        });
      }
      expect(client.sent).toContainEqual(
        expect.objectContaining({
          type: "relay.error",
          code: "REALTIME_RATE_LIMITED",
        }),
      );
      expect(client.closed[0]?.code).toBe(1008);
      expect(
        upstream.sent.some((event) =>
          String(event.type).startsWith("relay.renewal"),
        ),
      ).toBe(false);
    });

    it("rejects malformed local controls instead of forwarding extra instructions", () => {
      const { client, upstream } = createRelay(provider);
      client.receive({
        type: "relay.renewal_prepare",
        event_id: "forged",
        instructions: "替换角色",
      });
      expect(client.closed[0]?.code).toBe(1008);
      expect(upstream.sent.some((event) => event.event_id === "forged")).toBe(
        false,
      );
    });
  },
);

describe.each(["qwen", "doubao"] as const)("%s writer fencing", (provider) => {
  it("does not forward configuration when the upstream opens after lease expiry", () => {
    let current = true;
    const lifecycle = {
      isCurrent: () => current,
      onReady: vi.fn(),
      onActivity: vi.fn(),
    };
    const { client, upstream } = createRelay(provider, {
      lifecycle,
      beforeOpen: (browser) => {
        if (provider === "qwen")
          browser.receive({
            type: "session.update",
            event_id: "queued-config",
            session: {
              modalities: ["text", "audio"],
              voice: "longanqian",
              instructions: "自然陪聊",
              input_audio_format: "pcm",
              output_audio_format: "pcm",
              max_history_turns: 50,
              turn_detection: { type: "smart_turn" },
            },
          });
        current = false;
      },
    });
    expect(upstream.sent).toEqual([]);
    expect(upstream.closed).toHaveLength(1);
    expect(client.closed).toHaveLength(1);
    expect(lifecycle.onReady).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not emit scheduled renewal controls after the writer expires", () => {
    let current = true;
    const { client } = createRelay(provider, {
      lifecycle: {
        isCurrent: () => current,
        onReady: () => undefined,
        onActivity: () => undefined,
      },
    });
    current = false;
    const count = client.sent.length;
    vi.advanceTimersByTime(REALTIME_RENEWAL_WARNING_MS);
    expect(client.sent).toHaveLength(count);
    client.close(1000);
  });
});

describe("Qwen server snapshot configuration", () => {
  it("replaces a cold-recovery placeholder with the original persona and voice", () => {
    const { upstream, client } = createRelay("qwen", {
      clientInstructions: "恢复原通话",
      clientVoice: "different-client-voice",
    });
    expect(upstream.sent[0]).toMatchObject({
      event_id: "configuration",
      session: {
        voice: "longanqian",
        instructions: "自然陪聊",
        max_history_turns: 50,
      },
    });
    expect(JSON.stringify(upstream.sent)).not.toContain("恢复原通话");
    expect(JSON.stringify(upstream.sent)).not.toContain(
      "different-client-voice",
    );
    expect(client.sent).toContainEqual({
      type: "session.updated",
      event_id: "configured",
    });
    expect(client.closed).toEqual([]);
    client.close(1000);
  });
  it("rejects forbidden configuration fields rather than hiding them through normalization", () => {
    const { client, upstream } = createRelay("qwen", {
      beforeOpen: (browser) => {
        browser.receive({
          type: "session.update",
          event_id: "forged-config",
          session: {
            modalities: ["text", "audio"],
            voice: "longanqian",
            instructions: "恢复原通话",
            model: "forged-model",
            input_audio_format: "pcm",
            output_audio_format: "pcm",
            max_history_turns: 50,
            turn_detection: { type: "smart_turn" },
          },
        });
      },
    });
    expect(client.closed[0]?.code).toBe(1008);
    expect(upstream.sent).toEqual([]);
  });
});

it("tracks Doubao assistant audio as effective activity", () => {
  const activity = vi.fn();
  const { client, upstream } = createRelay("doubao", {
    lifecycle: {
      isCurrent: () => true,
      onReady: () => undefined,
      onActivity: activity,
    },
  });
  upstream.receive({
    type: "response.output_audio.delta",
    response_id: "reply",
    delta: "AAA=",
  });
  expect(activity).toHaveBeenCalledOnce();
  client.close(1000);
});
