import { createHash } from "node:crypto";

import {
  createDatabaseClient,
  type CreateDatabaseClientOptions,
  type Database,
} from "@meet/database";

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

export type TeachingSpikeDatabaseEnvironment = Readonly<{
  TEACHING_SPIKE_DATABASE_URL?: string;
  DATABASE_URL?: string;
}>;

export type TeachingSpikeDatabaseScope =
  "isolated_spike" | "application_database";

export type TeachingSpikeDatabaseAccessOptions = Readonly<{
  scope?: TeachingSpikeDatabaseScope;
}>;

export type TeachingSpikeDatabaseAccess = Readonly<{
  db: Database;
  databaseScope: TeachingSpikeDatabaseScope;
  databaseFingerprint: string;
  close: () => Promise<void>;
}>;

export type TeachingSpikeDatabaseConfigurationErrorCode =
  | "TEACHING_SPIKE_DATABASE_URL_REQUIRED"
  | "TEACHING_SPIKE_DATABASE_URL_INVALID"
  | "TEACHING_SPIKE_DATABASE_NOT_ISOLATED"
  | "APPLICATION_DATABASE_URL_REQUIRED"
  | "APPLICATION_DATABASE_URL_INVALID"
  | "TEACHING_SPIKE_DATABASE_CLIENT_INITIALIZATION_FAILED";

export class TeachingSpikeDatabaseConfigurationError extends Error {
  constructor(
    public readonly code: TeachingSpikeDatabaseConfigurationErrorCode,
  ) {
    super(code);
    this.name = "TeachingSpikeDatabaseConfigurationError";
  }
}

type DatabaseClientFactory = (
  options: CreateDatabaseClientOptions,
) => Readonly<{
  db: Database;
  close: () => Promise<void>;
}>;

export function createTeachingSpikeDatabaseAccess(
  environment: TeachingSpikeDatabaseEnvironment,
  options: TeachingSpikeDatabaseAccessOptions = {},
  clientFactory: DatabaseClientFactory = createDatabaseClient,
): TeachingSpikeDatabaseAccess {
  const databaseScope = options.scope ?? "isolated_spike";
  const connectionString =
    databaseScope === "application_database"
      ? environment.DATABASE_URL?.trim()
      : environment.TEACHING_SPIKE_DATABASE_URL?.trim();
  if (!connectionString) {
    throw configurationError(
      databaseScope === "application_database"
        ? "APPLICATION_DATABASE_URL_REQUIRED"
        : "TEACHING_SPIKE_DATABASE_URL_REQUIRED",
    );
  }

  const selectedIdentity = parseDatabaseIdentity(
    connectionString,
    databaseScope === "application_database"
      ? "APPLICATION_DATABASE_URL_INVALID"
      : "TEACHING_SPIKE_DATABASE_URL_INVALID",
  );
  const applicationConnectionString =
    databaseScope === "isolated_spike"
      ? environment.DATABASE_URL?.trim()
      : undefined;
  if (databaseScope === "isolated_spike" && applicationConnectionString) {
    const applicationIdentity = parseDatabaseIdentity(
      applicationConnectionString,
      "APPLICATION_DATABASE_URL_INVALID",
    );
    if (
      selectedIdentity.database === applicationIdentity.database ||
      selectedIdentity.databaseName === applicationIdentity.databaseName
    ) {
      throw configurationError("TEACHING_SPIKE_DATABASE_NOT_ISOLATED");
    }
  }

  try {
    const client = clientFactory({ connectionString });
    return Object.freeze({
      db: client.db,
      databaseScope,
      databaseFingerprint: fingerprintDatabaseIdentity(
        selectedIdentity,
        databaseScope,
      ),
      close: client.close,
    });
  } catch {
    throw configurationError(
      "TEACHING_SPIKE_DATABASE_CLIENT_INITIALIZATION_FAILED",
    );
  }
}

function parseDatabaseIdentity(
  connectionString: string,
  invalidCode:
    "TEACHING_SPIKE_DATABASE_URL_INVALID" | "APPLICATION_DATABASE_URL_INVALID",
): Readonly<{
  database: string;
  databaseName: string;
  principal: string;
}> {
  try {
    const url = new URL(connectionString);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      throw configurationError(invalidCode);
    }
    if (
      !url.hostname ||
      !url.port ||
      !url.username ||
      url.pathname.length <= 1
    ) {
      throw configurationError(invalidCode);
    }
    for (const name of TARGET_OVERRIDING_QUERY_PARAMETERS) {
      if (url.searchParams.has(name)) {
        throw configurationError(invalidCode);
      }
    }

    const databaseName = decodeURIComponent(url.pathname.slice(1));
    if (!databaseName) throw configurationError(invalidCode);
    return Object.freeze({
      database: [url.hostname.toLowerCase(), url.port, databaseName].join(
        "\u0000",
      ),
      databaseName,
      principal: decodeURIComponent(url.username),
    });
  } catch (error) {
    if (error instanceof TeachingSpikeDatabaseConfigurationError) throw error;
    throw configurationError(invalidCode);
  }
}

function fingerprintDatabaseIdentity(
  identity: Readonly<{
    database: string;
    databaseName: string;
    principal: string;
  }>,
  scope: TeachingSpikeDatabaseScope,
): string {
  return createHash("sha256")
    .update("meet-teaching-spike-database-v2\u0000")
    .update(scope)
    .update("\u0000")
    .update(identity.database)
    .update("\u0000")
    .update(identity.principal)
    .digest("hex");
}

function configurationError(
  code: TeachingSpikeDatabaseConfigurationErrorCode,
): TeachingSpikeDatabaseConfigurationError {
  return new TeachingSpikeDatabaseConfigurationError(code);
}
