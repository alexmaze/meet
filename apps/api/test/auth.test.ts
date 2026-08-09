import type { UserAccount } from "@meet/protocol";
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

const config: AppConfig = {
  server: { host: "127.0.0.1", port: 8787, logLevel: "silent" },
  database: {},
  auth: {
    cookieName: "meet_session",
    cookieSecure: true,
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

const admin: AuthUserRecord = {
  id: "4d1c2e31-ad0e-4fa9-9ae8-ae3497069116",
  username: "admin",
  displayName: "家庭管理员",
  accountType: "admin",
  status: "active",
  guardianHistoryAccess: null,
  createdAt: new Date("2026-08-09T00:00:00.000Z"),
  updatedAt: new Date("2026-08-09T00:00:00.000Z"),
};

let passwordHash = "";

beforeAll(async () => {
  passwordHash = await hashPassword("correct-password");
});

describe("authentication routes", () => {
  it("logs in, resolves the current account, and logs out", async () => {
    const repository = new MemoryAuthRepository([
      { user: admin, passwordHash },
    ]);
    const app = await buildApp({
      config,
      authRepository: repository,
      logger: false,
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "correct-password" },
    });

    expect(login.statusCode).toBe(200);
    expect(login.json<{ user: UserAccount }>().user).toMatchObject({
      username: "admin",
      accountType: "admin",
    });
    expect(login.body).not.toContain("passwordHash");
    const cookie = extractCookie(login.headers["set-cookie"]);
    expect(cookie).toContain("meet_session=");
    expect(login.headers["set-cookie"]).toContain("HttpOnly");
    expect(login.headers["set-cookie"]).toContain("Secure");
    expect(login.headers["set-cookie"]).toContain("SameSite=Lax");
    expect(login.headers["set-cookie"]).toContain("Path=/api");
    expect(login.headers["cache-control"]).toBe("no-store");

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ user: UserAccount }>().user.id).toBe(admin.id);

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ ok: true });

    const afterLogout = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie },
    });
    expect(afterLogout.statusCode).toBe(401);
    await app.close();
  });

  it("uses one response for unknown users and incorrect passwords", async () => {
    const repository = new MemoryAuthRepository([
      { user: admin, passwordHash },
    ]);
    const app = await buildApp({
      config,
      authRepository: repository,
      logger: false,
    });

    const unknown = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "missing", password: "wrong-password" },
    });
    const wrong = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "wrong-password" },
    });

    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
    await app.close();

    const disabledApp = await buildApp({
      config,
      authRepository: new MemoryAuthRepository([
        { user: { ...admin, status: "disabled" }, passwordHash },
      ]),
      logger: false,
    });
    const disabled = await disabledApp.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "correct-password" },
    });
    expect(disabled.statusCode).toBe(401);
    expect(disabled.json()).toEqual(wrong.json());
    await disabledApp.close();
  });

  it("does not create a session when credentials change after verification", async () => {
    const repository = new MemoryAuthRepository([
      { user: admin, passwordHash },
    ]);
    repository.changePasswordBeforeSessionCreation = true;
    const app = await buildApp({
      config,
      authRepository: repository,
      logger: false,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "correct-password" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      code: "INVALID_CREDENTIALS",
      message: "用户名或密码不正确。",
    });
    expect(repository.sessionCount).toBe(0);
    await app.close();
  });

  it("reports auth as unavailable when no database is configured", async () => {
    const app = await buildApp({ config, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "correct-password" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "AUTH_UNAVAILABLE" });
    await app.close();
  });

  it("does not expose database connection errors", async () => {
    const app = await buildApp({
      config,
      authRepository: new FailingLookupAuthRepository(),
      logger: false,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "correct-password" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      code: "AUTH_UNAVAILABLE",
      message: "账号服务暂时不可用，请稍后重试。",
    });
    expect(response.body).not.toContain("db.internal");
    expect(response.body).not.toContain("ECONNREFUSED");
    await app.close();
  });
});

class MemoryAuthRepository implements AuthRepository {
  changePasswordBeforeSessionCreation = false;
  private readonly credentials = new Map<string, CredentialRecord>();
  private readonly credentialsByUserId = new Map<string, CredentialRecord>();
  private readonly users = new Map<string, AuthUserRecord>();
  private readonly sessions = new Map<
    string,
    LoginSessionRecord & { revokedAt?: Date }
  >();

  constructor(credentials: CredentialRecord[]) {
    for (const credential of credentials) {
      this.credentials.set(credential.user.username, credential);
      this.credentialsByUserId.set(credential.user.id, credential);
      this.users.set(credential.user.id, credential.user);
    }
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  async findCredentialByUsername(
    username: string,
  ): Promise<CredentialRecord | null> {
    return this.credentials.get(username) ?? null;
  }

  async createLoginSessionIfCredentialCurrent(
    session: LoginSessionRecord,
    expectedPasswordHash: string,
  ): Promise<boolean> {
    const credential = this.credentialsByUserId.get(session.userId);
    if (this.changePasswordBeforeSessionCreation && credential) {
      const changedCredential = {
        ...credential,
        passwordHash: "changed-after-verification",
      };
      this.credentialsByUserId.set(session.userId, changedCredential);
      this.credentials.set(credential.user.username, changedCredential);
    }
    const currentCredential = this.credentialsByUserId.get(session.userId);
    if (
      !currentCredential ||
      currentCredential.user.status !== "active" ||
      currentCredential.passwordHash !== expectedPasswordHash
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
    if (!session || session.revokedAt || session.expiresAt <= now) {
      return null;
    }
    return this.users.get(session.userId) ?? null;
  }

  async revokeLoginSession(tokenHash: string, revokedAt: Date): Promise<void> {
    const session = this.sessions.get(tokenHash);
    if (session) session.revokedAt = revokedAt;
  }
}

class FailingLookupAuthRepository extends MemoryAuthRepository {
  constructor() {
    super([]);
  }

  override async findCredentialByUsername(): Promise<CredentialRecord | null> {
    throw new Error("connect ECONNREFUSED db.internal:5432");
  }
}

function extractCookie(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error("响应没有设置登录 Cookie。");
  return value.split(";", 1)[0] ?? "";
}
