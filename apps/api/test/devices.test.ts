import type { UserAccount } from "@meet/protocol";
import { beforeAll, describe, expect, it } from "vitest";

import { hashPassword } from "../src/auth/password.js";
import type {
  AuthRepository,
  AuthUserRecord,
  ChangeOwnPasswordResult,
  CredentialRecord,
  LoginSessionRecord,
} from "../src/auth/repository.js";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type {
  AuthenticateDeviceCredentialResult,
  ClaimPairingSessionInput,
  ClaimPairingSessionResult,
  CompanionDeviceRecord,
  CreatePairingSessionInput,
  DeliverPairingCredentialResult,
  DevicePairingSessionRecord,
  DeviceRepository,
} from "../src/devices/repository.js";

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

const adult: AuthUserRecord = {
  id: "4d1c2e31-ad0e-4fa9-9ae8-ae3497069117",
  username: "adult",
  displayName: "家长",
  accountType: "adult",
  status: "active",
  guardianHistoryAccess: null,
  createdAt: new Date("2026-08-09T00:00:00.000Z"),
  updatedAt: new Date("2026-08-09T00:00:00.000Z"),
};

let passwordHash = "";

beforeAll(async () => {
  passwordHash = await hashPassword("correct-password");
});

describe("companion device routes", () => {
  it("pairs a device, delivers credential once, and authenticates via bearer", async () => {
    const authRepository = new MemoryAuthRepository([
      { user: adult, passwordHash },
    ]);
    const deviceRepository = new MemoryDeviceRepository();
    const app = await buildApp({
      config,
      authRepository,
      deviceRepository,
      logger: false,
    });

    const create = await app.inject({
      method: "POST",
      url: "/api/devices/pairing-sessions",
      payload: { displayName: "客厅音箱" },
    });
    expect(create.statusCode).toBe(200);
    const created = create.json<{
      pairingSessionId: string;
      code: string;
      expiresAt: string;
    }>();
    expect(created.code).toMatch(/^\d{6}$/);

    const pending = await app.inject({
      method: "GET",
      url: `/api/devices/pairing-sessions/${created.pairingSessionId}`,
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({
      status: "pending",
      pairingSessionId: created.pairingSessionId,
    });

    const cookie = await login(app, "adult", "correct-password");
    const bind = await app.inject({
      method: "POST",
      url: "/api/devices/bindings",
      headers: { cookie },
      payload: { code: created.code },
    });
    expect(bind.statusCode).toBe(200);
    expect(bind.json()).toMatchObject({
      device: { displayName: "客厅音箱" },
    });

    const claimed = await app.inject({
      method: "GET",
      url: `/api/devices/pairing-sessions/${created.pairingSessionId}`,
    });
    expect(claimed.statusCode).toBe(200);
    const claimedBody = claimed.json<{
      status: "claimed";
      deviceId: string;
      deviceCredential: string;
    }>();
    expect(claimedBody.status).toBe("claimed");
    expect(claimedBody.deviceCredential.length).toBeGreaterThan(10);

    const secondPoll = await app.inject({
      method: "GET",
      url: `/api/devices/pairing-sessions/${created.pairingSessionId}`,
    });
    expect(secondPoll.statusCode).toBe(409);

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: {
        authorization: `Bearer ${claimedBody.deviceCredential}`,
      },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ user: UserAccount }>().user.id).toBe(adult.id);

    const list = await app.inject({
      method: "GET",
      url: "/api/devices",
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ devices: unknown[] }>().devices).toHaveLength(1);

    const revoke = await app.inject({
      method: "DELETE",
      url: `/api/devices/${claimedBody.deviceId}`,
      headers: { cookie },
    });
    expect(revoke.statusCode).toBe(200);

    const afterRevoke = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: {
        authorization: `Bearer ${claimedBody.deviceCredential}`,
      },
    });
    expect(afterRevoke.statusCode).toBe(401);

    await app.close();
  });

  it("rejects pairing create when rate limited", async () => {
    const app = await buildApp({
      config: {
        ...config,
        auth: { ...config.auth, loginMaxAttempts: 5, loginWindowMs: 60_000 },
      },
      authRepository: new MemoryAuthRepository([
        { user: adult, passwordHash },
      ]),
      deviceRepository: new MemoryDeviceRepository(),
      logger: false,
    });

    for (let index = 0; index < 5; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/devices/pairing-sessions",
        payload: {},
      });
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/api/devices/pairing-sessions",
      payload: {},
    });
    expect(limited.statusCode).toBe(429);

    await app.close();
  });
});

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
  const cookie = extractCookie(response.headers["set-cookie"]);
  expect(cookie).toContain("meet_session=");
  return cookie;
}

function extractCookie(
  setCookie: string | string[] | undefined,
): string {
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!value) return "";
  return value.split(";")[0] ?? "";
}

class MemoryAuthRepository implements AuthRepository {
  private readonly sessions = new Map<
    string,
    { userId: string; expiresAt: Date; revokedAt: Date | null }
  >();

  constructor(private readonly credentials: CredentialRecord[]) {}

  async findCredentialByUsername(
    username: string,
  ): Promise<CredentialRecord | null> {
    return (
      this.credentials.find(
        (item) => item.user.username === username.trim(),
      ) ?? null
    );
  }

  async findCredentialBySessionTokenHash(): Promise<CredentialRecord | null> {
    return null;
  }

  async createLoginSessionIfCredentialCurrent(
    session: LoginSessionRecord,
    _expectedPasswordHash: string,
  ): Promise<boolean> {
    this.sessions.set(session.tokenHash, {
      userId: session.userId,
      expiresAt: session.expiresAt,
      revokedAt: null,
    });
    return true;
  }

  async findUserBySessionTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<AuthUserRecord | null> {
    const session = this.sessions.get(tokenHash);
    if (!session || session.revokedAt || session.expiresAt <= now) return null;
    return (
      this.credentials.find((item) => item.user.id === session.userId)?.user ??
      null
    );
  }

  async revokeLoginSession(tokenHash: string, revokedAt: Date): Promise<void> {
    const session = this.sessions.get(tokenHash);
    if (session) session.revokedAt = revokedAt;
  }

  async changeOwnPassword(): Promise<ChangeOwnPasswordResult> {
    return { kind: "invalid_session" };
  }
}

class MemoryDeviceRepository implements DeviceRepository {
  private readonly sessions = new Map<string, DevicePairingSessionRecord>();
  private readonly devices = new Map<string, CompanionDeviceRecord>();
  private readonly credentials = new Map<
    string,
    {
      id: string;
      deviceId: string;
      tokenHash: string;
      expiresAt: Date;
      revokedAt: Date | null;
      createdAt: Date;
    }
  >();

  async createPairingSession(
    input: CreatePairingSessionInput,
  ): Promise<DevicePairingSessionRecord> {
    const session: DevicePairingSessionRecord = {
      id: input.id,
      codeHash: input.codeHash,
      devicePublicId: input.devicePublicId,
      displayName: input.displayName,
      expiresAt: input.expiresAt,
      claimedAt: null,
      claimedByUserId: null,
      pendingDeviceCredential: null,
      credentialDeliveredAt: null,
      createdAt: input.createdAt,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async findPairingSessionById(
    id: string,
  ): Promise<DevicePairingSessionRecord | null> {
    return this.sessions.get(id) ?? null;
  }

  async claimPairingSession(
    input: ClaimPairingSessionInput,
  ): Promise<ClaimPairingSessionResult> {
    const session = [...this.sessions.values()].find(
      (item) => item.codeHash === input.codeHash,
    );
    if (!session) return { kind: "not_found" };
    if (session.claimedAt) return { kind: "already_claimed" };
    if (session.expiresAt <= input.claimedAt) return { kind: "expired" };

    const existing = this.devices.get(session.devicePublicId);
    if (existing) {
      for (const credential of this.credentials.values()) {
        if (credential.deviceId === existing.id && !credential.revokedAt) {
          credential.revokedAt = input.claimedAt;
        }
      }
      existing.userId = input.userId;
      existing.displayName = session.displayName;
      existing.updatedAt = input.claimedAt;
      existing.lastSeenAt = input.claimedAt;
    } else {
      this.devices.set(session.devicePublicId, {
        id: session.devicePublicId,
        userId: input.userId,
        displayName: session.displayName,
        selectedCharacterId: null,
        lastSeenAt: input.claimedAt,
        createdAt: input.claimedAt,
        updatedAt: input.claimedAt,
      });
    }

    this.credentials.set(input.credentialTokenHash, {
      id: input.credentialId,
      deviceId: session.devicePublicId,
      tokenHash: input.credentialTokenHash,
      expiresAt: input.credentialExpiresAt,
      revokedAt: null,
      createdAt: input.claimedAt,
    });

    session.claimedAt = input.claimedAt;
    session.claimedByUserId = input.userId;
    session.pendingDeviceCredential = input.credentialPlaintext;
    session.credentialDeliveredAt = null;

    return {
      kind: "claimed",
      device: this.devices.get(session.devicePublicId)!,
      credentialExpiresAt: input.credentialExpiresAt,
    };
  }

  async deliverPairingCredential(
    pairingSessionId: string,
    deliveredAt: Date,
  ): Promise<DeliverPairingCredentialResult> {
    const session = this.sessions.get(pairingSessionId);
    if (!session) return { kind: "not_found" };
    if (!session.claimedAt) {
      if (session.expiresAt <= deliveredAt) return { kind: "expired" };
      return {
        kind: "pending",
        pairingSessionId: session.id,
        expiresAt: session.expiresAt,
      };
    }
    if (session.credentialDeliveredAt || !session.pendingDeviceCredential) {
      return { kind: "delivered" };
    }
    const credential = session.pendingDeviceCredential;
    session.pendingDeviceCredential = null;
    session.credentialDeliveredAt = deliveredAt;
    const credentialRow = [...this.credentials.values()]
      .filter((item) => item.deviceId === session.devicePublicId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
    return {
      kind: "claimed",
      pairingSessionId: session.id,
      deviceId: session.devicePublicId,
      deviceCredential: credential,
      expiresAt: credentialRow?.expiresAt ?? session.expiresAt,
    };
  }

  async listDevicesForUser(userId: string): Promise<CompanionDeviceRecord[]> {
    return [...this.devices.values()]
      .filter((device) => device.userId === userId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  async findDeviceForUser(
    userId: string,
    deviceId: string,
  ): Promise<CompanionDeviceRecord | null> {
    const device = this.devices.get(deviceId);
    return device && device.userId === userId ? device : null;
  }

  async revokeDevice(
    userId: string,
    deviceId: string,
    revokedAt: Date,
  ): Promise<boolean> {
    const device = this.devices.get(deviceId);
    if (!device || device.userId !== userId) return false;
    for (const credential of this.credentials.values()) {
      if (credential.deviceId === deviceId && !credential.revokedAt) {
        credential.revokedAt = revokedAt;
      }
    }
    this.devices.delete(deviceId);
    return true;
  }

  async updateDeviceSelection(input: {
    deviceId: string;
    userId: string;
    selectedCharacterId: string | null;
    updatedAt: Date;
  }): Promise<CompanionDeviceRecord | null> {
    const device = this.devices.get(input.deviceId);
    if (!device || device.userId !== input.userId) return null;
    device.selectedCharacterId = input.selectedCharacterId;
    device.updatedAt = input.updatedAt;
    return device;
  }

  async findUserByDeviceCredentialTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<AuthenticateDeviceCredentialResult> {
    const credential = this.credentials.get(tokenHash);
    if (
      !credential ||
      credential.revokedAt ||
      credential.expiresAt <= now
    ) {
      return null;
    }
    const device = this.devices.get(credential.deviceId);
    if (!device) return null;
    if (device.userId !== adult.id) return null;
    return { user: adult, deviceId: device.id };
  }

  async touchDeviceLastSeen(deviceId: string, seenAt: Date): Promise<void> {
    const device = this.devices.get(deviceId);
    if (device) {
      device.lastSeenAt = seenAt;
      device.updatedAt = seenAt;
    }
  }
}
