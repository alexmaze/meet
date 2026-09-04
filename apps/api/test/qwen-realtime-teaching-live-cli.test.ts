import { describe, expect, it, vi } from "vitest";

import {
  parseQwenTeachingLiveCliArguments,
  runQwenTeachingLiveCli,
  type QwenTeachingLiveCliDependencies,
  type QwenTeachingLivePreparedPlan,
} from "../src/cli/qwen-realtime-teaching-live.js";
import {
  buildTeachingSpikeLiveAuthorizationPlan,
  type TeachingSpikeLiveTarget,
} from "../src/spikes/realtime-teaching/live-authorization.js";
import { qwenTeachingLiveWebSocketEndpointFingerprint } from "../src/spikes/realtime-teaching/qwen-live-composition.js";
import {
  buildRealtimeTeachingLiveEvidenceReport,
  buildRealtimeTeachingLiveFailureEvidenceReport,
  type RealtimeTeachingLiveEvidenceReport,
} from "../src/spikes/realtime-teaching/live-evidence-report.js";
import {
  TEACHING_SPIKE_FIXTURE_HASH,
  TEACHING_SPIKE_FIXTURE_REVISION,
  TEACHING_SPIKE_USER_TEXT_HASH,
} from "../src/spikes/realtime-teaching/fixtures.js";
import { buildQwenTeachingSpikePricingBinding } from "../src/spikes/realtime-teaching/pricing.js";

const model = "qwen-audio-3.0-realtime-plus";
const runId = "70000000-0000-4000-8000-000000000007";
const target: TeachingSpikeLiveTarget = {
  provider: "qwen",
  modelId: model,
  voiceId: "longanqian",
  modelProfileId: "10000000-0000-4000-8000-000000000001",
  modelProfileRevision: 7,
  connectionId: "20000000-0000-4000-8000-000000000002",
  connectionRevision: 11,
  voiceProfileId: "30000000-0000-4000-8000-000000000003",
  voiceProfileRevision: 5,
  endpointFingerprint: qwenTeachingLiveWebSocketEndpointFingerprint(
    "workspace.cn-beijing.maas.aliyuncs.com",
    model,
  ),
  databaseScope: "isolated_spike",
  databaseFingerprint: "b".repeat(64),
};
const pricing = buildQwenTeachingSpikePricingBinding();

describe("Qwen-only teaching live CLI boundary", () => {
  it("defaults to preflight and calls neither confirmation nor execution", async () => {
    const prepared = createPreparedPlan();
    const dependencies = createDependencies(prepared);
    const write = vi.fn();

    const result = await runQwenTeachingLiveCli(
      selectorArgs(),
      { inputIsTTY: false, outputIsTTY: false, write },
      dependencies,
    );

    expect(result).toEqual({ mode: "preflight", plan: prepared.plan });
    expect(dependencies.createPreflight).toHaveBeenCalledWith({
      databaseScope: "isolated_spike",
      selector: {
        modelProfileId: target.modelProfileId,
        modelProfileRevision: target.modelProfileRevision,
        modelId: target.modelId,
        connectionId: target.connectionId,
        connectionRevision: target.connectionRevision,
        voiceProfileId: target.voiceProfileId,
        voiceProfileRevision: target.voiceProfileRevision,
        voiceId: target.voiceId,
      },
    });
    expect(dependencies.loadPreparedPlan).not.toHaveBeenCalled();
    expect(dependencies.confirmPlanHash).not.toHaveBeenCalled();
    expect(dependencies.execute).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledOnce();
  });

  it("accepts the standalone pnpm argument delimiter", () => {
    expect(
      parseQwenTeachingLiveCliArguments(["--", ...selectorArgs()]),
    ).toMatchObject({ mode: "preflight", selector: { modelId: model } });
  });

  it("requires an explicit per-command flag for the application database", async () => {
    const prepared = createPreparedPlan("application_database");
    const dependencies = createDependencies(prepared);

    expect(
      parseQwenTeachingLiveCliArguments([
        ...selectorArgs(),
        "--use-application-database",
      ]),
    ).toMatchObject({ databaseScope: "application_database" });
    await expect(
      runQwenTeachingLiveCli(
        [...selectorArgs(), "--use-application-database"],
        { inputIsTTY: false, outputIsTTY: false, write: vi.fn() },
        dependencies,
      ),
    ).resolves.toMatchObject({ mode: "preflight" });
    expect(dependencies.createPreflight).toHaveBeenCalledWith(
      expect.objectContaining({ databaseScope: "application_database" }),
    );
    expect(() =>
      parseQwenTeachingLiveCliArguments([
        ...selectorArgs(),
        "--use-application-database",
        "--use-application-database",
      ]),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_ARGUMENT" }));
  });

  it("rejects a prepared plan from a different database scope", async () => {
    const dependencies = createDependencies(createPreparedPlan());
    await expect(
      runQwenTeachingLiveCli(
        [...selectorArgs(), "--use-application-database"],
        { inputIsTTY: false, outputIsTTY: false, write: vi.fn() },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "INVALID_PREFLIGHT_PLAN" });
  });

  it("requires live, execute, and a complete plan hash as one indivisible flag set", () => {
    expect(() =>
      parseQwenTeachingLiveCliArguments([...selectorArgs(), "--live"]),
    ).toThrowError(
      expect.objectContaining({ code: "EXECUTION_FLAGS_INCOMPLETE" }),
    );
    expect(() =>
      parseQwenTeachingLiveCliArguments([
        ...selectorArgs(),
        "--live",
        "--execute",
        "--run-id",
        runId,
        "--ack-billable",
        "short",
      ]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_PLAN_HASH" }));
  });

  it("rejects all rather than broadening the Qwen-only target", () => {
    expect(() =>
      parseQwenTeachingLiveCliArguments(selectorArgs("all")),
    ).toThrowError(expect.objectContaining({ code: "QWEN_ONLY" }));
  });

  it("rejects a Qwen model not covered by the bound plus price card", () => {
    const args = selectorArgs();
    const modelValueIndex = args.indexOf("--model-id") + 1;
    args[modelValueIndex] = "qwen-audio-3.0-realtime-flash";
    expect(() => parseQwenTeachingLiveCliArguments(args)).toThrowError(
      expect.objectContaining({ code: "INVALID_TARGET_SELECTOR" }),
    );
  });

  it.each([
    ["endpoint", ["--endpoint", "example.invalid"]],
    ["credential", ["--api-key", "secret"]],
  ] as const)("rejects the forbidden %s CLI surface", (_name, extra) => {
    expect(() =>
      parseQwenTeachingLiveCliArguments([...selectorArgs(), ...extra]),
    ).toThrowError(
      expect.objectContaining({ code: "SENSITIVE_ARGUMENT_FORBIDDEN" }),
    );
  });

  it("rejects a stale billable acknowledgement before TTY confirmation or execution", async () => {
    const prepared = createPreparedPlan();
    const dependencies = createDependencies(prepared);
    await expect(
      runQwenTeachingLiveCli(
        executeArgs("f".repeat(64)),
        { inputIsTTY: true, outputIsTTY: true, write: vi.fn() },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "ACK_PLAN_HASH_MISMATCH" });
    expect(dependencies.confirmPlanHash).not.toHaveBeenCalled();
    expect(dependencies.execute).not.toHaveBeenCalled();
  });

  it("requires a real input and output TTY before the second confirmation", async () => {
    const prepared = createPreparedPlan();
    const dependencies = createDependencies(prepared);
    await expect(
      runQwenTeachingLiveCli(
        executeArgs(prepared.plan.planHash),
        { inputIsTTY: false, outputIsTTY: true, write: vi.fn() },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "INTERACTIVE_TTY_REQUIRED" });
    expect(dependencies.confirmPlanHash).not.toHaveBeenCalled();
    expect(dependencies.execute).not.toHaveBeenCalled();
  });

  it("executes only after the TTY repeats the exact plan hash and forwards exact revisions", async () => {
    const prepared = createPreparedPlan();
    const dependencies = createDependencies(prepared);
    vi.mocked(dependencies.confirmPlanHash).mockResolvedValue(
      prepared.plan.planHash,
    );
    const result = await runQwenTeachingLiveCli(
      executeArgs(prepared.plan.planHash),
      { inputIsTTY: true, outputIsTTY: true, write: vi.fn() },
      dependencies,
    );

    expect(result.mode).toBe("execute");
    expect(dependencies.createPreflight).not.toHaveBeenCalled();
    expect(dependencies.loadPreparedPlan).toHaveBeenCalledWith({
      selector: {
        modelProfileId: target.modelProfileId,
        modelProfileRevision: target.modelProfileRevision,
        modelId: target.modelId,
        connectionId: target.connectionId,
        connectionRevision: target.connectionRevision,
        voiceProfileId: target.voiceProfileId,
        voiceProfileRevision: target.voiceProfileRevision,
        voiceId: target.voiceId,
      },
      databaseScope: "isolated_spike",
      runId,
      planHash: prepared.plan.planHash,
    });
    expect(dependencies.confirmPlanHash).toHaveBeenCalledWith({
      expectedPlanHash: prepared.plan.planHash,
      prompt: expect.stringContaining("完整 planHash"),
    });
    expect(dependencies.execute).toHaveBeenCalledWith({
      live: true,
      execute: true,
      interactive: true,
      provider: "qwen",
      ackPlanHash: prepared.plan.planHash,
      plan: prepared.plan,
      currentTarget: target,
      currentInputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
      currentPricing: pricing,
    });
    expect(
      (result as { report: RealtimeTeachingLiveEvidenceReport }).report,
    ).toMatchObject({
      providerEvidence: false,
      outcome: { status: "failed", errorCode: "TRANSPORT_FAILED" },
    });
  });

  it("uses one normalized frozen prepared snapshot across TTY confirmation and execution", async () => {
    const mutablePrepared = structuredClone(createPreparedPlan());
    const originalPlanHash = mutablePrepared.plan.planHash;
    const originalPriceSnapshotHash =
      mutablePrepared.currentPricing.priceSnapshotHash;
    const dependencies = createDependencies(mutablePrepared);
    vi.mocked(dependencies.confirmPlanHash).mockImplementation(async () => {
      mutablePrepared.plan.limits.budgetCny = 0.01;
      mutablePrepared.plan.target.connectionRevision = 999;
      mutablePrepared.currentTarget.voiceProfileRevision = 999;
      mutablePrepared.currentPricing.priceSnapshotHash = "f".repeat(64);
      return originalPlanHash;
    });
    vi.mocked(dependencies.execute).mockImplementation(async (request) => {
      expect(Object.isFrozen(request.plan)).toBe(true);
      expect(Object.isFrozen(request.plan.limits)).toBe(true);
      expect(Object.isFrozen(request.currentTarget)).toBe(true);
      expect(Object.isFrozen(request.currentPricing)).toBe(true);
      expect(request.plan.planHash).toBe(originalPlanHash);
      expect(request.plan.limits.budgetCny).toBe(2);
      expect(request.plan.target.connectionRevision).toBe(
        target.connectionRevision,
      );
      expect(request.currentTarget.voiceProfileRevision).toBe(
        target.voiceProfileRevision,
      );
      expect(request.currentPricing.priceSnapshotHash).toBe(
        originalPriceSnapshotHash,
      );
      return failureEvidence(createPreparedPlan());
    });

    await runQwenTeachingLiveCli(
      executeArgs(originalPlanHash),
      { inputIsTTY: true, outputIsTTY: true, write: vi.fn() },
      dependencies,
    );

    expect(dependencies.execute).toHaveBeenCalledOnce();
  });

  it("rejects an issued fake-upstream completion instead of presenting it as live Provider evidence", async () => {
    const prepared = createPreparedPlan();
    const dependencies = createDependencies(prepared);
    vi.mocked(dependencies.confirmPlanHash).mockResolvedValue(
      prepared.plan.planHash,
    );
    vi.mocked(dependencies.execute).mockResolvedValue(
      completedFakeEvidence(prepared),
    );

    await expect(
      runQwenTeachingLiveCli(
        executeArgs(prepared.plan.planHash),
        { inputIsTTY: true, outputIsTTY: true, write: vi.fn() },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "INVALID_EXECUTION_RESULT" });
  });

  it("fails preflight if any exact profile, connection, or voice revision is stale", async () => {
    const prepared = createPreparedPlan();
    const dependencies = createDependencies({
      ...prepared,
      currentTarget: { ...target, connectionRevision: 12 },
    });
    await expect(
      runQwenTeachingLiveCli(
        selectorArgs(),
        { inputIsTTY: false, outputIsTTY: false, write: vi.fn() },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "INVALID_PREFLIGHT_PLAN" });
    expect(dependencies.execute).not.toHaveBeenCalled();
  });
});

function selectorArgs(provider = "qwen"): string[] {
  return [
    "--provider",
    provider,
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

function executeArgs(planHash: string): string[] {
  return [
    ...selectorArgs(),
    "--live",
    "--execute",
    "--run-id",
    runId,
    "--ack-billable",
    planHash,
  ];
}

function createPreparedPlan(
  databaseScope: TeachingSpikeLiveTarget["databaseScope"] = "isolated_spike",
): QwenTeachingLivePreparedPlan {
  const scopedTarget = { ...target, databaseScope };
  const plan = buildTeachingSpikeLiveAuthorizationPlan({
    target: scopedTarget,
    budgetCny: 2,
    pricing,
    inputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
    runId,
    issuedAtMs: 1_786_656_000_000,
    expiresAtMs: 1_786_656_600_000,
  });
  return {
    plan,
    currentTarget: scopedTarget,
    currentInputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
    currentPricing: pricing,
  };
}

function createDependencies(
  prepared: QwenTeachingLivePreparedPlan,
): QwenTeachingLiveCliDependencies {
  return {
    createPreflight: vi.fn(async () => prepared),
    loadPreparedPlan: vi.fn(async () => prepared),
    confirmPlanHash: vi.fn(async () => prepared.plan.planHash),
    execute: vi.fn(async () => failureEvidence(prepared)),
  };
}

function failureEvidence(
  prepared: QwenTeachingLivePreparedPlan,
): RealtimeTeachingLiveEvidenceReport {
  return buildRealtimeTeachingLiveFailureEvidenceReport({
    authorization: authorization(prepared),
    priceSnapshotHash: pricing.priceSnapshotHash,
    errorCode: "TRANSPORT_FAILED",
    transportAttempted: true,
    progress: { available: false },
  });
}

function completedFakeEvidence(
  prepared: QwenTeachingLivePreparedPlan,
): RealtimeTeachingLiveEvidenceReport {
  return buildRealtimeTeachingLiveEvidenceReport({
    authorization: authorization(prepared),
    priceSnapshotHash: pricing.priceSnapshotHash,
    usage: {
      inputAudioMs: 0,
      outputAudioMs: 0,
      estimatedCostCny: 0.00087,
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
      instructionAcks: {
        total: 5,
        echoedMatch: 2,
        omitted: 3,
      },
      usage: {
        totalTokens: 48,
        inputTokens: 30,
        outputTokens: 18,
        inputTextTokens: 30,
        inputAudioTokens: 0,
        outputTextTokens: 18,
        outputAudioTokens: 0,
      },
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

function authorization(prepared: QwenTeachingLivePreparedPlan) {
  return {
    authorized: true as const,
    runId: prepared.plan.runId,
    provider: "qwen" as const,
    planHash: prepared.plan.planHash,
    inputMode: "text" as const,
    inputFixtureHash: prepared.plan.inputFixtureHash,
    expiresAtMs: prepared.plan.expiresAtMs,
    caseIds: prepared.plan.caseIds,
    target: prepared.plan.target,
    pricing,
    limits: prepared.plan.limits,
  };
}
