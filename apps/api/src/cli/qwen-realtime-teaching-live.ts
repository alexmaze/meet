import { createHash } from "node:crypto";

import type {
  TeachingSpikeLiveAuthorizationPlan,
  TeachingSpikeLiveAuthorizationRequest,
  TeachingSpikeLivePricingBinding,
  TeachingSpikeLiveTarget,
} from "../spikes/realtime-teaching/live-authorization.js";
import {
  parseTeachingSpikeLiveAuthorizationPlan,
  teachingSpikeLiveTargetSchema,
} from "../spikes/realtime-teaching/live-authorization.js";
import {
  QWEN_TEACHING_LIVE_MODEL_ID,
  assertQwenTeachingLiveTargetSelector,
  type QwenTeachingLiveTargetSelector,
} from "../spikes/realtime-teaching/qwen-live-composition.js";
import {
  serializeRealtimeTeachingLiveEvidenceReport,
  type RealtimeTeachingLiveEvidenceReport,
} from "../spikes/realtime-teaching/live-evidence-report.js";
import { buildQwenTeachingSpikePricingBinding } from "../spikes/realtime-teaching/pricing.js";

const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const QWEN_TEACHING_LIVE_CLI_USAGE = `用法：
  qwen-realtime-teaching-live \\
    --provider qwen \\
    --model-profile-id <uuid> --model-profile-revision <正整数> \\
    --model-id <模型ID> \\
    --connection-id <uuid> --connection-revision <正整数> \\
    --voice-profile-id <uuid> --voice-profile-revision <正整数> \\
    --voice-id <音色ID> [--use-application-database] [--pretty]

默认仅生成并显示 preflight 计划，不读取 Provider 凭据，也不打开 Socket。
本冒烟固定为文本输入与纯文本输出；3 次响应按官方 Token 上界预留 ¥1.2288，授权硬上限为 ¥2。
默认使用独立 Spike 数据库；--use-application-database 会逐次显式改用 DATABASE_URL，
只读取精确模型配置并只写 teaching_spike_live_authorizations。执行阶段必须重复提供该参数。

执行真实调用还必须在交互式终端中同时提供：
  --live --execute --run-id <preflight 输出的 runId> \\
  --ack-billable <preflight 输出的完整 planHash>

该命令仅允许千问单 Provider，不支持 all，不接受 API Key、Endpoint、Prompt、文本或音频路径参数。`;

export type QwenTeachingLiveCliOptions = {
  mode: "preflight" | "execute";
  databaseScope: "isolated_spike" | "application_database";
  selector: QwenTeachingLiveTargetSelector;
  ackPlanHash?: string;
  runId?: string;
  pretty: boolean;
};

export type QwenTeachingLivePreparedPlan = {
  plan: TeachingSpikeLiveAuthorizationPlan;
  currentTarget: TeachingSpikeLiveTarget;
  currentInputFixtureHash: string;
  currentPricing: TeachingSpikeLivePricingBinding;
};

export type QwenTeachingLiveCliIo = {
  inputIsTTY: boolean;
  outputIsTTY: boolean;
  write(value: string): unknown;
};

export type QwenTeachingLiveCliDependencies = {
  /** Must not read Provider credentials or create network transports. */
  createPreflight(input: {
    selector: QwenTeachingLiveTargetSelector;
    databaseScope: QwenTeachingLiveCliOptions["databaseScope"];
  }): QwenTeachingLivePreparedPlan | Promise<QwenTeachingLivePreparedPlan>;
  /** Must load the preregistered plan by both immutable keys. */
  loadPreparedPlan(input: {
    selector: QwenTeachingLiveTargetSelector;
    databaseScope: QwenTeachingLiveCliOptions["databaseScope"];
    runId: string;
    planHash: string;
  }): QwenTeachingLivePreparedPlan | Promise<QwenTeachingLivePreparedPlan>;
  confirmPlanHash(input: {
    expectedPlanHash: string;
    prompt: string;
  }): string | Promise<string>;
  execute(
    request: TeachingSpikeLiveAuthorizationRequest,
  ):
    | RealtimeTeachingLiveEvidenceReport
    | Promise<RealtimeTeachingLiveEvidenceReport>;
};

export type QwenTeachingLiveCliRunResult =
  | {
      mode: "preflight";
      plan: TeachingSpikeLiveAuthorizationPlan;
    }
  | {
      mode: "execute";
      report: RealtimeTeachingLiveEvidenceReport;
    };

export function parseQwenTeachingLiveCliArguments(
  args: string[],
): QwenTeachingLiveCliOptions {
  const values = new Map<string, string>();
  let live = false;
  let execute = false;
  let pretty = false;
  let useApplicationDatabase = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) throw cliError("UNKNOWN_ARGUMENT");
    if (argument === "--") continue;
    if (argument === "--live") {
      if (live) throw cliError("DUPLICATE_ARGUMENT");
      live = true;
      continue;
    }
    if (argument === "--execute") {
      if (execute) throw cliError("DUPLICATE_ARGUMENT");
      execute = true;
      continue;
    }
    if (argument === "--pretty") {
      if (pretty) throw cliError("DUPLICATE_ARGUMENT");
      pretty = true;
      continue;
    }
    if (argument === "--use-application-database") {
      if (useApplicationDatabase) throw cliError("DUPLICATE_ARGUMENT");
      useApplicationDatabase = true;
      continue;
    }
    if (
      argument === "--api-key" ||
      argument === "--endpoint" ||
      argument === "--prompt" ||
      argument === "--instructions" ||
      argument === "--text" ||
      argument === "--audio"
    ) {
      throw cliError("SENSITIVE_ARGUMENT_FORBIDDEN");
    }
    if (argument === "--all") {
      throw cliError("QWEN_ONLY");
    }
    if (!VALUE_ARGUMENTS.has(argument)) {
      throw cliError("UNKNOWN_ARGUMENT");
    }
    if (values.has(argument)) throw cliError("DUPLICATE_ARGUMENT");
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw cliError("MISSING_ARGUMENT_VALUE");
    }
    values.set(argument, value);
    index += 1;
  }

  const provider = values.get("--provider");
  if (provider === undefined) throw cliError("MISSING_PROVIDER");
  if (provider !== "qwen") {
    throw cliError("QWEN_ONLY");
  }

  const selector: QwenTeachingLiveTargetSelector = {
    modelProfileId: requireUuid(values, "--model-profile-id"),
    modelProfileRevision: requireRevision(values, "--model-profile-revision"),
    modelId: requireIdentifier(values, "--model-id"),
    connectionId: requireUuid(values, "--connection-id"),
    connectionRevision: requireRevision(values, "--connection-revision"),
    voiceProfileId: requireUuid(values, "--voice-profile-id"),
    voiceProfileRevision: requireRevision(values, "--voice-profile-revision"),
    voiceId: requireIdentifier(values, "--voice-id"),
  };
  if (selector.modelId !== QWEN_TEACHING_LIVE_MODEL_ID) {
    throw cliError("INVALID_TARGET_SELECTOR");
  }
  const ackPlanHash = values.get("--ack-billable")?.trim();
  const rawRunId = values.get("--run-id");
  const runId =
    rawRunId === undefined ? undefined : requireUuid(values, "--run-id");
  const anyExecuteFlag =
    live || execute || ackPlanHash !== undefined || runId !== undefined;
  const allExecuteFlags =
    live && execute && ackPlanHash !== undefined && runId !== undefined;
  if (anyExecuteFlag !== allExecuteFlags) {
    throw cliError("EXECUTION_FLAGS_INCOMPLETE");
  }
  if (ackPlanHash !== undefined && !FINGERPRINT_PATTERN.test(ackPlanHash)) {
    throw cliError("INVALID_PLAN_HASH");
  }

  return {
    mode: allExecuteFlags ? "execute" : "preflight",
    databaseScope: useApplicationDatabase
      ? "application_database"
      : "isolated_spike",
    selector,
    ...(ackPlanHash === undefined ? {} : { ackPlanHash }),
    ...(runId === undefined ? {} : { runId }),
    pretty,
  };
}

export async function runQwenTeachingLiveCli(
  args: string[],
  io: QwenTeachingLiveCliIo,
  dependencies: QwenTeachingLiveCliDependencies,
): Promise<QwenTeachingLiveCliRunResult> {
  const options = parseQwenTeachingLiveCliArguments(args);
  if (options.mode === "preflight") {
    const prepared = snapshotPreparedPlan(
      await dependencies.createPreflight({
        selector: options.selector,
        databaseScope: options.databaseScope,
      }),
      options.selector,
      options.databaseScope,
    );
    const output = { mode: "preflight" as const, plan: prepared.plan };
    io.write(`${JSON.stringify(output, null, options.pretty ? 2 : 0)}\n`);
    return output;
  }

  if (!options.runId || !options.ackPlanHash) {
    throw cliError("EXECUTION_FLAGS_INCOMPLETE");
  }
  const prepared = snapshotPreparedPlan(
    await dependencies.loadPreparedPlan({
      selector: options.selector,
      databaseScope: options.databaseScope,
      runId: options.runId,
      planHash: options.ackPlanHash,
    }),
    options.selector,
    options.databaseScope,
  );

  if (
    options.runId !== prepared.plan.runId ||
    options.ackPlanHash !== prepared.plan.planHash
  ) {
    throw cliError("ACK_PLAN_HASH_MISMATCH");
  }
  if (!io.inputIsTTY || !io.outputIsTTY) {
    throw cliError("INTERACTIVE_TTY_REQUIRED");
  }
  const confirmation = (
    await dependencies.confirmPlanHash({
      expectedPlanHash: prepared.plan.planHash,
      prompt: "这是一次可能计费的千问真实调用。请再次输入完整 planHash 确认：",
    })
  ).trim();
  if (confirmation !== prepared.plan.planHash) {
    throw cliError("TTY_CONFIRMATION_MISMATCH");
  }

  const report = await dependencies.execute({
    live: true,
    execute: true,
    interactive: true,
    provider: "qwen",
    ackPlanHash: prepared.plan.planHash,
    plan: prepared.plan,
    currentTarget: prepared.currentTarget,
    currentInputFixtureHash: prepared.currentInputFixtureHash,
    currentPricing: prepared.currentPricing,
  });
  const serializedReport = requireExecutionReport(report, prepared);
  const output = { mode: "execute" as const, report };
  io.write(
    `${JSON.stringify(
      { mode: output.mode, report: JSON.parse(serializedReport) as unknown },
      null,
      options.pretty ? 2 : 0,
    )}\n`,
  );
  return output;
}

const VALUE_ARGUMENTS = new Set([
  "--provider",
  "--model-profile-id",
  "--model-profile-revision",
  "--model-id",
  "--connection-id",
  "--connection-revision",
  "--voice-profile-id",
  "--voice-profile-revision",
  "--voice-id",
  "--run-id",
  "--ack-billable",
]);

function requirePreparedPlan(
  prepared: QwenTeachingLivePreparedPlan,
  selector: QwenTeachingLiveTargetSelector,
  databaseScope: QwenTeachingLiveCliOptions["databaseScope"],
): void {
  const expectedPricing = buildQwenTeachingSpikePricingBinding();
  if (
    prepared.plan.provider !== "qwen" ||
    prepared.plan.target.provider !== "qwen" ||
    prepared.currentTarget.provider !== "qwen" ||
    prepared.plan.target.databaseScope !== databaseScope ||
    prepared.currentTarget.databaseScope !== databaseScope ||
    prepared.plan.inputMode !== "text" ||
    prepared.plan.inputFixtureHash !== prepared.currentInputFixtureHash ||
    prepared.plan.pricing.priceSnapshotHash !==
      prepared.currentPricing.priceSnapshotHash ||
    prepared.plan.pricing.estimatedMaxCostCny !==
      prepared.currentPricing.estimatedMaxCostCny ||
    prepared.plan.pricing.priceSnapshotHash !==
      expectedPricing.priceSnapshotHash ||
    prepared.plan.pricing.estimatedMaxCostCny !==
      expectedPricing.estimatedMaxCostCny
  ) {
    throw cliError("INVALID_PREFLIGHT_PLAN");
  }
  try {
    assertQwenTeachingLiveTargetSelector(prepared.plan.target, selector);
    assertQwenTeachingLiveTargetSelector(prepared.currentTarget, selector);
  } catch {
    throw cliError("INVALID_PREFLIGHT_PLAN");
  }
  if (!sameTarget(prepared.plan.target, prepared.currentTarget)) {
    throw cliError("INVALID_PREFLIGHT_PLAN");
  }
}

function snapshotPreparedPlan(
  input: QwenTeachingLivePreparedPlan,
  selector: QwenTeachingLiveTargetSelector,
  databaseScope: QwenTeachingLiveCliOptions["databaseScope"],
): QwenTeachingLivePreparedPlan {
  try {
    if (typeof input !== "object" || input === null) {
      throw cliError("INVALID_PREFLIGHT_PLAN");
    }
    const plan = parseTeachingSpikeLiveAuthorizationPlan(input.plan);
    const currentTarget = teachingSpikeLiveTargetSchema.parse(
      input.currentTarget,
    );
    if (
      typeof input.currentInputFixtureHash !== "string" ||
      !FINGERPRINT_PATTERN.test(input.currentInputFixtureHash) ||
      typeof input.currentPricing !== "object" ||
      input.currentPricing === null ||
      canonicalJson(Object.keys(input.currentPricing).sort()) !==
        canonicalJson(["estimatedMaxCostCny", "priceSnapshotHash"])
    ) {
      throw cliError("INVALID_PREFLIGHT_PLAN");
    }
    const currentPricing = {
      priceSnapshotHash: input.currentPricing.priceSnapshotHash,
      estimatedMaxCostCny: input.currentPricing.estimatedMaxCostCny,
    };
    const snapshot = deepFreeze({
      plan,
      currentTarget,
      currentInputFixtureHash: input.currentInputFixtureHash,
      currentPricing,
    });
    requirePreparedPlan(snapshot, selector, databaseScope);
    return snapshot;
  } catch (error) {
    if (
      error instanceof QwenTeachingLiveCliError &&
      error.code === "INVALID_PREFLIGHT_PLAN"
    ) {
      throw error;
    }
    throw cliError("INVALID_PREFLIGHT_PLAN");
  }
}

function sameTarget(
  left: TeachingSpikeLiveTarget,
  right: TeachingSpikeLiveTarget,
): boolean {
  return (
    left.provider === right.provider &&
    left.modelId === right.modelId &&
    left.voiceId === right.voiceId &&
    left.modelProfileId === right.modelProfileId &&
    left.modelProfileRevision === right.modelProfileRevision &&
    left.connectionId === right.connectionId &&
    left.connectionRevision === right.connectionRevision &&
    left.voiceProfileId === right.voiceProfileId &&
    left.voiceProfileRevision === right.voiceProfileRevision &&
    left.endpointFingerprint === right.endpointFingerprint &&
    left.databaseScope === right.databaseScope &&
    left.databaseFingerprint === right.databaseFingerprint
  );
}

function requireExecutionReport(
  report: RealtimeTeachingLiveEvidenceReport,
  prepared: QwenTeachingLivePreparedPlan,
): string {
  let serialized: string;
  try {
    serialized = serializeRealtimeTeachingLiveEvidenceReport(report);
  } catch {
    throw cliError("INVALID_EXECUTION_RESULT");
  }
  const plan = prepared.plan;
  if (
    report.provider !== "qwen" ||
    report.inputMode !== "text" ||
    report.runId !== plan.runId ||
    report.planHash !== plan.planHash ||
    report.inputFixtureHash !== plan.inputFixtureHash ||
    report.priceSnapshotHash !== plan.pricing.priceSnapshotHash ||
    report.target.fingerprint !== fingerprintTarget(plan.target) ||
    report.target.modelProfileRevision !== plan.target.modelProfileRevision ||
    report.target.connectionRevision !== plan.target.connectionRevision ||
    report.target.voiceProfileRevision !== plan.target.voiceProfileRevision ||
    report.budget.authorizedCny !== plan.limits.budgetCny ||
    report.budget.preflightEstimatedMaximumCny !==
      plan.pricing.estimatedMaxCostCny ||
    (report.outcome.status === "protocol_sequence_completed"
      ? report.providerEvidence !== true
      : report.providerEvidence !== false)
  ) {
    throw cliError("INVALID_EXECUTION_RESULT");
  }
  return serialized;
}

function fingerprintTarget(target: TeachingSpikeLiveTarget): string {
  return createHash("sha256")
    .update(canonicalJson(target), "utf8")
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function requireUuid(values: Map<string, string>, key: string): string {
  const value = requireValue(values, key);
  if (!UUID_PATTERN.test(value)) throw cliError("INVALID_TARGET_SELECTOR");
  return value.toLowerCase();
}

function requireRevision(values: Map<string, string>, key: string): number {
  const value = Number(requireValue(values, key));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw cliError("INVALID_TARGET_SELECTOR");
  }
  return value;
}

function requireIdentifier(values: Map<string, string>, key: string): string {
  const value = requireValue(values, key).trim();
  if (!value || value.length > 160) {
    throw cliError("INVALID_TARGET_SELECTOR");
  }
  return value;
}

function requireValue(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined) throw cliError("MISSING_TARGET_SELECTOR");
  return value;
}

export type QwenTeachingLiveCliErrorCode =
  | "UNKNOWN_ARGUMENT"
  | "DUPLICATE_ARGUMENT"
  | "MISSING_ARGUMENT_VALUE"
  | "MISSING_PROVIDER"
  | "MISSING_TARGET_SELECTOR"
  | "INVALID_TARGET_SELECTOR"
  | "SENSITIVE_ARGUMENT_FORBIDDEN"
  | "QWEN_ONLY"
  | "EXECUTION_FLAGS_INCOMPLETE"
  | "INVALID_PLAN_HASH"
  | "INVALID_PREFLIGHT_PLAN"
  | "ACK_PLAN_HASH_MISMATCH"
  | "INTERACTIVE_TTY_REQUIRED"
  | "TTY_CONFIRMATION_MISMATCH"
  | "INVALID_EXECUTION_RESULT";

export class QwenTeachingLiveCliError extends Error {
  constructor(readonly code: QwenTeachingLiveCliErrorCode) {
    super(code);
    this.name = "QwenTeachingLiveCliError";
  }
}

function cliError(
  code: QwenTeachingLiveCliErrorCode,
): QwenTeachingLiveCliError {
  return new QwenTeachingLiveCliError(code);
}
