import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { loadProjectEnvironment } from "../load-environment.js";
import {
  QWEN_TEACHING_LIVE_CLI_USAGE,
  QwenTeachingLiveCliError,
  parseQwenTeachingLiveCliArguments,
  runQwenTeachingLiveCli,
  type QwenTeachingLivePreparedPlan,
} from "./qwen-realtime-teaching-live.js";
import {
  TEACHING_SPIKE_LIVE_MAX_AUTHORIZATION_AGE_MS,
  TEACHING_SPIKE_LIVE_MAX_BUDGET_CNY,
  TeachingSpikeLiveAuthorizationError,
  buildTeachingSpikeLiveAuthorizationPlan,
  type TeachingSpikeLiveAuthorizationClock,
  type TeachingSpikeLiveAuthorizationConsumptionClaim,
  type TeachingSpikeLiveAuthorizationConsumptionResult,
  type TeachingSpikeLiveAuthorization,
  type TeachingSpikeLiveAuthorizationPlan,
  type TeachingSpikeLiveAuthorizationRequest,
  type TeachingSpikeLiveTarget,
} from "../spikes/realtime-teaching/live-authorization.js";
import {
  TeachingSpikeLivePersistenceError,
  createTeachingSpikeLivePersistenceDependencies,
  finalizeTeachingSpikeLiveEvidenceReport,
  loadTeachingSpikeLiveAuthorizationPlan,
  preregisterTeachingSpikeLiveAuthorization,
  resolveTeachingSpikeLiveTargetMetadata,
  type TeachingSpikeLiveAuthorizationPlanLoadResult,
  type TeachingSpikeLiveAuthorizationRegistrationResult,
  type TeachingSpikeLiveEvidenceFinalizationResult,
  type TeachingSpikeLiveTargetSelector,
} from "../spikes/realtime-teaching/live-authorization-persistence.js";
import {
  RealtimeTeachingLiveEvidenceError,
  runAuthorizedQwenTeachingLiveCompositionAndBuildEvidence,
  type RealtimeTeachingLiveEvidenceReport,
} from "../spikes/realtime-teaching/live-evidence-report.js";
import { TEACHING_SPIKE_USER_TEXT_HASH } from "../spikes/realtime-teaching/fixtures.js";
import { QwenTeachingLiveAdapterError } from "../spikes/realtime-teaching/qwen-live-adapter.js";
import {
  QwenTeachingLiveCompositionError,
  type QwenTeachingLiveTargetSelector,
  type ResolvedQwenTeachingLiveRuntime,
} from "../spikes/realtime-teaching/qwen-live-composition.js";
import { buildQwenTeachingSpikePricingBinding } from "../spikes/realtime-teaching/pricing.js";
import {
  TeachingSpikeDatabaseConfigurationError,
  createTeachingSpikeDatabaseAccess,
  type TeachingSpikeDatabaseAccess,
  type TeachingSpikeDatabaseEnvironment,
  type TeachingSpikeDatabaseScope,
} from "../spikes/realtime-teaching/teaching-spike-database.js";

export type QwenTeachingLiveMainIo = Readonly<{
  inputIsTTY: boolean;
  outputIsTTY: boolean;
  writeOutput(value: string): unknown;
  writeError(value: string): unknown;
}>;

export type QwenTeachingLiveMainDependencies = Readonly<{
  loadEnvironment(): void;
  createDatabaseAccess(
    environment: TeachingSpikeDatabaseEnvironment,
    options: Readonly<{ scope: TeachingSpikeDatabaseScope }>,
  ): TeachingSpikeDatabaseAccess;
  nowMs(): number;
  createRunId(): string;
  resolveTargetMetadata(
    access: TeachingSpikeDatabaseAccess,
    selector: TeachingSpikeLiveTargetSelector,
  ): TeachingSpikeLiveTarget | Promise<TeachingSpikeLiveTarget>;
  preregisterPlan(
    access: TeachingSpikeDatabaseAccess,
    plan: TeachingSpikeLiveAuthorizationPlan,
  ):
    | TeachingSpikeLiveAuthorizationRegistrationResult
    | Promise<TeachingSpikeLiveAuthorizationRegistrationResult>;
  loadPlan(
    access: TeachingSpikeDatabaseAccess,
    claim: { runId: string; planHash: string },
  ):
    | TeachingSpikeLiveAuthorizationPlanLoadResult
    | Promise<TeachingSpikeLiveAuthorizationPlanLoadResult>;
  consumeAuthorization(
    access: TeachingSpikeDatabaseAccess,
    claim: TeachingSpikeLiveAuthorizationConsumptionClaim,
  ):
    | TeachingSpikeLiveAuthorizationConsumptionResult
    | Promise<TeachingSpikeLiveAuthorizationConsumptionResult>;
  resolveRuntime(
    access: TeachingSpikeDatabaseAccess,
    authorization: TeachingSpikeLiveAuthorization,
  ): ResolvedQwenTeachingLiveRuntime | Promise<ResolvedQwenTeachingLiveRuntime>;
  executeAndBuildEvidence(input: {
    request: TeachingSpikeLiveAuthorizationRequest;
    dependencies: {
      clock: TeachingSpikeLiveAuthorizationClock;
      consumeAuthorization: (
        claim: TeachingSpikeLiveAuthorizationConsumptionClaim,
      ) =>
        | TeachingSpikeLiveAuthorizationConsumptionResult
        | Promise<TeachingSpikeLiveAuthorizationConsumptionResult>;
      resolveRuntime: (
        authorization: TeachingSpikeLiveAuthorization,
      ) =>
        | ResolvedQwenTeachingLiveRuntime
        | Promise<ResolvedQwenTeachingLiveRuntime>;
    };
  }):
    | RealtimeTeachingLiveEvidenceReport
    | Promise<RealtimeTeachingLiveEvidenceReport>;
  finalizeEvidence(
    access: TeachingSpikeDatabaseAccess,
    report: RealtimeTeachingLiveEvidenceReport,
  ):
    | TeachingSpikeLiveEvidenceFinalizationResult
    | Promise<TeachingSpikeLiveEvidenceFinalizationResult>;
  confirmPlanHash(input: {
    expectedPlanHash: string;
    prompt: string;
  }): string | Promise<string>;
}>;

const defaultIo: QwenTeachingLiveMainIo = {
  inputIsTTY: process.stdin.isTTY === true,
  outputIsTTY: process.stdout.isTTY === true,
  writeOutput: (value) => process.stdout.write(value),
  writeError: (value) => process.stderr.write(value),
};

const defaultDependencies: QwenTeachingLiveMainDependencies = {
  loadEnvironment: loadProjectEnvironment,
  createDatabaseAccess: (environment, options) =>
    createTeachingSpikeDatabaseAccess(environment, options),
  nowMs: Date.now,
  createRunId: randomUUID,
  resolveTargetMetadata: resolveTeachingSpikeLiveTargetMetadata,
  preregisterPlan: preregisterTeachingSpikeLiveAuthorization,
  loadPlan: loadTeachingSpikeLiveAuthorizationPlan,
  consumeAuthorization: (access, claim) =>
    createTeachingSpikeLivePersistenceDependencies(access).consumeAuthorization(
      claim,
    ),
  resolveRuntime: (access, authorization) =>
    createTeachingSpikeLivePersistenceDependencies(access).resolveRuntime(
      authorization,
    ),
  executeAndBuildEvidence:
    runAuthorizedQwenTeachingLiveCompositionAndBuildEvidence,
  finalizeEvidence: finalizeTeachingSpikeLiveEvidenceReport,
  confirmPlanHash: async ({ prompt }) => {
    const terminal = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });
    try {
      return await terminal.question(prompt);
    } finally {
      terminal.close();
    }
  },
};

export async function runQwenTeachingLiveMain(
  args: string[],
  environment: TeachingSpikeDatabaseEnvironment = process.env,
  io: QwenTeachingLiveMainIo = defaultIo,
  dependencies: QwenTeachingLiveMainDependencies = defaultDependencies,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.writeOutput(`${QWEN_TEACHING_LIVE_CLI_USAGE}\n`);
    return 0;
  }

  let access: TeachingSpikeDatabaseAccess | undefined;
  let exitCode: number;
  try {
    // Validate the complete target and execution flag shape before loading an
    // environment file or opening the isolated database.
    const cliOptions = parseQwenTeachingLiveCliArguments(args);
    dependencies.loadEnvironment();
    access = dependencies.createDatabaseAccess(environment, {
      scope: cliOptions.databaseScope,
    });
    const stableAccess = access;
    const result = await runQwenTeachingLiveCli(
      args,
      {
        inputIsTTY: io.inputIsTTY,
        outputIsTTY: io.outputIsTTY,
        write: io.writeOutput,
      },
      {
        createPreflight: ({ selector }) =>
          createPreflight(stableAccess, selector, dependencies),
        loadPreparedPlan: ({ selector, runId, planHash }) =>
          loadPreparedPlan(
            stableAccess,
            selector,
            { runId, planHash },
            dependencies,
          ),
        confirmPlanHash: dependencies.confirmPlanHash,
        execute: async (request) => {
          const report = await dependencies.executeAndBuildEvidence({
            request,
            dependencies: {
              clock: { readServerTimeMs: dependencies.nowMs },
              consumeAuthorization: (claim) =>
                dependencies.consumeAuthorization(stableAccess, claim),
              resolveRuntime: (authorization) =>
                dependencies.resolveRuntime(stableAccess, authorization),
            },
          });
          const finalization = await dependencies.finalizeEvidence(
            stableAccess,
            report,
          );
          if (
            finalization.status !== "finalized" &&
            finalization.status !== "already_finalized"
          ) {
            throw mainError("EVIDENCE_FINALIZATION_REJECTED");
          }
          return report;
        },
      },
    );
    exitCode =
      result.mode === "execute" && result.report.outcome.status === "failed"
        ? 1
        : 0;
  } catch (error) {
    io.writeError(`Qwen 教学 live Spike 未运行：${safeErrorCode(error)}\n`);
    exitCode = 2;
  } finally {
    if (access) {
      try {
        await access.close();
      } catch {
        io.writeError("Qwen 教学 live Spike 清理失败：DATABASE_CLOSE_FAILED\n");
        exitCode = 2;
      }
    }
  }
  return exitCode;
}

async function createPreflight(
  access: TeachingSpikeDatabaseAccess,
  selector: QwenTeachingLiveTargetSelector,
  dependencies: QwenTeachingLiveMainDependencies,
): Promise<QwenTeachingLivePreparedPlan> {
  const target = await dependencies.resolveTargetMetadata(
    access,
    persistenceSelector(selector),
  );
  const issuedAtMs = dependencies.nowMs();
  const pricing = buildQwenTeachingSpikePricingBinding();
  const plan = buildTeachingSpikeLiveAuthorizationPlan({
    target,
    budgetCny: TEACHING_SPIKE_LIVE_MAX_BUDGET_CNY,
    pricing,
    inputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
    runId: dependencies.createRunId(),
    issuedAtMs,
    expiresAtMs: issuedAtMs + TEACHING_SPIKE_LIVE_MAX_AUTHORIZATION_AGE_MS,
  });
  const registration = await dependencies.preregisterPlan(access, plan);
  if (registration !== "registered" && registration !== "already_registered") {
    throw mainError("PREFLIGHT_REGISTRATION_CONFLICT");
  }
  return {
    plan,
    currentTarget: target,
    currentInputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
    currentPricing: pricing,
  };
}

async function loadPreparedPlan(
  access: TeachingSpikeDatabaseAccess,
  selector: QwenTeachingLiveTargetSelector,
  claim: { runId: string; planHash: string },
  dependencies: QwenTeachingLiveMainDependencies,
): Promise<QwenTeachingLivePreparedPlan> {
  const loaded = await dependencies.loadPlan(access, claim);
  if (loaded.status !== "loaded") {
    throw mainError("PREPARED_PLAN_NOT_AVAILABLE");
  }
  const currentTarget = await dependencies.resolveTargetMetadata(
    access,
    persistenceSelector(selector),
  );
  return {
    plan: loaded.plan,
    currentTarget,
    currentInputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
    currentPricing: buildQwenTeachingSpikePricingBinding(),
  };
}

function persistenceSelector(
  selector: QwenTeachingLiveTargetSelector,
): TeachingSpikeLiveTargetSelector {
  return { provider: "qwen", ...selector };
}

export type QwenTeachingLiveMainErrorCode =
  | "PREFLIGHT_REGISTRATION_CONFLICT"
  | "PREPARED_PLAN_NOT_AVAILABLE"
  | "EVIDENCE_FINALIZATION_REJECTED";

export class QwenTeachingLiveMainError extends Error {
  constructor(readonly code: QwenTeachingLiveMainErrorCode) {
    super(code);
    this.name = "QwenTeachingLiveMainError";
  }
}

function mainError(code: QwenTeachingLiveMainErrorCode) {
  return new QwenTeachingLiveMainError(code);
}

function safeErrorCode(error: unknown): string {
  if (
    error instanceof QwenTeachingLiveMainError ||
    error instanceof QwenTeachingLiveCliError ||
    error instanceof TeachingSpikeDatabaseConfigurationError ||
    error instanceof TeachingSpikeLivePersistenceError ||
    error instanceof TeachingSpikeLiveAuthorizationError ||
    error instanceof QwenTeachingLiveCompositionError ||
    error instanceof QwenTeachingLiveAdapterError ||
    error instanceof RealtimeTeachingLiveEvidenceError
  ) {
    return error.code;
  }
  return "UNEXPECTED_LIVE_SPIKE_ERROR";
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runQwenTeachingLiveMain(process.argv.slice(2));
}
