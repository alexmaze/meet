import { describe, expect, it, vi } from "vitest";

import type {
  TeachingSpikeLiveAuthorizationRequest,
  TeachingSpikeLiveTarget,
} from "../src/spikes/realtime-teaching/live-authorization.js";
import type { QwenTeachingLiveCompositionDependencies } from "../src/spikes/realtime-teaching/qwen-live-composition.js";

const markerObservation = vi.hoisted(() => ({
  caseId: "D01T" as const,
  expectedState: "A" as const,
  activeInstructionAck: "omitted" as const,
  observedInstructionAcks: {
    total: 1,
    echoedMatch: 0,
    omitted: 1,
  },
  markerMultiplicity: {
    a: "zero" as const,
    b: "zero" as const,
    c: "zero" as const,
  },
  hasUnexpectedText: true,
  progress: {
    session: 1 as const,
    attempt: 1 as const,
    completed: 0 as const,
    failed: 1 as const,
  },
  usage: {
    totalTokens: 12,
    inputTokens: 10,
    outputTokens: 2,
    inputTextTokens: 10,
    inputAudioTokens: 0,
    outputTextTokens: 2,
    outputAudioTokens: 0,
  },
}));

vi.mock(
  "../src/spikes/realtime-teaching/qwen-live-adapter.js",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const AdapterError = actual.QwenTeachingLiveAdapterError as {
      new (...args: unknown[]): Error & { code: string };
      [Symbol.hasInstance](value: unknown): boolean;
    };
    const getOriginalObservation =
      actual.getQwenTeachingLiveMarkerFailureObservation as (
        error: unknown,
      ) => unknown;
    return {
      ...actual,
      getQwenTeachingLiveMarkerFailureObservation: (error: unknown) =>
        error instanceof AdapterError &&
        error.code === "MARKER_ASSERTION_FAILED"
          ? markerObservation
          : getOriginalObservation(error),
    };
  },
);

vi.mock(
  "../src/spikes/realtime-teaching/qwen-live-composition.js",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      runAuthorizedQwenTeachingLiveComposition: async (
        request: TeachingSpikeLiveAuthorizationRequest,
        dependencies: QwenTeachingLiveCompositionDependencies,
      ) => {
        const authorization = {
          authorized: true as const,
          runId: request.plan.runId,
          provider: request.plan.provider,
          planHash: request.plan.planHash,
          inputMode: request.plan.inputMode,
          inputFixtureHash: request.plan.inputFixtureHash,
          expiresAtMs: request.plan.expiresAtMs,
          caseIds: request.plan.caseIds,
          target: request.plan.target,
          pricing: request.plan.pricing,
          limits: request.plan.limits,
        };
        await dependencies.consumeAuthorization({
          runId: authorization.runId,
          planHash: authorization.planHash,
          expiresAtMs: authorization.expiresAtMs,
        });
        await dependencies.resolveRuntime(authorization);
        const adapter =
          await import("../src/spikes/realtime-teaching/qwen-live-adapter.js");
        throw new adapter.QwenTeachingLiveAdapterError(
          "MARKER_ASSERTION_FAILED",
          "D01T",
          "d01t_case",
        );
      },
    };
  },
);

import { buildTeachingSpikeLiveAuthorizationPlan } from "../src/spikes/realtime-teaching/live-authorization.js";
import {
  runAuthorizedQwenTeachingLiveCompositionAndBuildEvidence,
  serializeRealtimeTeachingLiveEvidenceReport,
} from "../src/spikes/realtime-teaching/live-evidence-report.js";
import { TEACHING_SPIKE_USER_TEXT_HASH } from "../src/spikes/realtime-teaching/fixtures.js";
import { buildQwenTeachingSpikePricingBinding } from "../src/spikes/realtime-teaching/pricing.js";

const nowMs = 1_786_656_001_000;
const endpoint = "workspace.cn-beijing.maas.aliyuncs.com";
const target: TeachingSpikeLiveTarget = {
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

function runMarkerFailureEvidence() {
  const pricing = buildQwenTeachingSpikePricingBinding();
  const plan = buildTeachingSpikeLiveAuthorizationPlan({
    target,
    budgetCny: 2,
    pricing,
    inputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
    runId: "70000000-0000-4000-8000-000000000007",
    issuedAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 60_000,
  });

  return runAuthorizedQwenTeachingLiveCompositionAndBuildEvidence({
    request: {
      live: true,
      execute: true,
      interactive: true,
      provider: "qwen",
      ackPlanHash: plan.planHash,
      plan,
      currentTarget: target,
      currentInputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
      currentPricing: pricing,
    },
    dependencies: {
      clock: { readServerTimeMs: () => nowMs },
      consumeAuthorization: () => "consumed",
      resolveRuntime: () => ({
        target,
        endpoint,
        apiKey: "SECRET_API_KEY",
      }),
    },
  });
}

describe("Qwen marker failure evidence", () => {
  it("copies only accessor-minted marker diagnostics, partial progress, usage, and cost", async () => {
    const report = await runMarkerFailureEvidence();

    expect(report).toMatchObject({
      schemaVersion: 5,
      providerEvidence: false,
      progress: {
        available: true,
        observedSessions: 1,
        attemptedResponses: 1,
        caseCounts: {
          total: 3,
          protocolSequenceCompleted: 0,
          failed: 1,
          notRun: 2,
        },
      },
      instructionAcks: { available: false },
      usage: {
        available: true,
        inputAudioMs: 0,
        outputAudioMs: 0,
        audioDurationBasis: "not_applicable_text_only",
        providerTokens: { available: true, ...markerObservation.usage },
        estimatedCostCny: 0.00013,
      },
      budget: {
        observation: {
          available: true,
          estimatedCostCny: 0.00013,
          status: "within_authorized_limit",
        },
      },
      scope: {
        upstream: "unattested_or_not_observed",
        transportAttempted: true,
      },
      outcome: {
        status: "failed",
        errorCode: "PROTOCOL_SEQUENCE_FAILED",
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
      capabilityDecision: {
        status: "not_evaluated",
        reason: "insufficient_sample",
      },
    });

    const serialized = serializeRealtimeTeachingLiveEvidenceReport(report);
    for (const forbidden of [
      "SECRET_API_KEY",
      "星尘",
      "月桂",
      "归航灯",
      '"instructions"',
      '"instructionHash"',
      '"sessionId"',
      '"responseId"',
      '"eventId"',
      '"prompt"',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("rejects an accessor marker observation without unexpected text", async () => {
    markerObservation.hasUnexpectedText = false;
    try {
      await expect(runMarkerFailureEvidence()).rejects.toMatchObject({
        code: "INVALID_FAILURE_DIAGNOSTIC",
      });
    } finally {
      markerObservation.hasUnexpectedText = true;
    }
  });
});
