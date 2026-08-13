import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Database } from "./client.js";
import { markModelTestSucceeded } from "./model-settings-operations.js";
import {
  modelConfigurationAuditEvents,
  modelConnections,
  providerProfiles,
  voiceProfiles,
} from "./schema.js";

const actorUserId = "4d1c2e31-ad0e-4fa9-9ae8-ae3497069116";
const profileId = "31c9ad8e-0e8b-4e2d-8c14-318d36d617b1";
const connectionId = "c393d85e-b708-4afa-b057-e34cb8116d5c";
const voiceProfileId = "be8f77ec-a61e-4be0-8b70-8c7cb9e51104";

describe("model settings database operations", () => {
  it("enables every builtin voice after a realtime model test", async () => {
    const updates: Array<{
      table: unknown;
      value: Record<string, unknown>;
    }> = [];
    const audits: Array<Record<string, unknown>> = [];
    const profile = {
      id: profileId,
      connectionId,
      kind: "realtime_voice",
      revision: 3,
    };
    const connection = {
      id: connectionId,
      adapter: "qwen_realtime",
      endpoint: "realtime.example.com",
      apiKey: "test-key",
      pendingEndpoint: null,
      pendingApiKey: null,
      compatibilityPreset: null,
      pendingCompatibilityPreset: null,
      revision: 5,
    };
    const tx = {
      select() {
        return {
          from(table: unknown) {
            const row = table === providerProfiles ? profile : connection;
            return {
              where() {
                return {
                  for() {
                    return { limit: async () => [row] };
                  },
                };
              },
            };
          },
        };
      },
      update(table: unknown) {
        return {
          set(value: Record<string, unknown>) {
            updates.push({ table, value });
            return { where: async () => undefined };
          },
        };
      },
      insert(table: unknown) {
        expect(table).toBe(modelConfigurationAuditEvents);
        return {
          values(value: Record<string, unknown>) {
            audits.push(value);
            return Promise.resolve();
          },
        };
      },
    };
    const db = {
      transaction<T>(operation: (transaction: typeof tx) => Promise<T>) {
        return operation(tx);
      },
    } as unknown as Database;

    await expect(
      markModelTestSucceeded(db, actorUserId, profileId, voiceProfileId),
    ).resolves.toBe("updated");

    const voiceUpdates = updates.filter(
      (update) => update.table === voiceProfiles,
    );
    expect(voiceUpdates).toHaveLength(2);
    expect(voiceUpdates[0]?.value).toMatchObject({
      status: "enabled",
      verifiedAt: expect.any(Date),
    });
    expect(voiceUpdates[1]?.value).toMatchObject({
      status: "enabled",
      verifiedAt: expect.any(Date),
    });
    expect(updates.map((update) => update.table)).toEqual([
      modelConnections,
      providerProfiles,
      voiceProfiles,
      voiceProfiles,
    ]);
    expect(audits).toHaveLength(2);
  });

  it("repairs builtin voices for already verified and enabled realtime models", () => {
    const migrationPath = fileURLToPath(
      new URL(
        "../migrations/0010_enable_verified_builtin_voices.sql",
        import.meta.url,
      ),
    );
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toContain('"voice"."source" = \'builtin\'');
    expect(migration).toContain('"profile"."kind" = \'realtime_voice\'');
    expect(migration).toContain('"profile"."status" = \'enabled\'');
    expect(migration).toContain('"profile"."verified_at" IS NOT NULL');
  });
});
