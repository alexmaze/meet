import type {
  CharacterRelationshipTransferPackage,
  UserAccount,
} from "@meet/protocol";
import { describe, expect, it, vi } from "vitest";

import type {
  AuthRepository,
  AuthUserRecord,
  LoginSessionRecord,
} from "../src/auth/repository.js";
import { hashSessionToken } from "../src/auth/session-token.js";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { RelationshipTransferRepository } from "../src/relationship-transfers/repository.js";
import {
  RelationshipTransferService,
  relationshipTransferPayloadChecksum,
} from "../src/relationship-transfers/service.js";

const actor: UserAccount = {
  id: "4d1c2e31-ad0e-4fa9-9ae8-ae3497069117",
  username: "admin",
  displayName: "管理员",
  accountType: "admin",
  status: "active",
  guardianHistoryAccess: null,
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
};
const characterId = "c437c71e-f209-4f7d-8f98-1c1e239d4201";
const transferId = "4c89af5d-f410-4da8-82cc-02f48dff2ff9";
const routeActor: AuthUserRecord = {
  ...actor,
  createdAt: new Date(actor.createdAt),
  updatedAt: new Date(actor.updatedAt),
};

describe("relationship transfer service", () => {
  it("builds a checksummed package containing relationship data only", async () => {
    const fake = repository();
    const service = new RelationshipTransferService(
      fake,
      () => new Date("2026-09-05T03:00:00.000Z"),
      () => transferId,
    );
    const result = await service.export(actor, characterId);

    expect(result.payload.transferId).toBe(transferId);
    expect(result.payload.conversations).toHaveLength(1);
    expect(result.integritySha256).toBe(
      relationshipTransferPayloadChecksum(result.payload),
    );
    expect(JSON.stringify(result)).not.toContain(actor.id);
    expect(JSON.stringify(result)).not.toContain("providerEventId");
    expect(JSON.stringify(result)).not.toContain("runtimeSnapshot");
  });

  it("rejects a modified package before touching the repository", async () => {
    const fake = repository();
    const service = new RelationshipTransferService(fake);
    const transferPackage = validPackage();
    transferPackage.payload.character.name = "被修改的角色名";

    await expect(
      service.import(actor, characterId, transferPackage, false),
    ).rejects.toMatchObject({
      code: "RELATIONSHIP_TRANSFER_INTEGRITY_FAILED",
      statusCode: 400,
    });
    expect(fake.import).not.toHaveBeenCalled();
  });

  it("surfaces character mismatch and returns idempotent import counts", async () => {
    const fake = repository();
    vi.mocked(fake.import)
      .mockResolvedValueOnce({
        kind: "character_mismatch",
        targetCharacterName: "林老师",
      })
      .mockResolvedValueOnce({
        kind: "unchanged",
        result: {
          transferId,
          targetCharacterId: characterId,
          importedConversations: 1,
          skippedConversations: 0,
          importedMemories: 1,
          skippedMemories: 0,
          wasAlreadyImported: true,
        },
      });
    const service = new RelationshipTransferService(fake);

    await expect(
      service.import(actor, characterId, validPackage(), false),
    ).rejects.toMatchObject({
      code: "RELATIONSHIP_TRANSFER_CHARACTER_MISMATCH",
      statusCode: 409,
    });
    await expect(
      service.import(actor, characterId, validPackage(), true),
    ).resolves.toMatchObject({
      importedConversations: 1,
      importedMemories: 1,
      wasAlreadyImported: true,
    });
  });
});

describe("relationship transfer routes", () => {
  it("requires authentication and exposes an attachment response", async () => {
    const fake = repository();
    const app = await testApp(fake);
    const unauthorized = await app.inject({
      method: "GET",
      url: `/api/characters/${characterId}/relationship-export`,
    });
    expect(unauthorized.statusCode).toBe(401);

    const exported = await injectAs(app, {
      method: "GET",
      url: `/api/characters/${characterId}/relationship-export`,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["cache-control"]).toBe("no-store");
    expect(exported.headers["content-disposition"]).toContain("attachment");
    expect(exported.json()).toMatchObject({
      schemaVersion: "meet-character-relationship-v1",
      payload: { character: { name: "奥特曼" } },
    });
    await app.close();
  });

  it("imports a valid package into the authenticated account", async () => {
    const fake = repository();
    const app = await testApp(fake);
    const response = await injectAs(app, {
      method: "POST",
      url: `/api/characters/${characterId}/relationship-import`,
      payload: validPackage(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: { importedConversations: 0, wasAlreadyImported: false },
    });
    expect(fake.import).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: routeActor.id,
        targetCharacterId: characterId,
        confirmCharacterMismatch: false,
      }),
    );
    await app.close();
  });
});

function repository(): RelationshipTransferRepository {
  return {
    export: vi.fn(async () => ({
      character: { name: "奥特曼", systemKey: null },
      conversations: [
        {
          sourceId: "9172f06d-c71a-47b3-94fe-35e1204b5b55",
          mode: "normal" as const,
          sourceStatus: "active" as const,
          provider: "qwen" as const,
          model: "qwen-audio-3.0-realtime-plus",
          voice: "longanqian",
          startedAt: "2026-09-04T03:00:00.000Z",
          endedAt: null,
          updatedAt: "2026-09-04T03:10:00.000Z",
          messages: [
            {
              sequence: 1,
              role: "user" as const,
              status: "completed" as const,
              text: "我们昨天说到哪里了？",
              createdAt: "2026-09-04T03:01:00.000Z",
            },
          ],
          summary: null,
        },
      ],
      memories: [],
    })),
    import: vi.fn(async (input) => ({
      kind: "imported" as const,
      result: {
        transferId: input.payload.transferId,
        targetCharacterId: input.targetCharacterId,
        importedConversations: input.payload.conversations.length,
        skippedConversations: 0,
        importedMemories: input.payload.memories.length,
        skippedMemories: 0,
        wasAlreadyImported: false,
      },
    })),
  };
}

function validPackage(): CharacterRelationshipTransferPackage {
  const payload = {
    transferId,
    exportedAt: "2026-09-05T03:00:00.000Z",
    character: { name: "奥特曼", systemKey: null },
    conversations: [],
    memories: [],
  };
  return {
    kind: "meet-character-relationship-transfer",
    schemaVersion: "meet-character-relationship-v1",
    payload,
    integritySha256: relationshipTransferPayloadChecksum(payload),
  };
}

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

async function testApp(
  relationshipTransferRepository: RelationshipTransferRepository,
) {
  return buildApp({
    config,
    authRepository: authRepository(),
    relationshipTransferRepository,
    logger: false,
  });
}

function authRepository(): AuthRepository {
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
      return tokenHash === hashSessionToken(routeActor.username)
        ? routeActor
        : null;
    },
    async revokeLoginSession() {},
    async changeOwnPassword() {
      return { kind: "invalid_session" };
    },
  };
}

function injectAs(
  app: Awaited<ReturnType<typeof testApp>>,
  options: Parameters<typeof app.inject>[0],
) {
  const headers = {
    ...(typeof options === "object" && "headers" in options
      ? options.headers
      : {}),
    cookie: `meet_session=${routeActor.username}`,
  };
  return app.inject({ ...options, headers });
}
