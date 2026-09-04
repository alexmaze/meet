import { createHash } from "node:crypto";

import { z } from "zod";

import {
  TEACHING_SPIKE_FIXTURE_HASH,
  TEACHING_SPIKE_FIXTURE_REVISION,
  TEACHING_SPIKE_USER_TEXT_HASH,
} from "./fixtures.js";

export const TEACHING_SPIKE_LIVE_AUTHORIZATION_SCHEMA_VERSION = 2 as const;
export const TEACHING_SPIKE_LIVE_STAGE = "protocol-smoke-live" as const;
export const TEACHING_SPIKE_LIVE_RUNNER_REVISION = "2026-08-15.10";
export const TEACHING_SPIKE_LIVE_MAX_SESSIONS = 2 as const;
export const TEACHING_SPIKE_LIVE_MAX_RESPONSE_ATTEMPTS = 3 as const;
export const TEACHING_SPIKE_LIVE_MAX_INPUT_MS = 5_000 as const;
export const TEACHING_SPIKE_LIVE_MAX_OUTPUT_MS = 15_000 as const;
export const TEACHING_SPIKE_LIVE_MAX_BUDGET_CNY = 2;
export const TEACHING_SPIKE_LIVE_MAX_AUTHORIZATION_AGE_MS = 10 * 60 * 1_000;

export const TEACHING_SPIKE_QWEN_LIVE_CASE_IDS = Object.freeze([
  "D01T",
  "D02T",
  "D03T",
] as const);
export const TEACHING_SPIKE_DOUBAO_LIVE_CASE_IDS = Object.freeze([
  "D01",
  "D02",
  "D03",
] as const);

export const TEACHING_SPIKE_LIVE_TIMEOUTS = Object.freeze({
  connectMs: 15_000,
  updateAckMs: 5_000,
  responseMs: 20_000,
  totalRunMs: 180_000,
});

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampMsSchema = z.number().int().nonnegative().safe();
const providerSchema = z.enum(["qwen", "doubao"]);

export const teachingSpikeLiveTargetSchema = z
  .object({
    provider: providerSchema,
    modelId: z.string().trim().min(1).max(160),
    voiceId: z.string().trim().min(1).max(160),
    modelProfileId: z.uuid(),
    modelProfileRevision: z.number().int().positive(),
    connectionId: z.uuid(),
    connectionRevision: z.number().int().positive(),
    voiceProfileId: z.uuid(),
    voiceProfileRevision: z.number().int().positive(),
    endpointFingerprint: fingerprintSchema,
    databaseScope: z.enum(["isolated_spike", "application_database"]),
    databaseFingerprint: fingerprintSchema,
  })
  .strict();

export type TeachingSpikeLiveProvider = z.infer<typeof providerSchema>;
export type TeachingSpikeLiveTarget = z.infer<
  typeof teachingSpikeLiveTargetSchema
>;

const budgetCnySchema = z
  .number()
  .finite()
  .positive()
  .max(TEACHING_SPIKE_LIVE_MAX_BUDGET_CNY)
  .refine((value) => Number.isSafeInteger(value * 100), {
    message: "budgetCny 最多保留两位小数。",
  });

const estimatedCostCnySchema = z
  .number()
  .finite()
  .positive()
  .max(TEACHING_SPIKE_LIVE_MAX_BUDGET_CNY)
  .refine((value) => Number.isSafeInteger(value * 1_000_000), {
    message: "estimatedMaxCostCny 最多保留六位小数。",
  });

const livePricingBindingSchema = z
  .object({
    priceSnapshotHash: fingerprintSchema,
    estimatedMaxCostCny: estimatedCostCnySchema,
  })
  .strict();

export type TeachingSpikeLivePricingBinding = z.infer<
  typeof livePricingBindingSchema
>;

const liveTimeoutsSchema = z
  .object({
    connectMs: z.literal(TEACHING_SPIKE_LIVE_TIMEOUTS.connectMs),
    updateAckMs: z.literal(TEACHING_SPIKE_LIVE_TIMEOUTS.updateAckMs),
    responseMs: z.literal(TEACHING_SPIKE_LIVE_TIMEOUTS.responseMs),
    totalRunMs: z.literal(TEACHING_SPIKE_LIVE_TIMEOUTS.totalRunMs),
  })
  .strict();

const livePlanLimitsSchema = z
  .object({
    maxSessions: z.literal(TEACHING_SPIKE_LIVE_MAX_SESSIONS),
    maxResponseAttempts: z.literal(TEACHING_SPIKE_LIVE_MAX_RESPONSE_ATTEMPTS),
    maxInputMs: z.literal(TEACHING_SPIKE_LIVE_MAX_INPUT_MS),
    maxOutputMs: z.literal(TEACHING_SPIKE_LIVE_MAX_OUTPUT_MS),
    budgetCny: budgetCnySchema,
    timeouts: liveTimeoutsSchema,
  })
  .strict();

const liveCaseIdsSchema = z.union([
  z.tuple([z.literal("D01T"), z.literal("D02T"), z.literal("D03T")]),
  z.tuple([z.literal("D01"), z.literal("D02"), z.literal("D03")]),
]);

const livePlanSchema = z
  .object({
    schemaVersion: z.literal(TEACHING_SPIKE_LIVE_AUTHORIZATION_SCHEMA_VERSION),
    runId: z.uuid(),
    issuedAtMs: timestampMsSchema,
    expiresAtMs: timestampMsSchema,
    stage: z.literal(TEACHING_SPIKE_LIVE_STAGE),
    provider: providerSchema,
    inputMode: z.enum(["text", "pcm16le"]),
    inputFixtureHash: fingerprintSchema,
    caseIds: liveCaseIdsSchema,
    target: teachingSpikeLiveTargetSchema,
    fixtureRevision: z.string().min(1).max(80),
    fixtureHash: fingerprintSchema,
    runnerRevision: z.string().min(1).max(80),
    pricing: livePricingBindingSchema,
    limits: livePlanLimitsSchema,
    planHash: fingerprintSchema,
  })
  .strict();

export type TeachingSpikeLiveAuthorizationPlan = z.infer<typeof livePlanSchema>;

export type TeachingSpikeLiveAuthorizationRequest = {
  live: boolean;
  execute: boolean;
  interactive: boolean;
  provider: TeachingSpikeLiveProvider | "all";
  ackPlanHash: string;
  plan: TeachingSpikeLiveAuthorizationPlan;
  currentTarget: TeachingSpikeLiveTarget;
  currentInputFixtureHash: string;
  currentPricing: TeachingSpikeLivePricingBinding;
};

export type TeachingSpikeLiveAuthorization = {
  authorized: true;
  runId: string;
  provider: TeachingSpikeLiveProvider;
  planHash: string;
  inputMode: TeachingSpikeLiveAuthorizationPlan["inputMode"];
  inputFixtureHash: string;
  expiresAtMs: number;
  caseIds: TeachingSpikeLiveAuthorizationPlan["caseIds"];
  target: TeachingSpikeLiveTarget;
  pricing: TeachingSpikeLivePricingBinding;
  limits: TeachingSpikeLiveAuthorizationPlan["limits"];
};

export type TeachingSpikeLiveAuthorizationClock = Readonly<{
  readServerTimeMs: () => number;
}>;

export type TeachingSpikeLiveAuthorizationConsumptionClaim = Readonly<{
  runId: string;
  planHash: string;
  expiresAtMs: number;
}>;

export type TeachingSpikeLiveAuthorizationConsumptionResult =
  "consumed" | "already_consumed" | "expired" | "claim_mismatch";

export function buildTeachingSpikeLiveAuthorizationPlan(input: {
  target: TeachingSpikeLiveTarget;
  budgetCny: number;
  pricing: TeachingSpikeLivePricingBinding;
  inputFixtureHash: string;
  runId: string;
  issuedAtMs: number;
  expiresAtMs: number;
}): TeachingSpikeLiveAuthorizationPlan {
  const target = parseTarget(input.target);
  const budgetCny = parseBudget(input.budgetCny);
  const pricing = parsePricing(input.pricing, budgetCny);
  const inputFixtureHash = parseFingerprint(input.inputFixtureHash);
  const authorizationWindow = parseAuthorizationWindow(input);
  const unsigned = buildUnsignedPlan(
    target,
    budgetCny,
    pricing,
    inputFixtureHash,
    authorizationWindow,
  );
  return deepFreeze({
    ...unsigned,
    planHash: hashCanonical(unsigned),
  });
}

export function authorizeTeachingSpikeLiveExecution(
  request: TeachingSpikeLiveAuthorizationRequest,
  clock: TeachingSpikeLiveAuthorizationClock,
): TeachingSpikeLiveAuthorization {
  if (request.live !== true) {
    throw authorizationError("LIVE_CONFIRMATION_REQUIRED");
  }
  if (request.execute !== true) {
    throw authorizationError("EXECUTE_CONFIRMATION_REQUIRED");
  }
  if (request.interactive !== true) {
    throw authorizationError("INTERACTIVE_CONFIRMATION_REQUIRED");
  }
  if (request.provider === "all") {
    throw authorizationError("ALL_PROVIDERS_FORBIDDEN");
  }

  const plan = parseTeachingSpikeLiveAuthorizationPlan(request.plan);
  const nowMs = readServerTime(clock);
  if (nowMs < plan.issuedAtMs || nowMs >= plan.expiresAtMs) {
    throw authorizationError("AUTHORIZATION_EXPIRED");
  }
  if (request.provider !== plan.provider) {
    throw authorizationError("PROVIDER_MISMATCH");
  }

  const currentTarget = parseTarget(request.currentTarget);
  if (canonicalJson(currentTarget) !== canonicalJson(plan.target)) {
    throw authorizationError("STALE_TARGET");
  }
  const currentInputFixtureHash = parseFingerprint(
    request.currentInputFixtureHash,
  );
  if (currentInputFixtureHash !== plan.inputFixtureHash) {
    throw authorizationError("STALE_INPUT_FIXTURE");
  }
  if (request.ackPlanHash !== plan.planHash) {
    throw authorizationError("ACK_PLAN_HASH_MISMATCH");
  }
  const currentPricing = parsePricing(
    request.currentPricing,
    plan.limits.budgetCny,
  );
  if (canonicalJson(currentPricing) !== canonicalJson(plan.pricing)) {
    throw authorizationError("STALE_PRICING");
  }

  return deepFreeze({
    authorized: true as const,
    runId: plan.runId,
    provider: plan.provider,
    planHash: plan.planHash,
    inputMode: plan.inputMode,
    inputFixtureHash: plan.inputFixtureHash,
    expiresAtMs: plan.expiresAtMs,
    caseIds: plan.caseIds,
    target: plan.target,
    pricing: plan.pricing,
    limits: plan.limits,
  });
}

export function parseTeachingSpikeLiveAuthorizationPlan(
  input: unknown,
): TeachingSpikeLiveAuthorizationPlan {
  const plan = parsePlan(input);
  verifyPlanIntegrity(plan);
  return deepFreeze(plan);
}

export async function runWithTeachingSpikeLiveAuthorization<Credential, Result>(
  request: TeachingSpikeLiveAuthorizationRequest,
  dependencies: {
    clock: TeachingSpikeLiveAuthorizationClock;
    /**
     * Must atomically match runId, planHash, and expiresAtMs against the
     * preregistered authorization; reject an expired claim using a trusted
     * server/storage clock; reject a consumed runId; or record the runId
     * before returning `consumed`.
     */
    consumeAuthorization: (
      claim: TeachingSpikeLiveAuthorizationConsumptionClaim,
    ) =>
      | TeachingSpikeLiveAuthorizationConsumptionResult
      | Promise<TeachingSpikeLiveAuthorizationConsumptionResult>;
    readCredential: (
      authorization: TeachingSpikeLiveAuthorization,
    ) => Credential | Promise<Credential>;
    openSocket: (input: {
      authorization: TeachingSpikeLiveAuthorization;
      credential: Credential;
    }) => Result | Promise<Result>;
  },
): Promise<Result> {
  const authorization = authorizeTeachingSpikeLiveExecution(
    request,
    dependencies.clock,
  );
  const consumptionResult = await dependencies.consumeAuthorization(
    deepFreeze({
      runId: authorization.runId,
      planHash: authorization.planHash,
      expiresAtMs: authorization.expiresAtMs,
    }),
  );
  if (consumptionResult === "expired") {
    throw authorizationError("AUTHORIZATION_EXPIRED");
  }
  if (consumptionResult === "claim_mismatch") {
    throw authorizationError("AUTHORIZATION_CLAIM_MISMATCH");
  }
  if (consumptionResult !== "consumed") {
    throw authorizationError("AUTHORIZATION_ALREADY_CONSUMED");
  }
  assertAuthorizationUnexpired(authorization, dependencies.clock);
  const credential = await dependencies.readCredential(authorization);
  assertAuthorizationUnexpired(authorization, dependencies.clock);
  return await dependencies.openSocket({ authorization, credential });
}

export type TeachingSpikeLiveAuthorizationErrorCode =
  | "INVALID_TARGET"
  | "INVALID_BUDGET"
  | "INVALID_PRICING"
  | "INVALID_INPUT_FIXTURE"
  | "INVALID_AUTHORIZATION_WINDOW"
  | "INVALID_PLAN"
  | "PLAN_HASH_MISMATCH"
  | "STALE_PLAN_REVISION"
  | "LIVE_CONFIRMATION_REQUIRED"
  | "EXECUTE_CONFIRMATION_REQUIRED"
  | "INTERACTIVE_CONFIRMATION_REQUIRED"
  | "AUTHORIZATION_EXPIRED"
  | "AUTHORIZATION_ALREADY_CONSUMED"
  | "AUTHORIZATION_CLAIM_MISMATCH"
  | "ALL_PROVIDERS_FORBIDDEN"
  | "PROVIDER_MISMATCH"
  | "STALE_TARGET"
  | "STALE_INPUT_FIXTURE"
  | "STALE_PRICING"
  | "ACK_PLAN_HASH_MISMATCH";

export class TeachingSpikeLiveAuthorizationError extends Error {
  constructor(public readonly code: TeachingSpikeLiveAuthorizationErrorCode) {
    super(code);
    this.name = "TeachingSpikeLiveAuthorizationError";
  }
}

function buildUnsignedPlan(
  target: TeachingSpikeLiveTarget,
  budgetCny: number,
  pricing: TeachingSpikeLivePricingBinding,
  inputFixtureHash: string,
  authorizationWindow: {
    runId: string;
    issuedAtMs: number;
    expiresAtMs: number;
  },
): Omit<TeachingSpikeLiveAuthorizationPlan, "planHash"> {
  const evidence = evidenceProfile(target.provider);
  if (
    target.provider === "qwen" &&
    inputFixtureHash !== TEACHING_SPIKE_USER_TEXT_HASH
  ) {
    throw authorizationError("INVALID_INPUT_FIXTURE");
  }
  return {
    schemaVersion: TEACHING_SPIKE_LIVE_AUTHORIZATION_SCHEMA_VERSION,
    ...authorizationWindow,
    stage: TEACHING_SPIKE_LIVE_STAGE,
    provider: target.provider,
    inputMode: evidence.inputMode,
    inputFixtureHash,
    caseIds: evidence.caseIds,
    target,
    fixtureRevision: TEACHING_SPIKE_FIXTURE_REVISION,
    fixtureHash: TEACHING_SPIKE_FIXTURE_HASH,
    runnerRevision: TEACHING_SPIKE_LIVE_RUNNER_REVISION,
    pricing,
    limits: {
      maxSessions: TEACHING_SPIKE_LIVE_MAX_SESSIONS,
      maxResponseAttempts: TEACHING_SPIKE_LIVE_MAX_RESPONSE_ATTEMPTS,
      maxInputMs: TEACHING_SPIKE_LIVE_MAX_INPUT_MS,
      maxOutputMs: TEACHING_SPIKE_LIVE_MAX_OUTPUT_MS,
      budgetCny,
      timeouts: { ...TEACHING_SPIKE_LIVE_TIMEOUTS },
    },
  };
}

function parsePricing(
  input: unknown,
  budgetCny: number,
): TeachingSpikeLivePricingBinding {
  const parsed = livePricingBindingSchema.safeParse(input);
  if (!parsed.success || parsed.data.estimatedMaxCostCny > budgetCny) {
    throw authorizationError("INVALID_PRICING");
  }
  return parsed.data;
}

function parseTarget(input: unknown): TeachingSpikeLiveTarget {
  const parsed = teachingSpikeLiveTargetSchema.safeParse(input);
  if (!parsed.success) throw authorizationError("INVALID_TARGET");
  return parsed.data;
}

function parseBudget(input: unknown): number {
  const parsed = budgetCnySchema.safeParse(input);
  if (!parsed.success) throw authorizationError("INVALID_BUDGET");
  return parsed.data;
}

function parseFingerprint(input: unknown): string {
  const parsed = fingerprintSchema.safeParse(input);
  if (!parsed.success) throw authorizationError("INVALID_INPUT_FIXTURE");
  return parsed.data;
}

function parseAuthorizationWindow(input: {
  runId: string;
  issuedAtMs: number;
  expiresAtMs: number;
}): { runId: string; issuedAtMs: number; expiresAtMs: number } {
  const runId = z.uuid().safeParse(input.runId);
  const issuedAtMs = timestampMsSchema.safeParse(input.issuedAtMs);
  const expiresAtMs = timestampMsSchema.safeParse(input.expiresAtMs);
  if (
    !runId.success ||
    !issuedAtMs.success ||
    !expiresAtMs.success ||
    expiresAtMs.data <= issuedAtMs.data ||
    expiresAtMs.data - issuedAtMs.data >
      TEACHING_SPIKE_LIVE_MAX_AUTHORIZATION_AGE_MS
  ) {
    throw authorizationError("INVALID_AUTHORIZATION_WINDOW");
  }
  return {
    runId: runId.data,
    issuedAtMs: issuedAtMs.data,
    expiresAtMs: expiresAtMs.data,
  };
}

function readServerTime(clock: TeachingSpikeLiveAuthorizationClock): number {
  const parsed = timestampMsSchema.safeParse(clock.readServerTimeMs());
  if (!parsed.success) throw authorizationError("AUTHORIZATION_EXPIRED");
  return parsed.data;
}

function assertAuthorizationUnexpired(
  authorization: TeachingSpikeLiveAuthorization,
  clock: TeachingSpikeLiveAuthorizationClock,
): void {
  if (readServerTime(clock) >= authorization.expiresAtMs) {
    throw authorizationError("AUTHORIZATION_EXPIRED");
  }
}

function parsePlan(input: unknown): TeachingSpikeLiveAuthorizationPlan {
  const parsed = livePlanSchema.safeParse(input);
  if (!parsed.success) throw authorizationError("INVALID_PLAN");
  return parsed.data;
}

function verifyPlanIntegrity(plan: TeachingSpikeLiveAuthorizationPlan): void {
  parseAuthorizationWindow(plan);
  parsePricing(plan.pricing, plan.limits.budgetCny);
  if (
    plan.fixtureRevision !== TEACHING_SPIKE_FIXTURE_REVISION ||
    plan.fixtureHash !== TEACHING_SPIKE_FIXTURE_HASH ||
    plan.runnerRevision !== TEACHING_SPIKE_LIVE_RUNNER_REVISION
  ) {
    throw authorizationError("STALE_PLAN_REVISION");
  }
  if (plan.provider !== plan.target.provider) {
    throw authorizationError("PROVIDER_MISMATCH");
  }
  const evidence = evidenceProfile(plan.provider);
  if (
    plan.inputMode !== evidence.inputMode ||
    canonicalJson(plan.caseIds) !== canonicalJson(evidence.caseIds)
  ) {
    throw authorizationError("INVALID_PLAN");
  }
  if (
    plan.provider === "qwen" &&
    plan.inputFixtureHash !== TEACHING_SPIKE_USER_TEXT_HASH
  ) {
    throw authorizationError("INVALID_PLAN");
  }

  const { planHash: _planHash, ...unsigned } = plan;
  if (hashCanonical(unsigned) !== plan.planHash) {
    throw authorizationError("PLAN_HASH_MISMATCH");
  }
}

function evidenceProfile(provider: TeachingSpikeLiveProvider):
  | {
      inputMode: "text";
      caseIds: ["D01T", "D02T", "D03T"];
    }
  | {
      inputMode: "pcm16le";
      caseIds: ["D01", "D02", "D03"];
    } {
  if (provider === "qwen") {
    return {
      inputMode: "text",
      caseIds: [...TEACHING_SPIKE_QWEN_LIVE_CASE_IDS],
    };
  }
  return {
    inputMode: "pcm16le",
    caseIds: [...TEACHING_SPIKE_DOUBAO_LIVE_CASE_IDS],
  };
}

function hashCanonical(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
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

function authorizationError(
  code: TeachingSpikeLiveAuthorizationErrorCode,
): TeachingSpikeLiveAuthorizationError {
  return new TeachingSpikeLiveAuthorizationError(code);
}
