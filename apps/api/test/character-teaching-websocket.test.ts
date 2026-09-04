import { once } from "node:events";

import {
  BUILTIN_CHARACTER_PRESETS,
  BUILTIN_VOICE_PROFILES,
  DEFAULT_PROVIDER_PROFILE,
  type CharacterAggregate,
  type ConversationTeachingStateRecord,
} from "@meet/database";
import WebSocket, { WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type {
  AuthRepository,
  AuthUserRecord,
  LoginSessionRecord,
} from "../src/auth/repository.js";
import { hashSessionToken } from "../src/auth/session-token.js";
import type { CharacterRepository } from "../src/characters/repository.js";
import type { AppConfig } from "../src/config.js";
import type { ConversationRepository } from "../src/conversations/repository.js";
import type { TeachingRepository } from "../src/teaching/repository.js";

const sessionToken = "character-teaching-session";
const conversationId = "9172f06d-c71a-47b3-94fe-35e1204b5b55";
const learningPlanId = "8f1b7f3d-0e1f-4a8d-9967-712f18b2d21b";
const child = account("4d1c2e31-ad0e-4fa9-9ae8-ae3497069118", "child");
const adult = account("4d1c2e31-ad0e-4fa9-9ae8-ae3497069117", "adult");
const character = aggregateFromPreset();
const websocketUrl = `/api/characters/${character.character.id}/realtime/websocket?conversationId=${conversationId}`;
const authHeaders = { cookie: `meet_session=${sessionToken}` };

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
    apiKey: "server-only-character-teaching-key",
    endpoint: "realtime.example.com",
    region: "cn-beijing",
    model: "qwen-audio-3.0-realtime-plus",
    voice: "longanqian",
    instructions: "测试",
    requestTimeoutMs: 15_000,
  },
  teaching: {
    dynamicQwen: {
      bindings: [
        {
          modelProfileId: DEFAULT_PROVIDER_PROFILE.id,
          modelProfileRevision: 1,
          connectionId: "00000000-0000-4000-8000-0000000000a1",
          connectionRevision: 1,
        },
      ],
    },
  },
};

describe("Character Qwen WebSocket teaching composition", () => {
  it("loads a prepared child state and maps claim, turn, and revisioned persistence to the repository", async () => {
    const upstream = await createUpstream();
    const teaching = teachingRepository();
    const app = await buildApp({
      config,
      authRepository: authRepository(child),
      characterRepository,
      conversationRepository,
      teachingRepository: teaching,
      qwenWebSocketFactory: (_url, options) =>
        new WebSocket(`ws://127.0.0.1:${upstream.port}`, options),
      logger: false,
    });
    let browser: WebSocket | undefined;

    try {
      await app.ready();
      const runtime = await loadRuntime(app);
      const received: Array<Record<string, unknown>> = [];
      browser = await connectBrowser(app, received);
      const provider = await upstream.connection;
      await waitUntil(() => hasFrame(received, "relay.ready"));

      browser.send(JSON.stringify(baseSessionUpdate(runtime)));
      await waitUntil(() => upstream.events.length === 1);
      provider.send(
        JSON.stringify(
          sessionUpdated(runtime.instructions, runtime.voice, "base-ack"),
        ),
      );
      const initialOpen = await waitForGate(received, true, 1);
      acknowledgeGate(browser, initialOpen, "initial-gate-ack");
      await waitUntil(() => hasTeachingState(received, "available"));

      expect(teaching.loadRuntimeForReconnect).toHaveBeenCalledWith({
        conversationId,
        loadedAt: expect.any(Date),
      });

      browser.send(
        JSON.stringify({
          type: "relay.teaching.request",
          event_id: "child-request-1",
        }),
      );
      const closeForApply = await waitForGate(received, false, 1);
      expect(teaching.claimInvitation).toHaveBeenCalledWith({
        conversationId,
        contentItemIds: ["english-space-orbit-v1"],
        expectedSubject: "english",
        explicitRequest: true,
        claimedAt: expect.any(Date),
      });
      acknowledgeGate(browser, closeForApply, "apply-gate-ack");
      await waitUntil(() => upstream.events.length === 2);
      const directive = readInstructions(upstream.events[1]);
      expect(directive).toContain("orbit");

      provider.send(
        JSON.stringify(
          sessionUpdated(directive, runtime.voice, "directive-ack"),
        ),
      );
      const activeOpen = await waitForGate(received, true, 2);
      acknowledgeGate(browser, activeOpen, "active-gate-ack");
      await waitUntil(() => hasTeachingState(received, "active"));
      await waitUntil(() => upstream.events.length === 3);
      expect(upstream.events[2]).toEqual({
        type: "response.create",
        response: { modalities: ["audio", "text"] },
      });

      provider.send(JSON.stringify(responseCreated("teaching-response-1")));
      provider.send(JSON.stringify(responseDone("teaching-response-1")));
      await waitUntil(() =>
        received.some((frame) => frame.event_id === "done-teaching-response-1"),
      );
      expect(teaching.markRestoring).not.toHaveBeenCalled();
      expect(
        upstream.events.filter(({ type }) => type === "response.create"),
      ).toHaveLength(1);

      provider.send(
        JSON.stringify({
          event_id: "child-answer-started",
          type: "input_audio_buffer.speech_started",
          item_id: "child-answer-1",
        }),
      );
      provider.send(
        JSON.stringify({
          event_id: "child-answer-stopped",
          type: "input_audio_buffer.speech_stopped",
          item_id: "child-answer-1",
        }),
      );
      provider.send(
        JSON.stringify({
          event_id: "stable-user-turn-1",
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "child-answer-1",
          transcript: "orbit 是轨道",
        }),
      );
      await vi.waitFor(() =>
        expect(teaching.recordValidTurn).toHaveBeenCalledWith({
          conversationId,
          recordedAt: expect.any(Date),
        }),
      );

      provider.send(JSON.stringify(responseCreated("teaching-response-2")));
      provider.send(JSON.stringify(responseDone("teaching-response-2")));
      await vi.waitFor(() =>
        expect(teaching.markRestoring).toHaveBeenCalledWith({
          conversationId,
          expectedRevision: 2,
          updatedAt: expect.any(Date),
        }),
      );
      const closeForRestore = await waitForGate(received, false, 2);
      acknowledgeGate(browser, closeForRestore, "restore-gate-ack");
      await waitUntil(() => upstream.events.length === 4);
      expect(readInstructions(upstream.events[3])).toBe(runtime.instructions);

      provider.send(
        JSON.stringify(
          sessionUpdated(runtime.instructions, runtime.voice, "restore-ack"),
        ),
      );
      await vi.waitFor(() =>
        expect(teaching.markCompleted).toHaveBeenCalledWith({
          conversationId,
          expectedRevision: 3,
          updatedAt: expect.any(Date),
        }),
      );
      const finalOpen = await waitForGate(received, true, 3);
      acknowledgeGate(browser, finalOpen, "final-gate-ack");
      await waitUntil(() => hasTeachingState(received, "completed"));
      expect(teaching.claimInvitation).toHaveBeenCalledTimes(1);
      expect(teaching.recordValidTurn).toHaveBeenCalledTimes(1);
      expect(teaching.markRestoring).toHaveBeenCalledTimes(1);
      expect(teaching.markCompleted).toHaveBeenCalledTimes(1);
    } finally {
      browser?.terminate();
      await app.close();
      await upstream.close();
    }
  });

  it("runs the same controlled teaching protocol for an approved Flash runtime", async () => {
    const flashModel = "qwen-audio-3.0-realtime-flash";
    const flashCharacter = aggregateFromPreset(flashModel);
    const upstream = await createUpstream();
    const teaching = teachingRepository(flashModel);
    const app = await buildApp({
      config,
      authRepository: authRepository(child),
      characterRepository: characterRepositoryFor(flashCharacter),
      conversationRepository,
      teachingRepository: teaching,
      qwenWebSocketFactory: (_url, options) =>
        new WebSocket(`ws://127.0.0.1:${upstream.port}`, options),
      logger: false,
    });
    let browser: WebSocket | undefined;

    try {
      await app.ready();
      const runtime = await loadRuntime(app);
      expect(runtime.model).toBe(flashModel);
      const received: Array<Record<string, unknown>> = [];
      browser = await connectBrowser(app, received);
      const provider = await upstream.connection;
      await waitUntil(() => hasFrame(received, "relay.ready"));

      browser.send(JSON.stringify(baseSessionUpdate(runtime)));
      await waitUntil(() => upstream.events.length === 1);
      provider.send(
        JSON.stringify(
          sparseSessionUpdated(runtime.voice, "flash-base-ack", flashModel),
        ),
      );
      const initialOpen = await waitForGate(received, true, 1);
      acknowledgeGate(browser, initialOpen, "flash-initial-gate-ack");
      await waitUntil(() => hasTeachingState(received, "available"));

      browser.send(
        JSON.stringify({
          type: "relay.teaching.request",
          event_id: "flash-child-request-1",
        }),
      );
      const closeForApply = await waitForGate(received, false, 1);
      acknowledgeGate(browser, closeForApply, "flash-apply-gate-ack");
      await waitUntil(() => upstream.events.length === 2);
      const directive = readInstructions(upstream.events[1]);
      expect(directive).toContain("orbit");
      provider.send(
        JSON.stringify(
          sessionUpdated(
            directive,
            runtime.voice,
            "flash-apply-ack",
            flashModel,
          ),
        ),
      );
      const activeOpen = await waitForGate(received, true, 2);
      acknowledgeGate(browser, activeOpen, "flash-active-gate-ack");
      await waitUntil(() => hasTeachingState(received, "active"));
      await waitUntil(() => upstream.events.length === 3);
      expect(upstream.events[2]).toEqual({
        type: "response.create",
        response: { modalities: ["audio", "text"] },
      });
      expect(teaching.claimInvitation).toHaveBeenCalledTimes(1);
      expect(teaching.loadRuntimeForReconnect).toHaveBeenCalledWith({
        conversationId,
        loadedAt: expect.any(Date),
      });
    } finally {
      browser?.terminate();
      await app.close();
      await upstream.close();
    }
  });

  it("keeps a muted Flash teaching session on ordinary chat after a sparse base ACK", async () => {
    const flashModel = "qwen-audio-3.0-realtime-flash";
    const flashCharacter = aggregateFromPreset(flashModel);
    const upstream = await createUpstream();
    const teaching = teachingRepository(flashModel);
    teaching.loadRuntimeForReconnect.mockResolvedValue({
      kind: "loaded",
      state: teachingState("muted", 5),
      conversationStartedAt: new Date("2026-08-15T08:00:00.000Z"),
      provider: "qwen",
      model: flashModel,
    });
    const app = await buildApp({
      config,
      authRepository: authRepository(child),
      characterRepository: characterRepositoryFor(flashCharacter),
      conversationRepository,
      teachingRepository: teaching,
      qwenWebSocketFactory: (_url, options) =>
        new WebSocket(`ws://127.0.0.1:${upstream.port}`, options),
      logger: false,
    });
    let browser: WebSocket | undefined;

    try {
      await app.ready();
      const runtime = await loadRuntime(app);
      const received: Array<Record<string, unknown>> = [];
      browser = await connectBrowser(app, received);
      const provider = await upstream.connection;
      await waitUntil(() => hasFrame(received, "relay.ready"));

      browser.send(JSON.stringify(baseSessionUpdate(runtime)));
      await waitUntil(() => upstream.events.length === 1);
      provider.send(
        JSON.stringify(
          sparseSessionUpdated(runtime.voice, "muted-base-ack", flashModel),
        ),
      );
      const initialOpen = await waitForGate(received, true, 1);
      acknowledgeGate(browser, initialOpen, "muted-initial-gate-ack");
      await waitUntil(() => hasTeachingState(received, "muted"));

      browser.send(
        JSON.stringify({
          type: "relay.teaching.request",
          event_id: "muted-teaching-request",
        }),
      );
      provider.send(JSON.stringify(responseCreated("ordinary-chat")));
      await waitUntil(() =>
        received.some(({ event_id }) => event_id === "created-ordinary-chat"),
      );

      expect(teaching.claimInvitation).not.toHaveBeenCalled();
      expect(upstream.events).toHaveLength(1);
      expect(browser.readyState).toBe(WebSocket.OPEN);
    } finally {
      browser?.terminate();
      await app.close();
      await upstream.close();
    }
  });

  it("keeps Flash teaching unavailable when its exact profile revision is not approved", async () => {
    const flashModel = "qwen-audio-3.0-realtime-flash";
    const flashCharacter = aggregateFromPreset(flashModel);
    const mismatchedConfig: AppConfig = {
      ...config,
      teaching: {
        dynamicQwen: {
          bindings: [
            {
              modelProfileId: DEFAULT_PROVIDER_PROFILE.id,
              modelProfileRevision: 2,
              connectionId: "00000000-0000-4000-8000-0000000000a1",
              connectionRevision: 1,
            },
          ],
        },
      },
    };
    const upstream = await createUpstream();
    const teaching = teachingRepository(flashModel);
    const app = await buildApp({
      config: mismatchedConfig,
      authRepository: authRepository(child),
      characterRepository: characterRepositoryFor(flashCharacter),
      conversationRepository,
      teachingRepository: teaching,
      qwenWebSocketFactory: (_url, options) =>
        new WebSocket(`ws://127.0.0.1:${upstream.port}`, options),
      logger: false,
    });
    let browser: WebSocket | undefined;

    try {
      await app.ready();
      const runtime = await loadRuntime(app);
      const received: Array<Record<string, unknown>> = [];
      browser = await connectBrowser(app, received);
      const provider = await upstream.connection;
      await waitUntil(() => hasFrame(received, "relay.ready"));
      browser.send(JSON.stringify(baseSessionUpdate(runtime)));
      await waitUntil(() => upstream.events.length === 1);
      provider.send(
        JSON.stringify(
          sessionUpdated(
            runtime.instructions,
            runtime.voice,
            "flash-unapproved-base-ack",
            flashModel,
          ),
        ),
      );
      const initialOpen = await waitForGate(received, true, 1);
      acknowledgeGate(browser, initialOpen, "flash-unapproved-gate-ack");
      await waitUntil(() => hasTeachingState(received, "unavailable"));

      browser.send(
        JSON.stringify({
          type: "relay.teaching.request",
          event_id: "flash-unapproved-request",
        }),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(teaching.claimInvitation).not.toHaveBeenCalled();
      expect(upstream.events).toHaveLength(1);
      expect(
        received.filter(
          (frame) =>
            frame.type === "relay.teaching.audio_gate" && frame.open === false,
        ),
      ).toHaveLength(0);
    } finally {
      browser?.terminate();
      await app.close();
      await upstream.close();
    }
  });

  it("keeps teaching disabled for an adult account", async () => {
    const upstream = await createUpstream();
    const teaching = teachingRepository();
    const app = await buildApp({
      config,
      authRepository: authRepository(adult),
      characterRepository,
      conversationRepository,
      teachingRepository: teaching,
      qwenWebSocketFactory: (_url, options) =>
        new WebSocket(`ws://127.0.0.1:${upstream.port}`, options),
      logger: false,
    });
    let browser: WebSocket | undefined;

    try {
      await app.ready();
      const runtime = await loadRuntime(app);
      const received: Array<Record<string, unknown>> = [];
      browser = await connectBrowser(app, received);
      const provider = await upstream.connection;
      await waitUntil(() => hasFrame(received, "relay.ready"));
      browser.send(JSON.stringify(baseSessionUpdate(runtime)));
      await waitUntil(() => upstream.events.length === 1);
      provider.send(
        JSON.stringify(
          sessionUpdated(runtime.instructions, runtime.voice, "base-ack"),
        ),
      );
      await waitUntil(() => hasFrame(received, "session.updated"));

      browser.send(
        JSON.stringify({
          type: "relay.teaching.request",
          event_id: "disabled-request-adult",
        }),
      );
      await waitUntil(() => hasTeachingState(received, "unavailable"));

      expect(teaching.loadRuntimeForReconnect).not.toHaveBeenCalled();
      expect(teaching.claimInvitation).not.toHaveBeenCalled();
      expect(
        received.some(({ type }) => type === "relay.teaching.audio_gate"),
      ).toBe(false);
    } finally {
      browser?.terminate();
      await app.close();
      await upstream.close();
    }
  });

  it("requires a child conversation to prepare teaching before opening the Provider socket", async () => {
    const teaching = teachingRepository();
    teaching.loadRuntimeForReconnect.mockResolvedValue({ kind: "not_found" });
    const qwenWebSocketFactory = vi.fn();
    const app = await buildApp({
      config,
      authRepository: authRepository(child),
      characterRepository,
      conversationRepository,
      teachingRepository: teaching,
      qwenWebSocketFactory,
      logger: false,
    });

    try {
      await app.ready();
      await expect(
        app.injectWS(websocketUrl, { headers: websocketHeaders() }),
      ).rejects.toThrow("Unexpected server response: 409");
      expect(teaching.loadRuntimeForReconnect).toHaveBeenCalledWith({
        conversationId,
        loadedAt: expect.any(Date),
      });
      expect(qwenWebSocketFactory).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("fails closed before opening the Provider socket when the child teaching state cannot load", async () => {
    const teaching = teachingRepository();
    teaching.loadRuntimeForReconnect.mockRejectedValue(
      new Error("private database detail"),
    );
    const qwenWebSocketFactory = vi.fn();
    const app = await buildApp({
      config,
      authRepository: authRepository(child),
      characterRepository,
      conversationRepository,
      teachingRepository: teaching,
      qwenWebSocketFactory,
      logger: false,
    });

    try {
      await app.ready();
      await expect(
        app.injectWS(websocketUrl, {
          headers: websocketHeaders(),
        }),
      ).rejects.toThrow("Unexpected server response: 503");
      expect(teaching.loadRuntimeForReconnect).toHaveBeenCalledWith({
        conversationId,
        loadedAt: expect.any(Date),
      });
      expect(qwenWebSocketFactory).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

function teachingRepository(model = "qwen-audio-3.0-realtime-plus") {
  return {
    listManagementTargets: vi.fn(async () => ({
      kind: "allowed" as const,
      targets: { children: [], characters: [] },
    })),
    listChildPlans: vi.fn(async () => ({
      kind: "allowed" as const,
      plans: [],
    })),
    putChildPlan: vi.fn(async () => ({ kind: "target_not_found" as const })),
    getChildAvailability: vi.fn(async () => ({
      kind: "unavailable" as const,
      reason: "no_enabled_plan" as const,
    })),
    prepareConversation: vi.fn(async () => ({ kind: "not_found" as const })),
    muteConversation: vi.fn(async () => ({
      kind: "muted" as const,
      state: teachingState("muted", 5),
    })),
    recordValidTurn: vi.fn(async () => ({
      kind: "recorded" as const,
      validUserTurns: 1,
    })),
    claimInvitation: vi.fn(async () => ({
      kind: "claimed" as const,
      state: teachingState("active", 2),
      contentCursor: 1,
      contentItemId: "english-space-orbit-v1",
      compiledDirective: null,
      maximumAssistantResponses: 2 as const,
    })),
    markRestoring: vi.fn(async () => ({
      kind: "transitioned" as const,
      state: teachingState("restoring", 3),
    })),
    markCompleted: vi.fn(async () => ({
      kind: "transitioned" as const,
      state: teachingState("completed", 4),
    })),
    recoverForReconnect: vi.fn(async () => ({
      kind: "unchanged" as const,
      state: teachingState("available", 1),
    })),
    loadRuntimeForReconnect: vi.fn(async () => ({
      kind: "loaded" as const,
      state: teachingState("available", 1),
      conversationStartedAt: new Date("2026-08-15T08:00:00.000Z"),
      provider: "qwen",
      model,
    })),
  } satisfies TeachingRepository;
}

function teachingState(
  state: ConversationTeachingStateRecord["state"],
  revision: number,
): ConversationTeachingStateRecord {
  const active = state === "active" || state === "restoring";
  return {
    conversationId,
    learningPlanId,
    learningPlanRevision: 1,
    subject: "english",
    difficulty: "starter",
    triggerMode: "on_request",
    disclosureVersion: "teaching-disclosure-v1",
    contentRevisionId: null,
    contentCatalogVersion: "reviewed-v1",
    state,
    muteReason: state === "muted" ? "child_request" : null,
    validUserTurns: 0,
    invitationCount: active || state === "completed" ? 1 : 0,
    activeContentItemId: active ? "english-space-orbit-v1" : null,
    revision,
    preparedAt: new Date("2026-08-15T08:00:00.000Z"),
    updatedAt: new Date("2026-08-15T08:00:00.000Z"),
  };
}

const characterRepository = characterRepositoryFor(character);

function characterRepositoryFor(aggregate: CharacterAggregate) {
  return {
    async listVisible() {
      return [aggregate];
    },
    async findVisible() {
      return aggregate;
    },
    async listCatalog() {
      return {
        providers: [aggregate.providerProfile],
        voices: [aggregate.voiceProfile],
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
}

const conversationRepository = {
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

function authRepository(actor: AuthUserRecord): AuthRepository {
  return {
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
      return tokenHash === hashSessionToken(sessionToken) ? actor : null;
    },
    async revokeLoginSession() {},
    async changeOwnPassword() {
      return { kind: "invalid_session" };
    },
  };
}

function account(
  id: string,
  accountType: "admin" | "adult" | "child",
): AuthUserRecord {
  const timestamp = new Date("2026-08-15T08:00:00.000Z");
  return {
    id,
    username: accountType,
    displayName: accountType,
    accountType,
    status: "active",
    guardianHistoryAccess: accountType === "child" ? "allowed" : null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function aggregateFromPreset(
  model = "qwen-audio-3.0-realtime-plus",
): CharacterAggregate {
  const preset = BUILTIN_CHARACTER_PRESETS[0]!;
  const voice = BUILTIN_VOICE_PROFILES.find(
    ({ id }) => id === preset.voiceProfileId,
  );
  if (!voice) throw new Error("测试预置角色缺少声音。");
  const timestamp = new Date("2026-08-15T08:00:00.000Z");
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
      model,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    voiceProfile: { ...voice, createdAt: timestamp, updatedAt: timestamp },
  };
}

type Runtime = {
  model: string;
  voice: string;
  instructions: string;
};

async function loadRuntime(app: Awaited<ReturnType<typeof buildApp>>) {
  const response = await app.inject({
    method: "GET",
    url: `/api/characters/${character.character.id}/runtime`,
    headers: authHeaders,
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ realtime: Runtime }>().realtime;
}

async function connectBrowser(
  app: Awaited<ReturnType<typeof buildApp>>,
  received: Array<Record<string, unknown>>,
): Promise<WebSocket> {
  return app.injectWS(
    websocketUrl,
    { headers: websocketHeaders() },
    {
      onInit(socket) {
        socket.on("message", (data) => {
          received.push(JSON.parse(data.toString()) as Record<string, unknown>);
        });
      },
    },
  );
}

function websocketHeaders() {
  return {
    ...authHeaders,
    host: "meet.test",
    origin: "http://meet.test",
  };
}

function baseSessionUpdate(runtime: Runtime) {
  return {
    event_id: "browser-base-update",
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
  };
}

function sessionUpdated(
  instructions: string,
  voice: string,
  eventId: string,
  model = "qwen-audio-3.0-realtime-plus",
) {
  return {
    event_id: eventId,
    type: "session.updated",
    session: {
      id: "provider-session-1",
      object: "realtime.session",
      model,
      modalities: ["text", "audio"],
      voice,
      input_audio_format: "pcm",
      output_audio_format: "pcm",
      instructions,
      max_history_turns: 50,
      turn_detection: { type: "smart_turn" },
    },
  };
}

function sparseSessionUpdated(
  voice: string,
  eventId: string,
  model = "qwen-audio-3.0-realtime-plus",
) {
  return {
    event_id: eventId,
    type: "session.updated",
    session: {
      id: "provider-session-1",
      object: "realtime.session",
      model,
      modalities: ["text", "audio"],
      voice,
      input_audio_transcription: { model: "fun-asr" },
      turn_detection: {
        type: "smart_turn",
        threshold: 0.5,
        silence_duration_ms: 800,
      },
    },
  } as const;
}

function responseCreated(responseId: string) {
  return {
    event_id: `created-${responseId}`,
    type: "response.created",
    response: { id: responseId, modalities: ["audio", "text"] },
  };
}

function responseDone(responseId: string) {
  return {
    event_id: `done-${responseId}`,
    type: "response.done",
    response: { id: responseId, status: "completed" },
  };
}

function acknowledgeGate(
  browser: WebSocket,
  gate: Record<string, unknown>,
  eventId: string,
) {
  const revision = gate.revision;
  if (typeof revision !== "number") throw new Error("gate revision missing");
  browser.send(
    JSON.stringify({
      type: "relay.teaching.audio_gate_ack",
      event_id: eventId,
      revision,
    }),
  );
}

async function waitForGate(
  frames: Array<Record<string, unknown>>,
  open: boolean,
  ordinal: number,
) {
  await waitUntil(
    () =>
      frames.filter(
        (frame) =>
          frame.type === "relay.teaching.audio_gate" && frame.open === open,
      ).length >= ordinal,
  );
  return frames.filter(
    (frame) =>
      frame.type === "relay.teaching.audio_gate" && frame.open === open,
  )[ordinal - 1]!;
}

function hasFrame(frames: Array<Record<string, unknown>>, type: string) {
  return frames.some((frame) => frame.type === type);
}

function hasTeachingState(
  frames: Array<Record<string, unknown>>,
  state: string,
) {
  return frames.some(
    (frame) => frame.type === "relay.teaching.state" && frame.state === state,
  );
}

function readInstructions(event: Record<string, unknown>): string {
  const session = event.session;
  if (!session || typeof session !== "object") {
    throw new Error("session update missing");
  }
  const instructions = Reflect.get(session, "instructions");
  if (typeof instructions !== "string") {
    throw new Error("session instructions missing");
  }
  return instructions;
}

async function createUpstream(): Promise<{
  port: number;
  events: Array<Record<string, unknown>>;
  connection: Promise<WebSocket>;
  close: () => Promise<void>;
}> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("测试 WebSocket 服务未监听 TCP 端口。");
  }
  const events: Array<Record<string, unknown>> = [];
  let resolveConnection!: (socket: WebSocket) => void;
  const connection = new Promise<WebSocket>((resolve) => {
    resolveConnection = resolve;
  });
  server.once("connection", (socket) => {
    socket.on("message", (data) => {
      events.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    resolveConnection(socket);
  });
  return {
    port: address.port,
    events,
    connection,
    close: async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 3_000) throw new Error("test timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
