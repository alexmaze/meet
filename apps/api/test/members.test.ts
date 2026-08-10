import { canonicalizeUsername } from "@meet/database";
import type { GuardianHistoryAccess, UserAccount } from "@meet/protocol";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { hashPassword } from "../src/auth/password.js";
import type {
  AuthRepository,
  AuthUserRecord,
  CredentialRecord,
  LoginSessionRecord,
} from "../src/auth/repository.js";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import {
  MemberUsernameTakenRepositoryError,
  type AdminMemberRepository,
  type CreateMemberRepositoryInput,
  type ResetMemberPasswordResult,
  type UpdateGuardianResult,
} from "../src/members/repository.js";
import { MemberService } from "../src/members/service.js";

const config: AppConfig = {
  server: { host: "127.0.0.1", port: 8787, logLevel: "silent" },
  database: {},
  auth: {
    cookieName: "meet_session",
    cookieSecure: true,
    sessionTtlMs: 30 * 24 * 60 * 60 * 1_000,
    loginMaxAttempts: 20,
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

const createdAt = new Date("2026-08-09T00:00:00.000Z");
const admin = account(
  "4d1c2e31-ad0e-4fa9-9ae8-ae3497069116",
  "admin",
  "家庭管理员",
  "admin",
  null,
);
const adult = account(
  "4d1c2e31-ad0e-4fa9-9ae8-ae3497069117",
  "adult",
  "家长",
  "adult",
  null,
);
const child = account(
  "4d1c2e31-ad0e-4fa9-9ae8-ae3497069118",
  "child",
  "小明",
  "child",
  "allowed",
);

let initialPasswordHash = "";

beforeAll(async () => {
  initialPasswordHash = await hashPassword("correct-password");
});

describe("admin member routes", () => {
  it("authenticates and authorizes every member operation first", async () => {
    const repository = seededRepository();
    const app = await buildApp({
      config,
      authRepository: repository,
      memberRepository: repository,
      logger: false,
    });

    const anonymous = await app.inject({
      method: "GET",
      url: "/api/admin/members",
    });
    expect(anonymous.statusCode).toBe(401);

    const adultCookie = await login(app, "adult", "correct-password");
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/admin/members",
      headers: { cookie: adultCookie },
      payload: { invalid: true },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: "ADMIN_REQUIRED" });
    expect(repository.members).toHaveLength(3);

    await app.close();
  });

  it("creates and lists adult and child accounts with canonical conflicts", async () => {
    const repository = seededRepository();
    const app = await buildApp({
      config,
      authRepository: repository,
      memberRepository: repository,
      logger: false,
    });
    const adminCookie = await login(app, "admin", "correct-password");

    const adultResponse = await app.inject({
      method: "POST",
      url: "/api/admin/members",
      headers: { cookie: adminCookie },
      payload: {
        username: "new-adult",
        displayName: "新家长",
        password: "long-enough-password",
        accountType: "adult",
      },
    });
    expect(adultResponse.statusCode).toBe(201);
    expect(adultResponse.json<{ member: UserAccount }>().member).toMatchObject({
      username: "new-adult",
      accountType: "adult",
      guardianHistoryAccess: null,
    });
    expect(adultResponse.body).not.toContain("passwordHash");

    const childResponse = await app.inject({
      method: "POST",
      url: "/api/admin/members",
      headers: { cookie: adminCookie },
      payload: {
        username: "new-child",
        displayName: "新儿童",
        password: "long-enough-password",
        accountType: "child",
      },
    });
    expect(childResponse.statusCode).toBe(201);
    expect(childResponse.json<{ member: UserAccount }>().member).toMatchObject({
      accountType: "child",
      guardianHistoryAccess: "allowed",
    });

    const invalidAdult = await app.inject({
      method: "POST",
      url: "/api/admin/members",
      headers: { cookie: adminCookie },
      payload: {
        username: "another-adult",
        displayName: "另一位家长",
        password: "long-enough-password",
        accountType: "adult",
        guardianHistoryAccess: null,
      },
    });
    expect(invalidAdult.statusCode).toBe(400);

    const conflict = await app.inject({
      method: "POST",
      url: "/api/admin/members",
      headers: { cookie: adminCookie },
      payload: {
        username: "  NEW-ADULT  ",
        displayName: "重复账号",
        password: "long-enough-password",
        accountType: "adult",
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      code: "USERNAME_TAKEN",
      message: "该用户名已被使用。",
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/admin/members",
      headers: { cookie: adminCookie },
    });
    expect(list.statusCode).toBe(200);
    const members = list.json<{ members: UserAccount[] }>().members;
    expect(members).toHaveLength(5);
    expect(members[0]?.accountType).toBe("admin");
    expect(
      repository.auditEvents.filter((event) => event.type === "created"),
    ).toHaveLength(2);

    await app.close();
  });

  it("updates only child guardian access and keeps same-value retries audit-free", async () => {
    const repository = seededRepository();
    const app = await buildApp({
      config,
      authRepository: repository,
      memberRepository: repository,
      logger: false,
    });
    const adminCookie = await login(app, "admin", "correct-password");

    const changed = await app.inject({
      method: "PATCH",
      url: `/api/admin/members/${child.id}`,
      headers: { cookie: adminCookie },
      payload: { guardianHistoryAccess: "denied" },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json<{ member: UserAccount }>().member).toMatchObject({
      id: child.id,
      guardianHistoryAccess: "denied",
    });

    const repeated = await app.inject({
      method: "PATCH",
      url: `/api/admin/members/${child.id}`,
      headers: { cookie: adminCookie },
      payload: { guardianHistoryAccess: "denied" },
    });
    expect(repeated.statusCode).toBe(200);
    expect(
      repository.auditEvents.filter((event) => event.type === "guardian"),
    ).toHaveLength(1);
    expect(repository.auditEvents.at(-1)).toMatchObject({
      previous: "allowed",
      current: "denied",
    });

    const adultTarget = await app.inject({
      method: "PATCH",
      url: `/api/admin/members/${adult.id}`,
      headers: { cookie: adminCookie },
      payload: { guardianHistoryAccess: "denied" },
    });
    expect(adultTarget.statusCode).toBe(400);
    expect(adultTarget.json()).toMatchObject({ code: "MEMBER_NOT_CHILD" });

    const adminTarget = await app.inject({
      method: "PATCH",
      url: `/api/admin/members/${admin.id}`,
      headers: { cookie: adminCookie },
      payload: { guardianHistoryAccess: "denied" },
    });
    expect(adminTarget.statusCode).toBe(403);
    expect(adminTarget.json()).toMatchObject({
      code: "ADMIN_ACCOUNT_PROTECTED",
    });

    const forbiddenField = await app.inject({
      method: "PATCH",
      url: `/api/admin/members/${child.id}`,
      headers: { cookie: adminCookie },
      payload: { guardianHistoryAccess: "allowed", status: "disabled" },
    });
    expect(forbiddenField.statusCode).toBe(400);

    await app.close();
  });

  it("resets only member passwords and invalidates every old session", async () => {
    const repository = seededRepository();
    const app = await buildApp({
      config,
      authRepository: repository,
      memberRepository: repository,
      logger: false,
    });
    const oldChildCookie = await login(app, "child", "correct-password");
    const secondChildCookie = await login(app, "child", "correct-password");
    const adminCookie = await login(app, "admin", "correct-password");

    const reset = await app.inject({
      method: "POST",
      url: `/api/admin/members/${child.id}/reset-password`,
      headers: { cookie: adminCookie },
      payload: { password: "new-member-password" },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ ok: true, revokedSessionCount: 2 });
    expect(repository.auditEvents.at(-1)).toMatchObject({
      type: "password_reset",
      revokedSessionCount: 2,
    });

    for (const cookie of [oldChildCookie, secondChildCookie]) {
      const me = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie },
      });
      expect(me.statusCode).toBe(401);
    }

    const oldPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "child", password: "correct-password" },
    });
    expect(oldPassword.statusCode).toBe(401);
    const newPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "child", password: "new-member-password" },
    });
    expect(newPassword.statusCode).toBe(200);

    const protectedAdmin = await app.inject({
      method: "POST",
      url: `/api/admin/members/${admin.id}/reset-password`,
      headers: { cookie: adminCookie },
      payload: { password: "another-long-password" },
    });
    expect(protectedAdmin.statusCode).toBe(403);
    expect(protectedAdmin.json()).toMatchObject({
      code: "ADMIN_ACCOUNT_PROTECTED",
    });

    await app.close();
  });

  it("does not expose member repository failures", async () => {
    const repository = seededRepository();
    repository.listError = new Error("connect ECONNREFUSED db.internal:5432");
    const app = await buildApp({
      config,
      authRepository: repository,
      memberRepository: repository,
      logger: false,
    });
    const adminCookie = await login(app, "admin", "correct-password");

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/members",
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      code: "MEMBER_SERVICE_UNAVAILABLE",
      message: "成员管理服务暂时不可用，请稍后重试。",
    });
    expect(response.body).not.toContain("db.internal");
    expect(response.body).not.toContain("ECONNREFUSED");

    await app.close();
  });
});

describe("MemberService ordering", () => {
  it("rejects non-admin actors before password hashing", async () => {
    let hashCalls = 0;
    const service = new MemberService(null, async () => {
      hashCalls += 1;
      return "unused";
    });

    await expect(
      service.createMember(toPublicUser(adult), {
        username: "new-user",
        displayName: "新用户",
        password: "long-enough-password",
        accountType: "adult",
      }),
    ).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    expect(hashCalls).toBe(0);
  });

  it("rejects an admin reset target before password hashing", async () => {
    const repository = seededRepository();
    let hashCalls = 0;
    const service = new MemberService(repository, async () => {
      hashCalls += 1;
      return "unused";
    });

    await expect(
      service.resetMemberPassword(
        toPublicUser(admin),
        admin.id,
        "long-enough-password",
      ),
    ).rejects.toMatchObject({ code: "ADMIN_ACCOUNT_PROTECTED" });
    expect(hashCalls).toBe(0);
  });
});

type AuditEvent =
  | { type: "created"; targetUserId: string }
  | {
      type: "guardian";
      targetUserId: string;
      previous: GuardianHistoryAccess;
      current: GuardianHistoryAccess;
    }
  | {
      type: "password_reset";
      targetUserId: string;
      revokedSessionCount: number;
    };

class MemoryAccountRepository implements AuthRepository, AdminMemberRepository {
  readonly members: AuthUserRecord[] = [];
  readonly auditEvents: AuditEvent[] = [];
  listError: Error | null = null;
  private readonly passwordHashes = new Map<string, string>();
  private readonly sessions = new Map<
    string,
    LoginSessionRecord & { revokedAt?: Date }
  >();

  constructor(credentials: CredentialRecord[]) {
    for (const credential of credentials) {
      this.members.push({ ...credential.user });
      this.passwordHashes.set(credential.user.id, credential.passwordHash);
    }
  }

  async findCredentialByUsername(
    username: string,
  ): Promise<CredentialRecord | null> {
    const canonical = canonicalizeUsername(username);
    const user = this.members.find(
      (candidate) => canonicalizeUsername(candidate.username) === canonical,
    );
    const passwordHash = user ? this.passwordHashes.get(user.id) : undefined;
    return user && passwordHash ? { user: { ...user }, passwordHash } : null;
  }

  async findCredentialBySessionTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<CredentialRecord | null> {
    const session = this.sessions.get(tokenHash);
    if (!session || session.revokedAt || session.expiresAt <= now) return null;
    const user = this.members.find(
      (candidate) => candidate.id === session.userId,
    );
    const passwordHash = user ? this.passwordHashes.get(user.id) : undefined;
    return user && passwordHash ? { user: { ...user }, passwordHash } : null;
  }

  async createLoginSessionIfCredentialCurrent(
    session: LoginSessionRecord,
    expectedPasswordHash: string,
  ): Promise<boolean> {
    const user = this.members.find(
      (candidate) => candidate.id === session.userId,
    );
    if (
      !user ||
      user.status !== "active" ||
      this.passwordHashes.get(user.id) !== expectedPasswordHash
    ) {
      return false;
    }
    this.sessions.set(session.tokenHash, session);
    return true;
  }

  async findUserBySessionTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<AuthUserRecord | null> {
    const session = this.sessions.get(tokenHash);
    if (!session || session.revokedAt || session.expiresAt <= now) return null;
    const user = this.members.find(
      (candidate) => candidate.id === session.userId,
    );
    return user ? { ...user } : null;
  }

  async revokeLoginSession(tokenHash: string, revokedAt: Date): Promise<void> {
    const session = this.sessions.get(tokenHash);
    if (session) session.revokedAt = revokedAt;
  }

  async changeOwnPassword() {
    return { kind: "invalid_session" as const };
  }

  async listMembers(): Promise<AuthUserRecord[]> {
    if (this.listError) throw this.listError;
    return this.members.map((member) => ({ ...member }));
  }

  async findAccountById(userId: string): Promise<AuthUserRecord | null> {
    const user = this.members.find((candidate) => candidate.id === userId);
    return user ? { ...user } : null;
  }

  async createMember(
    input: CreateMemberRepositoryInput,
  ): Promise<AuthUserRecord> {
    const canonical = canonicalizeUsername(input.username);
    if (
      this.members.some(
        (member) => canonicalizeUsername(member.username) === canonical,
      )
    ) {
      throw new MemberUsernameTakenRepositoryError();
    }
    const member = account(
      randomUUID(),
      input.username.trim(),
      input.displayName.trim(),
      input.accountType,
      input.accountType === "child" ? input.guardianHistoryAccess : null,
      input.createdAt,
    );
    this.members.push(member);
    this.passwordHashes.set(member.id, input.passwordHash);
    this.auditEvents.push({ type: "created", targetUserId: member.id });
    return { ...member };
  }

  async updateChildGuardianHistoryAccess(
    userId: string,
    guardianHistoryAccess: GuardianHistoryAccess,
    _actorUserId: string,
    changedAt: Date,
  ): Promise<UpdateGuardianResult> {
    const index = this.members.findIndex((member) => member.id === userId);
    if (index === -1) return { kind: "not_found" };
    const current = this.members[index];
    if (!current) return { kind: "not_found" };
    if (current.accountType === "admin") return { kind: "admin_protected" };
    if (current.accountType !== "child") return { kind: "not_child" };
    if (current.guardianHistoryAccess === guardianHistoryAccess) {
      return { kind: "unchanged", user: { ...current } };
    }
    const updated = {
      ...current,
      guardianHistoryAccess,
      updatedAt: changedAt,
    };
    this.members[index] = updated;
    this.auditEvents.push({
      type: "guardian",
      targetUserId: current.id,
      previous: current.guardianHistoryAccess ?? "allowed",
      current: guardianHistoryAccess,
    });
    return { kind: "updated", user: { ...updated } };
  }

  async resetMemberPassword(
    userId: string,
    passwordHash: string,
    _actorUserId: string,
    changedAt: Date,
  ): Promise<ResetMemberPasswordResult> {
    const user = this.members.find((candidate) => candidate.id === userId);
    if (!user) return { kind: "not_found" };
    if (user.accountType === "admin") return { kind: "admin_protected" };
    this.passwordHashes.set(user.id, passwordHash);
    let revokedSessionCount = 0;
    for (const session of this.sessions.values()) {
      if (session.userId === userId && !session.revokedAt) {
        session.revokedAt = changedAt;
        revokedSessionCount += 1;
      }
    }
    this.auditEvents.push({
      type: "password_reset",
      targetUserId: user.id,
      revokedSessionCount,
    });
    return { kind: "reset", revokedSessionCount };
  }
}

function seededRepository(): MemoryAccountRepository {
  return new MemoryAccountRepository(
    [admin, adult, child].map((user) => ({
      user,
      passwordHash: initialPasswordHash,
    })),
  );
}

function account(
  id: string,
  username: string,
  displayName: string,
  accountType: AuthUserRecord["accountType"],
  guardianHistoryAccess: GuardianHistoryAccess | null,
  timestamp: Date = createdAt,
): AuthUserRecord {
  return {
    id,
    username,
    displayName,
    accountType,
    status: "active",
    guardianHistoryAccess,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function toPublicUser(user: AuthUserRecord): UserAccount {
  return {
    ...user,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

async function login(
  app: Awaited<ReturnType<typeof buildApp>>,
  username: string,
  password: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error("登录响应没有 Cookie。");
  return value.split(";", 1)[0] ?? "";
}
