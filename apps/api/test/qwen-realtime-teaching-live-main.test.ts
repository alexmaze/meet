import type { Database } from "@meet/database";
import { describe, expect, it, vi } from "vitest";

import {
  runQwenTeachingLiveMain,
  type QwenTeachingLiveMainDependencies,
  type QwenTeachingLiveMainIo,
} from "../src/cli/qwen-realtime-teaching-live-main.js";
import {
  authorizeTeachingSpikeLiveExecution,
  buildTeachingSpikeLiveAuthorizationPlan,
  type TeachingSpikeLiveAuthorizationPlan,
  type TeachingSpikeLiveTarget,
} from "../src/spikes/realtime-teaching/live-authorization.js";
import { buildRealtimeTeachingLiveFailureEvidenceReport } from "../src/spikes/realtime-teaching/live-evidence-report.js";
import { TEACHING_SPIKE_USER_TEXT_HASH } from "../src/spikes/realtime-teaching/fixtures.js";
import { qwenTeachingLiveWebSocketEndpointFingerprint } from "../src/spikes/realtime-teaching/qwen-live-composition.js";
import { buildQwenTeachingSpikePricingBinding } from "../src/spikes/realtime-teaching/pricing.js";
import type { TeachingSpikeDatabaseAccess } from "../src/spikes/realtime-teaching/teaching-spike-database.js";

const nowMs = 1_786_656_001_000;
const runId = "70000000-0000-4000-8000-000000000007";
const modelId = "qwen-audio-3.0-realtime-plus";
const endpoint = "workspace.cn-beijing.maas.aliyuncs.com";
const target: TeachingSpikeLiveTarget = {
  provider: "qwen",
  modelId,
  voiceId: "longanqian",
  modelProfileId: "10000000-0000-4000-8000-000000000001",
  modelProfileRevision: 7,
  connectionId: "20000000-0000-4000-8000-000000000002",
  connectionRevision: 11,
  voiceProfileId: "30000000-0000-4000-8000-000000000003",
  voiceProfileRevision: 5,
  endpointFingerprint: qwenTeachingLiveWebSocketEndpointFingerprint(
    endpoint,
    modelId,
  ),
  databaseScope: "isolated_spike",
  databaseFingerprint: "b".repeat(64),
};
const pricing = buildQwenTeachingSpikePricingBinding();

describe("Qwen teaching live executable main", () => {
  it("prints help without loading environment, opening a database, or resolving a target", async () => {
    const harness = createHarness();

    await expect(
      runQwenTeachingLiveMain(["--help"], {}, harness.io, harness.dependencies),
    ).resolves.toBe(0);

    expect(harness.dependencies.loadEnvironment).not.toHaveBeenCalled();
    expect(harness.dependencies.createDatabaseAccess).not.toHaveBeenCalled();
    expect(harness.dependencies.resolveTargetMetadata).not.toHaveBeenCalled();
    expect(harness.output.join("")).toContain("默认仅生成并显示 preflight");
  });

  it("defaults to a persisted preflight without reading a credential or running evidence", async () => {
    const harness = createHarness();

    await expect(
      runQwenTeachingLiveMain(
        selectorArgs(),
        {},
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(0);

    expect(harness.dependencies.loadEnvironment).toHaveBeenCalledOnce();
    expect(harness.dependencies.createDatabaseAccess).toHaveBeenCalledWith(
      {},
      { scope: "isolated_spike" },
    );
    expect(harness.dependencies.resolveTargetMetadata).toHaveBeenCalledOnce();
    expect(harness.dependencies.preregisterPlan).toHaveBeenCalledOnce();
    expect(harness.dependencies.consumeAuthorization).not.toHaveBeenCalled();
    expect(harness.dependencies.resolveRuntime).not.toHaveBeenCalled();
    expect(harness.dependencies.executeAndBuildEvidence).not.toHaveBeenCalled();
    expect(harness.dependencies.finalizeEvidence).not.toHaveBeenCalled();
    expect(harness.close).toHaveBeenCalledOnce();
    const output = JSON.parse(harness.output.join("")) as {
      mode: string;
      plan: TeachingSpikeLiveAuthorizationPlan;
    };
    expect(output).toMatchObject({
      mode: "preflight",
      plan: {
        runId,
        provider: "qwen",
        inputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
        pricing,
        limits: { budgetCny: 2, maxSessions: 2, maxResponseAttempts: 3 },
      },
    });
  });

  it("opens the application database only when the per-command flag is present", async () => {
    const harness = createHarness();
    const applicationTarget = {
      ...target,
      databaseScope: "application_database" as const,
    };
    vi.mocked(harness.dependencies.createDatabaseAccess).mockImplementation(
      (_environment, options) => ({
        ...harness.access,
        databaseScope: options.scope,
      }),
    );
    vi.mocked(harness.dependencies.resolveTargetMetadata).mockResolvedValue(
      applicationTarget,
    );

    await expect(
      runQwenTeachingLiveMain(
        [...selectorArgs(), "--use-application-database"],
        {},
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(0);

    expect(harness.dependencies.createDatabaseAccess).toHaveBeenCalledWith(
      {},
      { scope: "application_database" },
    );
    const output = JSON.parse(harness.output.join("")) as {
      plan: TeachingSpikeLiveAuthorizationPlan;
    };
    expect(output.plan.target.databaseScope).toBe("application_database");
  });

  it("consumes, resolves the secret, and finalizes a redacted failure only after all live confirmations", async () => {
    const plan = createPlan();
    const harness = createHarness(plan);

    await expect(
      runQwenTeachingLiveMain(
        executeArgs(plan),
        {},
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(1);

    expect(harness.dependencies.loadPlan).toHaveBeenCalledWith(harness.access, {
      runId: plan.runId,
      planHash: plan.planHash,
    });
    expect(harness.dependencies.confirmPlanHash).toHaveBeenCalledOnce();
    expect(harness.dependencies.consumeAuthorization).toHaveBeenCalledOnce();
    expect(harness.dependencies.resolveRuntime).toHaveBeenCalledOnce();
    expect(harness.dependencies.finalizeEvidence).toHaveBeenCalledOnce();
    const output = JSON.parse(harness.output.join("")) as {
      mode: string;
      report: Record<string, unknown>;
    };
    expect(output).toMatchObject({
      mode: "execute",
      report: {
        runId: plan.runId,
        planHash: plan.planHash,
        providerEvidence: false,
        outcome: { status: "failed", errorCode: "TRANSPORT_FAILED" },
      },
    });
    expect(harness.output.join("")).not.toContain("provider-test-key");
    expect(harness.output.join("")).not.toContain(endpoint);
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("rejects incomplete live flags before loading environment or opening the database", async () => {
    const harness = createHarness();

    await expect(
      runQwenTeachingLiveMain(
        [...selectorArgs(), "--live"],
        {},
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(2);

    expect(harness.dependencies.loadEnvironment).not.toHaveBeenCalled();
    expect(harness.dependencies.createDatabaseAccess).not.toHaveBeenCalled();
    expect(harness.errors.join("")).toContain("EXECUTION_FLAGS_INCOMPLETE");
  });

  it("returns a failure code and redacts details when the isolated database cannot close", async () => {
    const harness = createHarness();
    harness.close.mockRejectedValueOnce(new Error("database-secret"));

    await expect(
      runQwenTeachingLiveMain(
        selectorArgs(),
        {},
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(2);

    expect(harness.errors.join("")).toContain("DATABASE_CLOSE_FAILED");
    expect(harness.errors.join("")).not.toContain("database-secret");
  });
});

function createHarness(plan?: TeachingSpikeLiveAuthorizationPlan) {
  const output: string[] = [];
  const errors: string[] = [];
  const close = vi.fn(async () => undefined);
  const access: TeachingSpikeDatabaseAccess = {
    db: {} as Database,
    databaseScope: target.databaseScope,
    databaseFingerprint: target.databaseFingerprint,
    close,
  };
  let preregisteredPlan = plan;
  const io: QwenTeachingLiveMainIo = {
    inputIsTTY: true,
    outputIsTTY: true,
    writeOutput: (value) => output.push(value),
    writeError: (value) => errors.push(value),
  };
  const dependencies = {
    loadEnvironment: vi.fn(),
    createDatabaseAccess: vi.fn((_environment, _options) => access),
    nowMs: vi.fn(() => nowMs),
    createRunId: vi.fn(() => runId),
    resolveTargetMetadata: vi.fn(async () => target),
    preregisterPlan: vi.fn(async (_access, nextPlan) => {
      preregisteredPlan = nextPlan;
      return "registered" as const;
    }),
    loadPlan: vi.fn(async () =>
      preregisteredPlan
        ? ({ status: "loaded", plan: preregisteredPlan } as const)
        : ({ status: "not_found" } as const),
    ),
    consumeAuthorization: vi.fn(async () => "consumed" as const),
    resolveRuntime: vi.fn(async (_access, authorization) => ({
      target: authorization.target,
      endpoint,
      apiKey: "provider-test-key",
    })),
    executeAndBuildEvidence: vi.fn(async ({ request, dependencies }) => {
      const authorization = authorizeTeachingSpikeLiveExecution(
        request,
        dependencies.clock,
      );
      await dependencies.consumeAuthorization({
        runId: authorization.runId,
        planHash: authorization.planHash,
        expiresAtMs: authorization.expiresAtMs,
      });
      await dependencies.resolveRuntime(authorization);
      return buildRealtimeTeachingLiveFailureEvidenceReport({
        authorization,
        priceSnapshotHash: authorization.pricing.priceSnapshotHash,
        errorCode: "TRANSPORT_FAILED",
        transportAttempted: true,
        progress: { available: false },
      });
    }),
    finalizeEvidence: vi.fn(async () => ({
      status: "finalized" as const,
      reportHash: "f".repeat(64),
      finishedAtMs: nowMs,
    })),
    confirmPlanHash: vi.fn(async ({ expectedPlanHash }) => expectedPlanHash),
  } satisfies QwenTeachingLiveMainDependencies;
  return { io, dependencies, access, output, errors, close };
}

function createPlan(): TeachingSpikeLiveAuthorizationPlan {
  return buildTeachingSpikeLiveAuthorizationPlan({
    target,
    budgetCny: 2,
    pricing,
    inputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
    runId,
    issuedAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 9 * 60 * 1_000,
  });
}

function selectorArgs(): string[] {
  return [
    "--provider",
    "qwen",
    "--model-profile-id",
    target.modelProfileId,
    "--model-profile-revision",
    String(target.modelProfileRevision),
    "--model-id",
    target.modelId,
    "--connection-id",
    target.connectionId,
    "--connection-revision",
    String(target.connectionRevision),
    "--voice-profile-id",
    target.voiceProfileId,
    "--voice-profile-revision",
    String(target.voiceProfileRevision),
    "--voice-id",
    target.voiceId,
  ];
}

function executeArgs(plan: TeachingSpikeLiveAuthorizationPlan): string[] {
  return [
    ...selectorArgs(),
    "--live",
    "--execute",
    "--run-id",
    plan.runId,
    "--ack-billable",
    plan.planHash,
  ];
}
