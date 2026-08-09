import { existsSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "drizzle-kit";

const rootEnvironmentFile = fileURLToPath(
  new URL("../../.env", import.meta.url),
);
const schemaFile = relative(
  process.cwd(),
  fileURLToPath(new URL("./src/schema.ts", import.meta.url)),
);
const migrationsDirectory = relative(
  process.cwd(),
  fileURLToPath(new URL("./migrations", import.meta.url)),
);

if (existsSync(rootEnvironmentFile)) {
  process.loadEnvFile(rootEnvironmentFile);
}

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "缺少 DATABASE_URL。请在仓库根目录的 .env 中配置 PostgreSQL 连接地址。",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: schemaFile,
  out: migrationsDirectory,
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
});
