import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
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
