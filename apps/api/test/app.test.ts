import { describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import {
  BUILTIN_CHARACTER_PRESETS,
  BUILTIN_VOICE_PROFILES,
  DEFAULT_PROVIDER_PROFILE,
  type CharacterAggregate,
} from "@meet/database";

import type {
  AuthRepository,
  AuthUserRecord,
  LoginSessionRecord,
} from "../src/auth/repository.js";
import { hashSessionToken } from "../src/auth/session-token.js";
import { buildApp } from "../src/app.js";
import type { CharacterRepository } from "../src/characters/repository.js";
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
const testCharacter = aggregateFromPreset();
const characterRepository = {
  async listVisible() {
    return [testCharacter];
  },
  async findVisible() {
    return testCharacter;
  },
  async listCatalog() {
    return {
      providers: [testCharacter.providerProfile],
      voices: [testCharacter.voiceProfile],
    };
  },
  async create() {
    throw new Error("unused");
  },
  async update() {
    throw new Error("unused");
  },
  async updateVisibility() {
    throw new Error("unused");
  },
  async copy() {
    throw new Error("unused");
  },
  async restore() {
    throw new Error("unused");
  },
  async delete() {
    throw new Error("unused");
  },
} satisfies CharacterRepository;
const characterSessionUrl = `/api/characters/${testCharacter.character.id}/realtime/sessions`;
const characterWebSocketUrl = `/api/characters/${testCharacter.character.id}/realtime/websocket`;

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
      characterRepository,
      logger: false,
    });
    const response = await app.inject({
      method: "POST",
      url: characterSessionUrl,
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

  it("authenticates and relays Qwen WebSocket events without exposing the API key", async () => {
    const upstreamServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(upstreamServer, "listening");
    const address = upstreamServer.address();
    if (typeof address === "string" || address === null) {
      throw new Error("测试 WebSocket 服务未监听 TCP 端口。");
    }

    let resolveUpstreamConnection!: (socket: WebSocket) => void;
    const upstreamConnection = new Promise<WebSocket>((resolve) => {
      resolveUpstreamConnection = resolve;
    });
    let authorization: string | undefined;
    upstreamServer.once("connection", (socket, request) => {
      authorization = request.headers.authorization;
      resolveUpstreamConnection(socket);
    });

    const qwenWebSocketFactory = vi.fn((url: string, options) => {
      expect(url).toBe(
        "wss://realtime.example.com/api-ws/v1/realtime?model=qwen-audio-3.0-realtime-plus",
      );
      return new WebSocket(`ws://127.0.0.1:${address.port}`, options);
    });
    const app = await buildApp({
      config,
      authRepository,
      characterRepository,
      qwenWebSocketFactory,
      logger: false,
    });
    await app.ready();
    const runtimeResponse = await app.inject({
      method: "GET",
      url: `/api/characters/${testCharacter.character.id}/runtime`,
      headers: authHeaders,
    });
    const runtime = runtimeResponse.json<{
      realtime: { voice: string; instructions: string };
    }>().realtime;

    let resolveReady!: () => void;
    const relayReady = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    let resolveRelayedResponse!: (event: Record<string, unknown>) => void;
    const relayedResponse = new Promise<Record<string, unknown>>((resolve) => {
      resolveRelayedResponse = resolve;
    });
    let resolveRelayError!: (event: Record<string, unknown>) => void;
    const relayError = new Promise<Record<string, unknown>>((resolve) => {
      resolveRelayError = resolve;
    });
    const client = await app.injectWS(
      characterWebSocketUrl,
      {
        headers: {
          ...authHeaders,
          host: "meet.test",
          origin: "http://meet.test",
        },
      },
      {
        onInit(socket) {
          socket.on("message", (data) => {
            const event = JSON.parse(data.toString()) as Record<
              string,
              unknown
            >;
            if (event.type === "relay.ready") resolveReady();
            if (event.type === "response.audio.delta") {
              resolveRelayedResponse(event);
            }
            if (event.type === "relay.error") resolveRelayError(event);
          });
        },
      },
    );
    const upstream = await withTimeout(
      upstreamConnection,
      "upstream connection",
    );
    await withTimeout(relayReady, "relay ready");

    const sessionUpdate = JSON.stringify({
      event_id: "event-session",
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: runtime.voice,
        input_audio_format: "pcm",
        output_audio_format: "pcm",
        instructions: runtime.instructions,
        max_history_turns: 50,
        turn_detection: { type: "smart_turn" },
      },
    });
    const upstreamSessionUpdate = once(upstream, "message");
    client.send(sessionUpdate);
    const [forwardedSessionUpdate] = await withTimeout(
      upstreamSessionUpdate,
      "session update relay",
    );
    expect(forwardedSessionUpdate.toString()).toBe(sessionUpdate);

    const clientEvent = JSON.stringify({
      event_id: "event-1",
      type: "input_audio_buffer.append",
      audio: "AQIDBA==",
    });
    const upstreamMessage = once(upstream, "message");
    client.send(clientEvent);
    const [forwarded] = await withTimeout(
      upstreamMessage,
      "client event relay",
    );
    expect(forwarded.toString()).toBe(clientEvent);

    upstream.send(
      JSON.stringify({
        type: "response.audio.delta",
        response_id: "response-1",
        delta: "base64-response-audio",
      }),
    );
    await expect(
      withTimeout(relayedResponse, "upstream event relay"),
    ).resolves.toMatchObject({
      type: "response.audio.delta",
      response_id: "response-1",
      delta: "base64-response-audio",
    });
    expect(authorization).toBe("Bearer never-return-this-key");
    expect(qwenWebSocketFactory).toHaveBeenCalledTimes(1);

    const clientClosed = once(client, "close");
    const upstreamClosed = once(upstream, "close");
    // Session identity (voice/instructions/turn mode) is immutable for this
    // relay; a second update is a policy violation rather than a way to mutate
    // the provider session after authentication.
    client.send(sessionUpdate);
    await expect(
      withTimeout(relayError, "relay policy error"),
    ).resolves.toMatchObject({
      type: "relay.error",
      code: "INVALID_CLIENT_EVENT",
    });
    await withTimeout(clientClosed, "client policy close");
    await withTimeout(upstreamClosed, "linked upstream close");
    await app.close();
    await closeWebSocketServer(upstreamServer);
  });

  it("rejects cross-origin Qwen WebSocket upgrades before opening upstream", async () => {
    const qwenWebSocketFactory = vi.fn();
    const app = await buildApp({
      config,
      authRepository,
      characterRepository,
      qwenWebSocketFactory,
      logger: false,
    });
    await app.ready();

    await expect(
      app.injectWS(characterWebSocketUrl, {
        headers: {
          ...authHeaders,
          host: "meet.test",
          origin: "https://evil.example",
        },
      }),
    ).rejects.toThrow("Unexpected server response: 403");
    expect(qwenWebSocketFactory).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects anonymous Qwen WebSocket upgrades before opening upstream", async () => {
    const qwenWebSocketFactory = vi.fn();
    const app = await buildApp({
      config,
      authRepository,
      characterRepository,
      qwenWebSocketFactory,
      logger: false,
    });
    await app.ready();

    await expect(
      app.injectWS(characterWebSocketUrl, {
        headers: { host: "meet.test", origin: "http://meet.test" },
      }),
    ).rejects.toThrow("Unexpected server response: 401");
    expect(qwenWebSocketFactory).not.toHaveBeenCalled();
    await app.close();
  });

  it("checks character visibility before opening the Qwen WebSocket", async () => {
    const qwenWebSocketFactory = vi.fn();
    const hiddenCharacterRepository = {
      ...characterRepository,
      async findVisible() {
        return null;
      },
    } satisfies CharacterRepository;
    const app = await buildApp({
      config,
      authRepository,
      characterRepository: hiddenCharacterRepository,
      qwenWebSocketFactory,
      logger: false,
    });
    await app.ready();

    await expect(
      app.injectWS(characterWebSocketUrl, {
        headers: {
          ...authHeaders,
          host: "meet.test",
          origin: "http://meet.test",
        },
      }),
    ).rejects.toThrow("Unexpected server response: 404");
    expect(qwenWebSocketFactory).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a character model outside the Qwen Audio allowlist", async () => {
    const qwenWebSocketFactory = vi.fn();
    const invalidModelCharacter = {
      ...testCharacter,
      providerProfile: {
        ...testCharacter.providerProfile,
        model: "qwen3.5-omni-plus-realtime",
      },
    };
    const invalidModelRepository = {
      ...characterRepository,
      async findVisible() {
        return invalidModelCharacter;
      },
    } satisfies CharacterRepository;
    const app = await buildApp({
      config,
      authRepository,
      characterRepository: invalidModelRepository,
      qwenWebSocketFactory,
      logger: false,
    });
    await app.ready();

    await expect(
      app.injectWS(characterWebSocketUrl, {
        headers: {
          ...authHeaders,
          host: "meet.test",
          origin: "http://meet.test",
        },
      }),
    ).rejects.toThrow("Unexpected server response: 409");
    expect(qwenWebSocketFactory).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects Qwen WebSocket upgrades when provider credentials are missing", async () => {
    const qwenWebSocketFactory = vi.fn();
    const app = await buildApp({
      config: {
        ...config,
        qwen: { ...config.qwen, apiKey: undefined },
      },
      authRepository,
      characterRepository,
      qwenWebSocketFactory,
      logger: false,
    });
    await app.ready();

    await expect(
      app.injectWS(characterWebSocketUrl, {
        headers: {
          ...authHeaders,
          host: "meet.test",
          origin: "http://meet.test",
        },
      }),
    ).rejects.toThrow("Unexpected server response: 503");
    expect(qwenWebSocketFactory).not.toHaveBeenCalled();
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
      characterRepository,
      logger: false,
    });
    const response = await app.inject({
      method: "POST",
      url: characterSessionUrl,
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
      characterRepository,
      logger: false,
    });
    const response = await app.inject({
      method: "POST",
      url: `${characterSessionUrl}?model=qwen3.5-omni-plus-realtime`,
      headers: {
        ...authHeaders,
        "content-type": "application/sdp",
      },
      payload: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetchFunction).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects anonymous realtime access before using provider credentials", async () => {
    const fetchFunction = vi.fn() as typeof globalThis.fetch;
    const app = await buildApp({
      config,
      fetchFunction,
      authRepository,
      characterRepository,
      logger: false,
    });
    const response = await app.inject({
      method: "POST",
      url: characterSessionUrl,
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

function aggregateFromPreset(): CharacterAggregate {
  const preset = BUILTIN_CHARACTER_PRESETS[0]!;
  const voice = BUILTIN_VOICE_PROFILES.find(
    ({ id }) => id === preset.voiceProfileId,
  );
  if (!voice) throw new Error("测试预置角色缺少声音。");
  const timestamp = new Date("2026-08-09T00:00:00.000Z");
  return {
    character: {
      ...preset,
      ownerUserId: null,
      visibility: "builtin",
      revision: 1,
      deletedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    providerProfile: {
      ...DEFAULT_PROVIDER_PROFILE,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    voiceProfile: { ...voice, createdAt: timestamp, updatedAt: timestamp },
  };
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`等待 ${label} 超时。`)),
          1_000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
