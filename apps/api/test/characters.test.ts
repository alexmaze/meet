import {
  BUILTIN_CHARACTER_PRESETS,
  BUILTIN_VOICE_PROFILES,
  DEFAULT_PROVIDER_PROFILE,
  type CharacterAggregate,
  type CharacterCatalog,
  type CharacterRecord,
} from "@meet/database";
import type {
  Character,
  CharacterSummary,
  CreateCharacterRequest,
  UserAccount,
} from "@meet/protocol";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type {
  AuthRepository,
  AuthUserRecord,
  LoginSessionRecord,
} from "../src/auth/repository.js";
import { hashSessionToken } from "../src/auth/session-token.js";
import type { CharacterRepository } from "../src/characters/repository.js";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const now = new Date("2026-08-09T06:00:00.000Z");
const admin = account("4d1c2e31-ad0e-4fa9-9ae8-ae3497069116", "admin", "admin");
const adult = account("4d1c2e31-ad0e-4fa9-9ae8-ae3497069117", "adult", "adult");
const child = account("4d1c2e31-ad0e-4fa9-9ae8-ae3497069118", "child", "child");
const otherAdult = account(
  "4d1c2e31-ad0e-4fa9-9ae8-ae3497069119",
  "other-adult",
  "adult",
);

const privateCharacterId = "c437c71e-f209-4f7d-8f98-1c1e239d4201";
const familyCharacterId = "c437c71e-f209-4f7d-8f98-1c1e239d4202";

const config: AppConfig = {
  server: { host: "127.0.0.1", port: 8787, logLevel: "silent" },
  database: {},
  auth: {
    cookieName: "meet_session",
    cookieSecure: false,
    sessionTtlMs: 30 * 24 * 60 * 60 * 1_000,
    loginMaxAttempts: 20,
    loginWindowMs: 300_000,
  },
  qwen: {
    enabled: true,
    apiKey: "never-return-this-api-key",
    endpoint: "realtime.example.com",
    region: "cn-beijing",
    model: "qwen-audio-3.0-realtime-flash",
    voice: "longanqian",
    instructions: "不应覆盖角色设定",
    requestTimeoutMs: 15_000,
  },
};

describe("character routes", () => {
  it("requires a signed-in account for character reads and writes", async () => {
    const repository = seededCharacters();
    const app = await testApp(repository);
    for (const requestOptions of [
      { method: "GET" as const, url: "/api/characters" },
      {
        method: "POST" as const,
        url: "/api/characters",
        payload: createInput(),
      },
      {
        method: "POST" as const,
        url: `/api/characters/${BUILTIN_CHARACTER_PRESETS[0]!.id}/realtime/sessions`,
        payload: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
        headers: { "content-type": "application/sdp" },
      },
    ]) {
      const response = await app.inject(requestOptions);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        code: "AUTHENTICATION_REQUIRED",
      });
    }
    await app.close();
  });

  it("enforces the visible-character matrix and hides other private ids", async () => {
    const repository = seededCharacters();
    const app = await testApp(repository);

    const adminList = await request(app, admin, "GET", "/api/characters");
    expect(adminList.statusCode).toBe(200);
    expect(
      adminList
        .json<{ characters: CharacterSummary[] }>()
        .characters.map(({ id }) => id),
    ).toContain(familyCharacterId);
    expect(adminList.body).not.toContain(privateCharacterId);

    const ownerList = await request(app, adult, "GET", "/api/characters");
    expect(ownerList.body).toContain(privateCharacterId);
    expect(ownerList.body).toContain(familyCharacterId);

    const childList = await request(app, child, "GET", "/api/characters");
    expect(childList.body).toContain(familyCharacterId);
    expect(childList.body).not.toContain(privateCharacterId);

    const hidden = await request(
      app,
      otherAdult,
      "GET",
      `/api/characters/${privateCharacterId}`,
    );
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ code: "CHARACTER_NOT_FOUND" });
    await app.close();
  });

  it("derives ownership and visibility and rejects all child writes first", async () => {
    const repository = seededCharacters();
    const app = await testApp(repository);

    const childWrite = await request(app, child, "POST", "/api/characters", {
      forged: true,
    });
    expect(childWrite.statusCode).toBe(403);
    expect(repository.createCalls).toBe(0);

    const forged = await request(app, adult, "POST", "/api/characters", {
      ...createInput(),
      visibility: "family",
      ownerUserId: admin.id,
      systemKey: "builtin.forged",
      providerSecret: "secret",
    });
    expect(forged.statusCode).toBe(400);
    expect(repository.createCalls).toBe(0);

    const adultCreated = await request(
      app,
      adult,
      "POST",
      "/api/characters",
      createInput(),
    );
    expect(adultCreated.statusCode).toBe(201);
    expect(
      adultCreated.json<{ character: Character }>().character,
    ).toMatchObject({ visibility: "private" });

    const adminCreated = await request(
      app,
      admin,
      "POST",
      "/api/characters",
      createInput(),
    );
    expect(adminCreated.statusCode).toBe(201);
    expect(
      adminCreated.json<{ character: Character }>().character,
    ).toMatchObject({ visibility: "family" });
    expect(adminCreated.body).not.toContain("ownerUserId");
    expect(adminCreated.body).not.toContain("secretRef");
    await app.close();
  });

  it("returns 403 for every child write route before repository mutation", async () => {
    const repository = seededCharacters();
    const mutationSpies = [
      vi.spyOn(repository, "create"),
      vi.spyOn(repository, "update"),
      vi.spyOn(repository, "updateVisibility"),
      vi.spyOn(repository, "copy"),
      vi.spyOn(repository, "restore"),
      vi.spyOn(repository, "delete"),
    ];
    const app = await testApp(repository);
    const builtinId = BUILTIN_CHARACTER_PRESETS[0]!.id;
    const cases: Array<{
      method: "POST" | "PATCH" | "DELETE";
      url: string;
      payload?: unknown;
    }> = [
      { method: "POST", url: "/api/characters", payload: { invalid: true } },
      {
        method: "PATCH",
        url: `/api/characters/${builtinId}`,
        payload: { invalid: true },
      },
      {
        method: "PATCH",
        url: `/api/characters/${builtinId}/visibility`,
        payload: { invalid: true },
      },
      { method: "POST", url: `/api/characters/${builtinId}/copy` },
      { method: "POST", url: `/api/characters/${builtinId}/restore` },
      {
        method: "DELETE",
        url: `/api/characters/${builtinId}`,
        payload: { invalid: true },
      },
    ];

    for (const testCase of cases) {
      const response = await request(
        app,
        child,
        testCase.method,
        testCase.url,
        testCase.payload,
      );
      expect(response.statusCode).toBe(403);
    }
    for (const spy of mutationSpies) expect(spy).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a voice that does not belong to the selected catalog profile", async () => {
    const repository = seededCharacters();
    const app = await testApp(repository);
    const response = await request(app, adult, "POST", "/api/characters", {
      ...createInput(),
      voiceProfileId: "be8f77ec-a61e-4be0-8b70-8c7cb9e59999",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "CHARACTER_PROFILE_INVALID",
    });
    await app.close();
  });

  it("allows only owners to edit/share/delete and protects revisions and builtins", async () => {
    const repository = seededCharacters();
    const app = await testApp(repository);

    const adminCannotEditAdultFamily = await request(
      app,
      admin,
      "PATCH",
      `/api/characters/${familyCharacterId}`,
      { revision: 1, name: "越权修改" },
    );
    expect(adminCannotEditAdultFamily.statusCode).toBe(403);

    const stale = await request(
      app,
      adult,
      "PATCH",
      `/api/characters/${privateCharacterId}`,
      { revision: 99, name: "过期修改" },
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: "CHARACTER_REVISION_CONFLICT",
    });

    const shared = await request(
      app,
      adult,
      "PATCH",
      `/api/characters/${privateCharacterId}/visibility`,
      { revision: 1, visibility: "family" },
    );
    expect(shared.statusCode).toBe(200);
    expect(shared.json<{ character: Character }>().character).toMatchObject({
      visibility: "family",
      revision: 2,
    });

    const adminShare = await request(
      app,
      admin,
      "PATCH",
      `/api/characters/${familyCharacterId}/visibility`,
      { revision: 1, visibility: "private" },
    );
    expect(adminShare.statusCode).toBe(403);

    const builtinDelete = await request(
      app,
      admin,
      "DELETE",
      `/api/characters/${BUILTIN_CHARACTER_PRESETS[0]!.id}`,
      { revision: 1 },
    );
    expect(builtinDelete.statusCode).toBe(403);
    expect(builtinDelete.json()).toMatchObject({
      code: "BUILTIN_CHARACTER_PROTECTED",
    });
    await app.close();
  });

  it("copies with server-derived ownership and restores a builtin in place", async () => {
    const repository = seededCharacters();
    const app = await testApp(repository);
    const builtin = BUILTIN_CHARACTER_PRESETS[0]!;

    const adultCopy = await request(
      app,
      adult,
      "POST",
      `/api/characters/${builtin.id}/copy`,
      {},
    );
    expect(adultCopy.statusCode).toBe(201);
    expect(adultCopy.json<{ character: Character }>().character).toMatchObject({
      systemKey: null,
      systemVersion: null,
      visibility: "private",
      revision: 1,
    });

    const adminCopy = await request(
      app,
      admin,
      "POST",
      `/api/characters/${builtin.id}/copy`,
      {},
    );
    expect(adminCopy.statusCode).toBe(201);
    expect(
      adminCopy.json<{ character: Character }>().character.visibility,
    ).toBe("family");

    repository.mutateBuiltin(builtin.id, {
      name: "被修改的预置角色",
      revision: 7,
    });
    const restored = await request(
      app,
      admin,
      "POST",
      `/api/characters/${builtin.id}/restore`,
      {},
    );
    expect(restored.statusCode).toBe(200);
    expect(restored.json<{ character: Character }>().character).toMatchObject({
      id: builtin.id,
      systemKey: builtin.systemKey,
      systemVersion: 1,
      name: builtin.name,
      revision: 8,
    });
    expect(repository.conversationSentinel).toBe("untouched");

    const adultRestore = await request(
      app,
      adult,
      "POST",
      `/api/characters/${builtin.id}/restore`,
      {},
    );
    expect(adultRestore.statusCode).toBe(403);
    await app.close();
  });

  it("requires a strict application/json empty object for copy and restore", async () => {
    const repository = seededCharacters();
    const copySpy = vi.spyOn(repository, "copy");
    const restoreSpy = vi.spyOn(repository, "restore");
    const app = await testApp(repository);
    const builtinId = BUILTIN_CHARACTER_PRESETS[0]!.id;
    const actions = [
      {
        actor: adult,
        url: `/api/characters/${builtinId}/copy`,
        spy: copySpy,
      },
      {
        actor: admin,
        url: `/api/characters/${builtinId}/restore`,
        spy: restoreSpy,
      },
    ];

    for (const action of actions) {
      const invalidRequests = [
        {},
        {
          headers: { "content-type": "text/plain" },
          payload: "{}",
        },
        {
          headers: { "content-type": "application/x-www-form-urlencoded" },
          payload: "value=1",
        },
        {
          headers: { "content-type": "application/json" },
          payload: JSON.stringify({ revision: 1 }),
        },
      ];

      for (const invalid of invalidRequests) {
        const response = await app.inject({
          method: "POST",
          url: action.url,
          headers: {
            cookie: `meet_session=${tokenFor(action.actor)}`,
            ...invalid.headers,
          },
          ...("payload" in invalid ? { payload: invalid.payload } : {}),
        });
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
      }
      expect(action.spy).not.toHaveBeenCalled();
    }
    await app.close();
  });

  it("compiles a safe runtime and creates SDP sessions only from that character", async () => {
    const repository = seededCharacters();
    const answer = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
    const fetchFunction = vi.fn(
      async () =>
        new Response(answer, {
          status: 200,
          headers: { "Content-Type": "application/sdp" },
        }),
    ) as typeof globalThis.fetch;
    const app = await testApp(repository, fetchFunction);
    const builtin = BUILTIN_CHARACTER_PRESETS[1]!;

    const runtime = await request(
      app,
      child,
      "GET",
      `/api/characters/${builtin.id}/runtime`,
    );
    expect(runtime.statusCode).toBe(200);
    expect(runtime.json()).toMatchObject({
      character: { id: builtin.id, name: "林老师" },
      realtime: {
        provider: "qwen",
        model: "qwen-audio-3.0-realtime-plus",
        voice: "longanlingxi",
        firstSpeaker: "assistant",
      },
    });
    expect(runtime.body).toContain("【人物背景】");
    expect(runtime.body).toContain("苏格拉底式追问");
    expect(runtime.body).not.toContain("never-return-this-api-key");
    expect(runtime.body).not.toContain("secretRef");

    const session = await request(
      app,
      child,
      "POST",
      `/api/characters/${builtin.id}/realtime/sessions`,
      "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
      "application/sdp",
    );
    expect(session.statusCode).toBe(200);
    expect(session.body).toBe(answer);
    const upstreamUrl = String(fetchFunction.mock.calls[0]?.[0]);
    expect(upstreamUrl).toContain("model=qwen-audio-3.0-realtime-plus");
    expect(upstreamUrl).not.toContain(config.qwen.model);

    const forgedModel = await request(
      app,
      child,
      "POST",
      `/api/characters/${builtin.id}/realtime/sessions?model=qwen-audio-3.0-realtime-flash`,
      "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
      "application/sdp",
    );
    expect(forgedModel.statusCode).toBe(400);
    expect(fetchFunction).toHaveBeenCalledTimes(1);

    const hidden = await request(
      app,
      otherAdult,
      "POST",
      `/api/characters/${privateCharacterId}/realtime/sessions?model=qwen-audio-3.0-realtime-plus`,
      "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
      "application/sdp",
    );
    expect(hidden.statusCode).toBe(404);
    expect(fetchFunction).toHaveBeenCalledTimes(1);

    const oldRoute = await request(
      app,
      admin,
      "POST",
      "/api/realtime/qwen/sessions",
      "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
      "application/sdp",
    );
    expect(oldRoute.statusCode).toBe(404);
    await app.close();
  });

  it("sanitizes repository failures", async () => {
    const repository = seededCharacters();
    repository.listError = Object.assign(
      new Error("query contained secret persona and db.internal"),
      { code: "ECONNREFUSED", params: ["private instructions"] },
    );
    const app = await testApp(repository);
    const response = await request(app, admin, "GET", "/api/characters");
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      code: "CHARACTER_SERVICE_UNAVAILABLE",
      message: "角色服务暂时不可用，请稍后重试。",
    });
    expect(response.body).not.toContain("db.internal");
    expect(response.body).not.toContain("private instructions");
    await app.close();
  });
});

class MemoryCharacterRepository implements CharacterRepository {
  readonly records = new Map<string, CharacterAggregate>();
  readonly events: Array<Record<string, unknown>> = [];
  createCalls = 0;
  listError: unknown;
  conversationSentinel = "untouched";

  constructor(
    private readonly actors: Map<string, AuthUserRecord>,
    records: CharacterAggregate[],
  ) {
    for (const record of records) this.records.set(record.character.id, record);
  }

  async listVisible(actorUserId: string) {
    if (this.listError) throw this.listError;
    return [...this.records.values()].filter((record) =>
      this.visible(record, actorUserId),
    );
  }

  async findVisible(actorUserId: string, characterId: string) {
    const record = this.records.get(characterId);
    return record && this.visible(record, actorUserId) ? record : null;
  }

  async listCatalog(): Promise<CharacterCatalog> {
    const first = this.records.values().next().value as
      CharacterAggregate | undefined;
    if (!first) return { providers: [], voices: [] };
    return {
      providers: [first.providerProfile],
      voices: BUILTIN_VOICE_PROFILES.map((voice) => voiceRecord(voice)),
    };
  }

  async create(
    actorUserId: string,
    input: CreateCharacterRequest,
    createdAt: Date,
  ) {
    this.createCalls += 1;
    const actor = this.actors.get(actorUserId);
    if (!actor || actor.accountType === "child") {
      return { kind: "forbidden" as const };
    }
    const pair = this.profilePair(
      input.providerProfileId,
      input.voiceProfileId,
    );
    if (!pair) return { kind: "invalid_profile" as const };
    const record: CharacterAggregate = {
      character: {
        id: randomUUID(),
        systemKey: null,
        systemVersion: null,
        ownerUserId: actor.id,
        visibility: actor.accountType === "admin" ? "family" : "private",
        ...input,
        revision: 1,
        deletedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      ...pair,
    };
    this.records.set(record.character.id, record);
    return { kind: "created" as const, character: record };
  }

  async update(
    actorUserId: string,
    characterId: string,
    expectedRevision: number,
    changes: Partial<CreateCharacterRequest>,
    updatedAt: Date,
  ) {
    const access = this.writeAccess(actorUserId, characterId);
    if (access.kind !== "allowed") return access;
    if (access.record.character.revision !== expectedRevision) {
      return { kind: "revision_conflict" as const };
    }
    const providerProfileId =
      changes.providerProfileId ?? access.record.character.providerProfileId;
    const voiceProfileId =
      changes.voiceProfileId ?? access.record.character.voiceProfileId;
    const pair = this.profilePair(providerProfileId, voiceProfileId);
    if (!pair) return { kind: "invalid_profile" as const };
    const updated = {
      ...access.record,
      character: {
        ...access.record.character,
        ...changes,
        revision: expectedRevision + 1,
        updatedAt,
      },
      ...pair,
    };
    this.records.set(characterId, updated);
    return { kind: "updated" as const, character: updated };
  }

  async updateVisibility(
    actorUserId: string,
    characterId: string,
    expectedRevision: number,
    visibility: "private" | "family",
    updatedAt: Date,
  ) {
    const actor = this.actors.get(actorUserId);
    if (!actor || actor.accountType !== "adult") {
      return { kind: "forbidden" as const };
    }
    const record = this.records.get(characterId);
    if (!record || record.character.deletedAt) {
      return { kind: "not_found" as const };
    }
    if (
      record.character.visibility === "private" &&
      record.character.ownerUserId !== actor.id
    ) {
      return { kind: "not_found" as const };
    }
    if (
      record.character.visibility === "builtin" ||
      record.character.ownerUserId !== actor.id
    ) {
      return { kind: "forbidden" as const };
    }
    if (record.character.revision !== expectedRevision) {
      return { kind: "revision_conflict" as const };
    }
    if (record.character.visibility === visibility) {
      return { kind: "unchanged" as const, character: record };
    }
    const updated = {
      ...record,
      character: {
        ...record.character,
        visibility,
        revision: expectedRevision + 1,
        updatedAt,
      },
    };
    this.records.set(characterId, updated);
    return { kind: "updated" as const, character: updated };
  }

  async copy(actorUserId: string, sourceCharacterId: string, createdAt: Date) {
    const actor = this.actors.get(actorUserId);
    if (!actor || actor.accountType === "child") {
      return { kind: "forbidden" as const };
    }
    const source = await this.findVisible(actorUserId, sourceCharacterId);
    if (!source) return { kind: "not_found" as const };
    const copied: CharacterAggregate = {
      ...source,
      character: {
        ...source.character,
        id: randomUUID(),
        systemKey: null,
        systemVersion: null,
        ownerUserId: actor.id,
        visibility: actor.accountType === "admin" ? "family" : "private",
        name: `${source.character.name} 副本`,
        revision: 1,
        deletedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
    };
    this.records.set(copied.character.id, copied);
    return { kind: "copied" as const, character: copied };
  }

  async restore(actorUserId: string, characterId: string, restoredAt: Date) {
    const actor = this.actors.get(actorUserId);
    if (!actor || actor.accountType !== "admin") {
      return { kind: "forbidden" as const };
    }
    const current = this.records.get(characterId);
    if (!current || current.character.deletedAt) {
      return { kind: "not_found" as const };
    }
    const preset = BUILTIN_CHARACTER_PRESETS.find(
      ({ id }) => id === characterId,
    );
    if (!preset || current.character.visibility !== "builtin") {
      return { kind: "not_builtin" as const };
    }
    const pair = this.profilePair(
      preset.providerProfileId,
      preset.voiceProfileId,
    );
    if (!pair) throw new Error("missing test profile");
    const restored: CharacterAggregate = {
      character: {
        ...current.character,
        ...preset,
        ownerUserId: null,
        visibility: "builtin",
        revision: current.character.revision + 1,
        deletedAt: null,
        updatedAt: restoredAt,
      },
      ...pair,
    };
    this.records.set(characterId, restored);
    this.events.push({ type: "restored", characterId });
    return { kind: "restored" as const, character: restored };
  }

  async delete(
    actorUserId: string,
    characterId: string,
    expectedRevision: number,
    deletedAt: Date,
  ) {
    const access = this.writeAccess(actorUserId, characterId);
    if (access.kind !== "allowed") return access;
    if (access.record.character.visibility === "builtin") {
      return { kind: "builtin_protected" as const };
    }
    if (access.record.character.revision !== expectedRevision) {
      return { kind: "revision_conflict" as const };
    }
    this.records.set(characterId, {
      ...access.record,
      character: {
        ...access.record.character,
        revision: expectedRevision + 1,
        deletedAt,
        updatedAt: deletedAt,
      },
    });
    return { kind: "deleted" as const };
  }

  mutateBuiltin(
    characterId: string,
    changes: Partial<Pick<CharacterRecord, "name" | "revision">>,
  ) {
    const record = this.records.get(characterId);
    if (!record) throw new Error("missing builtin");
    this.records.set(characterId, {
      ...record,
      character: { ...record.character, ...changes },
    });
  }

  private visible(record: CharacterAggregate, actorUserId: string) {
    return (
      !record.character.deletedAt &&
      (record.character.visibility !== "private" ||
        record.character.ownerUserId === actorUserId)
    );
  }

  private writeAccess(actorUserId: string, characterId: string) {
    const actor = this.actors.get(actorUserId);
    if (!actor || actor.accountType === "child") {
      return { kind: "forbidden" as const };
    }
    const record = this.records.get(characterId);
    if (!record || record.character.deletedAt) {
      return { kind: "not_found" as const };
    }
    if (
      record.character.visibility === "private" &&
      record.character.ownerUserId !== actor.id
    ) {
      return { kind: "not_found" as const };
    }
    if (record.character.visibility === "builtin") {
      return actor.accountType === "admin"
        ? { kind: "allowed" as const, record }
        : { kind: "forbidden" as const };
    }
    return record.character.ownerUserId === actor.id
      ? { kind: "allowed" as const, record }
      : { kind: "forbidden" as const };
  }

  private profilePair(providerProfileId: string, voiceProfileId: string) {
    if (providerProfileId !== DEFAULT_PROVIDER_PROFILE.id) return null;
    const voice = BUILTIN_VOICE_PROFILES.find(
      (candidate) =>
        candidate.id === voiceProfileId &&
        candidate.providerProfileId === providerProfileId,
    );
    if (!voice) return null;
    return {
      providerProfile: providerRecord(),
      voiceProfile: voiceRecord(voice),
    };
  }
}

function seededCharacters() {
  const actors = new Map(
    [admin, adult, child, otherAdult].map((actor) => [actor.id, actor]),
  );
  const builtins = BUILTIN_CHARACTER_PRESETS.map((preset) =>
    aggregateFromPreset(preset),
  );
  const customBase = aggregateFromPreset(BUILTIN_CHARACTER_PRESETS[2]!);
  return new MemoryCharacterRepository(actors, [
    ...builtins,
    {
      ...customBase,
      character: {
        ...customBase.character,
        id: privateCharacterId,
        systemKey: null,
        systemVersion: null,
        ownerUserId: adult.id,
        visibility: "private",
        name: "成人私人角色",
      },
    },
    {
      ...customBase,
      character: {
        ...customBase.character,
        id: familyCharacterId,
        systemKey: null,
        systemVersion: null,
        ownerUserId: adult.id,
        visibility: "family",
        name: "成人共享角色",
      },
    },
  ]);
}

function aggregateFromPreset(
  preset: (typeof BUILTIN_CHARACTER_PRESETS)[number],
): CharacterAggregate {
  const voice = BUILTIN_VOICE_PROFILES.find(
    ({ id }) => id === preset.voiceProfileId,
  );
  if (!voice) throw new Error("missing voice");
  return {
    character: {
      ...preset,
      ownerUserId: null,
      visibility: "builtin",
      revision: 1,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    providerProfile: providerRecord(),
    voiceProfile: voiceRecord(voice),
  };
}

function providerRecord(): CharacterAggregate["providerProfile"] {
  return {
    ...DEFAULT_PROVIDER_PROFILE,
    secretRef: "never-return-this-secret-ref",
    createdAt: now,
    updatedAt: now,
  } as CharacterAggregate["providerProfile"];
}

function voiceRecord(
  voice: (typeof BUILTIN_VOICE_PROFILES)[number],
): CharacterAggregate["voiceProfile"] {
  return { ...voice, createdAt: now, updatedAt: now };
}

function createInput(): CreateCharacterRequest {
  const preset = BUILTIN_CHARACTER_PRESETS[2]!;
  return {
    name: "自定义伙伴",
    description: "一个用于测试的自定义聊天伙伴。",
    persona: preset.persona,
    openingLine: "你好。",
    providerProfileId: preset.providerProfileId,
    voiceProfileId: preset.voiceProfileId,
    conversationPolicy: preset.conversationPolicy,
    visualProfile: preset.visualProfile,
  };
}

async function testApp(
  characters: MemoryCharacterRepository,
  fetchFunction?: typeof globalThis.fetch,
) {
  return buildApp({
    config,
    authRepository,
    characterRepository: characters,
    fetchFunction,
    logger: false,
  });
}

const tokens = new Map(
  [admin, adult, child, otherAdult].map((actor) => [
    hashSessionToken(tokenFor(actor)),
    actor,
  ]),
);

const authRepository: AuthRepository = {
  async findCredentialByUsername() {
    return null;
  },
  async createLoginSessionIfCredentialCurrent(_session: LoginSessionRecord) {
    return true;
  },
  async findUserBySessionTokenHash(tokenHash) {
    return tokens.get(tokenHash) ?? null;
  },
  async revokeLoginSession() {},
};

function tokenFor(actor: AuthUserRecord) {
  return `token-${actor.username}`;
}

async function request(
  app: Awaited<ReturnType<typeof buildApp>>,
  actor: AuthUserRecord,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
  contentType = "application/json",
) {
  return app.inject({
    method,
    url,
    headers: {
      cookie: `meet_session=${tokenFor(actor)}`,
      ...(payload === undefined ? {} : { "content-type": contentType }),
    },
    ...(payload === undefined ? {} : { payload }),
  });
}

function account(
  id: string,
  username: string,
  accountType: AuthUserRecord["accountType"],
): AuthUserRecord {
  return {
    id,
    username,
    displayName: username,
    accountType,
    status: "active",
    guardianHistoryAccess: accountType === "child" ? "allowed" : null,
    createdAt: now,
    updatedAt: now,
  };
}

type _ProtocolUserAccountCompatibility = UserAccount;
