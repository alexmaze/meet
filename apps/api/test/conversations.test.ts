import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createDatabaseClient,
  characters as characterTable,
  userAccounts as accountTable,
  conversations as conversationTable,
} from "@meet/database";
import {
  conversationContinuityStatusSchema,
  prepareConversationResponseSchema,
  completeConversationResponseSchema,
} from "@meet/protocol";
import { PostgresConversationRepository } from "../src/conversations/postgres-repository.js";
import { conversationLifecycleRepositoryFixture } from "./conversation-lifecycle-fixture.js";
import type {
  AuthUserRecord,
  LoginSessionRecord,
} from "../src/auth/repository.js";
import type { AuthRepository } from "../src/auth/repository.js";
import { hashSessionToken } from "../src/auth/session-token.js";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { ConversationRepository } from "../src/conversations/repository.js";
import { ConversationService } from "../src/conversations/service.js";
import type { ConversationServiceError } from "../src/conversations/service.js";
import type {
  ConversationAggregate,
  ConversationControlRecord,
} from "@meet/database";
import type { SemanticMemoryStore } from "@meet/memory";
import type { ConversationRuntimeSnapshot } from "@meet/protocol";
import { describe, expect, it, vi } from "vitest";

const adult = account("4d1c2e31-ad0e-4fa9-9ae8-ae3497069117", "adult");
const admin = account("4d1c2e31-ad0e-4fa9-9ae8-ae3497069116", "admin");
const childId = "4d1c2e31-ad0e-4fa9-9ae8-ae3497069118";
const otherAdultId = "4d1c2e31-ad0e-4fa9-9ae8-ae3497069119";
const conversationId = "9172f06d-c71a-47b3-94fe-35e1204b5b55";
const characterId = "c437c71e-f209-4f7d-8f98-1c1e239d4201";
const runtimeSnapshot: ConversationRuntimeSnapshot = {
  characterRevision: 3,
  realtimeModelProfileId: "a1293e2d-b8d1-4116-92a0-0bdbe666b1aa",
  provider: "qwen",
  model: "qwen-audio-3.0-realtime-plus",
  voice: "longanqian",
  instructions: "你是固定在本次通话中的林老师。",
  firstSpeaker: "assistant",
  openingLine: "我们继续吧。",
  contextPolicyVersion: "context-v1",
};

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
    enabled: false,
    region: "cn-beijing",
    model: "qwen-audio-3.0-realtime-plus",
    voice: "longanqian",
    instructions: "测试",
    requestTimeoutMs: 15_000,
  },
};

const writer = { clientId: "83e63c3c-7d2c-410b-9052-9f74c6195041", epoch: 1 };
const endRequestId = "1580d5cb-ef45-491e-af4d-8f9a9c0b8403";

describe("conversation routes", () => {
  it("requires authentication for history reads and writes", async () => {
    const app = await testApp(repository());
    for (const request of [
      { method: "GET" as const, url: "/api/conversations" },
      {
        method: "POST" as const,
        url: "/api/conversations",
        payload: { id: conversationId, characterId, mode: "normal" },
      },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        code: "AUTHENTICATION_REQUIRED",
      });
    }
    await app.close();
  });

  it("creates, appends, and completes using authenticated ownership", async () => {
    const fake = repository();
    const app = await testApp(fake);
    const created = await injectAs(app, adult, {
      method: "POST",
      url: "/api/conversations",
      payload: { id: conversationId, characterId, mode: "temporary" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      conversation: { id: conversationId, mode: "temporary" },
    });
    expect(fake.create).toHaveBeenCalledWith(
      adult.id,
      { id: conversationId, characterId, mode: "temporary" },
      expect.any(Date),
    );

    const message = {
      id: "9bb6162e-e85c-4e5d-a3ff-000000000001",
      sequence: 1,
      role: "user",
      text: "你好",
      createdAt: "2026-08-10T05:00:01.000Z",
    };
    const appended = await injectAs(app, adult, {
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      payload: { writer, messages: [message] },
    });
    expect(appended.statusCode).toBe(200);
    expect(appended.json()).toEqual({ acknowledgedSequence: 1 });
    expect(fake.appendMessages).toHaveBeenCalledWith(
      adult.id,
      conversationId,
      [
        {
          ...message,
          status: "completed",
          providerEventId: null,
        },
      ],
      expect.any(Date),
      writer,
    );

    const completed = await injectAs(app, adult, {
      method: "POST",
      url: `/api/conversations/${conversationId}/complete`,
      payload: { writer, requestId: endRequestId, lastSequence: 1 },
    });
    expect(completed.statusCode).toBe(200);
    expect(fake.complete).toHaveBeenCalledWith(
      adult.id,
      conversationId,
      {
        writer,
        requestId: endRequestId,
        lastSequence: 1,
        discardMissing: false,
      },
      expect.any(Date),
    );
    await app.close();
  });

  it("allows only configured child history through the administrator list", async () => {
    const fake = repository();
    vi.mocked(fake.isGuardianReadableTarget).mockImplementation(
      async (target) => target === childId,
    );
    const app = await testApp(fake);

    const childHistory = await injectAs(app, admin, {
      method: "GET",
      url: `/api/conversations?userId=${childId}`,
    });
    expect(childHistory.statusCode).toBe(200);
    expect(fake.list).toHaveBeenCalledWith(childId, 50);

    const adultHistory = await injectAs(app, admin, {
      method: "GET",
      url: `/api/conversations?userId=${otherAdultId}`,
    });
    expect(adultHistory.statusCode).toBe(404);
    expect(adultHistory.json()).toMatchObject({
      code: "CONVERSATION_NOT_FOUND",
    });
    expect(fake.list).not.toHaveBeenCalledWith(otherAdultId, 50);
    await app.close();
  });

  it("maps completed and out-of-order writes to explicit conflicts", async () => {
    const fake = repository();
    vi.mocked(fake.appendMessages)
      .mockResolvedValueOnce({ kind: "completed" })
      .mockResolvedValueOnce({ kind: "sequence_conflict" });
    const app = await testApp(fake);
    const payload = {
      writer,
      messages: [
        {
          id: "9bb6162e-e85c-4e5d-a3ff-000000000001",
          sequence: 1,
          role: "assistant",
          status: "completed",
          text: "你好",
          providerEventId: "response-1",
          createdAt: "2026-08-10T05:00:01.000Z",
        },
      ],
    };
    const completed = await injectAs(app, adult, {
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      payload,
    });
    expect(completed.statusCode).toBe(409);
    expect(completed.json()).toMatchObject({
      code: "CONVERSATION_ALREADY_COMPLETED",
    });
    const sequence = await injectAs(app, adult, {
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      payload,
    });
    expect(sequence.statusCode).toBe(409);
    expect(sequence.json()).toMatchObject({
      code: "CONVERSATION_SEQUENCE_CONFLICT",
    });
    await app.close();
  });
});

describe("conversation realtime continuity", () => {
  it("persists a proposed runtime snapshot and keeps the stored snapshot authoritative", async () => {
    const fake = repository();
    const storedSnapshot = {
      ...runtimeSnapshot,
      characterRevision: 2,
      instructions: "这是已经固定的旧角色配置。",
    };
    vi.mocked(fake.loadRealtimeContext).mockResolvedValue({
      mode: "normal",
      runtimeSnapshot: storedSnapshot,
      checkpoint: null,
      messages: [],
      summaries: [],
      memories: [],
    });
    const service = new ConversationService(fake);

    await expect(
      service.realtimeContext(
        adult,
        conversationId,
        characterId,
        runtimeSnapshot,
      ),
    ).resolves.toMatchObject({ runtimeSnapshot: storedSnapshot });
    expect(fake.loadRealtimeContext).toHaveBeenCalledWith(
      adult.id,
      conversationId,
      characterId,
      runtimeSnapshot,
    );
  });

  it("loads continuity through the authenticated account and requested character", async () => {
    const fake = repository();
    vi.mocked(fake.loadRealtimeContext).mockResolvedValue({
      mode: "normal",
      runtimeSnapshot: null,
      checkpoint: null,
      messages: [
        continuityMessage("000000000001", "user", "上次我说我周五考试"),
        continuityMessage(
          "000000000002",
          "assistant",
          "我记得，我们复习了分数。",
        ),
      ],
      summaries: [
        {
          conversationId,
          content: "上次一起复习了分数，约定继续准备周五考试。",
          updatedAt: new Date("2026-08-09T05:10:00.000Z"),
        },
      ],
      memories: [
        {
          id: "1d1c2e31-ad0e-4fa9-9ae8-ae3497069117",
          content: "用户周五有数学考试。",
          updatedAt: new Date("2026-08-09T05:11:00.000Z"),
        },
      ],
    });
    const service = new ConversationService(fake);

    await expect(
      service.realtimeContext(adult, conversationId, characterId),
    ).resolves.toMatchObject({
      mode: "normal",
      relationshipContext:
        "已确认长期记忆：\n- 用户周五有数学考试。\n\n此前通话摘要：\n- 上次一起复习了分数，约定继续准备周五考试。",
      messages: [
        {
          id: "9bb6162e-e85c-4e5d-a3ff-000000000001",
          role: "user",
          text: "上次我说我周五考试",
        },
        {
          id: "9bb6162e-e85c-4e5d-a3ff-000000000002",
          role: "assistant",
          text: "我记得，我们复习了分数。",
        },
      ],
    });
    expect(fake.loadRealtimeContext).toHaveBeenCalledWith(
      adult.id,
      conversationId,
      characterId,
    );
  });

  it("uses Mem0 hits to rank canonical active memories dynamically", async () => {
    const fake = repository();
    const semanticId = "1d1c2e31-ad0e-4fa9-9ae8-ae3497069120";
    vi.mocked(fake.loadRealtimeContext).mockResolvedValue({
      mode: "normal",
      runtimeSnapshot: null,
      checkpoint: null,
      messages: [continuityMessage("000000000001", "user", "围棋怎么入门？")],
      summaries: [],
      memories: [
        {
          id: "1d1c2e31-ad0e-4fa9-9ae8-ae3497069121",
          content: "用户最近在学游泳。",
          updatedAt: new Date("2026-08-09T05:11:00.000Z"),
        },
      ],
    });
    vi.mocked(fake.loadActiveMemoriesByIds).mockResolvedValue([
      {
        id: semanticId,
        content: "用户喜欢围棋，并且已经会基本规则。",
        updatedAt: new Date("2026-08-01T05:11:00.000Z"),
      },
    ]);
    const store = {
      search: vi.fn(async () => [
        {
          externalId: "mem0-1",
          localMemoryId: semanticId,
          content: "不直接信任的索引副本",
          score: 0.92,
        },
      ]),
      upsert: vi.fn(),
      delete: vi.fn(),
    } satisfies SemanticMemoryStore;
    const service = new ConversationService(fake, undefined, store, {
      limit: 8,
      threshold: 0.4,
    });

    const result = await service.realtimeContext(
      adult,
      conversationId,
      characterId,
    );
    expect(result.relationshipContext).toContain(
      "用户喜欢围棋，并且已经会基本规则。",
    );
    expect(result.relationshipContext).not.toContain("不直接信任的索引副本");
    expect(result.diagnostics.memoryRecall).toEqual({
      mode: "semantic",
      queryMessageCount: 1,
      hitCount: 1,
    });
    expect(store.search).toHaveBeenCalledWith({
      userId: adult.id,
      characterId,
      query: "围棋怎么入门？",
      limit: 8,
      threshold: 0.4,
    });
  });

  it("falls back to recent PostgreSQL memories when Mem0 is unavailable", async () => {
    const fake = repository();
    vi.mocked(fake.loadRealtimeContext).mockResolvedValue({
      mode: "normal",
      runtimeSnapshot: null,
      checkpoint: null,
      messages: [continuityMessage("000000000001", "user", "继续聊考试")],
      summaries: [],
      memories: [
        {
          id: "1d1c2e31-ad0e-4fa9-9ae8-ae3497069122",
          content: "用户周五有数学考试。",
          updatedAt: new Date("2026-08-09T05:11:00.000Z"),
        },
      ],
    });
    const store = {
      search: vi.fn(async () => {
        throw new Error("unavailable");
      }),
      upsert: vi.fn(),
      delete: vi.fn(),
    } satisfies SemanticMemoryStore;
    const service = new ConversationService(fake, undefined, store);

    const result = await service.realtimeContext(
      adult,
      conversationId,
      characterId,
    );
    expect(result.relationshipContext).toContain("用户周五有数学考试。");
    expect(result.diagnostics.memoryRecall.mode).toBe("fallback");
  });

  it("restores only this call's confirmed messages in temporary mode", async () => {
    const fake = repository();
    vi.mocked(fake.loadRealtimeContext).mockResolvedValue({
      mode: "temporary",
      runtimeSnapshot: null,
      checkpoint: null,
      messages: [
        continuityMessage("000000000001", "user", "本次临时通话已确认"),
        continuityMessage(
          "000000000002",
          "assistant",
          "其他通话不应泄露",
          "0e684b9d-8fe1-4e68-bd49-f399fbaa0001",
        ),
      ],
      summaries: [
        {
          conversationId,
          content: "临时对话不能加载的摘要",
          updatedAt: new Date("2026-08-09T05:10:00.000Z"),
        },
      ],
      memories: [
        {
          id: "1d1c2e31-ad0e-4fa9-9ae8-ae3497069118",
          content: "临时对话不能加载的记忆",
          updatedAt: new Date("2026-08-09T05:11:00.000Z"),
        },
      ],
    });
    const service = new ConversationService(fake);

    await expect(
      service.realtimeContext(adult, conversationId, characterId),
    ).resolves.toMatchObject({
      mode: "temporary",
      messages: [
        {
          id: "9bb6162e-e85c-4e5d-a3ff-000000000001",
          role: "user",
          text: "本次临时通话已确认",
        },
      ],
    });
  });

  it("injects a completed checkpoint into temporary call recovery", async () => {
    const fake = repository();
    vi.mocked(fake.loadRealtimeContext).mockResolvedValue({
      mode: "temporary",
      runtimeSnapshot: null,
      checkpoint: {
        id: "2fd4cbb6-fce4-40e2-9141-22f3a1bc2051",
        content: "本次较早讨论了分数与约分。",
        sourceLastSequence: 20,
      },
      messages: [continuityMessage("000000000021", "user", "继续做下一题")],
      summaries: [],
      memories: [],
    });
    const service = new ConversationService(fake);

    await expect(
      service.realtimeContext(adult, conversationId, characterId),
    ).resolves.toMatchObject({
      relationshipContext:
        expect.stringContaining("本次较早讨论了分数与约分。"),
      diagnostics: { checkpointSelected: true },
    });
  });

  it("excludes messages from another active call even if a repository returns them", async () => {
    const fake = repository();
    vi.mocked(fake.loadRealtimeContext).mockResolvedValue({
      mode: "normal",
      runtimeSnapshot: null,
      checkpoint: null,
      messages: [
        continuityMessage("000000000001", "user", "当前通话"),
        continuityMessage(
          "000000000002",
          "assistant",
          "另一条进行中通话",
          "0e684b9d-8fe1-4e68-bd49-f399fbaa0001",
        ),
        continuityMessage(
          "000000000003",
          "assistant",
          "已经完成的历史通话",
          "0e684b9d-8fe1-4e68-bd49-f399fbaa0002",
          "completed",
        ),
      ],
      summaries: [],
      memories: [],
    });
    const service = new ConversationService(fake);

    const result = await service.realtimeContext(
      adult,
      conversationId,
      characterId,
    );
    expect(result.messages.map(({ text }) => text)).toEqual([
      "当前通话",
      "已经完成的历史通话",
    ]);
  });

  it("uses a not-found response for an unowned or mismatched conversation", async () => {
    const fake = repository();
    vi.mocked(fake.loadRealtimeContext).mockResolvedValue(null);
    const service = new ConversationService(fake);

    await expect(
      service.realtimeContext(adult, conversationId, characterId),
    ).rejects.toMatchObject<Partial<ConversationServiceError>>({
      code: "CONVERSATION_NOT_FOUND",
      statusCode: 404,
    });
  });
});

describe("conversation continuity routes", () => {
  it("requires authenticated access and rejects the old unfenced write bodies", async () => {
    const fake = repository();
    const app = await testApp(fake);
    for (const url of [
      "/api/conversations/overview",
      `/api/conversations/${conversationId}/status`,
    ])
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    for (const [path, payload] of [
      [
        "messages",
        {
          messages: [
            {
              id: endRequestId,
              sequence: 1,
              role: "user",
              text: "你好",
              createdAt: new Date().toISOString(),
            },
          ],
        },
      ],
      ["complete", { lastSequence: 0 }],
      ["heartbeat", {}],
    ]) {
      expect(
        (
          await injectAs(app, adult, {
            method: "POST",
            url: `/api/conversations/${conversationId}/${path}`,
            payload,
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(fake.appendMessages).not.toHaveBeenCalled();
    expect(fake.complete).not.toHaveBeenCalled();
    expect(fake.heartbeatWriter).not.toHaveBeenCalled();
    await app.close();
  });

  it("shows authoritative end intent and keeps guardian status read-only", async () => {
    const fake = repository();
    const aggregate = conversationAggregate();
    aggregate.conversation.userId = childId;
    vi.mocked(fake.readLifecycle).mockResolvedValue({
      aggregate,
      control: controlFixture(),
      operation: null,
      characterAvailable: true,
      summary: { status: "waiting_configuration", content: null },
      memory: { status: "failed", activeCount: 1, suggestedCount: 2 },
    });
    vi.mocked(fake.findReadable).mockResolvedValue({
      ...aggregate,
      messages: [],
    });
    const app = await testApp(fake);
    const response = await injectAs(app, admin, {
      method: "GET",
      url: `/api/conversations/${conversationId}/status?clientId=${writer.clientId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      isOwner: false,
      canResume: false,
      canFinish: false,
      writerClientId: null,
      endRequestId: null,
      summary: { state: "not_configured" },
      memory: { state: "failed", activeCount: 1, suggestedCount: 2 },
    });
    vi.mocked(fake.findReadable).mockResolvedValue(null);
    expect(
      (
        await injectAs(app, adult, {
          method: "GET",
          url: `/api/conversations/${conversationId}/status`,
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });

  it("exposes only the current owner's overview and filters a racing deleted record", async () => {
    const fake = repository();
    vi.mocked(fake.overview).mockResolvedValue({
      pending: [conversationId, endRequestId],
      recent: [],
    });
    vi.mocked(fake.readLifecycle).mockImplementation(async (id) =>
      id === conversationId
        ? {
            aggregate: conversationAggregate(),
            control: null,
            operation: null,
            characterAvailable: true,
            summary: { status: null, content: null },
            memory: { status: null, activeCount: 0, suggestedCount: 0 },
          }
        : null,
    );
    const app = await testApp(fake);
    const response = await injectAs(app, adult, {
      method: "GET",
      url: `/api/conversations/overview?characterId=${characterId}&clientId=${writer.clientId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().pendingCount).toBe(1);
    expect(fake.overview).toHaveBeenCalledWith(adult.id, characterId);
    expect(
      (
        await injectAs(app, adult, {
          method: "GET",
          url: `/api/conversations/overview?userId=${childId}`,
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });

  it("recovers with the stored model metadata and never exposes the prompt or reopens the greeting", async () => {
    const fake = repository();
    vi.mocked(fake.prepare).mockResolvedValue({
      kind: "prepared",
      writer,
      hasConnected: true,
      runtimeSnapshot,
    });
    const app = await testApp(fake);
    const response = await injectAs(app, adult, {
      method: "POST",
      url: `/api/conversations/${conversationId}/prepare`,
      payload: {
        clientId: writer.clientId,
        requestId: endRequestId,
        intent: "connect",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      writer,
      launch: "resume",
      realtime: {
        model: runtimeSnapshot.model,
        voice: runtimeSnapshot.voice,
        firstSpeaker: "user",
        openingLine: null,
      },
    });
    expect(response.body).not.toContain(runtimeSnapshot.instructions);
    expect(response.json().realtime).not.toHaveProperty("instructions");
    await app.close();
  });

  it("does not promise background work for an empty failed startup that was closed", async () => {
    const fake = repository();
    const aggregate = conversationAggregate();
    aggregate.conversation.status = "completed";
    aggregate.conversation.endedAt = new Date();
    vi.mocked(fake.readLifecycle).mockResolvedValue({
      aggregate,
      control: null,
      operation: null,
      characterAvailable: true,
      summary: { status: null, content: null },
      memory: { status: null, activeCount: 0, suggestedCount: 0 },
    });
    const app = await testApp(fake);
    const response = await injectAs(app, adult, {
      method: "GET",
      url: `/api/conversations/${conversationId}/status`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      connectionState: "completed",
      summary: { state: "not_applicable" },
      memory: { state: "not_applicable" },
    });
    await app.close();
  });

  it("returns explicit conflicts for occupied, stale and missing-message operations", async () => {
    const fake = repository();
    vi.mocked(fake.prepare)
      .mockResolvedValueOnce({ kind: "in_use" })
      .mockResolvedValueOnce({ kind: "writer_stale" });
    vi.mocked(fake.complete).mockResolvedValue({ kind: "messages_missing" });
    const app = await testApp(fake);
    for (const code of ["CONVERSATION_IN_USE", "CONVERSATION_WRITER_STALE"]) {
      const response = await injectAs(app, adult, {
        method: "POST",
        url: `/api/conversations/${conversationId}/prepare`,
        payload: {
          clientId: writer.clientId,
          requestId: endRequestId,
          intent: "finish",
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe(code);
    }
    const result = await injectAs(app, adult, {
      method: "POST",
      url: `/api/conversations/${conversationId}/complete`,
      payload: { writer, requestId: endRequestId, lastSequence: 2 },
    });
    expect(result.statusCode).toBe(409);
    expect(result.json().code).toBe("CONVERSATION_MESSAGES_MISSING");
    await app.close();
  });

  it("queries the original logical end request while distinguishing text saving from analysis", async () => {
    const fake = repository();
    const aggregate = conversationAggregate();
    aggregate.conversation.status = "completed";
    aggregate.conversation.endedAt = new Date();
    const control = {
      ...controlFixture(),
      endRequestId,
      endTargetSequence: 2,
      finalizedAt: new Date(),
    };
    vi.mocked(fake.readLifecycle).mockResolvedValue({
      aggregate,
      control,
      operation: {
        conversationId,
        requestId: endRequestId,
        kind: "finish",
        clientId: writer.clientId,
        writerEpoch: 1,
        intent: "finish",
        targetSequence: 2,
        completedAt: new Date(),
        createdAt: new Date(),
      },
      characterAvailable: true,
      summary: { status: "queued", content: null },
      memory: { status: "completed", activeCount: 0, suggestedCount: 0 },
    });
    const app = await testApp(fake);
    const response = await injectAs(app, adult, {
      method: "GET",
      url: `/api/conversations/${conversationId}/status?requestId=${endRequestId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      connectionState: "completed",
      endRequestId,
      endTargetSequence: 2,
      canResume: false,
      summary: { state: "processing" },
      memory: { state: "completed", activeCount: 0 },
    });
    expect(fake.readLifecycle).toHaveBeenCalledWith(
      conversationId,
      endRequestId,
    );
    await app.close();
  });
});

it.skipIf(!process.env.DATABASE_CONTINUITY_TEST_URL)(
  "runs the public lifecycle contract against isolated PostgreSQL without a model",
  async () => {
    const testUrl = new URL(process.env.DATABASE_CONTINUITY_TEST_URL!);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(testUrl.hostname) ||
      !testUrl.pathname.endsWith("_test")
    )
      throw new Error("Only an explicit local *_test database is allowed.");
    const dbClient = createDatabaseClient({
      connectionString: testUrl.toString(),
    });
    const actor = { ...adult, id: randomUUID() };
    const localCharacterId = randomUUID();
    const localConversationId = randomUUID();
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      await dbClient.db.insert(accountTable).values({
        id: actor.id,
        username: `test-${actor.id}`,
        usernameCanonical: `test-${actor.id}`,
        displayName: "隔离接口验收",
        accountType: "adult",
        guardianHistoryAccess: null,
      });
      const [preset] = await dbClient.db.select().from(characterTable).limit(1);
      if (!preset) throw new Error("Migrate the isolated database first.");
      await dbClient.db.insert(characterTable).values({
        ...preset,
        id: localCharacterId,
        systemKey: null,
        systemVersion: null,
        ownerUserId: actor.id,
        visibility: "family",
      });
      const auth = authRepository();
      auth.findUserBySessionTokenHash = async (tokenHash) =>
        tokenHash === hashSessionToken(adult.username) ? actor : null;
      app = await buildApp({
        config,
        authRepository: auth,
        conversationRepository: new PostgresConversationRepository(dbClient.db),
        logger: false,
      });
      const created = await injectAs(app, adult, {
        method: "POST",
        url: "/api/conversations",
        payload: {
          id: localConversationId,
          characterId: localCharacterId,
          mode: "normal",
        },
      });
      expect(created.statusCode).toBe(201);
      const prepared = await injectAs(app, adult, {
        method: "POST",
        url: `/api/conversations/${localConversationId}/prepare`,
        payload: {
          clientId: writer.clientId,
          requestId: randomUUID(),
          intent: "connect",
        },
      });
      expect(prepared.statusCode).toBe(200);
      const launch = prepareConversationResponseSchema.parse(prepared.json());
      const heartbeat = await injectAs(app, adult, {
        method: "POST",
        url: `/api/conversations/${localConversationId}/heartbeat`,
        payload: { writer: launch.writer },
      });
      expect(heartbeat.statusCode).toBe(200);
      expect(
        conversationContinuityStatusSchema.parse(heartbeat.json()).writerEpoch,
      ).toBe(launch.writer.epoch);
      const appended = await injectAs(app, adult, {
        method: "POST",
        url: `/api/conversations/${localConversationId}/messages`,
        payload: {
          writer: launch.writer,
          messages: [
            {
              id: randomUUID(),
              sequence: 1,
              role: "user",
              text: "隔离验收已确认内容",
              createdAt: new Date().toISOString(),
            },
          ],
        },
      });
      expect(appended.statusCode).toBe(200);
      const requestId = randomUUID();
      const body = { writer: launch.writer, requestId, lastSequence: 1 };
      const completed = await injectAs(app, adult, {
        method: "POST",
        url: `/api/conversations/${localConversationId}/complete`,
        payload: body,
      });
      expect(completed.statusCode).toBe(200);
      expect(
        completeConversationResponseSchema.parse(completed.json()).status
          .connectionState,
      ).toBe("completed");
      const repeated = await injectAs(app, adult, {
        method: "POST",
        url: `/api/conversations/${localConversationId}/complete`,
        payload: body,
      });
      expect(repeated.statusCode).toBe(200);
      const queried = await injectAs(app, adult, {
        method: "GET",
        url: `/api/conversations/${localConversationId}/status?requestId=${requestId}`,
      });
      expect(queried.statusCode).toBe(200);
      expect(
        conversationContinuityStatusSchema.parse(queried.json()),
      ).toMatchObject({
        endRequestId: requestId,
        endTargetSequence: 1,
        canResume: false,
        connectionState: "completed",
      });
    } finally {
      await app?.close();
      await dbClient.db
        .delete(conversationTable)
        .where(eq(conversationTable.id, localConversationId));
      await dbClient.db
        .delete(characterTable)
        .where(eq(characterTable.id, localCharacterId));
      await dbClient.db
        .delete(accountTable)
        .where(eq(accountTable.id, actor.id));
      await dbClient.close();
    }
  },
);

function controlFixture(): ConversationControlRecord {
  return {
    conversationId,
    writerClientId: writer.clientId,
    writerEpoch: writer.epoch,
    leaseExpiresAt: new Date(0),
    connectionId: null,
    connectionExpiresAt: null,
    connectionStartedAt: null,
    lastHeartbeatAt: null,
    hasConnected: true,
    lastActivityAt: new Date("2026-08-10T05:00:00.000Z"),
    lastSavedAt: new Date("2026-08-10T05:00:01.000Z"),
    connectedDurationMs: 10_000,
    finalizedAt: null,
    endRequestId: null,
    endTargetSequence: null,
  };
}

function repository(): ConversationRepository {
  const aggregate = conversationAggregate();
  return {
    ...conversationLifecycleRepositoryFixture(aggregate),
    create: vi.fn(async (_actor, input) => ({
      kind: "created" as const,
      conversation: {
        ...aggregate,
        conversation: {
          ...aggregate.conversation,
          id: input.id,
          characterId: input.characterId,
          mode: input.mode,
        },
      },
    })),
    list: vi.fn(async () => [aggregate]),
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
    appendMessages: vi.fn(async (_actor, _id, messages) => ({
      kind: "appended" as const,
      acknowledgedSequence: messages.at(-1)?.sequence ?? 0,
    })),
    complete: vi.fn(async () => ({
      kind: "completed" as const,
      conversation: {
        ...aggregate,
        conversation: {
          ...aggregate.conversation,
          status: "completed" as const,
          endedAt: new Date("2026-08-10T05:20:00.000Z"),
        },
      },
    })),
    delete: vi.fn(async () => true),
  };
}

function continuityMessage(
  idSuffix: string,
  role: "user" | "assistant",
  text: string,
  sourceConversationId = conversationId,
  conversationStatus: "active" | "completed" = "active",
) {
  return {
    id: `9bb6162e-e85c-4e5d-a3ff-${idSuffix}`,
    conversationId: sourceConversationId,
    role,
    text,
    status: "completed" as const,
    conversationStatus,
    createdAt: new Date("2026-08-10T05:00:00.000Z"),
  };
}

function conversationAggregate(): ConversationAggregate {
  const now = new Date("2026-08-10T05:00:00.000Z");
  return {
    conversation: {
      id: conversationId,
      userId: adult.id,
      characterId,
      mode: "normal",
      status: "active",
      provider: "qwen",
      model: "qwen-audio-3.0-realtime-plus",
      voice: "longanqian",
      messageCount: 0,
      lastSequence: 0,
      startedAt: now,
      endedAt: null,
      updatedAt: now,
    },
    character: {
      id: characterId,
      name: "林老师",
      visualProfile: {
        avatarUrl: "/avatars/teacher-lin.svg",
        accentColor: "#487a67",
        background: "classroom",
        animationStyle: "subtle",
      },
    },
  };
}

async function testApp(conversationRepository: ConversationRepository) {
  return buildApp({
    config,
    authRepository: authRepository(),
    conversationRepository,
    logger: false,
  });
}

function authRepository(): AuthRepository {
  const users = new Map([
    [hashSessionToken(adult.username), adult],
    [hashSessionToken(admin.username), admin],
  ]);
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
      return users.get(tokenHash) ?? null;
    },
    async revokeLoginSession() {},
    async changeOwnPassword() {
      return { kind: "invalid_session" };
    },
  };
}

function injectAs(
  app: Awaited<ReturnType<typeof testApp>>,
  actor: AuthUserRecord,
  options: Parameters<typeof app.inject>[0],
) {
  const headers = {
    ...(typeof options === "object" && "headers" in options
      ? options.headers
      : {}),
    cookie: `meet_session=${actor.username}`,
  };
  return app.inject({ ...options, headers });
}

function account(
  id: string,
  accountType: "admin" | "adult" | "child",
): AuthUserRecord {
  return {
    id,
    username: accountType,
    displayName: accountType,
    accountType,
    status: "active",
    guardianHistoryAccess: accountType === "child" ? "allowed" : null,
    createdAt: new Date("2026-08-09T00:00:00.000Z"),
    updatedAt: new Date("2026-08-09T00:00:00.000Z"),
  };
}
