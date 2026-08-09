import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;

export type DatabaseClient = {
  db: Database;
  pool: Pool;
  close: () => Promise<void>;
};

export type CreateDatabaseClientOptions = {
  connectionString: string;
  pool?: Omit<PoolConfig, "connectionString">;
};

export function createDatabaseFromPool(pool: Pool): Database {
  return drizzle({ client: pool, schema });
}

export function createDatabaseClient(
  options: CreateDatabaseClientOptions,
): DatabaseClient {
  const pool = new Pool({
    ...options.pool,
    connectionString: options.connectionString,
  });

  return {
    db: createDatabaseFromPool(pool),
    pool,
    close: () => pool.end(),
  };
}
