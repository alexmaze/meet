import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";

import { createDatabaseClient, type Database } from "./client.js";

export const MIGRATION_ADVISORY_LOCK_KEYS = [
  0x4d45_4554, 0x4d49_4752,
] as const;

export type ApplyDatabaseMigrationsOptions = {
  migrationsFolder?: string;
  migrate?: (
    db: Database,
    config: { migrationsFolder: string },
  ) => Promise<void>;
};

export function resolveMigrationsDirectory(): string {
  return fileURLToPath(new URL("../migrations", import.meta.url));
}

export async function applyDatabaseMigrations(
  db: Database,
  options: ApplyDatabaseMigrationsOptions = {},
): Promise<void> {
  const migrationsFolder =
    options.migrationsFolder ?? resolveMigrationsDirectory();
  const runMigrate = options.migrate ?? migrate;

  await db.execute(
    sql`select pg_advisory_lock(
      ${MIGRATION_ADVISORY_LOCK_KEYS[0]},
      ${MIGRATION_ADVISORY_LOCK_KEYS[1]}
    )`,
  );
  try {
    await runMigrate(db, { migrationsFolder });
  } finally {
    await db.execute(
      sql`select pg_advisory_unlock(
        ${MIGRATION_ADVISORY_LOCK_KEYS[0]},
        ${MIGRATION_ADVISORY_LOCK_KEYS[1]}
      )`,
    );
  }
}

export async function applyDatabaseMigrationsToUrl(
  connectionString: string,
): Promise<void> {
  const client = createDatabaseClient({ connectionString });
  try {
    await applyDatabaseMigrations(client.db);
  } finally {
    await client.close();
  }
}
