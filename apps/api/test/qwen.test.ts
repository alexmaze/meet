import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

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
import {
  generateQwenVoicePreview,
  pcm16ToWav,
} from "../src/qwen-voice-preview.js";

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

describe("Qwen voice preview", () => {
  it("turns allowlisted realtime PCM into a playable mono WAV", async () => {
    const upstreamServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(upstreamServer, "listening");
    const address = upstreamServer.address();
    if (typeof address === "string" || address === null) {
      throw new Error("测试 WebSocket 服务未监听 TCP 端口。");
    }

    let authorization: string | undefined;
    const receivedTypes: string[] = [];
    upstreamServer.once("connection", (socket, request) => {
      authorization = request.headers.authorization;
      socket.send(JSON.stringify({ type: "session.created" }));
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        receivedTypes.push(String(event.type));
        if (event.type === "session.update") {
          expect(event).toMatchObject({
            session: {
              voice: "longanxiaoxin",
              output_audio_format: "pcm",
            },
          });
          socket.send(JSON.stringify({ type: "session.updated" }));
        }
        if (event.type === "conversation.item.create") {
          expect(event).toMatchObject({
            item: {
              role: "user",
              content: [{ type: "input_text" }],
            },
          });
        }
        if (event.type === "response.create") {
          for (const [index, delta] of ["AQI=", "AwQ="].entries()) {
            socket.send(
              JSON.stringify({
                type: "response.audio.delta",
                response_id: "response-preview",
                item_id: "item-preview",
                output_index: 0,
                content_index: index,
                delta,
              }),
            );
          }
          socket.send(
            JSON.stringify({
              type: "response.done",
              response: { id: "response-preview", status: "completed" },
            }),
          );
        }
      });
    });

    try {
      const wav = await generateQwenVoicePreview({
        config: { ...qwenConfig, requestTimeoutMs: 1_000 },
        model: "qwen-audio-3.0-realtime-plus",
        voice: "longanxiaoxin",
        webSocketFactory: (_url, options) =>
          new WebSocket(`ws://127.0.0.1:${address.port}`, options),
      });
      expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
      expect(wav.readUInt32LE(24)).toBe(24_000);
      expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4]);
      expect(receivedTypes).toEqual([
        "session.update",
        "conversation.item.create",
        "response.create",
      ]);
      expect(authorization).toBe("Bearer test-key");
    } finally {
      await new Promise<void>((resolve, reject) => {
        upstreamServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("writes the PCM length into a standard WAV header", () => {
    const wav = pcm16ToWav(Buffer.from([0, 0, 1, 0]), 24_000);
    expect(wav.readUInt32LE(4)).toBe(40);
    expect(wav.readUInt32LE(40)).toBe(4);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt16LE(34)).toBe(16);
  });
});
