import { createHash } from "node:crypto";

import {
  aiWorkItems,
  characterMemories,
  characters,
  conversationMessages,
  conversationRuntimeSnapshots,
  conversationSummaries,
  conversationSummaryCheckpoints,
  conversations,
  mediaObjects,
  memoryIndexEntries,
  modelConnections,
  providerProfiles,
  teachingSpikeLiveAuthorizations,
  type Database,
  userAccounts,
  voiceProfiles,
} from "@meet/database";
import { and, count, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { DOUBAO_REALTIME_WEBSOCKET_URL } from "../../doubao-websocket.js";
import {
  parseTeachingSpikeLiveAuthorizationPlan,
  runWithTeachingSpikeLiveAuthorization,
  teachingSpikeLiveTargetSchema,
  type TeachingSpikeLiveAuthorization,
  type TeachingSpikeLiveAuthorizationClock,
  type TeachingSpikeLiveAuthorizationConsumptionClaim,
  type TeachingSpikeLiveAuthorizationConsumptionResult,
  type TeachingSpikeLiveAuthorizationPlan,
  type TeachingSpikeLiveAuthorizationRequest,
  type TeachingSpikeLiveProvider,
  type TeachingSpikeLiveTarget,
} from "./live-authorization.js";
import { qwenTeachingLiveWebSocketEndpointFingerprint } from "./qwen-live-composition.js";
import {
  serializeRealtimeTeachingLiveEvidenceReport,
  type RealtimeTeachingLiveEvidenceReport,
} from "./live-evidence-report.js";
import type { TeachingSpikeDatabaseAccess } from "./teaching-spike-database.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type TeachingSpikeLiveAuthorizationRegistrationResult =
  "registered" | "already_registered" | "registration_conflict";

export type TeachingSpikeLiveAuthorizationPlanLoadResult =
  | Readonly<{
      status: "loaded";
      plan: TeachingSpikeLiveAuthorizationPlan;
    }>
  | Readonly<{
      status: "not_found" | "claim_mismatch" | "already_consumed" | "expired";
    }>;

export type TeachingSpikeLiveEvidenceFinalizationResult =
  | Readonly<{
      status: "finalized" | "already_finalized";
      reportHash: string;
      finishedAtMs: number;
    }>
  | Readonly<{
      status:
        "claim_mismatch" | "authorization_not_consumed" | "report_conflict";
    }>;

export type TeachingSpikeLiveTargetSelector = Pick<
  TeachingSpikeLiveTarget,
  | "provider"
  | "modelProfileId"
  | "modelProfileRevision"
  | "modelId"
  | "connectionId"
  | "connectionRevision"
  | "voiceProfileId"
  | "voiceProfileRevision"
  | "voiceId"
>;

export type TeachingSpikeResolvedLiveTarget = Readonly<{
  target: TeachingSpikeLiveTarget;
  endpoint: string;
  apiKey: string;
}>;

export type TeachingSpikeLivePersistenceErrorCode =
  | "INVALID_AUTHORIZATION_REGISTRATION"
  | "AUTHORIZATION_REGISTRATION_NOT_CURRENT"
  | "AUTHORIZATION_STORE_UNAVAILABLE"
  | "DATABASE_ISOLATION_VIOLATION"
  | "DATABASE_ISOLATION_AUDIT_FAILED"
  | "AUTHORIZATION_NOT_CONSUMED_OR_EXPIRED"
  | "EVIDENCE_REPORT_INVALID"
  | "EVIDENCE_FINALIZATION_FAILED"
  | "TARGET_NOT_ACTIVE"
  | "TARGET_RESOLUTION_FAILED";

export class TeachingSpikeLivePersistenceError extends Error {
  constructor(public readonly code: TeachingSpikeLivePersistenceErrorCode) {
    super(code);
    this.name = "TeachingSpikeLivePersistenceError";
  }
}

export async function preregisterTeachingSpikeLiveAuthorization(
  access: TeachingSpikeDatabaseAccess,
  input: TeachingSpikeLiveAuthorizationPlan,
): Promise<TeachingSpikeLiveAuthorizationRegistrationResult> {
  const plan = parsePlanForStorage(input);
  await auditTeachingSpikeDatabaseIsolation(access);
  const databaseNowMs = await readTeachingSpikeDatabaseTime(access);
  if (databaseNowMs < plan.issuedAtMs || databaseNowMs >= plan.expiresAtMs) {
    throw persistenceError("AUTHORIZATION_REGISTRATION_NOT_CURRENT");
  }
  try {
    const inserted = await access.db
      .insert(teachingSpikeLiveAuthorizations)
      .values({
        runId: plan.runId,
        planHash: plan.planHash,
        planJson: plan,
        expiresAt: new Date(plan.expiresAtMs),
      })
      .onConflictDoNothing({ target: teachingSpikeLiveAuthorizations.runId })
      .returning({ runId: teachingSpikeLiveAuthorizations.runId });
    if (inserted.length === 1) return "registered";

    const [existing] = await access.db
      .select({
        runId: teachingSpikeLiveAuthorizations.runId,
        planHash: teachingSpikeLiveAuthorizations.planHash,
        planJson: teachingSpikeLiveAuthorizations.planJson,
        expiresAt: teachingSpikeLiveAuthorizations.expiresAt,
      })
      .from(teachingSpikeLiveAuthorizations)
      .where(eq(teachingSpikeLiveAuthorizations.runId, plan.runId))
      .limit(1);
    if (!existing) {
      throw persistenceError("AUTHORIZATION_STORE_UNAVAILABLE");
    }
    const existingPlan = parseStoredPlan(existing.planJson);
    return existing.runId === plan.runId &&
      existing.planHash === plan.planHash &&
      existingPlan.planHash === plan.planHash &&
      validDateMs(existing.expiresAt) === plan.expiresAtMs
      ? "already_registered"
      : "registration_conflict";
  } catch (error) {
    if (error instanceof TeachingSpikeLivePersistenceError) throw error;
    throw persistenceError("AUTHORIZATION_STORE_UNAVAILABLE");
  }
}

export async function auditTeachingSpikeDatabaseIsolation(
  access: TeachingSpikeDatabaseAccess,
): Promise<
  Readonly<{
    status: "isolated" | "application_database_explicitly_selected";
  }>
> {
  if (access.databaseScope === "application_database") {
    return Object.freeze({
      status: "application_database_explicitly_selected" as const,
    });
  }
  try {
    return await access.db.transaction(
      async (tx) => {
        const accounts = await tx
          .select({
            accountType: userAccounts.accountType,
            status: userAccounts.status,
          })
          .from(userAccounts)
          .limit(2);
        if (
          accounts.length !== 1 ||
          accounts[0]?.accountType !== "admin" ||
          accounts[0].status !== "active"
        ) {
          throw persistenceError("DATABASE_ISOLATION_VIOLATION");
        }

        const counts = await Promise.all([
          tx.select({ value: count() }).from(characters).limit(1),
          tx.select({ value: count() }).from(conversations).limit(1),
          tx
            .select({ value: count() })
            .from(conversationRuntimeSnapshots)
            .limit(1),
          tx.select({ value: count() }).from(conversationMessages).limit(1),
          tx.select({ value: count() }).from(mediaObjects).limit(1),
          tx.select({ value: count() }).from(aiWorkItems).limit(1),
          tx.select({ value: count() }).from(conversationSummaries).limit(1),
          tx
            .select({ value: count() })
            .from(conversationSummaryCheckpoints)
            .limit(1),
          tx.select({ value: count() }).from(characterMemories).limit(1),
          tx.select({ value: count() }).from(memoryIndexEntries).limit(1),
        ]);
        if (
          counts.some((rows) => {
            const value = rows[0]?.value;
            return value === undefined || Number(value) !== 0;
          })
        ) {
          throw persistenceError("DATABASE_ISOLATION_VIOLATION");
        }
        return Object.freeze({ status: "isolated" as const });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  } catch (error) {
    if (error instanceof TeachingSpikeLivePersistenceError) throw error;
    throw persistenceError("DATABASE_ISOLATION_AUDIT_FAILED");
  }
}

export async function loadTeachingSpikeLiveAuthorizationPlan(
  access: TeachingSpikeDatabaseAccess,
  selector: Readonly<{ runId: string; planHash: string }>,
): Promise<TeachingSpikeLiveAuthorizationPlanLoadResult> {
  if (
    !UUID_PATTERN.test(selector.runId) ||
    !SHA256_PATTERN.test(selector.planHash)
  ) {
    return Object.freeze({ status: "claim_mismatch" as const });
  }
  const runId = selector.runId.toLowerCase();
  await auditTeachingSpikeDatabaseIsolation(access);

  try {
    return await access.db.transaction(async (tx) => {
      const [stored] = await tx
        .select({
          runId: teachingSpikeLiveAuthorizations.runId,
          planHash: teachingSpikeLiveAuthorizations.planHash,
          planJson: teachingSpikeLiveAuthorizations.planJson,
          expiresAt: teachingSpikeLiveAuthorizations.expiresAt,
          consumedAt: teachingSpikeLiveAuthorizations.consumedAt,
        })
        .from(teachingSpikeLiveAuthorizations)
        .where(eq(teachingSpikeLiveAuthorizations.runId, runId))
        .for("share")
        .limit(1);
      if (!stored) return Object.freeze({ status: "not_found" as const });
      if (stored.runId !== runId || stored.planHash !== selector.planHash) {
        return Object.freeze({ status: "claim_mismatch" as const });
      }

      const plan = parseStoredPlan(stored.planJson);
      if (
        plan.runId !== stored.runId ||
        plan.planHash !== stored.planHash ||
        plan.expiresAtMs !== validDateMs(stored.expiresAt)
      ) {
        throw persistenceError("AUTHORIZATION_STORE_UNAVAILABLE");
      }
      if (stored.consumedAt) {
        return Object.freeze({ status: "already_consumed" as const });
      }

      const databaseNowMs = await readDatabaseTimeMs(tx);
      if (
        databaseNowMs < plan.issuedAtMs ||
        databaseNowMs >= plan.expiresAtMs
      ) {
        return Object.freeze({ status: "expired" as const });
      }
      return Object.freeze({ status: "loaded" as const, plan });
    });
  } catch (error) {
    if (error instanceof TeachingSpikeLivePersistenceError) throw error;
    throw persistenceError("AUTHORIZATION_STORE_UNAVAILABLE");
  }
}

export async function consumeTeachingSpikeLiveAuthorization(
  access: TeachingSpikeDatabaseAccess,
  claim: TeachingSpikeLiveAuthorizationConsumptionClaim,
): Promise<TeachingSpikeLiveAuthorizationConsumptionResult> {
  const normalized = normalizeConsumptionClaim(claim);
  if (!normalized) return "claim_mismatch";
  await auditTeachingSpikeDatabaseIsolation(access);

  try {
    return await access.db.transaction(async (tx) => {
      const [registered] = await tx
        .select({
          runId: teachingSpikeLiveAuthorizations.runId,
          planHash: teachingSpikeLiveAuthorizations.planHash,
          planJson: teachingSpikeLiveAuthorizations.planJson,
          expiresAt: teachingSpikeLiveAuthorizations.expiresAt,
          consumedAt: teachingSpikeLiveAuthorizations.consumedAt,
        })
        .from(teachingSpikeLiveAuthorizations)
        .where(eq(teachingSpikeLiveAuthorizations.runId, normalized.runId))
        .for("update")
        .limit(1);
      if (
        !registered ||
        registered.runId !== normalized.runId ||
        registered.planHash !== normalized.planHash ||
        validDateMs(registered.expiresAt) !== normalized.expiresAtMs
      ) {
        return "claim_mismatch";
      }
      const storedPlan = parseStoredPlan(registered.planJson);
      if (
        storedPlan.runId !== normalized.runId ||
        storedPlan.planHash !== normalized.planHash ||
        storedPlan.expiresAtMs !== normalized.expiresAtMs
      ) {
        throw persistenceError("AUTHORIZATION_STORE_UNAVAILABLE");
      }
      if (registered.consumedAt) return "already_consumed";

      // Read the database clock only after acquiring the row lock. A second
      // concurrent claimant therefore observes both the first claim and a
      // fresh expiry decision from the same serialized transaction.
      const databaseNowMs = await readDatabaseTimeMs(tx);
      if (
        databaseNowMs < storedPlan.issuedAtMs ||
        databaseNowMs >= normalized.expiresAtMs
      ) {
        return "expired";
      }

      const consumed = await tx
        .update(teachingSpikeLiveAuthorizations)
        .set({ consumedAt: new Date(databaseNowMs) })
        .where(
          and(
            eq(teachingSpikeLiveAuthorizations.runId, normalized.runId),
            isNull(teachingSpikeLiveAuthorizations.consumedAt),
          ),
        )
        .returning({ runId: teachingSpikeLiveAuthorizations.runId });
      return consumed.length === 1 ? "consumed" : "already_consumed";
    });
  } catch (error) {
    if (error instanceof TeachingSpikeLivePersistenceError) throw error;
    throw persistenceError("AUTHORIZATION_STORE_UNAVAILABLE");
  }
}

/**
 * Persists exactly one allowlisted terminal report for a consumed run. The
 * report may describe success or failure, but a later process can neither
 * replace it nor attach it to a different plan.
 */
export async function finalizeTeachingSpikeLiveEvidenceReport(
  access: TeachingSpikeDatabaseAccess,
  report: RealtimeTeachingLiveEvidenceReport,
): Promise<TeachingSpikeLiveEvidenceFinalizationResult> {
  let reportJson: unknown;
  try {
    reportJson = JSON.parse(
      serializeRealtimeTeachingLiveEvidenceReport(report),
    ) as unknown;
  } catch {
    throw persistenceError("EVIDENCE_REPORT_INVALID");
  }
  const canonicalReport = canonicalJson(reportJson);
  const reportHash = createHash("sha256")
    .update(canonicalReport, "utf8")
    .digest("hex");
  await auditTeachingSpikeDatabaseIsolation(access);

  try {
    return await access.db.transaction(async (tx) => {
      const [stored] = await tx
        .select({
          runId: teachingSpikeLiveAuthorizations.runId,
          planHash: teachingSpikeLiveAuthorizations.planHash,
          planJson: teachingSpikeLiveAuthorizations.planJson,
          consumedAt: teachingSpikeLiveAuthorizations.consumedAt,
          reportHash: teachingSpikeLiveAuthorizations.reportHash,
          reportJson: teachingSpikeLiveAuthorizations.reportJson,
          finishedAt: teachingSpikeLiveAuthorizations.finishedAt,
        })
        .from(teachingSpikeLiveAuthorizations)
        .where(eq(teachingSpikeLiveAuthorizations.runId, report.runId))
        .for("update")
        .limit(1);
      if (
        !stored ||
        stored.runId !== report.runId ||
        stored.planHash !== report.planHash
      ) {
        return Object.freeze({ status: "claim_mismatch" as const });
      }

      const plan = parseStoredPlan(stored.planJson);
      assertReportMatchesStoredPlan(report, plan);
      if (!stored.consumedAt) {
        return Object.freeze({
          status: "authorization_not_consumed" as const,
        });
      }
      if (
        stored.reportHash !== null ||
        stored.reportJson !== null ||
        stored.finishedAt !== null
      ) {
        const storedFinishedAtMs = validDateMs(stored.finishedAt);
        if (
          stored.reportHash === null ||
          stored.reportJson === null ||
          storedFinishedAtMs === null ||
          createHash("sha256")
            .update(canonicalJson(stored.reportJson), "utf8")
            .digest("hex") !== stored.reportHash
        ) {
          throw persistenceError("EVIDENCE_FINALIZATION_FAILED");
        }
        return stored.reportHash === reportHash
          ? Object.freeze({
              status: "already_finalized" as const,
              reportHash,
              finishedAtMs: storedFinishedAtMs,
            })
          : Object.freeze({ status: "report_conflict" as const });
      }

      const finishedAtMs = await readDatabaseTimeMs(tx);
      const finalized = await tx
        .update(teachingSpikeLiveAuthorizations)
        .set({
          reportHash,
          reportJson,
          finishedAt: new Date(finishedAtMs),
        })
        .where(
          and(
            eq(teachingSpikeLiveAuthorizations.runId, report.runId),
            eq(teachingSpikeLiveAuthorizations.planHash, report.planHash),
            isNotNull(teachingSpikeLiveAuthorizations.consumedAt),
            isNull(teachingSpikeLiveAuthorizations.reportHash),
          ),
        )
        .returning({ runId: teachingSpikeLiveAuthorizations.runId });
      if (finalized.length !== 1) {
        throw persistenceError("EVIDENCE_FINALIZATION_FAILED");
      }
      return Object.freeze({
        status: "finalized" as const,
        reportHash,
        finishedAtMs,
      });
    });
  } catch (error) {
    if (error instanceof TeachingSpikeLivePersistenceError) throw error;
    throw persistenceError("EVIDENCE_FINALIZATION_FAILED");
  }
}

/**
 * Runs the already-defined authorization gate, persists its one-time claim,
 * and resolves the active target only after the claim succeeds. The callback
 * is the only public boundary that receives the runtime endpoint and API key.
 */
export async function withTeachingSpikeLiveTarget<Result>(
  request: TeachingSpikeLiveAuthorizationRequest,
  dependencies: Readonly<{
    access: TeachingSpikeDatabaseAccess;
    clock: TeachingSpikeLiveAuthorizationClock;
    useTarget: (input: {
      authorization: TeachingSpikeLiveAuthorization;
      target: TeachingSpikeResolvedLiveTarget;
    }) => Result | Promise<Result>;
  }>,
): Promise<Result> {
  return await runWithTeachingSpikeLiveAuthorization(request, {
    clock: dependencies.clock,
    consumeAuthorization: (claim) =>
      consumeTeachingSpikeLiveAuthorization(dependencies.access, claim),
    readCredential: (authorization) =>
      resolveRuntimeForConsumedAuthorization(
        dependencies.access,
        authorization,
      ),
    openSocket: ({ authorization, credential }) =>
      dependencies.useTarget({ authorization, target: credential }),
  });
}

export function createTeachingSpikeLivePersistenceDependencies(
  access: TeachingSpikeDatabaseAccess,
) {
  return Object.freeze({
    consumeAuthorization: (
      claim: TeachingSpikeLiveAuthorizationConsumptionClaim,
    ) => consumeTeachingSpikeLiveAuthorization(access, claim),
    resolveRuntime: (authorization: TeachingSpikeLiveAuthorization) =>
      resolveRuntimeForConsumedAuthorization(access, authorization),
  });
}

/**
 * Preflight lookup that projects active identifiers and the endpoint only.
 * It never selects the API key and never reads pending configuration fields.
 */
export async function resolveTeachingSpikeLiveTargetMetadata(
  access: TeachingSpikeDatabaseAccess,
  input: TeachingSpikeLiveTargetSelector,
): Promise<TeachingSpikeLiveTarget> {
  const selector = parseTargetSelector(input);
  await auditTeachingSpikeDatabaseIsolation(access);
  try {
    return await access.db.transaction(async (tx) => {
      const active = await selectActiveTarget(tx, selector);
      return buildTargetMetadata(access, selector, active);
    });
  } catch (error) {
    if (error instanceof TeachingSpikeLivePersistenceError) throw error;
    throw persistenceError("TARGET_RESOLUTION_FAILED");
  }
}

export async function resolveRuntimeForConsumedAuthorization(
  access: TeachingSpikeDatabaseAccess,
  authorization: TeachingSpikeLiveAuthorization,
): Promise<TeachingSpikeResolvedLiveTarget> {
  const parsed = teachingSpikeLiveTargetSchema.safeParse(authorization.target);
  if (
    !parsed.success ||
    parsed.data.databaseScope !== access.databaseScope ||
    parsed.data.databaseFingerprint !== access.databaseFingerprint
  ) {
    throw persistenceError("TARGET_NOT_ACTIVE");
  }
  const target = parsed.data;
  const claim = normalizeConsumptionClaim({
    runId: authorization.runId,
    planHash: authorization.planHash,
    expiresAtMs: authorization.expiresAtMs,
  });
  if (!claim) {
    throw persistenceError("AUTHORIZATION_NOT_CONSUMED_OR_EXPIRED");
  }
  await auditTeachingSpikeDatabaseIsolation(access);
  const selector: TeachingSpikeLiveTargetSelector = {
    provider: target.provider,
    modelProfileId: target.modelProfileId,
    modelProfileRevision: target.modelProfileRevision,
    modelId: target.modelId,
    connectionId: target.connectionId,
    connectionRevision: target.connectionRevision,
    voiceProfileId: target.voiceProfileId,
    voiceProfileRevision: target.voiceProfileRevision,
    voiceId: target.voiceId,
  };
  const expectedAdapter = adapterForProvider(target.provider);

  try {
    return await access.db.transaction(async (tx) => {
      const [consumedAuthorization] = await tx
        .select({
          runId: teachingSpikeLiveAuthorizations.runId,
          planHash: teachingSpikeLiveAuthorizations.planHash,
          planJson: teachingSpikeLiveAuthorizations.planJson,
          expiresAt: teachingSpikeLiveAuthorizations.expiresAt,
          consumedAt: teachingSpikeLiveAuthorizations.consumedAt,
        })
        .from(teachingSpikeLiveAuthorizations)
        .where(eq(teachingSpikeLiveAuthorizations.runId, claim.runId))
        .for("share")
        .limit(1);
      if (
        !consumedAuthorization ||
        consumedAuthorization.runId !== claim.runId ||
        consumedAuthorization.planHash !== claim.planHash ||
        validDateMs(consumedAuthorization.expiresAt) !== claim.expiresAtMs ||
        !consumedAuthorization.consumedAt
      ) {
        throw persistenceError("AUTHORIZATION_NOT_CONSUMED_OR_EXPIRED");
      }
      const storedPlan = parseStoredPlan(consumedAuthorization.planJson);
      if (!authorizationMatchesPlan(authorization, storedPlan)) {
        throw persistenceError("AUTHORIZATION_NOT_CONSUMED_OR_EXPIRED");
      }
      const databaseNowMs = await readDatabaseTimeMs(tx);
      if (
        databaseNowMs < storedPlan.issuedAtMs ||
        databaseNowMs >= claim.expiresAtMs
      ) {
        throw persistenceError("AUTHORIZATION_NOT_CONSUMED_OR_EXPIRED");
      }

      const active = await selectActiveTarget(tx, selector);
      const currentTarget = buildTargetMetadata(access, selector, active);
      if (!sameTarget(currentTarget, target)) {
        throw persistenceError("TARGET_NOT_ACTIVE");
      }
      const endpoint = active?.endpoint?.trim();
      if (!endpoint) throw persistenceError("TARGET_NOT_ACTIVE");

      // The first SELECT holds a shared lock and intentionally excludes the
      // API key. Read the credential only after every active identity,
      // revision, status, verification marker, and endpoint hash matches.
      const [credential] = await tx
        .select({ apiKey: modelConnections.apiKey })
        .from(modelConnections)
        .where(
          and(
            eq(modelConnections.id, target.connectionId),
            eq(modelConnections.revision, target.connectionRevision),
            eq(modelConnections.adapter, expectedAdapter),
            eq(modelConnections.status, "enabled"),
            isNotNull(modelConnections.verifiedAt),
            isNotNull(modelConnections.apiKey),
          ),
        )
        .for("share")
        .limit(1);
      const apiKey = credential?.apiKey?.trim();
      if (!apiKey) throw persistenceError("TARGET_NOT_ACTIVE");

      return Object.freeze({
        target,
        endpoint,
        apiKey,
      });
    });
  } catch (error) {
    if (error instanceof TeachingSpikeLivePersistenceError) throw error;
    throw persistenceError("TARGET_RESOLUTION_FAILED");
  }
}

type ActiveTargetRow = {
  provider: string;
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

async function selectActiveTarget(
  db: Pick<Database, "select">,
  selector: TeachingSpikeLiveTargetSelector,
): Promise<ActiveTargetRow | undefined> {
  const expectedAdapter = adapterForProvider(selector.provider);
  const [active] = await db
    .select({
      provider: providerProfiles.provider,
      model: providerProfiles.model,
      modelProfileId: providerProfiles.id,
      modelProfileRevision: providerProfiles.revision,
      modelProfileStatus: providerProfiles.status,
      modelProfileVerifiedAt: providerProfiles.verifiedAt,
      connectionId: modelConnections.id,
      connectionRevision: modelConnections.revision,
      connectionAdapter: modelConnections.adapter,
      connectionStatus: modelConnections.status,
      connectionVerifiedAt: modelConnections.verifiedAt,
      endpoint: modelConnections.endpoint,
      voiceProfileId: voiceProfiles.id,
      voiceProfileRevision: voiceProfiles.revision,
      voiceProfileStatus: voiceProfiles.status,
      voiceProfileVerifiedAt: voiceProfiles.verifiedAt,
      voice: voiceProfiles.providerVoiceId,
    })
    .from(providerProfiles)
    .innerJoin(
      modelConnections,
      eq(providerProfiles.connectionId, modelConnections.id),
    )
    .innerJoin(
      voiceProfiles,
      eq(voiceProfiles.providerProfileId, providerProfiles.id),
    )
    .where(
      and(
        eq(providerProfiles.id, selector.modelProfileId),
        eq(providerProfiles.revision, selector.modelProfileRevision),
        eq(providerProfiles.provider, selector.provider),
        eq(providerProfiles.model, selector.modelId),
        eq(providerProfiles.kind, "realtime_voice"),
        eq(providerProfiles.status, "enabled"),
        isNotNull(providerProfiles.verifiedAt),
        eq(modelConnections.id, selector.connectionId),
        eq(modelConnections.revision, selector.connectionRevision),
        eq(modelConnections.adapter, expectedAdapter),
        eq(modelConnections.status, "enabled"),
        isNotNull(modelConnections.verifiedAt),
        isNotNull(modelConnections.endpoint),
        eq(voiceProfiles.id, selector.voiceProfileId),
        eq(voiceProfiles.revision, selector.voiceProfileRevision),
        eq(voiceProfiles.providerVoiceId, selector.voiceId),
        eq(voiceProfiles.status, "enabled"),
        isNotNull(voiceProfiles.verifiedAt),
      ),
    )
    .for("share")
    .limit(1);
  return active;
}

function buildTargetMetadata(
  access: TeachingSpikeDatabaseAccess,
  selector: TeachingSpikeLiveTargetSelector,
  active: ActiveTargetRow | undefined,
): TeachingSpikeLiveTarget {
  const expectedAdapter = adapterForProvider(selector.provider);
  if (!active || !activeTargetMatches(active, selector, expectedAdapter)) {
    throw persistenceError("TARGET_NOT_ACTIVE");
  }
  const endpoint = active.endpoint.trim();
  const endpointFingerprint = fingerprintRuntimeEndpoint(
    selector.provider,
    endpoint,
    selector.modelId,
  );
  return Object.freeze({
    ...selector,
    endpointFingerprint,
    databaseScope: access.databaseScope,
    databaseFingerprint: access.databaseFingerprint,
  });
}

function activeTargetMatches(
  active: ActiveTargetRow,
  target: TeachingSpikeLiveTargetSelector,
  expectedAdapter: "qwen_realtime" | "doubao_realtime",
): active is typeof active & { endpoint: string } {
  return (
    active.provider === target.provider &&
    active.model === target.modelId &&
    active.modelProfileId === target.modelProfileId &&
    active.modelProfileRevision === target.modelProfileRevision &&
    active.modelProfileStatus === "enabled" &&
    active.modelProfileVerifiedAt instanceof Date &&
    active.connectionId === target.connectionId &&
    active.connectionRevision === target.connectionRevision &&
    active.connectionAdapter === expectedAdapter &&
    active.connectionStatus === "enabled" &&
    active.connectionVerifiedAt instanceof Date &&
    typeof active.endpoint === "string" &&
    active.voiceProfileId === target.voiceProfileId &&
    active.voiceProfileRevision === target.voiceProfileRevision &&
    active.voiceProfileStatus === "enabled" &&
    active.voiceProfileVerifiedAt instanceof Date &&
    active.voice === target.voiceId
  );
}

function parseTargetSelector(
  input: TeachingSpikeLiveTargetSelector,
): TeachingSpikeLiveTargetSelector {
  if (
    (input.provider !== "qwen" && input.provider !== "doubao") ||
    !UUID_PATTERN.test(input.modelProfileId) ||
    !UUID_PATTERN.test(input.connectionId) ||
    !UUID_PATTERN.test(input.voiceProfileId) ||
    !isPositiveRevision(input.modelProfileRevision) ||
    !isPositiveRevision(input.connectionRevision) ||
    !isPositiveRevision(input.voiceProfileRevision) ||
    !isExactIdentifier(input.modelId) ||
    !isExactIdentifier(input.voiceId)
  ) {
    throw persistenceError("TARGET_NOT_ACTIVE");
  }
  return Object.freeze({
    provider: input.provider,
    modelProfileId: input.modelProfileId.toLowerCase(),
    modelProfileRevision: input.modelProfileRevision,
    modelId: input.modelId,
    connectionId: input.connectionId.toLowerCase(),
    connectionRevision: input.connectionRevision,
    voiceProfileId: input.voiceProfileId.toLowerCase(),
    voiceProfileRevision: input.voiceProfileRevision,
    voiceId: input.voiceId,
  });
}

function fingerprintRuntimeEndpoint(
  provider: TeachingSpikeLiveProvider,
  endpoint: string,
  model: string,
): string {
  if (!endpoint) throw persistenceError("TARGET_NOT_ACTIVE");
  if (provider === "qwen") {
    try {
      return qwenTeachingLiveWebSocketEndpointFingerprint(endpoint, model);
    } catch {
      throw persistenceError("TARGET_NOT_ACTIVE");
    }
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw persistenceError("TARGET_NOT_ACTIVE");
  }
  if (url.toString() !== DOUBAO_REALTIME_WEBSOCKET_URL) {
    throw persistenceError("TARGET_NOT_ACTIVE");
  }
  return createHash("sha256").update(url.toString(), "utf8").digest("hex");
}

function adapterForProvider(
  provider: TeachingSpikeLiveProvider,
): "qwen_realtime" | "doubao_realtime" {
  return provider === "qwen" ? "qwen_realtime" : "doubao_realtime";
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

function assertReportMatchesStoredPlan(
  report: RealtimeTeachingLiveEvidenceReport,
  plan: TeachingSpikeLiveAuthorizationPlan,
): void {
  const targetFingerprint = createHash("sha256")
    .update(canonicalJson(plan.target), "utf8")
    .digest("hex");
  if (
    report.runId !== plan.runId ||
    report.planHash !== plan.planHash ||
    report.provider !== plan.provider ||
    report.inputMode !== plan.inputMode ||
    report.fixtureRevision !== plan.fixtureRevision ||
    report.fixtureHash !== plan.fixtureHash ||
    report.inputFixtureHash !== plan.inputFixtureHash ||
    report.priceSnapshotHash !== plan.pricing.priceSnapshotHash ||
    report.target.fingerprint !== targetFingerprint ||
    report.target.modelProfileRevision !== plan.target.modelProfileRevision ||
    report.target.connectionRevision !== plan.target.connectionRevision ||
    report.target.voiceProfileRevision !== plan.target.voiceProfileRevision ||
    report.budget.authorizedCny !== plan.limits.budgetCny ||
    report.budget.preflightEstimatedMaximumCny !==
      plan.pricing.estimatedMaxCostCny ||
    report.sessions.authorized !== plan.limits.maxSessions ||
    report.responses.authorized !== plan.limits.maxResponseAttempts
  ) {
    throw persistenceError("EVIDENCE_REPORT_INVALID");
  }
}

function authorizationMatchesPlan(
  authorization: TeachingSpikeLiveAuthorization,
  plan: TeachingSpikeLiveAuthorizationPlan,
): boolean {
  return (
    authorization.authorized === true &&
    authorization.runId === plan.runId &&
    authorization.provider === plan.provider &&
    authorization.planHash === plan.planHash &&
    authorization.inputMode === plan.inputMode &&
    authorization.inputFixtureHash === plan.inputFixtureHash &&
    authorization.expiresAtMs === plan.expiresAtMs &&
    sameTarget(authorization.target, plan.target) &&
    authorization.caseIds.length === plan.caseIds.length &&
    authorization.caseIds.every(
      (caseId, index) => caseId === plan.caseIds[index],
    ) &&
    authorization.pricing.priceSnapshotHash ===
      plan.pricing.priceSnapshotHash &&
    authorization.pricing.estimatedMaxCostCny ===
      plan.pricing.estimatedMaxCostCny &&
    authorization.limits.maxSessions === plan.limits.maxSessions &&
    authorization.limits.maxResponseAttempts ===
      plan.limits.maxResponseAttempts &&
    authorization.limits.maxInputMs === plan.limits.maxInputMs &&
    authorization.limits.maxOutputMs === plan.limits.maxOutputMs &&
    authorization.limits.budgetCny === plan.limits.budgetCny &&
    authorization.limits.timeouts.connectMs ===
      plan.limits.timeouts.connectMs &&
    authorization.limits.timeouts.updateAckMs ===
      plan.limits.timeouts.updateAckMs &&
    authorization.limits.timeouts.responseMs ===
      plan.limits.timeouts.responseMs &&
    authorization.limits.timeouts.totalRunMs === plan.limits.timeouts.totalRunMs
  );
}

function isPositiveRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isExactIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 160 && value === value.trim();
}

function parsePlanForStorage(
  input: unknown,
): TeachingSpikeLiveAuthorizationPlan {
  try {
    return parseTeachingSpikeLiveAuthorizationPlan(input);
  } catch {
    throw persistenceError("INVALID_AUTHORIZATION_REGISTRATION");
  }
}

function parseStoredPlan(input: unknown): TeachingSpikeLiveAuthorizationPlan {
  try {
    return parseTeachingSpikeLiveAuthorizationPlan(input);
  } catch {
    throw persistenceError("AUTHORIZATION_STORE_UNAVAILABLE");
  }
}

function normalizeConsumptionClaim(
  claim: TeachingSpikeLiveAuthorizationConsumptionClaim,
): TeachingSpikeLiveAuthorizationConsumptionClaim | null {
  if (
    !UUID_PATTERN.test(claim.runId) ||
    !SHA256_PATTERN.test(claim.planHash) ||
    !Number.isSafeInteger(claim.expiresAtMs) ||
    claim.expiresAtMs < 0
  ) {
    return null;
  }
  return Object.freeze({
    runId: claim.runId.toLowerCase(),
    planHash: claim.planHash,
    expiresAtMs: claim.expiresAtMs,
  });
}

function validDateMs(value: unknown): number | null {
  if (!(value instanceof Date)) return null;
  const milliseconds = value.getTime();
  return Number.isFinite(milliseconds) ? milliseconds : null;
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

async function readDatabaseTimeMs(
  db: Pick<Database, "execute">,
): Promise<number> {
  const result = await db.execute<{ databaseNowMs: string }>(
    sql`select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as "databaseNowMs"`,
  );
  const rawValue = result.rows[0]?.databaseNowMs;
  const databaseNowMs =
    typeof rawValue === "string" && /^\d+$/u.test(rawValue)
      ? Number(rawValue)
      : Number.NaN;
  if (!Number.isSafeInteger(databaseNowMs) || databaseNowMs < 0) {
    throw persistenceError("AUTHORIZATION_STORE_UNAVAILABLE");
  }
  return databaseNowMs;
}

async function readTeachingSpikeDatabaseTime(
  access: TeachingSpikeDatabaseAccess,
): Promise<number> {
  try {
    return await readDatabaseTimeMs(access.db);
  } catch (error) {
    if (error instanceof TeachingSpikeLivePersistenceError) throw error;
    throw persistenceError("AUTHORIZATION_STORE_UNAVAILABLE");
  }
}

function persistenceError(
  code: TeachingSpikeLivePersistenceErrorCode,
): TeachingSpikeLivePersistenceError {
  return new TeachingSpikeLivePersistenceError(code);
}
