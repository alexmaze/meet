import type {
  AuthUserRecord,
  LoginSessionRecord,
} from "../src/auth/repository.js";
import type { AuthRepository } from "../src/auth/repository.js";
import { hashSessionToken } from "../src/auth/session-token.js";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { MemoryRepository } from "../src/memories/repository.js";
import type { CharacterMemoryAggregate } from "@meet/database";
import { describe, expect, it, vi } from "vitest";

const adult = account("4d1c2e31-ad0e-4fa9-9ae8-ae3497069117", "adult");
const admin = account("4d1c2e31-ad0e-4fa9-9ae8-ae3497069116", "admin");
const childId = "4d1c2e31-ad0e-4fa9-9ae8-ae3497069118";
const otherAdultId = "4d1c2e31-ad0e-4fa9-9ae8-ae3497069119";
const memoryId = "2fd4cbb6-fce4-40e2-9141-22f3a1bc2051";

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

describe("memory routes", () => {
  it("requires authentication", async () => {
    const app = await testApp(repository());
    const response = await app.inject({ method: "GET", url: "/api/memories" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("lists and reviews only the current account's memories", async () => {
    const fake = repository();
    const app = await testApp(fake);
    const listed = await injectAs(app, adult, {
      method: "GET",
      url: "/api/memories?status=suggested",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      memories: [{ id: memoryId, status: "suggested" }],
    });
    expect(fake.list).toHaveBeenCalledWith(adult.id, "suggested", 100);

    const accepted = await injectAs(app, adult, {
      method: "PATCH",
      url: `/api/memories/${memoryId}`,
      payload: { action: "accept" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(fake.review).toHaveBeenCalledWith(
      adult.id,
      memoryId,
      { action: "accept" },
      expect.any(Date),
    );
    await app.close();
  });

  it("lets administrators read only configured child memories", async () => {
    const fake = repository();
    vi.mocked(fake.isGuardianReadableTarget).mockImplementation(
      async (target) => target === childId,
    );
    const app = await testApp(fake);
    expect(
      (
        await injectAs(app, admin, {
          method: "GET",
          url: `/api/memories?userId=${childId}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await injectAs(app, admin, {
          method: "GET",
          url: `/api/memories?userId=${otherAdultId}`,
        })
      ).statusCode,
    ).toBe(404);
    expect(fake.list).not.toHaveBeenCalledWith(otherAdultId, undefined, 100);
    await app.close();
  });

  it("maps repeated reviews and duplicate content to conflicts", async () => {
    const fake = repository();
    vi.mocked(fake.review)
      .mockResolvedValueOnce({ kind: "invalid_state" })
      .mockResolvedValueOnce({ kind: "content_conflict" });
    const app = await testApp(fake);
    const repeated = await injectAs(app, adult, {
      method: "PATCH",
      url: `/api/memories/${memoryId}`,
      payload: { action: "accept" },
    });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json()).toMatchObject({ code: "MEMORY_INVALID_STATE" });
    const duplicate = await injectAs(app, adult, {
      method: "PATCH",
      url: `/api/memories/${memoryId}`,
      payload: { action: "edit", content: "用户喜欢围棋" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: "MEMORY_CONTENT_CONFLICT" });
    await app.close();
  });
});

function repository(): MemoryRepository {
  const aggregate = memoryAggregate();
  return {
    list: vi.fn(async () => [aggregate]),
    isGuardianReadableTarget: vi.fn(async () => false),
    review: vi.fn(async () => ({
      kind: "updated" as const,
      memory: aggregate,
    })),
  };
}

function memoryAggregate(): CharacterMemoryAggregate {
  const now = new Date("2026-08-10T05:20:00.000Z");
  return {
    memory: {
      id: memoryId,
      userId: adult.id,
      characterId: "c437c71e-f209-4f7d-8f98-1c1e239d4201",
      sourceConversationId: "9172f06d-c71a-47b3-94fe-35e1204b5b55",
      contentFingerprint: "a".repeat(64),
      content: "用户喜欢围棋",
      sourceExcerpt: "我一直很喜欢围棋",
      confidence: 0.8,
      status: "suggested",
      reviewedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    character: {
      id: "c437c71e-f209-4f7d-8f98-1c1e239d4201",
      name: "知夏",
      visualProfile: {
        avatarUrl: "/avatars/zhixia.svg",
        accentColor: "#9a5d73",
        background: "sunset",
        animationStyle: "subtle",
      },
    },
  };
}

async function testApp(memoryRepository: MemoryRepository) {
  return buildApp({
    config,
    authRepository: authRepository(),
    memoryRepository,
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
    async createLoginSessionIfCredentialCurrent(_session: LoginSessionRecord) {
      return true;
    },
    async findUserBySessionTokenHash(tokenHash) {
      return users.get(tokenHash) ?? null;
    },
    async revokeLoginSession() {},
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
  const now = new Date("2026-08-10T00:00:00.000Z");
  return {
    id,
    username: accountType,
    displayName: accountType,
    accountType,
    status: "active",
    guardianHistoryAccess: accountType === "child" ? "allowed" : null,
    createdAt: now,
    updatedAt: now,
  };
}
