import { describe, expect, it, vi } from "vitest";

import type {
  AuthRepository,
  AuthUserRecord,
  LoginSessionRecord,
} from "../src/auth/repository.js";
import { hashSessionToken } from "../src/auth/session-token.js";
import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";

const config: AppConfig = {
  server: { host: "127.0.0.1", port: 8787, logLevel: "silent" },
  database: {},
  auth: {
    cookieName: "meet_session",
    cookieSecure: false,
    sessionTtlMs: 30 * 24 * 60 * 60 * 1_000,
    loginMaxAttempts: 10,
    loginWindowMs: 300_000,
  },
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

const sessionToken = "authenticated-test-session";
const testUser: AuthUserRecord = {
  id: "4d1c2e31-ad0e-4fa9-9ae8-ae3497069116",
  username: "admin",
  displayName: "家庭管理员",
  accountType: "admin",
  status: "active",
  guardianHistoryAccess: null,
  createdAt: new Date("2026-08-09T00:00:00.000Z"),
  updatedAt: new Date("2026-08-09T00:00:00.000Z"),
};
const authRepository: AuthRepository = {
  async findCredentialByUsername() {
    return null;
  },
  async createLoginSessionIfCredentialCurrent(_session: LoginSessionRecord) {
    return true;
  },
  async findUserBySessionTokenHash(tokenHash) {
    return tokenHash === hashSessionToken(sessionToken) ? testUser : null;
  },
  async revokeLoginSession() {},
};
const authHeaders = { cookie: `meet_session=${sessionToken}` };

describe("Meet API", () => {
  it("returns authenticated realtime config without secrets", async () => {
    const app = await buildApp({ config, authRepository, logger: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/realtime/qwen/config",
      headers: authHeaders,
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
      authRepository,
      logger: false,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/realtime/qwen/config",
      headers: authHeaders,
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
    const app = await buildApp({
      config,
      fetchFunction,
      authRepository,
      logger: false,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/realtime/qwen/sessions",
      headers: {
        ...authHeaders,
        "content-type": "application/sdp",
      },
      payload: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/sdp");
    expect(response.body).toBe(answer);
    await app.close();
  });

  it("does not expose unexpected upstream error details", async () => {
    const fetchFunction = vi.fn(async () => {
      throw new Error("upstream.internal.example leaked detail");
    }) as typeof globalThis.fetch;
    const app = await buildApp({
      config,
      fetchFunction,
      authRepository,
      logger: false,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/realtime/qwen/sessions",
      headers: {
        ...authHeaders,
        "content-type": "application/sdp",
      },
      payload: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      code: "QWEN_NETWORK_ERROR",
      message: "无法连接千问实时服务。",
    });
    expect(response.body).not.toContain("upstream.internal.example");
    await app.close();
  });

  it("rejects models outside the Audio 3.0 allowlist", async () => {
    const fetchFunction = vi.fn() as typeof globalThis.fetch;
    const app = await buildApp({
      config,
      fetchFunction,
      authRepository,
      logger: false,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/realtime/qwen/sessions?model=qwen3.5-omni-plus-realtime",
      headers: {
        ...authHeaders,
        "content-type": "application/sdp",
      },
      payload: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_MODEL" });
    expect(fetchFunction).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects anonymous realtime access before using provider credentials", async () => {
    const fetchFunction = vi.fn() as typeof globalThis.fetch;
    const app = await buildApp({
      config,
      fetchFunction,
      authRepository,
      logger: false,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/realtime/qwen/sessions",
      headers: { "content-type": "application/sdp" },
      payload: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
    });

    expect(response.statusCode).toBe(401);
    expect(fetchFunction).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires authentication for realtime configuration", async () => {
    const app = await buildApp({ config, authRepository, logger: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/realtime/qwen/config",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
    });
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

  it("defaults session cookies to Secure and requires an explicit local override", () => {
    expect(loadConfig({}).auth.cookieSecure).toBe(true);
    expect(loadConfig({ AUTH_COOKIE_SECURE: "false" }).auth.cookieSecure).toBe(
      false,
    );
    expect(() => loadConfig({ AUTH_COOKIE_SECURE: "auto" })).toThrow(
      /AUTH_COOKIE_SECURE/,
    );
  });
});
