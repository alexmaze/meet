import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  copyCharacter,
  createCharacter,
  deleteCharacter,
  restoreBuiltinCharacter,
  updateCharacter,
} from "./character-operations.js";
import {
  BUILTIN_CHARACTER_PRESETS,
  BUILTIN_VOICE_PROFILES,
  DEFAULT_PROVIDER_PROFILE,
} from "./character-presets.js";
import type { Database } from "./client.js";
import {
  characterAuditEvents,
  characters,
  providerProfiles,
  userAccounts,
  type CharacterRecord,
  type UserAccount,
} from "./schema.js";

const now = new Date("2026-08-09T07:00:00.000Z");
const adminId = "4d1c2e31-ad0e-4fa9-9ae8-ae3497069116";
const adultId = "4d1c2e31-ad0e-4fa9-9ae8-ae3497069117";
const otherAdultId = "4d1c2e31-ad0e-4fa9-9ae8-ae3497069119";

describe("character database operations", () => {
  it("derives an adult private owner and audits creation in one transaction", async () => {
    const harness = transactionHarness({ actor: actor("adult", adultId) });
    const id = "c437c71e-f209-4f7d-8f98-1c1e239d4301";
    const result = await createCharacter(harness.db, {
      ...editableValues(),
      id,
      actorUserId: adultId,
      createdAt: now,
    });

    expect(result.kind).toBe("created");
    expect(harness.transactions).toBe(1);
    expect(harness.characterInserts).toHaveLength(1);
    expect(harness.characterInserts[0]).toMatchObject({
      id,
      ownerUserId: adultId,
      visibility: "private",
      systemKey: null,
      systemVersion: null,
      revision: 1,
    });
    expect(harness.auditInserts[0]).toMatchObject({
      eventType: "created",
      actorUserId: adultId,
      characterId: id,
      details: { revision: 1, visibility: "private" },
    });
  });

  it("rejects a mismatched provider/voice pair before inserting", async () => {
    const harness = transactionHarness({
      actor: actor("adult", adultId),
      profilePair: null,
    });
    const result = await createCharacter(harness.db, {
      ...editableValues(),
      actorUserId: adultId,
      createdAt: now,
    });

    expect(result).toEqual({ kind: "invalid_profile" });
    expect(harness.characterInserts).toHaveLength(0);
    expect(harness.auditInserts).toHaveLength(0);
  });

  it("does not let an administrator edit an adult-owned family character", async () => {
    const target = customCharacter({
      ownerUserId: adultId,
      visibility: "family",
    });
    const harness = transactionHarness({
      actor: actor("admin", adminId),
      target,
    });
    const result = await updateCharacter(harness.db, {
      actorUserId: adminId,
      characterId: target.id,
      expectedRevision: target.revision,
      changes: { name: "越权修改" },
      updatedAt: now,
    });

    expect(result).toEqual({ kind: "forbidden" });
    expect(harness.updates).toHaveLength(0);
    expect(harness.auditInserts).toHaveLength(0);
  });

  it("fails stale revisions before any profile lookup or update", async () => {
    const target = customCharacter({ ownerUserId: adultId, revision: 4 });
    const harness = transactionHarness({
      actor: actor("adult", adultId),
      target,
    });
    const result = await updateCharacter(harness.db, {
      actorUserId: adultId,
      characterId: target.id,
      expectedRevision: 3,
      changes: { name: "过期修改" },
      updatedAt: now,
    });

    expect(result).toEqual({ kind: "revision_conflict" });
    expect(harness.profileLookups).toBe(0);
    expect(harness.updates).toHaveLength(0);
  });

  it("soft-deletes an owner character and records only non-sensitive audit details", async () => {
    const target = customCharacter({ ownerUserId: adultId, revision: 2 });
    const harness = transactionHarness({
      actor: actor("adult", adultId),
      target,
    });
    const result = await deleteCharacter(harness.db, {
      actorUserId: adultId,
      characterId: target.id,
      expectedRevision: 2,
      deletedAt: now,
    });

    expect(result).toEqual({ kind: "deleted" });
    expect(harness.deletes).toBe(0);
    expect(harness.updates[0]).toMatchObject({
      table: characters,
      value: { deletedAt: now, revision: 3 },
    });
    expect(harness.auditInserts[0]).toMatchObject({
      eventType: "deleted",
      characterId: target.id,
      details: {
        previousRevision: 2,
        revision: 3,
        visibility: "private",
      },
    });
    expect(JSON.stringify(harness.auditInserts[0])).not.toContain("persona");
  });

  it("copies only the definition while stripping all system ownership markers", async () => {
    const source = builtinCharacter({ revision: 5 });
    const harness = transactionHarness({
      actor: actor("adult", adultId),
      target: source,
    });
    const copiedId = "c437c71e-f209-4f7d-8f98-1c1e239d4302";
    const result = await copyCharacter(harness.db, {
      actorUserId: adultId,
      sourceCharacterId: source.id,
      id: copiedId,
      createdAt: now,
    });

    expect(result.kind).toBe("copied");
    expect(harness.characterInserts[0]).toMatchObject({
      id: copiedId,
      systemKey: null,
      systemVersion: null,
      ownerUserId: adultId,
      visibility: "private",
      revision: 1,
    });
    expect(harness.auditInserts[0]).toMatchObject({
      eventType: "copied",
      details: { sourceCharacterId: source.id, sourceRevision: 5 },
    });
  });

  it("restores the canonical preset under a row lock without changing its id", async () => {
    const preset = BUILTIN_CHARACTER_PRESETS[0]!;
    const target = builtinCharacter({
      id: preset.id,
      name: "已被修改",
      revision: 9,
    });
    const harness = transactionHarness({
      actor: actor("admin", adminId),
      target,
    });
    const result = await restoreBuiltinCharacter(harness.db, {
      actorUserId: adminId,
      characterId: target.id,
      restoredAt: now,
    });

    expect(result.kind).toBe("restored");
    if (result.kind !== "restored") throw new Error("unexpected result");
    expect(result.character.character).toMatchObject({
      id: preset.id,
      systemKey: preset.systemKey,
      systemVersion: 1,
      name: preset.name,
      revision: 10,
    });
    expect(harness.characterInserts).toHaveLength(0);
    expect(harness.updates[0]?.value).not.toHaveProperty("id");
    expect(harness.auditInserts[0]).toMatchObject({
      eventType: "restored",
      characterId: preset.id,
      details: {
        systemKey: preset.systemKey,
        previousRevision: 9,
        revision: 10,
      },
    });
  });

  it("keeps the generated migration strict about null builtin versions", () => {
    const migrationPath = fileURLToPath(
      new URL("../migrations/0002_awesome_red_hulk.sql", import.meta.url),
    );
    const migration = readFileSync(migrationPath, "utf8");
    expect(migration).toContain(
      '"characters"."system_version" IS NOT NULL AND "characters"."system_version" > 0',
    );
  });
});

function transactionHarness(options: {
  actor: UserAccount;
  target?: CharacterRecord;
  profilePair?: {
    providerProfile: ReturnType<typeof providerRecord>;
    voiceProfile: ReturnType<typeof voiceRecord>;
  } | null;
}) {
  const profilePair =
    options.profilePair === undefined
      ? { providerProfile: providerRecord(), voiceProfile: voiceRecord() }
      : options.profilePair;
  const characterInserts: Array<Record<string, unknown>> = [];
  const auditInserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ table: unknown; value: Record<string, unknown> }> = [];
  let profileLookups = 0;
  let transactions = 0;
  let deletes = 0;

  const tx = {
    select() {
      return {
        from(table: unknown) {
          if (table === providerProfiles) {
            return {
              innerJoin() {
                return {
                  where() {
                    return {
                      async limit() {
                        profileLookups += 1;
                        return profilePair ? [profilePair] : [];
                      },
                    };
                  },
                };
              },
            };
          }
          const row = table === userAccounts ? options.actor : options.target;
          return {
            where() {
              return {
                for() {
                  return { limit: async () => (row ? [row] : []) };
                },
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(value: Record<string, unknown>) {
          if (table === characters) characterInserts.push(value);
          if (table === characterAuditEvents) auditInserts.push(value);
          return {
            async returning() {
              if (table !== characters) return [];
              return [
                {
                  ...value,
                  id: value.id ?? "c437c71e-f209-4f7d-8f98-1c1e239d4399",
                  deletedAt: null,
                },
              ];
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(value: Record<string, unknown>) {
          updates.push({ table, value });
          return {
            where() {
              return {
                async returning() {
                  if (table !== characters || !options.target) return [];
                  return [{ ...options.target, ...value }];
                },
              };
            },
          };
        },
      };
    },
    delete() {
      deletes += 1;
    },
  };

  return {
    db: {
      async transaction<T>(operation: (transaction: unknown) => Promise<T>) {
        transactions += 1;
        return operation(tx);
      },
    } as unknown as Database,
    characterInserts,
    auditInserts,
    updates,
    get profileLookups() {
      return profileLookups;
    },
    get transactions() {
      return transactions;
    },
    get deletes() {
      return deletes;
    },
  };
}

function editableValues() {
  const preset = BUILTIN_CHARACTER_PRESETS[2]!;
  return {
    name: "自定义角色",
    description: "测试角色描述。",
    persona: preset.persona,
    openingLine: "你好。",
    providerProfileId: preset.providerProfileId,
    voiceProfileId: preset.voiceProfileId,
    conversationPolicy: preset.conversationPolicy,
    visualProfile: preset.visualProfile,
  };
}

function actor(
  accountType: UserAccount["accountType"],
  id: string,
): UserAccount {
  return {
    id,
    username: `${accountType}-${id.slice(-2)}`,
    usernameCanonical: `${accountType}-${id.slice(-2)}`,
    displayName: accountType,
    accountType,
    status: "active",
    guardianHistoryAccess: accountType === "child" ? "allowed" : null,
    createdAt: now,
    updatedAt: now,
  };
}

function customCharacter(
  changes: Partial<CharacterRecord> = {},
): CharacterRecord {
  const preset = BUILTIN_CHARACTER_PRESETS[2]!;
  return {
    ...preset,
    id: "c437c71e-f209-4f7d-8f98-1c1e239d4310",
    systemKey: null,
    systemVersion: null,
    ownerUserId: otherAdultId,
    visibility: "private",
    revision: 1,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...changes,
  };
}

function builtinCharacter(
  changes: Partial<CharacterRecord> = {},
): CharacterRecord {
  const preset = BUILTIN_CHARACTER_PRESETS[0]!;
  return {
    ...preset,
    ownerUserId: null,
    visibility: "builtin",
    revision: 1,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...changes,
  };
}

function providerRecord() {
  return { ...DEFAULT_PROVIDER_PROFILE, createdAt: now, updatedAt: now };
}

function voiceRecord() {
  return {
    ...BUILTIN_VOICE_PROFILES[2]!,
    createdAt: now,
    updatedAt: now,
  };
}
