import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";

const config: AppConfig = {
  server: { host: "127.0.0.1", port: 8787, logLevel: "silent" },
  qwen: {
    enabled: true,
    apiKey: "never-return-this-key",
    endpoint: "realtime.example.com",
    region: "cn-beijing",
    model: "qwen-audio-3.0-realtime-plus",
    voice: "longanqian",
    instructions: "测试",
    requestTimeoutMs: 15_000,
  },
};

describe("Meet API", () => {
  it("returns public realtime config without secrets", async () => {
    const app = await buildApp({ config, logger: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/realtime/qwen/config",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      enabled: true,
      configured: true,
      model: "qwen-audio-3.0-realtime-plus",
      availableModels: [
        "qwen-audio-3.0-realtime-plus",
        "qwen-audio-3.0-realtime-flash",
      ],
      voice: "longanqian",
    });
    expect(response.body).not.toContain("never-return-this-key");
    expect(response.body).not.toContain("realtime.example.com");
    await app.close();
  });

  it("reports realtime as unconfigured when the endpoint is missing", async () => {
    const app = await buildApp({
      config: {
        ...config,
        qwen: { ...config.qwen, endpoint: undefined },
      },
      logger: false,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/realtime/qwen/config",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ configured: false });
    await app.close();
  });

  it("proxies SDP as application/sdp", async () => {
    const answer = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
    const fetchFunction = vi.fn(
      async () =>
        new Response(answer, {
          status: 200,
          headers: { "Content-Type": "application/sdp" },
        }),
    ) as typeof globalThis.fetch;
    const app = await buildApp({ config, fetchFunction, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/api/realtime/qwen/sessions",
      headers: { "content-type": "application/sdp" },
      payload: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/sdp");
    expect(response.body).toBe(answer);
    await app.close();
  });

  it("rejects models outside the Audio 3.0 allowlist", async () => {
    const fetchFunction = vi.fn() as typeof globalThis.fetch;
    const app = await buildApp({ config, fetchFunction, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/api/realtime/qwen/sessions?model=qwen3.5-omni-plus-realtime",
      headers: { "content-type": "application/sdp" },
      payload: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_MODEL" });
    expect(fetchFunction).not.toHaveBeenCalled();
    await app.close();
  });

  it("normalizes an HTTPS WebRTC endpoint from the environment", () => {
    const loaded = loadConfig({
      QWEN_REALTIME_ENDPOINT: "https://realtime.example.com/",
    });

    expect(loaded.qwen.endpoint).toBe("realtime.example.com");
  });

  it("rejects an endpoint containing an upstream path", () => {
    expect(() =>
      loadConfig({
        QWEN_REALTIME_ENDPOINT: "https://realtime.example.com/custom/path",
      }),
    ).toThrow(/QWEN_REALTIME_ENDPOINT/);
  });
});
