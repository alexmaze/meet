import type { MediaObjectRecord } from "@meet/database";
import type { MediaStore } from "@meet/media";
import { describe, expect, it, vi } from "vitest";

import type {
  AuthRepository,
  AuthUserRecord,
  LoginSessionRecord,
} from "../src/auth/repository.js";
import { hashSessionToken } from "../src/auth/session-token.js";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { MediaRepository } from "../src/media/repository.js";

const adult = account("4d1c2e31-ad0e-4fa9-9ae8-ae3497069117", "adult");
const admin = account("4d1c2e31-ad0e-4fa9-9ae8-ae3497069116", "admin");
const child = account("4d1c2e31-ad0e-4fa9-9ae8-ae3497069118", "child");
const mediaId = "2fd4cbb6-fce4-40e2-9141-22f3a1bc2051";

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

describe("media routes", () => {
  it("uploads a validated image as a temporary owner-scoped character avatar", async () => {
    const fakeRepository = repository();
    const fakeStore = store();
    vi.mocked(fakeStore.put).mockResolvedValue({
      key: "2026/08/2fd4cbb6-fce4-40e2-9141-22f3a1bc2051",
      sizeBytes: 8,
      checksumSha256: "b".repeat(64),
    });
    vi.mocked(fakeRepository.createCharacterAvatar).mockResolvedValue({
      kind: "created",
      media: avatarRecord(),
    });
    const app = await testApp(fakeRepository, fakeStore);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const response = await injectAs(app, adult, {
      method: "POST",
      url: "/api/media/character-avatars",
      headers: { "content-type": "image/png" },
      payload: png,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      media: {
        id: mediaId,
        ownerUserId: adult.id,
        kind: "character_avatar",
        retention: "temporary",
      },
      avatarUrl: `/api/media/${mediaId}/content`,
    });
    expect(fakeStore.put).toHaveBeenCalledWith({
      body: expect.any(Uint8Array),
      contentType: "image/png",
    });
    expect(fakeRepository.createCharacterAvatar).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: adult.id,
        contentType: "image/png",
        sizeBytes: 8,
        checksumSha256: "b".repeat(64),
        expiresAt: expect.any(Date),
      }),
    );
    await app.close();
  });

  it("rejects disguised images and child avatar uploads", async () => {
    const fakeRepository = repository();
    const fakeStore = store();
    const app = await testApp(fakeRepository, fakeStore);
    const disguised = await injectAs(app, adult, {
      method: "POST",
      url: "/api/media/character-avatars",
      headers: { "content-type": "image/png" },
      payload: Buffer.from("not an image"),
    });
    expect(disguised.statusCode).toBe(400);
    expect(disguised.json()).toMatchObject({
      code: "MEDIA_INVALID_CHARACTER_AVATAR",
    });

    const childUpload = await injectAs(app, child, {
      method: "POST",
      url: "/api/media/character-avatars",
      headers: { "content-type": "image/jpeg" },
      payload: Buffer.from([0xff, 0xd8, 0xff]),
    });
    expect(childUpload.statusCode).toBe(403);
    expect(fakeStore.put).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires authentication", async () => {
    const app = await testApp(repository(), store());
    const response = await app.inject({
      method: "GET",
      url: `/api/media/${mediaId}`,
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("returns authorized metadata and content without exposing object keys", async () => {
    const fakeRepository = repository();
    const fakeStore = store();
    const app = await testApp(fakeRepository, fakeStore);

    const metadata = await injectAs(app, adult, {
      method: "GET",
      url: `/api/media/${mediaId}`,
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toMatchObject({
      media: { id: mediaId, kind: "call_recording", sizeBytes: 3 },
    });
    expect(metadata.body).not.toContain("private/object-key");
    expect(metadata.headers["cache-control"]).toBe("private, no-store");

    const content = await injectAs(app, adult, {
      method: "GET",
      url: `/api/media/${mediaId}/content`,
    });
    expect(content.statusCode).toBe(200);
    expect(content.rawPayload).toEqual(Buffer.from([1, 2, 3]));
    expect(content.headers["content-type"]).toContain(
      "application/octet-stream",
    );
    expect(fakeStore.open).toHaveBeenCalledWith("private/object-key");
    await app.close();
  });

  it("passes the child-history capability only for administrators", async () => {
    const fakeRepository = repository();
    const app = await testApp(fakeRepository, store());
    await injectAs(app, admin, {
      method: "GET",
      url: `/api/media/${mediaId}`,
    });
    expect(fakeRepository.findReadable).toHaveBeenCalledWith(
      admin.id,
      true,
      mediaId,
    );
    await injectAs(app, adult, {
      method: "GET",
      url: `/api/media/${mediaId}`,
    });
    expect(fakeRepository.findReadable).toHaveBeenCalledWith(
      adult.id,
      false,
      mediaId,
    );
    await app.close();
  });

  it("requests owner-scoped deletion and keeps repeated deletion idempotent", async () => {
    const fakeRepository = repository();
    vi.mocked(fakeRepository.requestDelete).mockResolvedValue({
      kind: "unchanged",
      media: record(),
    });
    const app = await testApp(fakeRepository, store());
    const response = await injectAs(app, adult, {
      method: "DELETE",
      url: `/api/media/${mediaId}`,
    });
    expect(response.statusCode).toBe(204);
    expect(fakeRepository.requestDelete).toHaveBeenCalledWith(
      adult.id,
      mediaId,
      expect.any(Date),
    );
    await app.close();
  });

  it("retains temporary media for the current owner", async () => {
    const fakeRepository = repository();
    vi.mocked(fakeRepository.retain).mockResolvedValue({
      kind: "retained",
      media: record(),
    });
    const app = await testApp(fakeRepository, store());
    const response = await injectAs(app, adult, {
      method: "POST",
      url: `/api/media/${mediaId}/retain`,
    });
    expect(response.statusCode).toBe(200);
    expect(fakeRepository.retain).toHaveBeenCalledWith(
      adult.id,
      mediaId,
      expect.any(Date),
    );
    await app.close();
  });

  it("maps missing and storage-inconsistent media without leaking paths", async () => {
    const fakeRepository = repository();
    vi.mocked(fakeRepository.findReadable)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(record());
    const fakeStore = store();
    vi.mocked(fakeStore.open).mockRejectedValue(
      new Error("ENOENT /srv/private/media/object"),
    );
    const app = await testApp(fakeRepository, fakeStore);
    const missing = await injectAs(app, adult, {
      method: "GET",
      url: `/api/media/${mediaId}`,
    });
    expect(missing.statusCode).toBe(404);
    const unavailable = await injectAs(app, adult, {
      method: "GET",
      url: `/api/media/${mediaId}/content`,
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.body).not.toContain("/srv/private");
    await app.close();
  });
});

function repository(): MediaRepository {
  return {
    createCharacterAvatar: vi.fn(async () => ({
      kind: "created" as const,
      media: avatarRecord(),
    })),
    findReadable: vi.fn(async () => record()),
    requestDelete: vi.fn(async () => ({
      kind: "requested" as const,
      media: record(),
    })),
    retain: vi.fn(async () => ({
      kind: "unchanged" as const,
      media: record(),
    })),
  };
}

function store(): MediaStore {
  return {
    put: vi.fn(async () => ({
      key: "2026/08/2fd4cbb6-fce4-40e2-9141-22f3a1bc2051",
      sizeBytes: 3,
      checksumSha256: "b".repeat(64),
    })),
    open: vi.fn(
      async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          },
        }),
    ),
    delete: vi.fn(async () => undefined),
    exists: vi.fn(async () => true),
  };
}

function avatarRecord(): MediaObjectRecord {
  return {
    ...record(),
    conversationId: null,
    kind: "character_avatar",
    contentType: "image/png",
    sizeBytes: 8,
    retention: "temporary",
    expiresAt: new Date("2026-08-11T05:20:00.000Z"),
  };
}

function record(): MediaObjectRecord {
  const now = new Date("2026-08-10T05:20:00.000Z");
  return {
    id: mediaId,
    ownerUserId: adult.id,
    conversationId: "9172f06d-c71a-47b3-94fe-35e1204b5b55",
    kind: "call_recording",
    objectKey: "private/object-key",
    contentType: "application/octet-stream",
    sizeBytes: 3,
    checksumSha256: "a".repeat(64),
    retention: "retained",
    status: "available",
    expiresAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function testApp(
  mediaRepository: MediaRepository,
  mediaStore: MediaStore,
) {
  return buildApp({
    config,
    authRepository: authRepository(),
    mediaRepository,
    mediaStore,
    logger: false,
  });
}

function authRepository(): AuthRepository {
  const users = new Map([
    [hashSessionToken(adult.username), adult],
    [hashSessionToken(admin.username), admin],
    [hashSessionToken(child.username), child],
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
