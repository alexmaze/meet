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
import type { ConversationAggregate } from "@meet/database";
import { describe, expect, it, vi } from "vitest";

const adult = account("4d1c2e31-ad0e-4fa9-9ae8-ae3497069117", "adult");
const admin = account("4d1c2e31-ad0e-4fa9-9ae8-ae3497069116", "admin");
const childId = "4d1c2e31-ad0e-4fa9-9ae8-ae3497069118";
const otherAdultId = "4d1c2e31-ad0e-4fa9-9ae8-ae3497069119";
const conversationId = "9172f06d-c71a-47b3-94fe-35e1204b5b55";
const characterId = "c437c71e-f209-4f7d-8f98-1c1e239d4201";

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
      payload: { messages: [message] },
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
    );

    const completed = await injectAs(app, adult, {
      method: "POST",
      url: `/api/conversations/${conversationId}/complete`,
      payload: { lastSequence: 1 },
    });
    expect(completed.statusCode).toBe(200);
    expect(fake.complete).toHaveBeenCalledWith(
      adult.id,
      conversationId,
      1,
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
  it("loads continuity through the authenticated account and requested character", async () => {
    const fake = repository();
    vi.mocked(fake.loadRealtimeContext).mockResolvedValue({
      mode: "normal",
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
          content: "上次一起复习了分数，约定继续准备周五考试。",
          updatedAt: new Date("2026-08-09T05:10:00.000Z"),
        },
      ],
      memories: [
        {
          content: "用户周五有数学考试。",
          updatedAt: new Date("2026-08-09T05:11:00.000Z"),
        },
      ],
    });
    const service = new ConversationService(fake);

    await expect(
      service.realtimeContext(adult, conversationId, characterId),
    ).resolves.toEqual({
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

  it("restores only this call's confirmed messages in temporary mode", async () => {
    const fake = repository();
    vi.mocked(fake.loadRealtimeContext).mockResolvedValue({
      mode: "temporary",
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
          content: "临时对话不能加载的摘要",
          updatedAt: new Date("2026-08-09T05:10:00.000Z"),
        },
      ],
      memories: [
        {
          content: "临时对话不能加载的记忆",
          updatedAt: new Date("2026-08-09T05:11:00.000Z"),
        },
      ],
    });
    const service = new ConversationService(fake);

    await expect(
      service.realtimeContext(adult, conversationId, characterId),
    ).resolves.toEqual({
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

function repository(): ConversationRepository {
  const aggregate = conversationAggregate();
  return {
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
      messages: [],
    })),
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
) {
  return {
    id: `9bb6162e-e85c-4e5d-a3ff-${idSuffix}`,
    conversationId: sourceConversationId,
    role,
    text,
    status: "completed" as const,
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
