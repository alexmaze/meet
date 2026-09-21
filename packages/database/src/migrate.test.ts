import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Database } from "./client.js";
import {
  applyDatabaseMigrations,
  resolveMigrationsDirectory,
} from "./migrate.js";

describe("database migrations", () => {
  it("resolves the packaged Drizzle journal next to compiled output", () => {
    const directory = resolveMigrationsDirectory();
    expect(existsSync(join(directory, "meta/_journal.json"))).toBe(true);
    expect(existsSync(join(directory, "0000_account_foundation.sql"))).toBe(
      true,
    );
  });

  it("holds an advisory lock around migrate and always unlocks", async () => {
    const events: string[] = [];
    const db = {
      async execute() {
        events.push(events.length === 0 ? "lock" : "unlock");
      },
    } as unknown as Database;

    await applyDatabaseMigrations(db, {
      migrationsFolder: "/tmp/meet-migrations",
      migrate: async (_database, config) => {
        events.push(`migrate:${config.migrationsFolder}`);
      },
    });

    expect(events).toEqual(["lock", "migrate:/tmp/meet-migrations", "unlock"]);
  });

  it("unlocks when migrate fails", async () => {
    const events: string[] = [];
    const db = {
      async execute() {
        events.push(events.length === 0 ? "lock" : "unlock");
      },
    } as unknown as Database;

    await expect(
      applyDatabaseMigrations(db, {
        migrate: async () => {
          events.push("migrate");
          throw new Error("migration failed");
        },
      }),
    ).rejects.toThrow(/migration failed/);

    expect(events).toEqual(["lock", "migrate", "unlock"]);
  });
});
