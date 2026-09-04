import { readFile } from "node:fs/promises";

import {
  modelConnections,
  providerProfiles,
  teachingSpikeLiveAuthorizations,
  type Database,
  voiceProfiles,
} from "@meet/database";
import { describe, expect, it, vi } from "vitest";

import {
  auditTeachingSpikeDatabaseIsolation,
  consumeTeachingSpikeLiveAuthorization,
  createTeachingSpikeLivePersistenceDependencies,
  finalizeTeachingSpikeLiveEvidenceReport,
  loadTeachingSpikeLiveAuthorizationPlan,
  preregisterTeachingSpikeLiveAuthorization,
  resolveTeachingSpikeLiveTargetMetadata,
  type TeachingSpikeLivePersistenceError,
  withTeachingSpikeLiveTarget,
} from "../src/spikes/realtime-teaching/live-authorization-persistence.js";
import {
  authorizeTeachingSpikeLiveExecution,
  buildTeachingSpikeLiveAuthorizationPlan,
  type TeachingSpikeLiveAuthorizationRequest,
  type TeachingSpikeLiveTarget,
} from "../src/spikes/realtime-teaching/live-authorization.js";
import { qwenTeachingLiveWebSocketEndpointFingerprint } from "../src/spikes/realtime-teaching/qwen-live-composition.js";
import {
  createTeachingSpikeDatabaseAccess,
  type TeachingSpikeDatabaseAccess,
  type TeachingSpikeDatabaseConfigurationError,
} from "../src/spikes/realtime-teaching/teaching-spike-database.js";
import {
  TEACHING_SPIKE_FIXTURE_HASH,
  TEACHING_SPIKE_FIXTURE_REVISION,
  TEACHING_SPIKE_USER_TEXT_HASH,
} from "../src/spikes/realtime-teaching/fixtures.js";
import {
  buildRealtimeTeachingLiveEvidenceReport,
  buildRealtimeTeachingLiveFailureEvidenceReport,
} from "../src/spikes/realtime-teaching/live-evidence-report.js";
import { estimateQwenTeachingSpikeUsageCostCny } from "../src/spikes/realtime-teaching/pricing.js";

const runId = "70000000-0000-4000-8000-000000000007";
const issuedAtMs = 1_786_656_000_000;
const expiresAtMs = issuedAtMs + 10 * 60 * 1_000;
const providerEndpoint = "workspace.cn-beijing.maas.aliyuncs.com";
const providerApiKey = "provider-secret-that-must-not-leak";
const pricing = {
  priceSnapshotHash: "9".repeat(64),
  estimatedMaxCostCny: 0.75,
};
const spikeDatabaseUrl =
  "postgresql://spike:database-secret@127.0.0.1:5432/meet_teaching_spike";
const applicationDatabaseUrl =
  "postgresql://meet:application-secret@127.0.0.1:5432/meet";

type AuthorizationRow = {
  runId: string;
  planHash: string;
  planJson: unknown;
  expiresAt: Date;
  consumedAt: Date | null;
  reportHash?: string | null;
  reportJson?: unknown | null;
  finishedAt?: Date | null;
};

type ActiveTargetRow = {
  provider: "qwen" | "doubao";
  model: string;
  modelProfileId: string;
  modelProfileRevision: number;
  modelProfileStatus: string;
  modelProfileVerifiedAt: Date | null;
  connectionId: string;
  connectionRevision: number;
  connectionAdapter: string;
  connectionStatus: string;
  connectionVerifiedAt: Date | null;
  endpoint: string | null;
  voiceProfileId: string;
  voiceProfileRevision: number;
  voiceProfileStatus: string;
  voiceProfileVerifiedAt: Date | null;
  voice: string;
};

function createFakeDatabase(input: {
  databaseNowMs?: () => number;
  authorization?: AuthorizationRow;
  activeTarget?: ActiveTargetRow;
  apiKey?: string | null;
  accounts?: Array<{ accountType: string; status: string }>;
  businessRowCount?: number;
}) {
  let authorization = input.authorization
    ? {
        ...input.authorization,
        reportHash: input.authorization.reportHash ?? null,
        reportJson: input.authorization.reportJson ?? null,
        finishedAt: input.authorization.finishedAt ?? null,
      }
    : undefined;
  let transactionQueue = Promise.resolve();
  const events: string[] = [];
  let targetReads = 0;
  let credentialReads = 0;

  function recordTableRead(table: unknown) {
    if (
      table !== teachingSpikeLiveAuthorizations &&
      table !== providerProfiles &&
      table !== modelConnections &&
      table !== voiceProfiles
    ) {
      events.push("private_business_read");
    }
  }

  function selectedRows(selection: Record<string, unknown>, table: unknown) {
    if (
      Object.hasOwn(selection, "accountType") &&
      Object.hasOwn(selection, "status")
    ) {
      events.push("private_business_read");
      return input.accounts ?? [{ accountType: "admin", status: "active" }];
    }
    if (Object.hasOwn(selection, "value")) {
      events.push("private_business_read");
      return [{ value: input.businessRowCount ?? 0 }];
    }
    if (table === teachingSpikeLiveAuthorizations) {
      events.push("authorization_read");
      return authorization
        ? [
            Object.fromEntries(
              Object.keys(selection).map((key) => [
                key,
                authorization?.[key as keyof AuthorizationRow],
              ]),
            ),
          ]
        : [];
    }
    if (table === providerProfiles) {
      events.push("target_read");
      targetReads += 1;
      return input.activeTarget ? [{ ...input.activeTarget }] : [];
    }
    if (table === modelConnections) {
      events.push("credential_read");
      credentialReads += 1;
      return input.apiKey === undefined ? [] : [{ apiKey: input.apiKey }];
    }
    return [];
  }

  function select(selection: Record<string, unknown>) {
    if (Object.hasOwn(selection, "databaseNow")) {
      events.push("database_clock_read");
      return Promise.resolve([
        {
          databaseNow: new Date(input.databaseNowMs?.() ?? issuedAtMs + 1_000),
        },
      ]);
    }

    let selectedTable: unknown;
    const builder = {
      from(table: unknown) {
        selectedTable = table;
        recordTableRead(table);
        return builder;
      },
      innerJoin(table: unknown) {
        recordTableRead(table);
        return builder;
      },
      where() {
        return builder;
      },
      for() {
        return builder;
      },
      limit() {
        return Promise.resolve(selectedRows(selection, selectedTable));
      },
    };
    return builder;
  }

  function execute() {
    events.push("database_clock_read");
    return Promise.resolve({
      rows: [
        {
          databaseNowMs: String(input.databaseNowMs?.() ?? issuedAtMs + 1_000),
        },
      ],
    });
  }

  const transaction = {
    select,
    execute,
    update(table: unknown) {
      expect(table).toBe(teachingSpikeLiveAuthorizations);
      let update: {
        consumedAt?: Date;
        reportHash?: string;
        reportJson?: unknown;
        finishedAt?: Date;
      } = {};
      const builder = {
        set(value: typeof update) {
          update = value;
          return builder;
        },
        where() {
          return builder;
        },
        returning() {
          if (!authorization) {
            return Promise.resolve([]);
          }
          if (Object.hasOwn(update, "consumedAt")) {
            if (authorization.consumedAt) return Promise.resolve([]);
            events.push("authorization_consumed");
            authorization = {
              ...authorization,
              consumedAt: update.consumedAt ?? null,
            };
          } else {
            if (
              !authorization.consumedAt ||
              authorization.reportHash !== null
            ) {
              return Promise.resolve([]);
            }
            events.push("evidence_finalized");
            authorization = { ...authorization, ...update };
          }
          return Promise.resolve([{ runId: authorization.runId }]);
        },
      };
      return builder;
    },
  };

  const db = {
    select,
    execute,
    insert(table: unknown) {
      expect(table).toBe(teachingSpikeLiveAuthorizations);
      let value: {
        runId: string;
        planHash: string;
        planJson: unknown;
        expiresAt: Date;
      };
      const builder = {
        values(next: typeof value) {
          value = next;
          return builder;
        },
        onConflictDoNothing() {
          return builder;
        },
        returning() {
          if (authorization) return Promise.resolve([]);
          authorization = {
            ...value,
            consumedAt: null,
            reportHash: null,
            reportJson: null,
            finishedAt: null,
          };
          return Promise.resolve([{ runId: value.runId }]);
        },
      };
      return builder;
    },
    transaction<Result>(
      operation: (tx: typeof transaction) => Promise<Result>,
    ): Promise<Result> {
      const result = transactionQueue.then(() => operation(transaction));
      transactionQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  } as unknown as Database;

  return {
    db,
    events,
    getAuthorization: () => authorization,
    getTargetReads: () => targetReads,
    getCredentialReads: () => credentialReads,
  };
}

function createAccess(db: Database): TeachingSpikeDatabaseAccess {
  return createTeachingSpikeDatabaseAccess(
    {
      TEACHING_SPIKE_DATABASE_URL: spikeDatabaseUrl,
      DATABASE_URL: applicationDatabaseUrl,
    },
    {},
    () => ({ db, close: async () => undefined }),
  );
}

function createApplicationAccess(db: Database): TeachingSpikeDatabaseAccess {
  return createTeachingSpikeDatabaseAccess(
    { DATABASE_URL: applicationDatabaseUrl },
    { scope: "application_database" },
    () => ({ db, close: async () => undefined }),
  );
}

function claimFor(planHash = "a".repeat(64)) {
  return { runId, planHash, expiresAtMs } as const;
}

function validPlanAndClaim() {
  const seed = createFakeDatabase({});
  const plan = requestFor(targetFor(createAccess(seed.db))).plan;
  return {
    plan,
    claim: {
      runId: plan.runId,
      planHash: plan.planHash,
      expiresAtMs: plan.expiresAtMs,
    },
  };
}

function activeQwenTarget(): ActiveTargetRow {
  return {
    provider: "qwen",
    model: "qwen-audio-3.0-realtime-plus",
    modelProfileId: "10000000-0000-4000-8000-000000000001",
    modelProfileRevision: 7,
    modelProfileStatus: "enabled",
    modelProfileVerifiedAt: new Date(issuedAtMs - 10_000),
    connectionId: "20000000-0000-4000-8000-000000000002",
    connectionRevision: 11,
    connectionAdapter: "qwen_realtime",
    connectionStatus: "enabled",
    connectionVerifiedAt: new Date(issuedAtMs - 10_000),
    endpoint: providerEndpoint,
    voiceProfileId: "30000000-0000-4000-8000-000000000003",
    voiceProfileRevision: 5,
    voiceProfileStatus: "enabled",
    voiceProfileVerifiedAt: new Date(issuedAtMs - 10_000),
    voice: "longanqian",
  };
}

function targetFor(
  access: TeachingSpikeDatabaseAccess,
  active = activeQwenTarget(),
): TeachingSpikeLiveTarget {
  return {
    provider: active.provider,
    modelId: active.model,
    voiceId: active.voice,
    modelProfileId: active.modelProfileId,
    modelProfileRevision: active.modelProfileRevision,
    connectionId: active.connectionId,
    connectionRevision: active.connectionRevision,
    voiceProfileId: active.voiceProfileId,
    voiceProfileRevision: active.voiceProfileRevision,
    endpointFingerprint: qwenTeachingLiveWebSocketEndpointFingerprint(
      active.endpoint ?? "",
      active.model,
    ),
    databaseScope: access.databaseScope,
    databaseFingerprint: access.databaseFingerprint,
  };
}

function requestFor(
  target: TeachingSpikeLiveTarget,
): TeachingSpikeLiveAuthorizationRequest {
  const plan = buildTeachingSpikeLiveAuthorizationPlan({
    target,
    budgetCny: 1,
    pricing,
    inputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
    runId,
    issuedAtMs,
    expiresAtMs,
  });
  return {
    live: true,
    execute: true,
    interactive: true,
    provider: target.provider,
    ackPlanHash: plan.planHash,
    plan,
    currentTarget: target,
    currentInputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
    currentPricing: pricing,
  };
}

function failureReportFor(
  request: TeachingSpikeLiveAuthorizationRequest,
  errorCode: "TRANSPORT_FAILED" | "PROTOCOL_SEQUENCE_FAILED",
) {
  const authorization = authorizeTeachingSpikeLiveExecution(request, {
    readServerTimeMs: () => issuedAtMs + 1_000,
  });
  return buildRealtimeTeachingLiveFailureEvidenceReport({
    authorization,
    priceSnapshotHash: request.plan.pricing.priceSnapshotHash,
    errorCode,
    transportAttempted: false,
    progress: { available: false },
  });
}

function providerErrorReportFor(
  request: TeachingSpikeLiveAuthorizationRequest,
) {
  const authorization = authorizeTeachingSpikeLiveExecution(request, {
    readServerTimeMs: () => issuedAtMs + 1_000,
  });
  return buildRealtimeTeachingLiveFailureEvidenceReport({
    authorization,
    priceSnapshotHash: request.plan.pricing.priceSnapshotHash,
    errorCode: "PROTOCOL_SEQUENCE_FAILED",
    transportAttempted: true,
    progress: { available: false },
    diagnostic: {
      available: true,
      source: "qwen_live_adapter",
      checkpoint: "d01t_case",
      adapterErrorCode: "PROVIDER_ERROR",
      providerError: {
        available: true,
        typeCategory: "invalid_request",
        codeCategory: "invalid_value",
        paramCategory: "response_create",
      },
      markerAssertion: { available: false },
    },
  });
}

function completedReportFor(request: TeachingSpikeLiveAuthorizationRequest) {
  const authorization = authorizeTeachingSpikeLiveExecution(request, {
    readServerTimeMs: () => issuedAtMs + 1_000,
  });
  const usage = {
    totalTokens: 48,
    inputTokens: 30,
    outputTokens: 18,
    inputTextTokens: 30,
    inputAudioTokens: 0,
    outputTextTokens: 18,
    outputAudioTokens: 0,
  } as const;
  return buildRealtimeTeachingLiveEvidenceReport({
    authorization,
    priceSnapshotHash: request.plan.pricing.priceSnapshotHash,
    usage: {
      inputAudioMs: 0,
      outputAudioMs: 0,
      estimatedCostCny: estimateQwenTeachingSpikeUsageCostCny(usage),
    },
    protocolResult: {
      schemaVersion: 3,
      provider: "qwen",
      inputMode: "text",
      fixtureRevision: TEACHING_SPIKE_FIXTURE_REVISION,
      fixtureHash: TEACHING_SPIKE_FIXTURE_HASH,
      inputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
      scope: {
        transport: "isolated_provider_websocket",
        relayExercised: false,
        browserExercised: false,
      },
      providerEvidence: false,
      upstreamSessions: 2,
      responseAttempts: 3,
      instructionAcks: { total: 5, echoedMatch: 2, omitted: 3 },
      usage,
      cases: [
        {
          id: "D01T",
          status: "protocol_sequence_completed",
          expectedMarkerCount: 1,
          forbiddenMarkerCount: 0,
        },
        {
          id: "D02T",
          status: "protocol_sequence_completed",
          expectedMarkerCount: 1,
          forbiddenMarkerCount: 0,
        },
        {
          id: "D03T",
          status: "protocol_sequence_completed",
          expectedMarkerCount: 1,
          forbiddenMarkerCount: 0,
        },
      ],
    },
  });
}

describe("teaching spike database isolation", () => {
  it("never falls back to DATABASE_URL", () => {
    const factory = vi.fn();
    expect(() =>
      createTeachingSpikeDatabaseAccess(
        { DATABASE_URL: applicationDatabaseUrl },
        {},
        factory,
      ),
    ).toThrowError(
      expect.objectContaining<TeachingSpikeDatabaseConfigurationError>({
        code: "TEACHING_SPIKE_DATABASE_URL_REQUIRED",
      }),
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects the ordinary application database even with different credentials", () => {
    const factory = vi.fn();
    expect(() =>
      createTeachingSpikeDatabaseAccess(
        {
          TEACHING_SPIKE_DATABASE_URL:
            "postgresql://other:other@127.0.0.1:5432/meet?sslmode=require",
          DATABASE_URL: applicationDatabaseUrl,
        },
        {},
        factory,
      ),
    ).toThrowError(
      expect.objectContaining<TeachingSpikeDatabaseConfigurationError>({
        code: "TEACHING_SPIKE_DATABASE_NOT_ISOLATED",
      }),
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it("treats percent-encoded database names as the same application target", () => {
    const factory = vi.fn();
    expect(() =>
      createTeachingSpikeDatabaseAccess(
        {
          TEACHING_SPIKE_DATABASE_URL:
            "postgresql://other:other@127.0.0.1:5432/%6deet",
          DATABASE_URL: applicationDatabaseUrl,
        },
        {},
        factory,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "TEACHING_SPIKE_DATABASE_NOT_ISOLATED" }),
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it("fails closed when a host alias still uses the application database name", () => {
    const factory = vi.fn();
    expect(() =>
      createTeachingSpikeDatabaseAccess(
        {
          TEACHING_SPIKE_DATABASE_URL:
            "postgresql://other:other@localhost:5432/meet",
          DATABASE_URL: applicationDatabaseUrl,
        },
        {},
        factory,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "TEACHING_SPIKE_DATABASE_NOT_ISOLATED" }),
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it("passes only the explicit spike URL to the client and returns no pool", () => {
    const fake = createFakeDatabase({});
    const close = vi.fn(async () => undefined);
    const factory = vi.fn(() => ({ db: fake.db, close }));
    const access = createTeachingSpikeDatabaseAccess(
      {
        TEACHING_SPIKE_DATABASE_URL: spikeDatabaseUrl,
        DATABASE_URL: applicationDatabaseUrl,
      },
      {},
      factory,
    );

    expect(factory).toHaveBeenCalledExactlyOnceWith({
      connectionString: spikeDatabaseUrl,
    });
    expect(access).toEqual({
      db: fake.db,
      databaseScope: "isolated_spike",
      databaseFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      close,
    });
    expect(access).not.toHaveProperty("pool");
  });

  it("uses DATABASE_URL only after the caller explicitly selects application mode", () => {
    const fake = createFakeDatabase({ businessRowCount: 42 });
    const close = vi.fn(async () => undefined);
    const factory = vi.fn(() => ({ db: fake.db, close }));
    const access = createTeachingSpikeDatabaseAccess(
      { DATABASE_URL: applicationDatabaseUrl },
      { scope: "application_database" },
      factory,
    );

    expect(factory).toHaveBeenCalledExactlyOnceWith({
      connectionString: applicationDatabaseUrl,
    });
    expect(access.databaseScope).toBe("application_database");
    expect(access.databaseFingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("does not silently use DATABASE_URL without the application mode", () => {
    const factory = vi.fn();
    expect(() =>
      createTeachingSpikeDatabaseAccess(
        { DATABASE_URL: applicationDatabaseUrl },
        {},
        factory,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "TEACHING_SPIKE_DATABASE_URL_REQUIRED" }),
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it("binds database scope and connection principal into the fingerprint", () => {
    const fake = createFakeDatabase({});
    const isolated = createTeachingSpikeDatabaseAccess(
      { TEACHING_SPIKE_DATABASE_URL: applicationDatabaseUrl },
      {},
      () => ({ db: fake.db, close: async () => undefined }),
    );
    const application = createApplicationAccess(fake.db);
    const anotherPrincipal = createTeachingSpikeDatabaseAccess(
      {
        DATABASE_URL:
          "postgresql://other:application-secret@127.0.0.1:5432/meet",
      },
      { scope: "application_database" },
      () => ({ db: fake.db, close: async () => undefined }),
    );

    expect(isolated.databaseFingerprint).not.toBe(
      application.databaseFingerprint,
    );
    expect(anotherPrincipal.databaseFingerprint).not.toBe(
      application.databaseFingerprint,
    );
  });

  it("keeps connection secrets out of configuration errors", () => {
    const secret = "should-never-appear";
    let caught: unknown;
    try {
      createTeachingSpikeDatabaseAccess(
        {
          TEACHING_SPIKE_DATABASE_URL: `not-a-url:${secret}`,
        },
        {},
        vi.fn(),
      );
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).not.toContain(secret);
  });

  it.each([
    "postgresql://spike:secret@127.0.0.1:5432/meet_spike?user=other",
    "postgresql://127.0.0.1:5432/meet_spike",
    "postgresql://spike:secret@127.0.0.1/meet_spike",
  ])(
    "rejects a connection whose actual principal is not bound in the authority",
    (url) => {
      const factory = vi.fn();
      expect(() =>
        createTeachingSpikeDatabaseAccess(
          { TEACHING_SPIKE_DATABASE_URL: url },
          {},
          factory,
        ),
      ).toThrowError(
        expect.objectContaining({
          code: "TEACHING_SPIKE_DATABASE_URL_INVALID",
        }),
      );
      expect(factory).not.toHaveBeenCalled();
    },
  );
});

describe("teaching spike data isolation audit", () => {
  it("allows only one active admin and empty business-data tables", async () => {
    const fake = createFakeDatabase({});
    await expect(
      auditTeachingSpikeDatabaseIsolation(createAccess(fake.db)),
    ).resolves.toEqual({ status: "isolated" });
  });

  it("does not inspect private business tables in explicit application mode", async () => {
    const fake = createFakeDatabase({
      accounts: [
        { accountType: "admin", status: "active" },
        { accountType: "child", status: "active" },
      ],
      businessRowCount: 42,
    });
    await expect(
      auditTeachingSpikeDatabaseIsolation(createApplicationAccess(fake.db)),
    ).resolves.toEqual({
      status: "application_database_explicitly_selected",
    });
    expect(fake.events).not.toContain("private_business_read");
  });

  it("resolves only exact model metadata in application mode without reading credentials or private tables", async () => {
    const fake = createFakeDatabase({
      activeTarget: activeQwenTarget(),
      apiKey: providerApiKey,
      businessRowCount: 42,
    });
    const access = createApplicationAccess(fake.db);
    await expect(
      resolveTeachingSpikeLiveTargetMetadata(access, {
        provider: "qwen",
        modelProfileId: activeQwenTarget().modelProfileId,
        modelProfileRevision: activeQwenTarget().modelProfileRevision,
        modelId: activeQwenTarget().model,
        connectionId: activeQwenTarget().connectionId,
        connectionRevision: activeQwenTarget().connectionRevision,
        voiceProfileId: activeQwenTarget().voiceProfileId,
        voiceProfileRevision: activeQwenTarget().voiceProfileRevision,
        voiceId: activeQwenTarget().voice,
      }),
    ).resolves.toMatchObject({ databaseScope: "application_database" });
    expect(fake.events).not.toContain("private_business_read");
    expect(fake.getCredentialReads()).toBe(0);
  });

  it("keeps the complete application-database flow on the target configuration and authorization allowlists", async () => {
    const fake = createFakeDatabase({
      activeTarget: activeQwenTarget(),
      apiKey: providerApiKey,
      businessRowCount: 42,
    });
    const access = createApplicationAccess(fake.db);
    const selector = activeQwenTarget();
    const target = await resolveTeachingSpikeLiveTargetMetadata(access, {
      provider: "qwen",
      modelProfileId: selector.modelProfileId,
      modelProfileRevision: selector.modelProfileRevision,
      modelId: selector.model,
      connectionId: selector.connectionId,
      connectionRevision: selector.connectionRevision,
      voiceProfileId: selector.voiceProfileId,
      voiceProfileRevision: selector.voiceProfileRevision,
      voiceId: selector.voice,
    });
    const request = requestFor(target);

    await expect(
      preregisterTeachingSpikeLiveAuthorization(access, request.plan),
    ).resolves.toBe("registered");
    await expect(
      loadTeachingSpikeLiveAuthorizationPlan(access, {
        runId: request.plan.runId,
        planHash: request.plan.planHash,
      }),
    ).resolves.toMatchObject({ status: "loaded" });
    expect(fake.getCredentialReads()).toBe(0);
    await expect(
      consumeTeachingSpikeLiveAuthorization(access, {
        runId: request.plan.runId,
        planHash: request.plan.planHash,
        expiresAtMs: request.plan.expiresAtMs,
      }),
    ).resolves.toBe("consumed");
    const authorization = authorizeTeachingSpikeLiveExecution(request, {
      readServerTimeMs: () => issuedAtMs + 1_000,
    });
    await expect(
      createTeachingSpikeLivePersistenceDependencies(access).resolveRuntime(
        authorization,
      ),
    ).resolves.toMatchObject({ apiKey: providerApiKey });
    await expect(
      finalizeTeachingSpikeLiveEvidenceReport(
        access,
        failureReportFor(request, "TRANSPORT_FAILED"),
      ),
    ).resolves.toMatchObject({ status: "finalized" });

    expect(fake.getCredentialReads()).toBe(1);
    expect(fake.events).not.toContain("private_business_read");
  });

  it.each([
    [[], 0],
    [[{ accountType: "child", status: "active" }], 0],
    [[{ accountType: "adult", status: "active" }], 0],
    [[{ accountType: "admin", status: "disabled" }], 0],
    [
      [
        { accountType: "admin", status: "active" },
        { accountType: "admin", status: "active" },
      ],
      0,
    ],
    [[{ accountType: "admin", status: "active" }], 1],
  ])(
    "fails closed for accounts=%j and business count=%i",
    async (accounts, businessRowCount) => {
      const fake = createFakeDatabase({ accounts, businessRowCount });
      await expect(
        auditTeachingSpikeDatabaseIsolation(createAccess(fake.db)),
      ).rejects.toMatchObject({ code: "DATABASE_ISOLATION_VIOLATION" });
    },
  );

  it("blocks registration before writing when business data is present", async () => {
    const fake = createFakeDatabase({ businessRowCount: 1 });
    const access = createAccess(fake.db);
    const plan = requestFor(targetFor(access)).plan;
    await expect(
      preregisterTeachingSpikeLiveAuthorization(access, plan),
    ).rejects.toMatchObject({ code: "DATABASE_ISOLATION_VIOLATION" });
    expect(fake.getAuthorization()).toBeUndefined();
  });

  it("blocks target metadata reads when business data is present", async () => {
    const active = activeQwenTarget();
    const fake = createFakeDatabase({
      businessRowCount: 1,
      activeTarget: active,
      apiKey: providerApiKey,
    });
    const access = createAccess(fake.db);
    await expect(
      resolveTeachingSpikeLiveTargetMetadata(access, {
        provider: "qwen",
        modelProfileId: active.modelProfileId,
        modelProfileRevision: active.modelProfileRevision,
        modelId: active.model,
        connectionId: active.connectionId,
        connectionRevision: active.connectionRevision,
        voiceProfileId: active.voiceProfileId,
        voiceProfileRevision: active.voiceProfileRevision,
        voiceId: active.voice,
      }),
    ).rejects.toMatchObject({ code: "DATABASE_ISOLATION_VIOLATION" });
    expect(fake.getTargetReads()).toBe(0);
    expect(fake.getCredentialReads()).toBe(0);
  });
});

describe("persistent teaching spike live authorization", () => {
  it("preregisters without overwriting an existing claim", async () => {
    const fake = createFakeDatabase({});
    const access = createAccess(fake.db);
    const plan = requestFor(targetFor(access)).plan;
    const conflictingPlan = buildTeachingSpikeLiveAuthorizationPlan({
      target: plan.target,
      budgetCny: 0.9,
      pricing,
      inputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
      runId: plan.runId,
      issuedAtMs: plan.issuedAtMs,
      expiresAtMs: plan.expiresAtMs,
    });

    await expect(
      preregisterTeachingSpikeLiveAuthorization(access, plan),
    ).resolves.toBe("registered");
    await expect(
      preregisterTeachingSpikeLiveAuthorization(access, plan),
    ).resolves.toBe("already_registered");
    await expect(
      preregisterTeachingSpikeLiveAuthorization(access, conflictingPlan),
    ).resolves.toBe("registration_conflict");
    expect(fake.getAuthorization()).toMatchObject({
      runId: plan.runId,
      planHash: plan.planHash,
      planJson: plan,
      expiresAt: new Date(plan.expiresAtMs),
    });
  });

  it("loads the exact strict unconsumed plan persisted by preflight", async () => {
    const fake = createFakeDatabase({});
    const access = createAccess(fake.db);
    const plan = requestFor(targetFor(access)).plan;
    await preregisterTeachingSpikeLiveAuthorization(access, plan);

    await expect(
      loadTeachingSpikeLiveAuthorizationPlan(access, {
        runId: plan.runId,
        planHash: plan.planHash,
      }),
    ).resolves.toEqual({ status: "loaded", plan });
    await expect(
      loadTeachingSpikeLiveAuthorizationPlan(access, {
        runId: plan.runId,
        planHash: "f".repeat(64),
      }),
    ).resolves.toEqual({ status: "claim_mismatch" });

    await consumeTeachingSpikeLiveAuthorization(access, {
      runId: plan.runId,
      planHash: plan.planHash,
      expiresAtMs: plan.expiresAtMs,
    });
    await expect(
      loadTeachingSpikeLiveAuthorizationPlan(access, {
        runId: plan.runId,
        planHash: plan.planHash,
      }),
    ).resolves.toEqual({ status: "already_consumed" });
  });

  it("rejects a corrupted stored plan and a plan outside the database-clock window", async () => {
    const baseline = createFakeDatabase({});
    const access = createAccess(baseline.db);
    const plan = requestFor(targetFor(access)).plan;
    const corrupt = createFakeDatabase({
      authorization: {
        runId: plan.runId,
        planHash: plan.planHash,
        planJson: { ...plan, runnerRevision: "tampered" },
        expiresAt: new Date(plan.expiresAtMs),
        consumedAt: null,
      },
    });
    await expect(
      loadTeachingSpikeLiveAuthorizationPlan(createAccess(corrupt.db), {
        runId: plan.runId,
        planHash: plan.planHash,
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_STORE_UNAVAILABLE" });

    const future = createFakeDatabase({
      databaseNowMs: () => plan.issuedAtMs - 1,
    });
    await expect(
      preregisterTeachingSpikeLiveAuthorization(createAccess(future.db), plan),
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_REGISTRATION_NOT_CURRENT",
    });
    expect(future.getAuthorization()).toBeUndefined();
  });

  it("atomically lets only one concurrent claimant consume a run", async () => {
    const { claim, plan } = validPlanAndClaim();
    const fake = createFakeDatabase({
      authorization: {
        runId: claim.runId,
        planHash: claim.planHash,
        planJson: plan,
        expiresAt: new Date(claim.expiresAtMs),
        consumedAt: null,
      },
    });
    const access = createAccess(fake.db);

    const results = await Promise.all([
      consumeTeachingSpikeLiveAuthorization(access, claim),
      consumeTeachingSpikeLiveAuthorization(access, claim),
    ]);

    expect(results.sort()).toEqual(["already_consumed", "consumed"]);
    expect(
      fake.events.filter((event) => event === "authorization_consumed"),
    ).toHaveLength(1);
  });

  it("uses the database clock and returns every safe refusal status", async () => {
    const { claim, plan } = validPlanAndClaim();
    const expired = createFakeDatabase({
      databaseNowMs: () => claim.expiresAtMs,
      authorization: {
        runId: claim.runId,
        planHash: claim.planHash,
        planJson: plan,
        expiresAt: new Date(claim.expiresAtMs),
        consumedAt: null,
      },
    });
    await expect(
      consumeTeachingSpikeLiveAuthorization(createAccess(expired.db), claim),
    ).resolves.toBe("expired");

    const mismatch = createFakeDatabase({
      authorization: {
        runId: claim.runId,
        planHash: claim.planHash,
        planJson: plan,
        expiresAt: new Date(claim.expiresAtMs),
        consumedAt: null,
      },
    });
    await expect(
      consumeTeachingSpikeLiveAuthorization(createAccess(mismatch.db), {
        ...claim,
        expiresAtMs: claim.expiresAtMs - 1,
      }),
    ).resolves.toBe("claim_mismatch");
    await expect(
      consumeTeachingSpikeLiveAuthorization(createAccess(mismatch.db), {
        ...claim,
        planHash: "not-a-hash",
      }),
    ).resolves.toBe("claim_mismatch");
  });

  it("finalizes exactly one allowlisted report for a consumed run", async () => {
    const baseline = createFakeDatabase({});
    const access = createAccess(baseline.db);
    const request = requestFor(targetFor(access));
    const consumedAt = new Date(issuedAtMs + 1_000);
    const fake = createFakeDatabase({
      databaseNowMs: () => issuedAtMs + 2_000,
      authorization: {
        runId: request.plan.runId,
        planHash: request.plan.planHash,
        planJson: request.plan,
        expiresAt: new Date(request.plan.expiresAtMs),
        consumedAt,
      },
    });
    const report = failureReportFor(request, "TRANSPORT_FAILED");
    const finalizationAccess = createAccess(fake.db);

    const finalized = await finalizeTeachingSpikeLiveEvidenceReport(
      finalizationAccess,
      report,
    );
    expect(finalized).toMatchObject({
      status: "finalized",
      reportHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      finishedAtMs: issuedAtMs + 2_000,
    });
    await expect(
      finalizeTeachingSpikeLiveEvidenceReport(finalizationAccess, report),
    ).resolves.toMatchObject({
      status: "already_finalized",
      reportHash: finalized.status === "finalized" ? finalized.reportHash : "",
      finishedAtMs: issuedAtMs + 2_000,
    });
    await expect(
      finalizeTeachingSpikeLiveEvidenceReport(
        finalizationAccess,
        failureReportFor(request, "PROTOCOL_SEQUENCE_FAILED"),
      ),
    ).resolves.toEqual({ status: "report_conflict" });
    expect(
      fake.events.filter((event) => event === "evidence_finalized"),
    ).toHaveLength(1);
    expect(fake.getAuthorization()).toMatchObject({
      consumedAt,
      reportHash:
        finalized.status === "finalized" ? finalized.reportHash : undefined,
      reportJson: {
        schemaVersion: 5,
        instructionAcks: { available: false },
        outcome: { status: "failed" },
      },
      finishedAt: new Date(issuedAtMs + 2_000),
    });
  });

  it("persists only categorized Provider error diagnostics", async () => {
    const baseline = createFakeDatabase({});
    const access = createAccess(baseline.db);
    const request = requestFor(targetFor(access));
    const fake = createFakeDatabase({
      authorization: {
        runId: request.plan.runId,
        planHash: request.plan.planHash,
        planJson: request.plan,
        expiresAt: new Date(request.plan.expiresAtMs),
        consumedAt: new Date(issuedAtMs + 1_000),
      },
    });

    await expect(
      finalizeTeachingSpikeLiveEvidenceReport(
        createAccess(fake.db),
        providerErrorReportFor(request),
      ),
    ).resolves.toMatchObject({ status: "finalized" });

    const stored = fake.getAuthorization();
    expect(stored?.reportJson).toMatchObject({
      schemaVersion: 5,
      instructionAcks: { available: false },
      diagnostic: {
        available: true,
        source: "qwen_live_adapter",
        checkpoint: "d01t_case",
        adapterErrorCode: "PROVIDER_ERROR",
        providerError: {
          available: true,
          typeCategory: "invalid_request",
          codeCategory: "invalid_value",
          paramCategory: "response_create",
        },
        markerAssertion: { available: false },
      },
    });
    const serialized = JSON.stringify(stored?.reportJson);
    for (const forbidden of [
      "SECRET_API_KEY",
      "wss://",
      '"message"',
      '"rawType"',
      '"rawCode"',
      '"rawParam"',
      '"eventId"',
      '"instructions"',
      '"instructionHash"',
      '"marker"',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("persists only aggregate instruction ACK evidence from a completed Qwen protocol", async () => {
    const baseline = createFakeDatabase({});
    const access = createAccess(baseline.db);
    const request = requestFor(targetFor(access));
    const fake = createFakeDatabase({
      authorization: {
        runId: request.plan.runId,
        planHash: request.plan.planHash,
        planJson: request.plan,
        expiresAt: new Date(request.plan.expiresAtMs),
        consumedAt: new Date(issuedAtMs + 1_000),
      },
    });

    await expect(
      finalizeTeachingSpikeLiveEvidenceReport(
        createAccess(fake.db),
        completedReportFor(request),
      ),
    ).resolves.toMatchObject({ status: "finalized" });

    const stored = fake.getAuthorization();
    expect(stored?.reportJson).toMatchObject({
      schemaVersion: 5,
      providerEvidence: false,
      instructionAcks: {
        available: true,
        total: 5,
        echoedMatch: 2,
        omitted: 3,
      },
      capabilityDecision: {
        status: "not_evaluated",
        reason: "insufficient_sample",
      },
    });
    const serialized = JSON.stringify(stored?.reportJson);
    for (const forbidden of [
      '"instructions"',
      '"instructionHash"',
      '"marker"',
      '"sessionId"',
      '"responseId"',
      '"eventId"',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("refuses to attach evidence before authorization consumption", async () => {
    const baseline = createFakeDatabase({});
    const access = createAccess(baseline.db);
    const request = requestFor(targetFor(access));
    const fake = createFakeDatabase({
      authorization: {
        runId: request.plan.runId,
        planHash: request.plan.planHash,
        planJson: request.plan,
        expiresAt: new Date(request.plan.expiresAtMs),
        consumedAt: null,
      },
    });

    await expect(
      finalizeTeachingSpikeLiveEvidenceReport(
        createAccess(fake.db),
        failureReportFor(request, "TRANSPORT_FAILED"),
      ),
    ).resolves.toEqual({ status: "authorization_not_consumed" });
    expect(fake.events).not.toContain("evidence_finalized");
  });
});

describe("exact active teaching spike target resolution", () => {
  it("resolves preflight metadata with the Qwen composition fingerprint and no credential read", async () => {
    const active = activeQwenTarget();
    const fake = createFakeDatabase({
      activeTarget: active,
      apiKey: providerApiKey,
    });
    const access = createAccess(fake.db);
    const metadata = await resolveTeachingSpikeLiveTargetMetadata(access, {
      provider: "qwen",
      modelProfileId: active.modelProfileId,
      modelProfileRevision: active.modelProfileRevision,
      modelId: active.model,
      connectionId: active.connectionId,
      connectionRevision: active.connectionRevision,
      voiceProfileId: active.voiceProfileId,
      voiceProfileRevision: active.voiceProfileRevision,
      voiceId: active.voice,
    });

    expect(metadata).toEqual({
      provider: "qwen",
      modelProfileId: active.modelProfileId,
      modelProfileRevision: active.modelProfileRevision,
      modelId: active.model,
      connectionId: active.connectionId,
      connectionRevision: active.connectionRevision,
      voiceProfileId: active.voiceProfileId,
      voiceProfileRevision: active.voiceProfileRevision,
      voiceId: active.voice,
      endpointFingerprint: qwenTeachingLiveWebSocketEndpointFingerprint(
        providerEndpoint,
        active.model,
      ),
      databaseScope: "isolated_spike",
      databaseFingerprint: access.databaseFingerprint,
    });
    expect(fake.getTargetReads()).toBe(1);
    expect(fake.getCredentialReads()).toBe(0);
  });

  it("requires an exact consumed authorization row before target or secret reads", async () => {
    const active = activeQwenTarget();
    const fake = createFakeDatabase({
      activeTarget: active,
      apiKey: providerApiKey,
    });
    const access = createAccess(fake.db);
    const request = requestFor(targetFor(access, active));
    const authorization = authorizeTeachingSpikeLiveExecution(request, {
      readServerTimeMs: () => issuedAtMs + 1_000,
    });
    const dependencies = createTeachingSpikeLivePersistenceDependencies(access);

    await expect(
      dependencies.resolveRuntime(authorization),
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_NOT_CONSUMED_OR_EXPIRED",
    });
    expect(fake.getTargetReads()).toBe(0);
    expect(fake.getCredentialReads()).toBe(0);

    await preregisterTeachingSpikeLiveAuthorization(access, request.plan);
    await expect(
      dependencies.consumeAuthorization({
        runId: authorization.runId,
        planHash: authorization.planHash,
        expiresAtMs: authorization.expiresAtMs,
      }),
    ).resolves.toBe("consumed");
    await expect(
      dependencies.resolveRuntime({
        ...authorization,
        target: {
          ...authorization.target,
          voiceProfileRevision: authorization.target.voiceProfileRevision + 1,
        },
      }),
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_NOT_CONSUMED_OR_EXPIRED",
    });
    expect(fake.getTargetReads()).toBe(0);
    expect(fake.getCredentialReads()).toBe(0);
    await expect(dependencies.resolveRuntime(authorization)).resolves.toEqual({
      target: authorization.target,
      endpoint: providerEndpoint,
      apiKey: providerApiKey,
    });
  });

  it("reads the API key only after atomic consumption and exact active matching", async () => {
    const active = activeQwenTarget();
    const fake = createFakeDatabase({
      databaseNowMs: () => issuedAtMs + 2_000,
      activeTarget: active,
      apiKey: providerApiKey,
    });
    const access = createAccess(fake.db);
    const target = targetFor(access, active);
    const request = requestFor(target);
    await preregisterTeachingSpikeLiveAuthorization(access, request.plan);
    const useTarget = vi.fn(async ({ target: resolved }) => resolved);

    const result = await withTeachingSpikeLiveTarget(request, {
      access,
      clock: { readServerTimeMs: () => issuedAtMs + 1_000 },
      useTarget,
    });

    expect(result).toEqual({
      target,
      endpoint: providerEndpoint,
      apiKey: providerApiKey,
    });
    expect(Object.keys(result)).toEqual(["target", "endpoint", "apiKey"]);
    expect(fake.events.indexOf("authorization_consumed")).toBeLessThan(
      fake.events.indexOf("target_read"),
    );
    expect(fake.events.indexOf("target_read")).toBeLessThan(
      fake.events.indexOf("credential_read"),
    );
    expect(useTarget).toHaveBeenCalledOnce();
  });

  it("does not query target data or credentials when consumption fails", async () => {
    const active = activeQwenTarget();
    let databaseNowMs = issuedAtMs + 1_000;
    const fake = createFakeDatabase({
      databaseNowMs: () => databaseNowMs,
      activeTarget: active,
      apiKey: providerApiKey,
    });
    const access = createAccess(fake.db);
    const request = requestFor(targetFor(access, active));
    await preregisterTeachingSpikeLiveAuthorization(access, request.plan);
    databaseNowMs = expiresAtMs;

    await expect(
      withTeachingSpikeLiveTarget(request, {
        access,
        clock: { readServerTimeMs: () => issuedAtMs + 1_000 },
        useTarget: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_EXPIRED" });
    expect(fake.getTargetReads()).toBe(0);
    expect(fake.getCredentialReads()).toBe(0);
  });

  it.each([
    ["model revision", { modelProfileRevision: 8 }],
    ["connection revision", { connectionRevision: 12 }],
    ["voice revision", { voiceProfileRevision: 6 }],
    ["model disabled", { modelProfileStatus: "disabled" }],
    ["connection unverified", { connectionVerifiedAt: null }],
    ["voice disabled", { voiceProfileStatus: "disabled" }],
    ["wrong adapter", { connectionAdapter: "doubao_realtime" }],
    ["wrong voice", { voice: "another-voice" }],
    ["changed endpoint", { endpoint: `${providerEndpoint}/changed` }],
  ])("rejects a non-exact active target: %s", async (_name, override) => {
    const expected = activeQwenTarget();
    const actual = { ...expected, ...override } as ActiveTargetRow;
    const fake = createFakeDatabase({
      activeTarget: actual,
      apiKey: providerApiKey,
    });
    const access = createAccess(fake.db);
    const request = requestFor(targetFor(access, expected));
    await preregisterTeachingSpikeLiveAuthorization(access, request.plan);

    await expect(
      withTeachingSpikeLiveTarget(request, {
        access,
        clock: { readServerTimeMs: () => issuedAtMs + 1_000 },
        useTarget: vi.fn(),
      }),
    ).rejects.toMatchObject<TeachingSpikeLivePersistenceError>({
      code: "TARGET_NOT_ACTIVE",
    });
    expect(fake.getCredentialReads()).toBe(0);
  });

  it("rejects a database fingerprint mismatch before any database query", async () => {
    const fake = createFakeDatabase({
      activeTarget: activeQwenTarget(),
      apiKey: providerApiKey,
    });
    const access = createAccess(fake.db);
    const target = {
      ...targetFor(access),
      databaseFingerprint: "f".repeat(64),
    };
    const request = requestFor(target);
    await preregisterTeachingSpikeLiveAuthorization(access, request.plan);

    await expect(
      withTeachingSpikeLiveTarget(request, {
        access,
        clock: { readServerTimeMs: () => issuedAtMs + 1_000 },
        useTarget: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "TARGET_NOT_ACTIVE" });
    expect(fake.getTargetReads()).toBe(0);
    expect(fake.getCredentialReads()).toBe(0);
  });

  it("redacts database failure details", async () => {
    const access = createAccess({
      transaction: async () => {
        throw new Error(providerApiKey);
      },
    } as unknown as Database);
    let caught: unknown;
    try {
      await consumeTeachingSpikeLiveAuthorization(access, claimFor());
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toBe(
      "TeachingSpikeLivePersistenceError: DATABASE_ISOLATION_AUDIT_FAILED",
    );
    expect(String(caught)).not.toContain(providerApiKey);
  });
});

describe("teaching spike persistence migration", () => {
  it("defines an isolated authorization table and keeps pending/test mutation paths out of the resolver", async () => {
    const [migration, persistenceSource] = await Promise.all([
      readFile(
        new URL(
          "../../../packages/database/migrations/0019_teaching_spike_live_authorizations.sql",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../src/spikes/realtime-teaching/live-authorization-persistence.ts",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);

    expect(migration).toContain(
      'CREATE TABLE "teaching_spike_live_authorizations"',
    );
    expect(migration).toContain('"run_id" uuid PRIMARY KEY');
    expect(migration).toContain('"plan_hash" varchar(64) NOT NULL');
    expect(migration).toContain('"plan_json" jsonb NOT NULL');
    expect(migration).toContain('"report_hash" varchar(64)');
    expect(migration).toContain('"report_json" jsonb');
    expect(migration).toContain('"finished_at" timestamp with time zone');
    expect(migration).toContain(
      'CONSTRAINT "teaching_spike_live_authorizations_report_terminal_pair"',
    );
    expect(persistenceSource).toContain("clock_timestamp()");
    expect(persistenceSource).toContain('.for("update")');
    expect(persistenceSource).not.toMatch(/pendingEndpoint|pendingApiKey/u);
    expect(persistenceSource).not.toMatch(
      /testModel|markModelTestSucceeded|promot(?:e|ion)/u,
    );
  });

  it("provides a dedicated migration entry with no DATABASE_URL fallback", async () => {
    const [configSource, databasePackage, rootPackage] = await Promise.all([
      readFile(
        new URL(
          "../../../packages/database/drizzle.teaching-spike.config.ts",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL("../../../packages/database/package.json", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    ]);
    const databaseScripts = (
      JSON.parse(databasePackage) as { scripts: Record<string, string> }
    ).scripts;
    const rootScripts = (
      JSON.parse(rootPackage) as { scripts: Record<string, string> }
    ).scripts;

    expect(configSource).toContain(
      "process.env.TEACHING_SPIKE_DATABASE_URL?.trim()",
    );
    expect(configSource).toContain("url: teachingSpikeDatabaseUrl");
    expect(configSource).toContain("decodeURIComponent(url.pathname.slice(1))");
    expect(configSource).toContain(
      "teachingIdentity.databaseName === applicationIdentity.databaseName",
    );
    expect(configSource).not.toMatch(
      /TEACHING_SPIKE_DATABASE_URL[^\n]*(?:\?\?|\|\|)[^\n]*DATABASE_URL/u,
    );
    expect(databaseScripts["db:migrate:teaching-spike"]).toBe(
      "drizzle-kit migrate --config drizzle.teaching-spike.config.ts",
    );
    expect(rootScripts["db:migrate:teaching-spike"]).toBe(
      "pnpm --filter @meet/database db:migrate:teaching-spike",
    );
  });
});
