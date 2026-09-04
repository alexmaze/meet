import { existsSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "drizzle-kit";

const TARGET_OVERRIDING_QUERY_PARAMETERS = new Set([
  "database",
  "dbname",
  "host",
  "hostaddr",
  "options",
  "port",
  "service",
  "user",
]);
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

const teachingSpikeDatabaseUrl =
  process.env.TEACHING_SPIKE_DATABASE_URL?.trim();
if (!teachingSpikeDatabaseUrl) {
  throw new Error(
    "缺少 TEACHING_SPIKE_DATABASE_URL；实时教学 Spike 迁移不会回退到 DATABASE_URL。",
  );
}
const teachingIdentity = parseDatabaseIdentity(teachingSpikeDatabaseUrl);
const applicationDatabaseUrl = process.env.DATABASE_URL?.trim();
if (applicationDatabaseUrl) {
  const applicationIdentity = parseDatabaseIdentity(applicationDatabaseUrl);
  if (
    teachingIdentity.target === applicationIdentity.target ||
    teachingIdentity.databaseName === applicationIdentity.databaseName
  ) {
    throw new Error(
      "TEACHING_SPIKE_DATABASE_URL 必须使用与 DATABASE_URL 不同的数据库名称。",
    );
  }
}

export default defineConfig({
  dialect: "postgresql",
  schema: schemaFile,
  out: migrationsDirectory,
  dbCredentials: {
    url: teachingSpikeDatabaseUrl,
  },
  strict: true,
  verbose: true,
});

function parseDatabaseIdentity(
  connectionString: string,
): Readonly<{ target: string; databaseName: string }> {
  try {
    const url = new URL(connectionString);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      throw new Error();
    }
    if (
      !url.hostname ||
      !url.port ||
      !url.username ||
      url.pathname.length <= 1
    ) {
      throw new Error();
    }
    for (const name of TARGET_OVERRIDING_QUERY_PARAMETERS) {
      if (url.searchParams.has(name)) throw new Error();
    }
    const databaseName = decodeURIComponent(url.pathname.slice(1));
    if (!databaseName) throw new Error();
    return Object.freeze({
      target: [url.hostname.toLowerCase(), url.port, databaseName].join(
        "\u0000",
      ),
      databaseName,
    });
  } catch {
    throw new Error("教学 Spike 数据库 URL 无效；不会尝试其他数据库连接配置。");
  }
}
