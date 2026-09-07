import { conversationLifecycleRepositoryFixture } from "./conversation-lifecycle-fixture.js";
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
import type { ConversationRepository } from "../src/conversations/repository.js";

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
  async findCredentialBySessionTokenHash() {
    return null;
  },
  async createLoginSessionIfCredentialCurrent(_session: LoginSessionRecord) {
    return true;
  },
  async findUserBySessionTokenHash(tokenHash) {
    return tokenHash === hashSessionToken(sessionToken) ? testUser : null;
  },
  async revokeLoginSession() {},
  async changeOwnPassword() {
    return { kind: "invalid_session" };
  },
};
const authHeaders = { cookie: `meet_session=${sessionToken}` };
const testConversationId = "9172f06d-c71a-47b3-94fe-35e1204b5b55";
const testCharacter = aggregateFromPreset();
const characterRepository = {
  async listFavoriteIds() {
    return [];
  },
  async setFavorite() {
    return true;
  },
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
const conversationRepository = {
  ...conversationLifecycleRepositoryFixture(),
  create: vi.fn(async () => {
    throw new Error("unused");
  }),
  list: vi.fn(async () => []),
  isGuardianReadableTarget: vi.fn(async () => false),
  findReadable: vi.fn(async () => null),
  loadRealtimeContext: vi.fn(async () => ({
    mode: "normal" as const,
    runtimeSnapshot: null,
    checkpoint: null,
    messages: [],
    summaries: [],
    memories: [],
  })),
  loadActiveMemoriesByIds: vi.fn(async () => []),
  appendMessages: vi.fn(async () => ({ kind: "not_found" as const })),
  complete: vi.fn(async () => ({ kind: "not_found" as const })),
  delete: vi.fn(async () => false),
} satisfies ConversationRepository;
const characterSessionUrl = `/api/characters/${testCharacter.character.id}/realtime/sessions`;
const characterWebSocketUrl = `/api/characters/${testCharacter.character.id}/realtime/websocket?conversationId=${testConversationId}&clientId=83e63c3c-7d2c-410b-9052-9f74c6195041&epoch=1`;
const voicePreviewUrl = `/api/characters/voices/${testCharacter.voiceProfile.id}/preview`;

describe("Meet API", () => {
  it("forbids non-admin accounts from model management APIs", async () => {
    const adultRepository: AuthRepository = {
      ...authRepository,
      async findUserBySessionTokenHash(tokenHash) {
        return tokenHash === hashSessionToken(sessionToken)
          ? { ...testUser, accountType: "adult" }
          : null;
      },
    };
    const app = await buildApp({
      config,
      authRepository: adultRepository,
      logger: false,
    });
    for (const request of [
      { method: "GET" as const, url: "/api/admin/model-settings" },
      {
        method: "POST" as const,
        url: "/api/admin/model-connections",
        payload: {
          adapter: "qwen_realtime",
          displayName: "不应创建",
          endpoint: "https://realtime.example.com",
          apiKey: "must-not-be-used",
        },
      },
    ]) {
      const response = await app.inject({ ...request, headers: authHeaders });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        code: "MODEL_SETTINGS_FORBIDDEN",
      });
    }
    await app.close();
  });

  it("reports provider readiness without exposing realtime secrets", async () => {
    const app = await buildApp({
      config: {
        ...config,
        doubao: {
          enabled: true,
          apiKey: "never-return-this-doubao-key",
          model: "1.2.6.1",
          requestTimeoutMs: 15_000,
        },
      },
      authRepository,
      logger: false,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/realtime/providers",
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      providers: [
        { provider: "qwen", enabled: true, configured: true },
        { provider: "doubao", enabled: true, configured: true },
      ],
    });
    expect(response.body).not.toContain("never-return-this-key");
    expect(response.body).not.toContain("never-return-this-doubao-key");
    await app.close();
  });

  it("removes the legacy global Qwen config endpoint", async () => {
    const app = await buildApp({ config, authRepository, logger: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/realtime/qwen/config",
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("never-return-this-key");
    expect(response.body).not.toContain("realtime.example.com");
    await app.close();
  });

  it("does not restore the removed global config endpoint when legacy config is incomplete", async () => {
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

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("returns an authenticated catalog voice preview as WAV", async () => {
    const upstreamServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(upstreamServer, "listening");
    const address = upstreamServer.address();
    if (typeof address === "string" || address === null) {
      throw new Error("测试 WebSocket 服务未监听 TCP 端口。");
    }
    upstreamServer.once("connection", (socket) => {
      socket.send(JSON.stringify({ type: "session.created" }));
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        if (event.type === "session.update") {
          expect(event).toMatchObject({
            session: { voice: testCharacter.voiceProfile.providerVoiceId },
          });
          socket.send(JSON.stringify({ type: "session.updated" }));
        }
        if (event.type === "response.create") {
          socket.send(
            JSON.stringify({
              type: "response.audio.delta",
              response_id: "response-preview",
              item_id: "item-preview",
              output_index: 0,
              content_index: 0,
              delta: "AQIDBA==",
            }),
          );
          socket.send(
            JSON.stringify({
              type: "response.done",
              response: { id: "response-preview", status: "completed" },
            }),
          );
        }
      });
    });

    const app = await buildApp({
      config,
      authRepository,
      characterRepository,
      qwenWebSocketFactory: (_url, options) =>
        new WebSocket(`ws://127.0.0.1:${address.port}`, options),
      logger: false,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: voicePreviewUrl,
        headers: authHeaders,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("audio/wav");
      expect(response.rawPayload.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect([...response.rawPayload.subarray(44)]).toEqual([1, 2, 3, 4]);
      expect(response.body).not.toContain("never-return-this-key");
    } finally {
      await app.close();
      await closeWebSocketServer(upstreamServer);
    }
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
    const relayConversationRepository = {
      ...conversationRepository,
      loadRealtimeContext: vi.fn(async () => ({
        mode: "normal" as const,
        runtimeSnapshot: null,
        checkpoint: null,
        messages: [
          {
            id: "9bb6162e-e85c-4e5d-a3ff-000000000001",
            conversationId: testConversationId,
            role: "user" as const,
            text: "我周五要考试。",
            status: "completed" as const,
            conversationStatus: "active" as const,
            createdAt: new Date("2026-08-09T05:00:00.000Z"),
          },
          {
            id: "9bb6162e-e85c-4e5d-a3ff-000000000002",
            conversationId: testConversationId,
            role: "assistant" as const,
            text: "记得，我们先复习分数。",
            status: "completed" as const,
            conversationStatus: "active" as const,
            createdAt: new Date("2026-08-09T05:00:01.000Z"),
          },
        ],
        summaries: [],
        memories: [],
      })),
    } satisfies ConversationRepository;
    const app = await buildApp({
      config,
      authRepository,
      characterRepository,
      conversationRepository: relayConversationRepository,
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

    const injectedHistory = nextWebSocketMessages(upstream, 4);
    upstream.send(JSON.stringify({ type: "session.updated" }));
    const injectedEvents = (
      await withTimeout(injectedHistory, "history injection")
    ).map((payload) => JSON.parse(payload) as Record<string, unknown>);
    expect(injectedEvents).toHaveLength(4);
    expect(injectedEvents.map((event) => event.type)).toEqual([
      "conversation.item.create",
      "conversation.item.create",
      "conversation.item.create",
      "conversation.item.create",
    ]);
    expect(injectedEvents[1]).toMatchObject({
      item: {
        role: "user",
        content: [{ type: "input_text", text: "我周五要考试。" }],
      },
    });
    expect(injectedEvents[2]).toMatchObject({
      item: {
        role: "assistant",
        content: [{ type: "output_text", text: "记得，我们先复习分数。" }],
      },
    });

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
      conversationRepository,
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
      conversationRepository,
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
      conversationRepository,
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

  it("rejects an unowned or character-mismatched conversation before opening upstream", async () => {
    const qwenWebSocketFactory = vi.fn();
    const inaccessibleConversationRepository = {
      ...conversationRepository,
      loadRealtimeContext: vi.fn(async () => null),
    } satisfies ConversationRepository;
    const app = await buildApp({
      config,
      authRepository,
      characterRepository,
      conversationRepository: inaccessibleConversationRepository,
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
    expect(
      inaccessibleConversationRepository.loadRealtimeContext,
    ).toHaveBeenCalledWith(
      testUser.id,
      testConversationId,
      testCharacter.character.id,
    );
    expect(qwenWebSocketFactory).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an empty configured realtime model id", async () => {
    const qwenWebSocketFactory = vi.fn();
    const invalidModelCharacter = {
      ...testCharacter,
      providerProfile: {
        ...testCharacter.providerProfile,
        model: "",
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
      conversationRepository,
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
      conversationRepository,
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

  it("does not expose the removed realtime configuration endpoint", async () => {
    const app = await buildApp({ config, authRepository, logger: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/realtime/qwen/config",
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("ignores legacy Qwen endpoint environment variables", () => {
    const loaded = loadConfig({
      QWEN_REALTIME_ENDPOINT: "https://realtime.example.com/",
    });

    expect(loaded.qwen.enabled).toBe(false);
    expect(loaded.qwen.endpoint).toBeUndefined();
  });

  it("ignores legacy Doubao model environment variables", () => {
    const loaded = loadConfig({
      DOUBAO_REALTIME_ENABLED: "true",
      DOUBAO_SPEECH_API_KEY: "server-only-doubao-key",
    });

    expect(loaded.doubao).toMatchObject({
      enabled: false,
      model: "1.2.6.1",
      requestTimeoutMs: 15_000,
    });
    expect(loaded.doubao?.apiKey).toBeUndefined();
    expect(
      loadConfig({ DOUBAO_REALTIME_MODEL: "latest" }).doubao?.enabled,
    ).toBe(false);
  });

  it("does not validate unused legacy model environment variables", () => {
    expect(
      loadConfig({
        QWEN_REALTIME_ENDPOINT: "https://realtime.example.com/custom/path",
      }).qwen.endpoint,
    ).toBeUndefined();
  });

  it("keeps dynamic Qwen teaching disabled unless exact reviewed bindings are configured", () => {
    expect(loadConfig({}).teaching?.dynamicQwen).toBeUndefined();
    expect(() =>
      loadConfig({
        TEACHING_QWEN_DYNAMIC_ENABLED: "true",
      }),
    ).toThrow(/必须同时绑定模型配置与连接/);
    expect(() =>
      loadConfig({
        TEACHING_QWEN_DYNAMIC_ENABLED: "false",
        TEACHING_QWEN_MODEL_PROFILE_ID: "00000000-0000-4000-8000-000000000001",
      }),
    ).toThrow(/只能在 TEACHING_QWEN_DYNAMIC_ENABLED=true/);
    expect(() =>
      loadConfig({
        TEACHING_QWEN_DYNAMIC_ENABLED: "false",
        TEACHING_QWEN_DYNAMIC_ADDITIONAL_BINDINGS: JSON.stringify([
          {
            modelProfileId: "00000000-0000-4000-8000-000000000003",
            modelProfileRevision: 7,
            connectionId: "00000000-0000-4000-8000-000000000002",
            connectionRevision: 5,
          },
        ]),
      }),
    ).toThrow(/只能在 TEACHING_QWEN_DYNAMIC_ENABLED=true/);

    expect(
      loadConfig({
        TEACHING_QWEN_DYNAMIC_ENABLED: "true",
        TEACHING_QWEN_MODEL_PROFILE_ID: "00000000-0000-4000-8000-000000000001",
        TEACHING_QWEN_MODEL_PROFILE_REVISION: "3",
        TEACHING_QWEN_CONNECTION_ID: "00000000-0000-4000-8000-000000000002",
        TEACHING_QWEN_CONNECTION_REVISION: "5",
      }).teaching?.dynamicQwen,
    ).toEqual({
      bindings: [
        {
          modelProfileId: "00000000-0000-4000-8000-000000000001",
          modelProfileRevision: 3,
          connectionId: "00000000-0000-4000-8000-000000000002",
          connectionRevision: 5,
        },
      ],
    });
  });

  it("adds strictly validated dynamic Qwen teaching bindings", () => {
    const environment = {
      TEACHING_QWEN_DYNAMIC_ENABLED: "true",
      TEACHING_QWEN_MODEL_PROFILE_ID: "00000000-0000-4000-8000-000000000001",
      TEACHING_QWEN_MODEL_PROFILE_REVISION: "3",
      TEACHING_QWEN_CONNECTION_ID: "00000000-0000-4000-8000-000000000002",
      TEACHING_QWEN_CONNECTION_REVISION: "5",
    };
    const flashBinding = {
      modelProfileId: "00000000-0000-4000-8000-000000000003",
      modelProfileRevision: 7,
      connectionId: "00000000-0000-4000-8000-000000000002",
      connectionRevision: 5,
    };

    expect(
      loadConfig({
        ...environment,
        TEACHING_QWEN_DYNAMIC_ADDITIONAL_BINDINGS: JSON.stringify([
          flashBinding,
        ]),
      }).teaching?.dynamicQwen,
    ).toEqual({
      bindings: [
        {
          modelProfileId: "00000000-0000-4000-8000-000000000001",
          modelProfileRevision: 3,
          connectionId: "00000000-0000-4000-8000-000000000002",
          connectionRevision: 5,
        },
        flashBinding,
      ],
    });

    expect(() =>
      loadConfig({
        ...environment,
        TEACHING_QWEN_DYNAMIC_ADDITIONAL_BINDINGS: "not-json",
      }),
    ).toThrow(/必须是合法的 JSON 数组/);
    expect(() =>
      loadConfig({
        ...environment,
        TEACHING_QWEN_DYNAMIC_ADDITIONAL_BINDINGS: JSON.stringify([
          { ...flashBinding, unexpected: true },
        ]),
      }),
    ).toThrow(/unexpected/);
    expect(() =>
      loadConfig({
        ...environment,
        TEACHING_QWEN_DYNAMIC_ADDITIONAL_BINDINGS: JSON.stringify([
          { ...flashBinding, modelProfileRevision: 0 },
        ]),
      }),
    ).toThrow(/TEACHING_QWEN_DYNAMIC_ADDITIONAL_BINDINGS/);
    expect(() =>
      loadConfig({
        ...environment,
        TEACHING_QWEN_DYNAMIC_ADDITIONAL_BINDINGS: JSON.stringify([
          {
            ...flashBinding,
            modelProfileId: environment.TEACHING_QWEN_MODEL_PROFILE_ID,
            modelProfileRevision: 3,
          },
        ]),
      }),
    ).toThrow(/不能重复绑定同一模型配置修订/);
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

  it("binds the API to all IPv4 interfaces by default", () => {
    expect(loadConfig({}).server.host).toBe("0.0.0.0");
    expect(loadConfig({ API_HOST: "127.0.0.1" }).server.host).toBe("127.0.0.1");
  });

  it("resolves the private media directory outside public web assets", () => {
    expect(
      loadConfig({ MEDIA_LOCAL_DIR: "./private-media" }).media?.localDirectory,
    ).toMatch(/private-media$/);
    expect(
      loadConfig({
        EMBEDDING_LOCAL_CACHE_DIR: "./private-embedding-models",
      }).embedding?.localCacheDirectory,
    ).toMatch(/private-embedding-models$/);
  });

  it("does not read retired Mem0 embedding environment variables", () => {
    const config = loadConfig({
      MEM0_ENABLED: "true",
      MEM0_EMBEDDING_API_KEY: "legacy-key",
    });
    expect(config).not.toHaveProperty("memory");
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

function nextWebSocketMessages(
  socket: WebSocket,
  count: number,
): Promise<string[]> {
  return new Promise((resolve) => {
    const messages: string[] = [];
    const onMessage = (data: WebSocket.RawData) => {
      messages.push(data.toString());
      if (messages.length === count) {
        socket.off("message", onMessage);
        resolve(messages);
      }
    };
    socket.on("message", onMessage);
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
