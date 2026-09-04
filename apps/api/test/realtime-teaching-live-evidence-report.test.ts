import { describe, expect, it } from "vitest";

import * as liveEvidenceModule from "../src/spikes/realtime-teaching/live-evidence-report.js";
import {
  authorizeTeachingSpikeLiveExecution,
  buildTeachingSpikeLiveAuthorizationPlan,
  type TeachingSpikeLiveAuthorization,
  type TeachingSpikeLiveAuthorizationPlan,
  type TeachingSpikeLiveAuthorizationRequest,
  type TeachingSpikeLiveTarget,
} from "../src/spikes/realtime-teaching/live-authorization.js";
import {
  buildRealtimeTeachingLiveEvidenceReport,
  buildRealtimeTeachingLiveFailureEvidenceReport,
  runAuthorizedQwenTeachingLiveCompositionAndBuildEvidence,
  serializeRealtimeTeachingLiveEvidenceReport,
  type RealtimeTeachingCoreProtocolResult,
  type RealtimeTeachingLiveEvidenceError,
  type RealtimeTeachingLiveObservedUsageInput,
} from "../src/spikes/realtime-teaching/live-evidence-report.js";
import {
  TEACHING_SPIKE_FIXTURE_HASH,
  TEACHING_SPIKE_FIXTURE_REVISION,
  TEACHING_SPIKE_USER_TEXT_HASH,
} from "../src/spikes/realtime-teaching/fixtures.js";
import { buildQwenTeachingSpikePricingBinding } from "../src/spikes/realtime-teaching/pricing.js";

const issuedAtMs = 1_786_656_000_000;
const expiresAtMs = issuedAtMs + 10 * 60 * 1_000;
const priceSnapshotHash = "c".repeat(64);
const otherPriceSnapshotHash = "e".repeat(64);
const doubaoInputFixtureHash = "d".repeat(64);
const pricing = {
  priceSnapshotHash,
  estimatedMaxCostCny: 1.5,
} as const;

const qwenTarget: TeachingSpikeLiveTarget = {
  provider: "qwen",
  modelId: "qwen-audio-3.0-realtime-plus",
  voiceId: "longanqian",
  modelProfileId: "10000000-0000-4000-8000-000000000001",
  modelProfileRevision: 7,
  connectionId: "20000000-0000-4000-8000-000000000002",
  connectionRevision: 11,
  voiceProfileId: "30000000-0000-4000-8000-000000000003",
  voiceProfileRevision: 5,
  endpointFingerprint: "a".repeat(64),
  databaseScope: "isolated_spike",
  databaseFingerprint: "b".repeat(64),
};

const doubaoTarget: TeachingSpikeLiveTarget = {
  ...qwenTarget,
  provider: "doubao",
  modelId: "1.2.6.1",
  voiceId: "zh_female_vv_jupiter_bigtts",
  modelProfileId: "40000000-0000-4000-8000-000000000004",
  connectionId: "50000000-0000-4000-8000-000000000005",
  voiceProfileId: "60000000-0000-4000-8000-000000000006",
  endpointFingerprint: "f".repeat(64),
};

const qwenCoreUsage = {
  totalTokens: 48,
  inputTokens: 30,
  outputTokens: 18,
  inputTextTokens: 30,
  inputAudioTokens: 0,
  outputTextTokens: 18,
  outputAudioTokens: 0,
} as const;

const zeroObservedUsage: RealtimeTeachingLiveObservedUsageInput = {
  inputAudioMs: 0,
  outputAudioMs: 0,
  estimatedCostCny: 0,
};

const qwenObservedUsage: RealtimeTeachingLiveObservedUsageInput = {
  inputAudioMs: 0,
  outputAudioMs: 0,
  estimatedCostCny: 0.00087,
};

function authorizationPlan(
  provider: "qwen" | "doubao" = "qwen",
  runId = "70000000-0000-4000-8000-000000000007",
  pricingBinding = pricing,
): TeachingSpikeLiveAuthorizationPlan {
  const target = provider === "qwen" ? qwenTarget : doubaoTarget;
  const inputFixtureHash =
    provider === "qwen"
      ? TEACHING_SPIKE_USER_TEXT_HASH
      : doubaoInputFixtureHash;
  return buildTeachingSpikeLiveAuthorizationPlan({
    target,
    budgetCny: 2,
    pricing: pricingBinding,
    inputFixtureHash,
    runId,
    issuedAtMs,
    expiresAtMs,
  });
}

function authorization(
  provider: "qwen" | "doubao" = "qwen",
  runId = "70000000-0000-4000-8000-000000000007",
): TeachingSpikeLiveAuthorization {
  const plan = authorizationPlan(provider, runId);
  return authorizeTeachingSpikeLiveExecution(requestFor(plan), {
    readServerTimeMs: () => issuedAtMs + 1_000,
  });
}

function requestFor(
  plan: TeachingSpikeLiveAuthorizationPlan,
): TeachingSpikeLiveAuthorizationRequest {
  return {
    live: true,
    execute: true,
    interactive: true,
    provider: plan.provider,
    ackPlanHash: plan.planHash,
    plan,
    currentTarget: plan.target,
    currentInputFixtureHash: plan.inputFixtureHash,
    currentPricing: plan.pricing,
  };
}

function protocolResult(
  provider: "qwen" | "doubao" = "qwen",
): RealtimeTeachingCoreProtocolResult {
  const common = {
    providerEvidence: false as const,
    fixtureRevision: TEACHING_SPIKE_FIXTURE_REVISION,
    fixtureHash: TEACHING_SPIKE_FIXTURE_HASH,
    scope: {
      transport: "isolated_provider_websocket" as const,
      relayExercised: false as const,
      browserExercised: false as const,
    },
    upstreamSessions: 2 as const,
    responseAttempts: 3 as const,
  };
  if (provider === "qwen") {
    return {
      ...common,
      schemaVersion: 3,
      provider,
      inputMode: "text",
      inputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
      instructionAcks: {
        total: 5,
        echoedMatch: 2,
        omitted: 3,
      },
      usage: qwenCoreUsage,
      cases: [
        completedCase("D01T", 1),
        completedCase("D02T", 1),
        completedCase("D03T", 1),
      ],
    };
  }
  return {
    ...common,
    schemaVersion: 1,
    provider,
    inputMode: "pcm16le",
    inputFixtureHash: doubaoInputFixtureHash,
    cases: [
      completedCase("D01", 1),
      completedCase("D02", 0),
      completedCase("D03", 1),
    ],
  };
}

function completedCase(
  id: "D01T" | "D02T" | "D03T" | "D01" | "D02" | "D03",
  expectedMarkerCount: 0 | 1,
) {
  return {
    id,
    status: "protocol_sequence_completed" as const,
    expectedMarkerCount,
    forbiddenMarkerCount: 0 as const,
  };
}

describe("realtime teaching live evidence report", () => {
  it("keeps every public core/fake result outside Provider evidence", () => {
    const auth = authorization();
    const report = buildRealtimeTeachingLiveEvidenceReport({
      authorization: auth,
      protocolResult: protocolResult(),
      priceSnapshotHash,
      usage: qwenObservedUsage,
    });

    expect(report).toMatchObject({
      schemaVersion: 5,
      runId: auth.runId,
      planHash: auth.planHash,
      provider: "qwen",
      providerEvidence: false,
      inputMode: "text",
      inputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
      priceSnapshotHash,
      budget: {
        authorizedCny: 2,
        preflightEstimatedMaximumCny: 1.5,
        observation: {
          available: true,
          estimatedCostCny: 0.00087,
          status: "within_authorized_limit",
        },
      },
      sessions: { authorized: 2 },
      responses: { authorized: 3 },
      progress: {
        available: true,
        observedSessions: 2,
        attemptedResponses: 3,
        caseCounts: {
          total: 3,
          protocolSequenceCompleted: 3,
          failed: 0,
          notRun: 0,
        },
      },
      instructionAcks: {
        available: true,
        total: 5,
        echoedMatch: 2,
        omitted: 3,
      },
      usage: {
        available: true,
        inputAudioMs: 0,
        outputAudioMs: 0,
        estimatedCostCny: 0.00087,
        audioDurationBasis: "not_applicable_text_only",
        providerTokens: { available: true, ...qwenCoreUsage },
      },
      scope: {
        transport: "isolated_provider_websocket",
        upstream: "scripted_fake_upstream",
        transportAttempted: true,
        relayExercised: false,
        browserExercised: false,
      },
      outcome: { status: "protocol_sequence_completed" },
      capabilityDecision: {
        status: "not_evaluated",
        reason: "insufficient_sample",
        protocolSequenceCompletedIsCapabilityPassed: false,
        requiresHumanReview: true,
      },
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.target)).toBe(true);
  });

  it("does not export an attestation mint and ignores forged promotion-shaped input", () => {
    expect(liveEvidenceModule).not.toHaveProperty(
      "createRealtimeTeachingRealTransportAttestor",
    );
    expect(liveEvidenceModule).not.toHaveProperty(
      "RealtimeTeachingRealTransportAttestation",
    );

    const forgedInput = {
      authorization: authorization(),
      protocolResult: protocolResult(),
      priceSnapshotHash,
      usage: qwenObservedUsage,
      transportAttestation: Object.freeze({ realTransportObservation: true }),
      providerEvidence: true,
    } as unknown as Parameters<
      typeof buildRealtimeTeachingLiveEvidenceReport
    >[0];
    const report = buildRealtimeTeachingLiveEvidenceReport(forgedInput);

    expect(report.providerEvidence).toBe(false);
    expect(report.scope.upstream).toBe("scripted_fake_upstream");
  });

  it("derives all seven Qwen token aggregates only from the strict core result", () => {
    const report = buildRealtimeTeachingLiveEvidenceReport({
      authorization: authorization(),
      protocolResult: protocolResult(),
      priceSnapshotHash,
      usage: qwenObservedUsage,
    });
    expect(report.usage).toMatchObject({
      available: true,
      providerTokens: { available: true, ...qwenCoreUsage },
    });

    expect(() =>
      buildRealtimeTeachingLiveEvidenceReport({
        authorization: authorization(),
        protocolResult: {
          ...protocolResult(),
          usage: { ...qwenCoreUsage, totalTokens: 49 },
        } as unknown as RealtimeTeachingCoreProtocolResult,
        priceSnapshotHash,
        usage: qwenObservedUsage,
      }),
    ).toThrowError(
      expect.objectContaining<RealtimeTeachingLiveEvidenceError>({
        code: "INVALID_PROTOCOL_RESULT",
      }),
    );

    expect(() =>
      buildRealtimeTeachingLiveEvidenceReport({
        authorization: authorization(),
        protocolResult: {
          ...protocolResult(),
          usage: {
            ...qwenCoreUsage,
            outputTextTokens: 17,
            outputAudioTokens: 1,
          },
        } as RealtimeTeachingCoreProtocolResult,
        priceSnapshotHash,
        usage: qwenObservedUsage,
      }),
    ).toThrowError(
      expect.objectContaining<RealtimeTeachingLiveEvidenceError>({
        code: "INVALID_PROTOCOL_RESULT",
      }),
    );

    expect(() =>
      buildRealtimeTeachingLiveEvidenceReport({
        authorization: authorization(),
        protocolResult: protocolResult(),
        priceSnapshotHash,
        usage: {
          ...qwenObservedUsage,
          providerTokens: { available: false },
        } as unknown as RealtimeTeachingLiveObservedUsageInput,
      }),
    ).toThrowError(
      expect.objectContaining<RealtimeTeachingLiveEvidenceError>({
        code: "INVALID_USAGE",
      }),
    );
  });

  it("copies Qwen instruction ACK counts only from the completed protocol result", () => {
    const result = {
      ...protocolResult(),
      instructionAcks: { total: 5, echoedMatch: 4, omitted: 1 },
    } as RealtimeTeachingCoreProtocolResult;
    const forgedInput = {
      authorization: authorization(),
      protocolResult: result,
      priceSnapshotHash,
      usage: qwenObservedUsage,
      instructionAcks: {
        available: true,
        total: 5,
        echoedMatch: 0,
        omitted: 5,
      },
    } as unknown as Parameters<
      typeof buildRealtimeTeachingLiveEvidenceReport
    >[0];

    const qwenReport = buildRealtimeTeachingLiveEvidenceReport(forgedInput);
    expect(qwenReport.instructionAcks).toEqual({
      available: true,
      total: 5,
      echoedMatch: 4,
      omitted: 1,
    });

    const doubaoReport = buildRealtimeTeachingLiveEvidenceReport({
      authorization: authorization("doubao"),
      protocolResult: protocolResult("doubao"),
      priceSnapshotHash,
      usage: {
        inputAudioMs: 6_000,
        outputAudioMs: 9_000,
        estimatedCostCny: 0.4,
      },
    });
    expect(doubaoReport.instructionAcks).toEqual({ available: false });

    for (const forgedReport of [
      { ...qwenReport, instructionAcks: { available: false } },
      {
        ...doubaoReport,
        instructionAcks: {
          available: true,
          total: 5,
          echoedMatch: 4,
          omitted: 1,
        },
      },
    ]) {
      expect(() =>
        serializeRealtimeTeachingLiveEvidenceReport(forgedReport),
      ).toThrowError(
        expect.objectContaining<RealtimeTeachingLiveEvidenceError>({
          code: "INVALID_REPORT",
        }),
      );
    }
  });

  it("rejects malformed or content-bearing instruction ACK evidence", () => {
    const invalidCounts = [
      { total: 4, echoedMatch: 2, omitted: 2 },
      { total: 5, echoedMatch: 2, omitted: 2 },
      { total: 5, echoedMatch: -1, omitted: 6 },
      { total: 5, echoedMatch: 2.5, omitted: 2.5 },
    ];
    const contentBearing = [
      "instructions",
      "marker",
      "instructionHash",
      "sessionId",
      "responseId",
      "eventId",
    ].map((key) => ({
      total: 5,
      echoedMatch: 2,
      omitted: 3,
      [key]: `SECRET_${key}`,
    }));

    for (const instructionAcks of [...invalidCounts, ...contentBearing]) {
      expect(() =>
        buildRealtimeTeachingLiveEvidenceReport({
          authorization: authorization(),
          protocolResult: {
            ...protocolResult(),
            instructionAcks,
          } as unknown as RealtimeTeachingCoreProtocolResult,
          priceSnapshotHash,
          usage: qwenObservedUsage,
        }),
      ).toThrowError(
        expect.objectContaining<RealtimeTeachingLiveEvidenceError>({
          code: "INVALID_PROTOCOL_RESULT",
        }),
      );
    }
  });

  it("distinguishes unknown failure progress from observed partial progress", () => {
    const auth = authorization();
    const unknownProgress = buildRealtimeTeachingLiveFailureEvidenceReport({
      authorization: auth,
      priceSnapshotHash,
      errorCode: "RUNTIME_RESOLUTION_FAILED",
      transportAttempted: false,
      progress: { available: false },
    });
    expect(unknownProgress).toMatchObject({
      providerEvidence: false,
      budget: { observation: { available: false } },
      sessions: { authorized: 2 },
      responses: { authorized: 3 },
      progress: { available: false },
      instructionAcks: { available: false },
      usage: { available: false },
      scope: {
        upstream: "unattested_or_not_observed",
        transportAttempted: false,
      },
      outcome: {
        status: "failed",
        errorCode: "RUNTIME_RESOLUTION_FAILED",
      },
      capabilityDecision: {
        status: "not_evaluated",
        reason: "insufficient_sample",
      },
    });

    const partial = buildRealtimeTeachingLiveFailureEvidenceReport({
      authorization: auth,
      priceSnapshotHash,
      errorCode: "PROTOCOL_SEQUENCE_FAILED",
      transportAttempted: true,
      progress: {
        available: true,
        observedSessions: 1,
        attemptedResponses: 2,
        protocolSequenceCompleted: 1,
        failed: 1,
      },
    });
    expect(partial).toMatchObject({
      progress: {
        available: true,
        observedSessions: 1,
        attemptedResponses: 2,
        caseCounts: {
          protocolSequenceCompleted: 1,
          failed: 1,
          notRun: 1,
        },
      },
      providerEvidence: false,
      instructionAcks: { available: false },
      outcome: {
        status: "failed",
        errorCode: "PROTOCOL_SEQUENCE_FAILED",
      },
    });
  });

  it("persists only allowlisted Qwen adapter diagnostics", () => {
    const report = buildRealtimeTeachingLiveFailureEvidenceReport({
      authorization: authorization(),
      priceSnapshotHash,
      errorCode: "PROTOCOL_SEQUENCE_FAILED",
      transportAttempted: true,
      progress: { available: false },
      diagnostic: {
        available: true,
        source: "qwen_live_adapter",
        checkpoint: "session_1_base_update_ack",
        adapterErrorCode: "INVALID_SESSION_UPDATED_EVENT",
        providerError: { available: false },
        markerAssertion: { available: false },
      },
    });

    expect(report).toMatchObject({
      progress: { available: false },
      instructionAcks: { available: false },
      usage: { available: false },
      diagnostic: {
        available: true,
        source: "qwen_live_adapter",
        checkpoint: "session_1_base_update_ack",
        adapterErrorCode: "INVALID_SESSION_UPDATED_EVENT",
        providerError: { available: false },
        markerAssertion: { available: false },
      },
    });
    const serialized = serializeRealtimeTeachingLiveEvidenceReport(report);
    expect(serialized).not.toContain("event_secret");
    expect(serialized).not.toContain("wss://");

    expect(() =>
      buildRealtimeTeachingLiveFailureEvidenceReport({
        authorization: authorization(),
        priceSnapshotHash,
        errorCode: "PROTOCOL_SEQUENCE_FAILED",
        transportAttempted: true,
        progress: { available: false },
        diagnostic: {
          available: true,
          source: "qwen_live_adapter",
          checkpoint: "session_1_base_update_ack",
          adapterErrorCode: "INVALID_SESSION_UPDATED_EVENT",
          providerError: { available: false },
          markerAssertion: { available: false },
          eventId: "event_secret",
        } as never,
      }),
    ).toThrowError(
      expect.objectContaining<RealtimeTeachingLiveEvidenceError>({
        code: "INVALID_FAILURE_DIAGNOSTIC",
      }),
    );
  });

  it("rejects caller-forged marker observations outside the adapter accessor", () => {
    expect(() =>
      buildRealtimeTeachingLiveFailureEvidenceReport({
        authorization: authorization(),
        priceSnapshotHash,
        errorCode: "PROTOCOL_SEQUENCE_FAILED",
        transportAttempted: true,
        progress: {
          available: true,
          observedSessions: 1,
          attemptedResponses: 1,
          protocolSequenceCompleted: 0,
          failed: 1,
        },
        diagnostic: {
          available: true,
          source: "qwen_live_adapter",
          checkpoint: "d01t_case",
          adapterErrorCode: "MARKER_ASSERTION_FAILED",
          providerError: { available: false },
          markerAssertion: {
            available: true,
            caseId: "D01T",
            expectedState: "A",
            activeInstructionAck: "omitted",
            observedInstructionAcks: {
              total: 1,
              echoedMatch: 0,
              omitted: 1,
            },
            markerMultiplicity: {
              a: "zero",
              b: "zero",
              c: "zero",
            },
            hasUnexpectedText: true,
          },
        },
      }),
    ).toThrowError(
      expect.objectContaining<RealtimeTeachingLiveEvidenceError>({
        code: "INVALID_FAILURE_DIAGNOSTIC",
      }),
    );
  });

  it("rejects marker diagnostics that deny unexpected text", () => {
    expect(() =>
      buildRealtimeTeachingLiveFailureEvidenceReport({
        authorization: authorization(),
        priceSnapshotHash,
        errorCode: "PROTOCOL_SEQUENCE_FAILED",
        transportAttempted: true,
        progress: {
          available: true,
          observedSessions: 1,
          attemptedResponses: 1,
          protocolSequenceCompleted: 0,
          failed: 1,
        },
        diagnostic: {
          available: true,
          source: "qwen_live_adapter",
          checkpoint: "d01t_case",
          adapterErrorCode: "MARKER_ASSERTION_FAILED",
          providerError: { available: false },
          markerAssertion: {
            available: true,
            caseId: "D01T",
            expectedState: "A",
            activeInstructionAck: "omitted",
            observedInstructionAcks: {
              total: 1,
              echoedMatch: 0,
              omitted: 1,
            },
            markerMultiplicity: {
              a: "zero",
              b: "zero",
              c: "zero",
            },
            hasUnexpectedText: false,
          },
        } as never,
      }),
    ).toThrowError(
      expect.objectContaining<RealtimeTeachingLiveEvidenceError>({
        code: "INVALID_FAILURE_DIAGNOSTIC",
      }),
    );
  });

  it("serializes only categorized Provider error diagnostics", () => {
    const report = buildRealtimeTeachingLiveFailureEvidenceReport({
      authorization: authorization(),
      priceSnapshotHash,
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

    expect(report.diagnostic).toEqual({
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
    });
    const serialized = serializeRealtimeTeachingLiveEvidenceReport(report);
    const keys = collectKeys(JSON.parse(serialized) as unknown);
    for (const forbiddenKey of [
      "message",
      "type",
      "code",
      "param",
      "rawType",
      "rawCode",
      "rawParam",
      "eventId",
    ]) {
      expect(keys).not.toContain(forbiddenKey);
    }
    expect(serialized).not.toContain("SECRET_PROVIDER_MESSAGE");
    expect(serialized).not.toContain("wss://provider.example/private");
  });

  it("rejects raw Provider error fields and arbitrary categories", () => {
    const base = {
      authorization: authorization(),
      priceSnapshotHash,
      errorCode: "PROTOCOL_SEQUENCE_FAILED" as const,
      transportAttempted: true,
      progress: { available: false as const },
      diagnostic: {
        available: true as const,
        source: "qwen_live_adapter" as const,
        checkpoint: "d01t_case" as const,
        adapterErrorCode: "PROVIDER_ERROR" as const,
        providerError: {
          available: true as const,
          typeCategory: "invalid_request" as const,
          codeCategory: "invalid_value" as const,
          paramCategory: "response_create" as const,
        },
        markerAssertion: { available: false as const },
      },
    };

    for (const diagnostic of [
      {
        available: true as const,
        source: "qwen_live_adapter" as const,
        checkpoint: "d01t_case" as const,
        adapterErrorCode: "PROVIDER_ERROR" as const,
      },
      {
        ...base.diagnostic,
        providerError: {
          ...base.diagnostic.providerError,
          message:
            "SECRET_API_KEY wss://provider.example/private transcript_secret",
        },
      },
      {
        ...base.diagnostic,
        providerError: {
          ...base.diagnostic.providerError,
          typeCategory: "SECRET_PROVIDER_TYPE",
        },
      },
      {
        ...base.diagnostic,
        providerError: {
          ...base.diagnostic.providerError,
          codeCategory: "SECRET_PROVIDER_CODE",
        },
      },
      {
        ...base.diagnostic,
        providerError: {
          ...base.diagnostic.providerError,
          paramCategory: "SECRET_PROVIDER_PARAM",
        },
      },
    ]) {
      expect(() =>
        buildRealtimeTeachingLiveFailureEvidenceReport({
          ...base,
          diagnostic: diagnostic as never,
        }),
      ).toThrowError(
        expect.objectContaining<RealtimeTeachingLiveEvidenceError>({
          code: "INVALID_FAILURE_DIAGNOSTIC",
        }),
      );
    }
  });

  it("binds categorized Provider errors exactly to PROVIDER_ERROR", () => {
    const common = {
      authorization: authorization(),
      priceSnapshotHash,
      errorCode: "PROTOCOL_SEQUENCE_FAILED" as const,
      transportAttempted: true,
      progress: { available: false as const },
      diagnostic: {
        available: true as const,
        source: "qwen_live_adapter" as const,
        checkpoint: "d01t_case" as const,
        markerAssertion: { available: false as const },
      },
    };
    const categorizedProviderError = {
      available: true as const,
      typeCategory: "unrecognized" as const,
      codeCategory: "missing" as const,
      paramCategory: "unrecognized" as const,
    };

    for (const diagnostic of [
      {
        ...common.diagnostic,
        adapterErrorCode: "PROVIDER_ERROR" as const,
        providerError: { available: false as const },
      },
      {
        ...common.diagnostic,
        adapterErrorCode: "INVALID_SERVER_EVENT" as const,
        providerError: categorizedProviderError,
      },
    ]) {
      expect(() =>
        buildRealtimeTeachingLiveFailureEvidenceReport({
          ...common,
          diagnostic,
        }),
      ).toThrowError(
        expect.objectContaining<RealtimeTeachingLiveEvidenceError>({
          code: "INVALID_REPORT",
        }),
      );
    }

    expect(() =>
      buildRealtimeTeachingLiveFailureEvidenceReport({
        ...common,
        transportAttempted: false,
        diagnostic: {
          ...common.diagnostic,
          adapterErrorCode: "PROVIDER_ERROR",
          providerError: categorizedProviderError,
        },
      }),
    ).toThrowError(
      expect.objectContaining<RealtimeTeachingLiveEvidenceError>({
        code: "INVALID_REPORT",
      }),
    );
  });

  it("rejects arbitrary failure codes and inconsistent progress", () => {
    const auth = authorization();
    expect(() =>
      buildRealtimeTeachingLiveFailureEvidenceReport({
        authorization: auth,
        priceSnapshotHash,
        errorCode: "RUNTIME_RESOLUTION_FAILED",
        transportAttempted: false,
        progress: {
          available: false,
          observedSessions: 0,
          attemptedResponses: 0,
          protocolSequenceCompleted: 0,
          failed: 0,
        } as unknown as { available: false },
      }),
    ).toThrowError(
      expect.objectContaining<RealtimeTeachingLiveEvidenceError>({
        code: "INVALID_FAILURE_PROGRESS",
      }),
    );

    expect(() =>
      buildRealtimeTeachingLiveFailureEvidenceReport({
        authorization: auth,
        priceSnapshotHash,
        errorCode: "SECRET_ENDPOINT_wss://private" as never,
        transportAttempted: false,
        progress: { available: false },
      }),
    ).toThrowError(
      expect.objectContaining<RealtimeTeachingLiveEvidenceError>({
        code: "INVALID_FAILURE_CODE",
      }),
    );

    expect(() =>
      buildRealtimeTeachingLiveFailureEvidenceReport({
        authorization: auth,
        priceSnapshotHash,
        errorCode: "PROTOCOL_SEQUENCE_FAILED",
        transportAttempted: false,
        progress: {
          available: true,
          observedSessions: 1,
          attemptedResponses: 1,
          protocolSequenceCompleted: 1,
          failed: 0,
        },
      }),
    ).toThrowError(
      expect.objectContaining<RealtimeTeachingLiveEvidenceError>({
        code: "INVALID_FAILURE_PROGRESS",
      }),
    );
  });

  it("returns a redacted failure after authorization consumption without exposing runtime errors", async () => {
    const plan = authorizationPlan(
      "qwen",
      "70000000-0000-4000-8000-000000000007",
      buildQwenTeachingSpikePricingBinding(),
    );
    const request = structuredClone(requestFor(plan));
    const originalPlanHash = plan.planHash;
    const originalPriceSnapshotHash = plan.pricing.priceSnapshotHash;
    const secret =
      "SECRET_API_KEY endpoint=wss://provider.example/private session_secret";
    const report =
      await runAuthorizedQwenTeachingLiveCompositionAndBuildEvidence({
        request,
        dependencies: {
          clock: { readServerTimeMs: () => issuedAtMs + 1_000 },
          consumeAuthorization: () => "consumed",
          resolveRuntime: async (authorized) => {
            request.plan.limits.budgetCny = 0.01;
            request.plan.pricing.priceSnapshotHash = "f".repeat(64);
            request.plan.target.modelProfileRevision = 999;
            expect(authorized.planHash).toBe(originalPlanHash);
            expect(authorized.limits.budgetCny).toBe(2);
            throw new Error(secret);
          },
        },
      });

    expect(report).toMatchObject({
      providerEvidence: false,
      planHash: originalPlanHash,
      priceSnapshotHash: originalPriceSnapshotHash,
      budget: { authorizedCny: 2 },
      target: { modelProfileRevision: qwenTarget.modelProfileRevision },
      progress: { available: false },
      usage: { available: false },
      outcome: {
        status: "failed",
        errorCode: "RUNTIME_RESOLUTION_FAILED",
      },
      capabilityDecision: { status: "not_evaluated" },
    });
    expect(serializeRealtimeTeachingLiveEvidenceReport(report)).not.toContain(
      secret,
    );
  });

  it("fails with a fixed local code before authorization consumption", async () => {
    const plan = authorizationPlan(
      "qwen",
      "70000000-0000-4000-8000-000000000007",
      buildQwenTeachingSpikePricingBinding(),
    );
    await expect(
      runAuthorizedQwenTeachingLiveCompositionAndBuildEvidence({
        request: requestFor(plan),
        dependencies: {
          clock: { readServerTimeMs: () => issuedAtMs + 1_000 },
          consumeAuthorization: () => "already_consumed",
          resolveRuntime: async () => {
            throw new Error("SHOULD_NOT_RUN");
          },
        },
      }),
    ).rejects.toMatchObject<RealtimeTeachingLiveEvidenceError>({
      code: "LIVE_RUN_FAILED_BEFORE_AUTHORIZATION_CONSUMED",
    });
  });

  it("binds protocol, price, and observed usage to the authorization", () => {
    const qwen = authorization();
    expect(() =>
      buildRealtimeTeachingLiveEvidenceReport({
        authorization: qwen,
        protocolResult: protocolResult("doubao"),
        priceSnapshotHash,
        usage: zeroObservedUsage,
      }),
    ).toThrowError(
      expect.objectContaining<RealtimeTeachingLiveEvidenceError>({
        code: "PROTOCOL_AUTHORIZATION_MISMATCH",
      }),
    );
    expect(() =>
      buildRealtimeTeachingLiveEvidenceReport({
        authorization: qwen,
        protocolResult: protocolResult(),
        priceSnapshotHash,
        usage: { ...zeroObservedUsage, inputAudioMs: 1 },
      }),
    ).toThrowError(
      expect.objectContaining<RealtimeTeachingLiveEvidenceError>({
        code: "INVALID_USAGE",
      }),
    );
    expect(() =>
      buildRealtimeTeachingLiveEvidenceReport({
        authorization: qwen,
        protocolResult: protocolResult(),
        priceSnapshotHash: otherPriceSnapshotHash,
        usage: qwenObservedUsage,
      }),
    ).toThrowError(
      expect.objectContaining<RealtimeTeachingLiveEvidenceError>({
        code: "PRICE_SNAPSHOT_MISMATCH",
      }),
    );
  });

  it("rejects core evidence claims and hidden content", () => {
    const auth = authorization();
    for (const unsafeResult of [
      { ...protocolResult(), providerEvidence: true },
      { ...protocolResult(), transcript: "SECRET_TRANSCRIPT" },
      { ...protocolResult(), apiKey: "SECRET_API_KEY" },
    ]) {
      expect(() =>
        buildRealtimeTeachingLiveEvidenceReport({
          authorization: auth,
          protocolResult:
            unsafeResult as unknown as RealtimeTeachingCoreProtocolResult,
          priceSnapshotHash,
          usage: qwenObservedUsage,
        }),
      ).toThrowError(
        expect.objectContaining<RealtimeTeachingLiveEvidenceError>({
          code: "INVALID_PROTOCOL_RESULT",
        }),
      );
    }
  });

  it("serializes an allowlist only and never emits bodies, credentials, endpoints, or Provider entity IDs", () => {
    const report = buildRealtimeTeachingLiveEvidenceReport({
      authorization: authorization("doubao"),
      protocolResult: protocolResult("doubao"),
      priceSnapshotHash,
      usage: {
        inputAudioMs: 6_000,
        outputAudioMs: 9_000,
        estimatedCostCny: 0.4,
      },
    });
    const serialized = serializeRealtimeTeachingLiveEvidenceReport(
      report,
      true,
    );
    const forbiddenValues = [
      "SECRET_TRANSCRIPT",
      "SECRET_PROMPT",
      "SECRET_PCM",
      "SECRET_BASE64",
      "SECRET_API_KEY",
      "wss://provider.example/private",
      "sess_secret",
      "item_secret",
      "response_secret",
    ];
    for (const value of forbiddenValues)
      expect(serialized).not.toContain(value);

    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    const keys = collectKeys(parsed);
    for (const forbiddenKey of [
      "transcript",
      "prompt",
      "pcm",
      "base64",
      "apiKey",
      "endpoint",
      "sessionId",
      "itemId",
      "responseId",
      "eventId",
      "instructions",
      "instructionHash",
      "marker",
      "errorMessage",
      "errorDetail",
    ]) {
      expect(keys).not.toContain(forbiddenKey);
    }

    const structurallyValidClone = JSON.parse(serialized) as unknown;
    expect(() =>
      serializeRealtimeTeachingLiveEvidenceReport(structurallyValidClone),
    ).toThrowError(
      expect.objectContaining<RealtimeTeachingLiveEvidenceError>({
        code: "INVALID_REPORT",
      }),
    );

    expect(() =>
      serializeRealtimeTeachingLiveEvidenceReport({
        ...report,
        providerEvidence: true,
        scope: {
          transport: "isolated_provider_websocket",
          upstream: "attested_real_provider",
          transportAttempted: true,
          relayExercised: false,
          browserExercised: false,
        },
      }),
    ).toThrowError(
      expect.objectContaining<RealtimeTeachingLiveEvidenceError>({
        code: "INVALID_REPORT",
      }),
    );

    const failureReport = buildRealtimeTeachingLiveFailureEvidenceReport({
      authorization: authorization(),
      priceSnapshotHash,
      errorCode: "TRANSPORT_FAILED",
      transportAttempted: true,
      progress: { available: false },
    });
    expect(failureReport.providerEvidence).toBe(false);
    expect(() =>
      serializeRealtimeTeachingLiveEvidenceReport({
        ...failureReport,
        providerEvidence: true,
      }),
    ).toThrowError(
      expect.objectContaining<RealtimeTeachingLiveEvidenceError>({
        code: "INVALID_REPORT",
      }),
    );
    expect(() =>
      serializeRealtimeTeachingLiveEvidenceReport({
        ...failureReport,
        instructionAcks: {
          available: true,
          total: 5,
          echoedMatch: 2,
          omitted: 3,
        },
      }),
    ).toThrowError(
      expect.objectContaining<RealtimeTeachingLiveEvidenceError>({
        code: "INVALID_REPORT",
      }),
    );

    for (const unsafeReport of [
      { ...report, transcript: "SECRET_TRANSCRIPT" },
      { ...report, endpoint: "wss://provider.example/private" },
      {
        ...report,
        instructionAcks: {
          available: true,
          total: 5,
          echoedMatch: 2,
          omitted: 3,
          instructions: "SECRET_PROMPT",
        },
      },
      {
        ...report,
        usage: { ...report.usage, apiKey: "SECRET_API_KEY" },
      },
      {
        ...report,
        capabilityDecision: {
          ...report.capabilityDecision,
          capabilityPassed: true,
        },
      },
    ]) {
      expect(() =>
        serializeRealtimeTeachingLiveEvidenceReport(unsafeReport),
      ).toThrowError(
        expect.objectContaining<RealtimeTeachingLiveEvidenceError>({
          code: "INVALID_REPORT",
        }),
      );
    }
  });
});

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  if (typeof value !== "object" || value === null) return keys;
  for (const [key, nested] of Object.entries(value)) {
    keys.push(key);
    collectKeys(nested, keys);
  }
  return keys;
}
