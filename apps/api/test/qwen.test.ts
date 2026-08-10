import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import {
  buildQwenContinuityEvents,
  buildQwenRealtimeWebSocketUrl,
  isAllowedQwenClientEvent,
  isAllowedWebSocketOrigin,
  QWEN_RELAY_MAX_AUDIO_BASE64_CHARACTERS,
} from "../src/qwen-websocket.js";
import {
  buildQwenRealtimeUrl,
  exchangeQwenOffer,
  normalizeQwenRealtimeEndpoint,
  validateOfferSdp,
} from "../src/qwen.js";

const offer = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const answer = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

const qwenConfig: AppConfig["qwen"] = {
  enabled: true,
  apiKey: "test-key",
  endpoint: "realtime.example.com",
  region: "cn-beijing",
  model: "qwen-audio-3.0-realtime-plus",
  voice: "longanqian",
  instructions: "测试",
  requestTimeoutMs: 15_000,
};

describe("Qwen WebRTC gateway", () => {
  it("constructs the allowlisted signaling endpoint", () => {
    expect(
      buildQwenRealtimeUrl(
        "realtime.example.com",
        "qwen-audio-3.0-realtime-plus",
      ).toString(),
    ).toBe(
      "https://realtime.example.com/api/v1/webrtc/realtime?model=qwen-audio-3.0-realtime-plus",
    );
  });

  it("normalizes an HTTPS origin without duplicating protocol or path", () => {
    expect(normalizeQwenRealtimeEndpoint("https://realtime.example.com/")).toBe(
      "realtime.example.com",
    );
    expect(
      buildQwenRealtimeUrl(
        "https://realtime.example.com/",
        "qwen-audio-3.0-realtime-flash",
      ).toString(),
    ).toBe(
      "https://realtime.example.com/api/v1/webrtc/realtime?model=qwen-audio-3.0-realtime-flash",
    );
  });

  it.each([
    "http://realtime.example.com",
    "https://user@realtime.example.com",
    "https://realtime.example.com:8443",
    "https://realtime.example.com/custom/path",
    "https://realtime.example.com/%2e%2e",
    "https://realtime.example.com?target=other",
    "//realtime.example.com",
    "not_a_hostname",
  ])("rejects an invalid signaling endpoint: %s", (endpoint) => {
    expect(() => normalizeQwenRealtimeEndpoint(endpoint)).toThrow(
      /QWEN_REALTIME_ENDPOINT/,
    );
  });

  it("rejects SDP without an audio media section", () => {
    expect(() =>
      validateOfferSdp("v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n"),
    ).toThrow(/音频媒体段/);
  });

  it("keeps the API key server-side while exchanging SDP", async () => {
    const fetchFunction = vi.fn(
      async (url: URL | RequestInfo, init?: RequestInit) => {
        expect(url.toString()).toBe(
          "https://realtime.example.com/api/v1/webrtc/realtime?model=qwen-audio-3.0-realtime-plus",
        );
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer test-key",
          "Content-Type": "application/sdp",
        });
        expect(init?.body).toBe(offer);
        return new Response(answer, {
          status: 200,
          headers: { "Content-Type": "application/sdp" },
        });
      },
    ) as typeof globalThis.fetch;

    await expect(
      exchangeQwenOffer(
        qwenConfig,
        "qwen-audio-3.0-realtime-plus",
        offer,
        fetchFunction,
      ),
    ).resolves.toBe(answer);
  });
});

describe("Qwen WebSocket relay", () => {
  const runtime = { voice: "longanqian", instructions: "测试" };

  it("constructs the allowlisted upstream WebSocket endpoint", () => {
    expect(
      buildQwenRealtimeWebSocketUrl(
        "https://realtime.example.com/",
        "qwen-audio-3.0-realtime-plus",
      ).toString(),
    ).toBe(
      "wss://realtime.example.com/api-ws/v1/realtime?model=qwen-audio-3.0-realtime-plus",
    );
  });

  it("maps saved turns to provider-native history items in order", () => {
    const events = buildQwenContinuityEvents([
      {
        id: "9bb6162e-e85c-4e5d-a3ff-000000000001",
        role: "user",
        text: "我周五要考试。",
      },
      {
        id: "9bb6162e-e85c-4e5d-a3ff-000000000002",
        role: "assistant",
        text: "记得，我们先复习分数。",
      },
    ]);

    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      type: "conversation.item.create",
      item: {
        role: "system",
        content: [{ type: "input_text" }],
      },
    });
    expect(events[1]).toMatchObject({
      item: {
        role: "user",
        content: [{ type: "input_text", text: "我周五要考试。" }],
      },
    });
    expect(events[2]).toMatchObject({
      item: {
        role: "assistant",
        content: [{ type: "output_text", text: "记得，我们先复习分数。" }],
      },
    });
    expect(events[3]).toMatchObject({
      item: {
        role: "system",
        content: [
          {
            type: "input_text",
            text: expect.stringContaining("不要因为连接恢复而重复上一句"),
          },
        ],
      },
    });
  });

  it("does not inject synthetic continuity when no history is available", () => {
    expect(buildQwenContinuityEvents([])).toEqual([]);
  });

  it("injects confirmed memories before recent raw history", () => {
    const events = buildQwenContinuityEvents(
      [
        {
          id: "9bb6162e-e85c-4e5d-a3ff-000000000001",
          role: "user",
          text: "我们继续吧。",
        },
      ],
      "已确认长期记忆：\n- 用户喜欢围棋。",
    );
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      item: {
        id: "meet_relationship_context",
        role: "system",
        content: [
          {
            text: expect.stringContaining("用户喜欢围棋"),
          },
        ],
      },
    });
    expect(events[2]).toMatchObject({
      item: { role: "user", content: [{ text: "我们继续吧。" }] },
    });
  });

  it("accepts the page origin when it exactly matches the request host", () => {
    expect(
      isAllowedWebSocketOrigin({
        origin: "https://meet.example.com",
        host: "meet.example.com",
        remoteAddress: "203.0.113.20",
        cookieSecure: true,
      }),
    ).toBe(true);
  });

  it.each([
    ["http://localhost:5173", "127.0.0.1"],
    ["http://127.0.0.1:5173", "::1"],
    ["http://192.168.1.20:5173", "::ffff:127.0.0.1"],
  ])("allows a local Vite proxy origin (%s)", (origin, remoteAddress) => {
    expect(
      isAllowedWebSocketOrigin({
        origin,
        host: "127.0.0.1:8787",
        remoteAddress,
        cookieSecure: false,
      }),
    ).toBe(true);
  });

  it.each([
    {
      origin: undefined,
      host: "meet.example.com",
      remoteAddress: "127.0.0.1",
      cookieSecure: false,
    },
    {
      origin: "https://evil.example",
      host: "meet.example.com",
      remoteAddress: "203.0.113.20",
      cookieSecure: true,
    },
    {
      origin: "https://evil.example",
      host: "127.0.0.1:8787",
      remoteAddress: "127.0.0.1",
      cookieSecure: false,
    },
    {
      origin: "http://192.168.1.20:5173",
      host: "127.0.0.1:8787",
      remoteAddress: "127.0.0.1",
      cookieSecure: true,
    },
  ])("rejects an unsafe WebSocket origin: $origin", (input) => {
    expect(isAllowedWebSocketOrigin(input)).toBe(false);
  });

  it.each([
    {
      event_id: "event-session",
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice: "longanqian",
        input_audio_format: "pcm",
        output_audio_format: "pcm",
        instructions: "测试",
        max_history_turns: 20,
        turn_detection: { type: "smart_turn" },
      },
    },
    {
      event_id: "event-audio",
      type: "input_audio_buffer.append",
      audio: "AQIDBA==",
    },
    {
      event_id: "event-text",
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "你好" }],
      },
    },
    { event_id: "event-create", type: "response.create" },
    { event_id: "event-cancel", type: "response.cancel" },
  ])("accepts an allowlisted client event: $type", (event) => {
    expect(
      isAllowedQwenClientEvent(Buffer.from(JSON.stringify(event)), runtime),
    ).toBe(true);
  });

  it.each([
    { event_id: "event-unknown", type: "session.delete" },
    { event_id: "event-cancel", type: "response.cancel", extra: true },
    {
      event_id: "event-session",
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice: "unauthorized-voice",
        input_audio_format: "pcm",
        output_audio_format: "pcm",
        instructions: "测试",
        max_history_turns: 20,
        turn_detection: { type: "smart_turn" },
      },
    },
    {
      event_id: "event-audio",
      type: "input_audio_buffer.append",
      audio: "A".repeat(QWEN_RELAY_MAX_AUDIO_BASE64_CHARACTERS + 4),
    },
  ])("rejects a non-allowlisted client event", (event) => {
    expect(
      isAllowedQwenClientEvent(Buffer.from(JSON.stringify(event)), runtime),
    ).toBe(false);
  });
});
