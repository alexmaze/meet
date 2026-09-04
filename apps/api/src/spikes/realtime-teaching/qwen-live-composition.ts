import type { QwenRealtimeModel } from "@meet/protocol";
import { createHash } from "node:crypto";
import WebSocket, { type ClientOptions } from "ws";

import { buildQwenRealtimeWebSocketUrl } from "../../qwen-websocket.js";
import {
  TEACHING_SPIKE_LIVE_RUNNER_REVISION,
  runWithTeachingSpikeLiveAuthorization,
  type TeachingSpikeLiveAuthorization,
  type TeachingSpikeLiveAuthorizationClock,
  type TeachingSpikeLiveAuthorizationConsumptionClaim,
  type TeachingSpikeLiveAuthorizationConsumptionResult,
  type TeachingSpikeLiveAuthorizationRequest,
  type TeachingSpikeLiveTarget,
} from "./live-authorization.js";
import {
  QWEN_TEACHING_LIVE_MAX_RESPONSE_MS,
  runQwenTeachingTextProtocolSmoke,
  type QwenTeachingLiveInstructionAcks,
  type QwenTeachingLiveSmokeResult,
  type QwenTeachingLiveTimeouts,
  type QwenTeachingLiveWebSocketFactory,
} from "./qwen-live-adapter.js";
import {
  buildQwenTeachingSpikePricingBinding,
  estimateQwenTeachingSpikeUsageCostCny,
} from "./pricing.js";
import {
  TEACHING_SPIKE_FIXTURE_HASH,
  TEACHING_SPIKE_FIXTURE_REVISION,
} from "./fixtures.js";

export const QWEN_TEACHING_LIVE_COMPOSITION_REVISION =
  TEACHING_SPIKE_LIVE_RUNNER_REVISION;
export const QWEN_TEACHING_LIVE_MODEL_ID =
  "qwen-audio-3.0-realtime-plus" as const;

const QWEN_TEACHING_LIVE_COMPOSITION_TIMEOUTS = Object.freeze({
  socketOpenMs: 10_000,
  socketCloseMs: 2_000,
  sessionCreatedMs: 10_000,
  updateAckMs: 5_000,
  itemCreatedMs: 5_000,
  responseCreatedMs: 5_000,
  responseDoneMs: QWEN_TEACHING_LIVE_MAX_RESPONSE_MS,
} satisfies QwenTeachingLiveTimeouts);

const QWEN_TEACHING_LIVE_LEGACY_HOSTNAME = "dashscope.aliyuncs.com";
const QWEN_TEACHING_LIVE_BEIJING_HOSTNAME_SUFFIX =
  ".cn-beijing.maas.aliyuncs.com";

export type QwenTeachingLiveTargetSelector = Pick<
  TeachingSpikeLiveTarget,
  | "modelProfileId"
  | "modelProfileRevision"
  | "modelId"
  | "connectionId"
  | "connectionRevision"
  | "voiceProfileId"
  | "voiceProfileRevision"
  | "voiceId"
>;

/**
 * Runtime data resolved only after one-time authorization has been consumed.
 * Implementations may read this from a dedicated test store later; this module
 * deliberately has no database, environment-variable, HTTP, relay, or report
 * dependency.
 */
export type ResolvedQwenTeachingLiveRuntime = {
  target: TeachingSpikeLiveTarget;
  endpoint: string;
  apiKey: string;
};

export type QwenTeachingLiveCompositionResult = Readonly<{
  schemaVersion: 1;
  provider: "qwen";
  providerEvidence: false;
  compositionRevision: typeof QWEN_TEACHING_LIVE_COMPOSITION_REVISION;
  authorization: TeachingSpikeLiveAuthorization;
  protocol: QwenTeachingLiveSmokeResult;
}>;

export type QwenTeachingLiveCompositionDependencies = {
  clock: TeachingSpikeLiveAuthorizationClock;
  consumeAuthorization: (
    claim: TeachingSpikeLiveAuthorizationConsumptionClaim,
  ) =>
    | TeachingSpikeLiveAuthorizationConsumptionResult
    | Promise<TeachingSpikeLiveAuthorizationConsumptionResult>;
  resolveRuntime: (
    authorization: TeachingSpikeLiveAuthorization,
  ) =>
    ResolvedQwenTeachingLiveRuntime | Promise<ResolvedQwenTeachingLiveRuntime>;
};

type InjectedProtocolRunner = (input: {
  authorization: TeachingSpikeLiveAuthorization;
  runtime: ResolvedQwenTeachingLiveRuntime;
}) => QwenTeachingLiveSmokeResult | Promise<QwenTeachingLiveSmokeResult>;

/**
 * The only production-oriented composition entry. Its WebSocket constructor is
 * fixed to `ws`; callers cannot substitute a mock transport through this path.
 * A successful protocol result remains `providerEvidence: false` until a
 * separately reviewed private attestation/report layer promotes it.
 */
export async function runAuthorizedQwenTeachingLiveComposition(
  request: TeachingSpikeLiveAuthorizationRequest,
  dependencies: QwenTeachingLiveCompositionDependencies,
): Promise<QwenTeachingLiveCompositionResult> {
  requireQwenRequest(request);
  return await runComposition(
    request,
    dependencies,
    async ({ authorization, runtime }) => {
      const expectedUrl = requireAuthorizedRuntime(authorization, runtime);
      return await runQwenTeachingTextProtocolSmoke({
        endpoint: runtime.endpoint,
        apiKey: runtime.apiKey,
        model: authorization.target.modelId as QwenRealtimeModel,
        voice: authorization.target.voiceId,
        webSocketFactory: createQwenTeachingLiveRealWebSocketFactory({
          expectedUrl,
          apiKey: runtime.apiKey,
        }),
        timeouts: QWEN_TEACHING_LIVE_COMPOSITION_TIMEOUTS,
      });
    },
  );
}

/**
 * Explicitly test-only composition seam. It exercises authorization and target
 * binding without opening a socket. Even a forged injected result cannot be
 * promoted to Provider evidence.
 */
export async function runAuthorizedQwenTeachingLiveCompositionForTest(
  request: TeachingSpikeLiveAuthorizationRequest,
  dependencies: QwenTeachingLiveCompositionDependencies & {
    runProtocol: InjectedProtocolRunner;
  },
): Promise<QwenTeachingLiveCompositionResult> {
  requireQwenRequest(request);
  return await runComposition(request, dependencies, async (input) => {
    requireAuthorizedRuntime(input.authorization, input.runtime);
    return await dependencies.runProtocol(input);
  });
}

export function qwenTeachingLiveWebSocketEndpointFingerprint(
  endpoint: string,
  model: string,
): string {
  return createHash("sha256")
    .update(buildExactQwenTeachingLiveWebSocketUrl(endpoint, model), "utf8")
    .digest("hex");
}

export function assertQwenTeachingLiveTargetSelector(
  target: TeachingSpikeLiveTarget,
  selector: QwenTeachingLiveTargetSelector,
): void {
  if (
    target.provider !== "qwen" ||
    target.modelId !== QWEN_TEACHING_LIVE_MODEL_ID ||
    selector.modelId !== QWEN_TEACHING_LIVE_MODEL_ID ||
    target.modelProfileId !== selector.modelProfileId ||
    target.modelProfileRevision !== selector.modelProfileRevision ||
    target.modelId !== selector.modelId ||
    target.connectionId !== selector.connectionId ||
    target.connectionRevision !== selector.connectionRevision ||
    target.voiceProfileId !== selector.voiceProfileId ||
    target.voiceProfileRevision !== selector.voiceProfileRevision ||
    target.voiceId !== selector.voiceId
  ) {
    throw compositionError("TARGET_SELECTOR_MISMATCH");
  }
}

function createQwenTeachingLiveRealWebSocketFactory(input: {
  expectedUrl: string;
  apiKey: string;
}): QwenTeachingLiveWebSocketFactory {
  const expectedAuthorization = `Bearer ${input.apiKey}`;
  return (url: string, options: ClientOptions): WebSocket => {
    if (
      url !== input.expectedUrl ||
      readAuthorizationHeader(options) !== expectedAuthorization ||
      options.perMessageDeflate !== false
    ) {
      throw compositionError("REAL_TRANSPORT_CONFIGURATION_MISMATCH");
    }
    return new WebSocket(input.expectedUrl, options);
  };
}

async function runComposition(
  request: TeachingSpikeLiveAuthorizationRequest,
  dependencies: QwenTeachingLiveCompositionDependencies,
  runProtocol: InjectedProtocolRunner,
): Promise<QwenTeachingLiveCompositionResult> {
  return await runWithTeachingSpikeLiveAuthorization(request, {
    clock: dependencies.clock,
    consumeAuthorization: dependencies.consumeAuthorization,
    readCredential: async (authorization) =>
      await dependencies.resolveRuntime(authorization),
    openSocket: async ({ authorization, credential: runtime }) => {
      assertPricingBinding(authorization.pricing);
      requireAuthorizedRuntime(authorization, runtime);
      const untrustedProtocol = await runProtocol({ authorization, runtime });
      assertProtocolResult(authorization, untrustedProtocol);
      const protocol = copyProtocolResult(untrustedProtocol);
      return deepFreeze({
        schemaVersion: 1 as const,
        provider: "qwen" as const,
        providerEvidence: false as const,
        compositionRevision: QWEN_TEACHING_LIVE_COMPOSITION_REVISION,
        // This is the exact immutable authorization produced before the
        // one-time claim was consumed. Never reconstruct it from request.plan
        // after credential resolution or a Provider round trip.
        authorization,
        protocol,
      });
    },
  });
}

function requireQwenRequest(
  request: TeachingSpikeLiveAuthorizationRequest,
): void {
  if (
    request.provider !== "qwen" ||
    request.plan.provider !== "qwen" ||
    request.plan.inputMode !== "text" ||
    request.plan.target.modelId !== QWEN_TEACHING_LIVE_MODEL_ID ||
    request.currentTarget.modelId !== QWEN_TEACHING_LIVE_MODEL_ID
  ) {
    throw compositionError("QWEN_ONLY");
  }
  assertPricingBinding(request.plan.pricing);
}

function requireAuthorizedRuntime(
  authorization: TeachingSpikeLiveAuthorization,
  runtime: ResolvedQwenTeachingLiveRuntime,
): string {
  if (
    authorization.provider !== "qwen" ||
    runtime.target.provider !== "qwen" ||
    authorization.inputMode !== "text" ||
    authorization.target.modelId !== QWEN_TEACHING_LIVE_MODEL_ID ||
    !sameTarget(runtime.target, authorization.target)
  ) {
    throw compositionError("RUNTIME_TARGET_MISMATCH");
  }
  if (!runtime.apiKey.trim() || runtime.apiKey !== runtime.apiKey.trim()) {
    throw compositionError("INVALID_RUNTIME_CREDENTIAL");
  }

  const expectedUrl = buildExactQwenTeachingLiveWebSocketUrl(
    runtime.endpoint,
    authorization.target.modelId,
  );
  if (
    qwenTeachingLiveWebSocketEndpointFingerprint(
      runtime.endpoint,
      authorization.target.modelId,
    ) !== authorization.target.endpointFingerprint
  ) {
    throw compositionError("ENDPOINT_FINGERPRINT_MISMATCH");
  }
  return expectedUrl;
}

function buildExactQwenTeachingLiveWebSocketUrl(
  endpoint: string,
  model: string,
): string {
  let url: URL;
  try {
    url = buildQwenRealtimeWebSocketUrl(endpoint, model);
  } catch {
    throw compositionError("INVALID_REALTIME_ENDPOINT");
  }
  if (
    url.protocol !== "wss:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/api-ws/v1/realtime" ||
    url.hash ||
    url.searchParams.size !== 1 ||
    url.searchParams.get("model") !== model ||
    !isOfficialQwenTeachingLiveHostname(url.hostname)
  ) {
    throw compositionError("INVALID_REALTIME_ENDPOINT");
  }
  return url.toString();
}

function isOfficialQwenTeachingLiveHostname(hostname: string): boolean {
  return (
    hostname === QWEN_TEACHING_LIVE_LEGACY_HOSTNAME ||
    (hostname.endsWith(QWEN_TEACHING_LIVE_BEIJING_HOSTNAME_SUFFIX) &&
      hostname.length > QWEN_TEACHING_LIVE_BEIJING_HOSTNAME_SUFFIX.length)
  );
}

function readAuthorizationHeader(options: ClientOptions): string | undefined {
  const headers = options.headers;
  if (!headers || Array.isArray(headers)) return undefined;
  const value = headers.Authorization ?? headers.authorization;
  return typeof value === "string" ? value : undefined;
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

function assertProtocolResult(
  authorization: TeachingSpikeLiveAuthorization,
  protocol: QwenTeachingLiveSmokeResult,
): void {
  if (
    protocol.provider !== "qwen" ||
    protocol.schemaVersion !== 3 ||
    protocol.providerEvidence !== false ||
    protocol.inputMode !== authorization.inputMode ||
    protocol.fixtureRevision !== TEACHING_SPIKE_FIXTURE_REVISION ||
    protocol.fixtureHash !== TEACHING_SPIKE_FIXTURE_HASH ||
    protocol.inputFixtureHash !== authorization.inputFixtureHash ||
    protocol.usage.inputAudioTokens !== 0 ||
    protocol.usage.outputAudioTokens !== 0 ||
    protocol.upstreamSessions !== authorization.limits.maxSessions ||
    protocol.responseAttempts !== authorization.limits.maxResponseAttempts ||
    protocol.scope.transport !== "isolated_provider_websocket" ||
    protocol.scope.relayExercised !== false ||
    protocol.scope.browserExercised !== false ||
    !hasValidInstructionAcks(protocol.instructionAcks) ||
    protocol.cases.length !== authorization.caseIds.length ||
    protocol.cases.some(
      (protocolCase, index) => protocolCase.id !== authorization.caseIds[index],
    )
  ) {
    throw compositionError("INVALID_PROTOCOL_RESULT");
  }
  assertPricingBinding(authorization.pricing);
  let actualCostCny: number;
  try {
    actualCostCny = estimateQwenTeachingSpikeUsageCostCny(protocol.usage);
  } catch {
    throw compositionError("INVALID_PROTOCOL_RESULT");
  }
  if (
    actualCostCny > authorization.limits.budgetCny ||
    actualCostCny > authorization.pricing.estimatedMaxCostCny
  ) {
    throw compositionError("USAGE_COST_LIMIT_EXCEEDED");
  }
}

function assertPricingBinding(
  pricing: TeachingSpikeLiveAuthorization["pricing"] | undefined,
): void {
  const expected = buildQwenTeachingSpikePricingBinding();
  if (
    pricing?.priceSnapshotHash !== expected.priceSnapshotHash ||
    pricing?.estimatedMaxCostCny !== expected.estimatedMaxCostCny
  ) {
    throw compositionError("PRICING_BINDING_MISMATCH");
  }
}

function copyProtocolResult(
  protocol: QwenTeachingLiveSmokeResult,
): QwenTeachingLiveSmokeResult {
  return {
    schemaVersion: 3,
    provider: "qwen",
    inputMode: "text",
    fixtureRevision: protocol.fixtureRevision,
    fixtureHash: protocol.fixtureHash,
    inputFixtureHash: protocol.inputFixtureHash,
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
      echoedMatch: protocol.instructionAcks.echoedMatch,
      omitted: protocol.instructionAcks.omitted,
    },
    usage: {
      totalTokens: protocol.usage.totalTokens,
      inputTokens: protocol.usage.inputTokens,
      outputTokens: protocol.usage.outputTokens,
      inputTextTokens: protocol.usage.inputTextTokens,
      inputAudioTokens: protocol.usage.inputAudioTokens,
      outputTextTokens: protocol.usage.outputTextTokens,
      outputAudioTokens: protocol.usage.outputAudioTokens,
    },
    cases: protocol.cases.map((protocolCase) => ({
      id: protocolCase.id,
      status: "protocol_sequence_completed",
      expectedMarkerCount: protocolCase.expectedMarkerCount,
      forbiddenMarkerCount: protocolCase.forbiddenMarkerCount,
    })),
  };
}

function hasValidInstructionAcks(
  value: unknown,
): value is QwenTeachingLiveInstructionAcks {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 3 &&
    record.total === 5 &&
    Number.isSafeInteger(record.echoedMatch) &&
    Number.isSafeInteger(record.omitted) &&
    (record.echoedMatch as number) >= 0 &&
    (record.omitted as number) >= 0 &&
    (record.echoedMatch as number) + (record.omitted as number) === 5
  );
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

export type QwenTeachingLiveCompositionErrorCode =
  | "QWEN_ONLY"
  | "TARGET_SELECTOR_MISMATCH"
  | "RUNTIME_TARGET_MISMATCH"
  | "INVALID_RUNTIME_CREDENTIAL"
  | "INVALID_REALTIME_ENDPOINT"
  | "ENDPOINT_FINGERPRINT_MISMATCH"
  | "PRICING_BINDING_MISMATCH"
  | "USAGE_COST_LIMIT_EXCEEDED"
  | "REAL_TRANSPORT_CONFIGURATION_MISMATCH"
  | "INVALID_PROTOCOL_RESULT";

export class QwenTeachingLiveCompositionError extends Error {
  constructor(readonly code: QwenTeachingLiveCompositionErrorCode) {
    super(code);
    this.name = "QwenTeachingLiveCompositionError";
  }
}

function compositionError(
  code: QwenTeachingLiveCompositionErrorCode,
): QwenTeachingLiveCompositionError {
  return new QwenTeachingLiveCompositionError(code);
}
