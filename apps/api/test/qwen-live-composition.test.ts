import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  buildTeachingSpikeLiveAuthorizationPlan,
  type TeachingSpikeLiveAuthorization,
  type TeachingSpikeLiveAuthorizationRequest,
  type TeachingSpikeLiveTarget,
} from "../src/spikes/realtime-teaching/live-authorization.js";
import {
  qwenTeachingLiveWebSocketEndpointFingerprint,
  runAuthorizedQwenTeachingLiveCompositionForTest,
} from "../src/spikes/realtime-teaching/qwen-live-composition.js";
import type { QwenTeachingLiveSmokeResult } from "../src/spikes/realtime-teaching/qwen-live-adapter.js";
import { buildQwenTeachingSpikePricingBinding } from "../src/spikes/realtime-teaching/pricing.js";
import {
  TEACHING_SPIKE_FIXTURE_HASH,
  TEACHING_SPIKE_FIXTURE_REVISION,
  TEACHING_SPIKE_USER_TEXT_HASH,
} from "../src/spikes/realtime-teaching/fixtures.js";

const endpoint = "workspace.cn-beijing.maas.aliyuncs.com";
const model = "qwen-audio-3.0-realtime-plus";
const nowMs = 1_786_656_001_000;
const pricing = buildQwenTeachingSpikePricingBinding();
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
    endpoint,
    model,
  ),
  databaseScope: "isolated_spike",
  databaseFingerprint: "b".repeat(64),
};

describe("Qwen live teaching composition", () => {
  it("fingerprints only the exact official WSS path and model query", () => {
    const expectedUrl =
      "wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen-audio-3.0-realtime-plus";
    expect(qwenTeachingLiveWebSocketEndpointFingerprint(endpoint, model)).toBe(
      createHash("sha256").update(expectedUrl).digest("hex"),
    );
    expect(() =>
      qwenTeachingLiveWebSocketEndpointFingerprint(
        "https://workspace.cn-beijing.maas.aliyuncs.com/unapproved",
        model,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_REALTIME_ENDPOINT" }),
    );
    expect(() =>
      qwenTeachingLiveWebSocketEndpointFingerprint(
        "realtime.example.com",
        model,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_REALTIME_ENDPOINT" }),
    );
    expect(
      qwenTeachingLiveWebSocketEndpointFingerprint(
        "dashscope.aliyuncs.com",
        model,
      ),
    ).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("binds the consumed authorization to the exact runtime and keeps injected results non-evidence", async () => {
    const request = createRequest();
    const consumeAuthorization = vi.fn(() => "consumed" as const);
    const resolveRuntime = vi.fn(() => ({
      target,
      endpoint,
      apiKey: "test-only-key",
    }));
    const runProtocol = vi.fn(() => protocolResult());

    const result = await runAuthorizedQwenTeachingLiveCompositionForTest(
      request,
      {
        clock: { readServerTimeMs: () => nowMs },
        consumeAuthorization,
        resolveRuntime,
        runProtocol,
      },
    );

    expect(consumeAuthorization).toHaveBeenCalledWith({
      runId: request.plan.runId,
      planHash: request.plan.planHash,
      expiresAtMs: request.plan.expiresAtMs,
    });
    expect(runProtocol).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      provider: "qwen",
      providerEvidence: false,
      authorization: {
        runId: request.plan.runId,
        planHash: request.plan.planHash,
        target,
        inputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
      },
      protocol: { providerEvidence: false },
    });
    expect(result.protocol.instructionAcks).toEqual({
      total: 5,
      echoedMatch: 2,
      omitted: 3,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.authorization)).toBe(true);
    expect(Object.isFrozen(result.authorization.target)).toBe(true);
    expect(Object.isFrozen(result.authorization.pricing)).toBe(true);
    expect(Object.isFrozen(result.authorization.limits)).toBe(true);
    expect(Object.isFrozen(result.protocol)).toBe(true);
    expect(Object.isFrozen(result.protocol.instructionAcks)).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(endpoint);
    expect(serialized).not.toContain("test-only-key");
  });

  it("keeps the exact authorized snapshot when runtime resolution mutates the caller request", async () => {
    const request = structuredClone(createRequest());
    const originalPlanHash = request.plan.planHash;
    const originalBudget = request.plan.limits.budgetCny;
    const runProtocol = vi.fn(
      ({
        authorization,
      }: {
        authorization: TeachingSpikeLiveAuthorization;
      }) => {
        expect(authorization.planHash).toBe(originalPlanHash);
        return protocolResult();
      },
    );

    const result = await runAuthorizedQwenTeachingLiveCompositionForTest(
      request,
      {
        clock: { readServerTimeMs: () => nowMs },
        consumeAuthorization: () => "consumed",
        resolveRuntime: (authorization) => {
          request.plan.limits.budgetCny = 0.01;
          request.plan.target.modelId = "mutated-after-authorization";
          request.plan.pricing.priceSnapshotHash = "f".repeat(64);
          request.currentTarget.modelId = "mutated-current-target";
          expect(authorization.limits.budgetCny).toBe(originalBudget);
          expect(authorization.target.modelId).toBe(model);
          return { target, endpoint, apiKey: "test-only-key" };
        },
        runProtocol,
      },
    );

    expect(runProtocol).toHaveBeenCalledOnce();
    expect(result.authorization).toMatchObject({
      authorized: true,
      runId: "70000000-0000-4000-8000-000000000007",
      planHash: originalPlanHash,
      inputMode: "text",
      pricing,
      limits: { budgetCny: originalBudget },
      target,
    });
    expect(result.authorization.target.modelId).toBe(model);
  });

  it("rejects an injected protocol result that tries to claim Provider evidence", async () => {
    const forged = {
      ...protocolResult(),
      providerEvidence: true,
    } as unknown as QwenTeachingLiveSmokeResult;

    await expect(
      runAuthorizedQwenTeachingLiveCompositionForTest(createRequest(), {
        clock: { readServerTimeMs: () => nowMs },
        consumeAuthorization: () => "consumed",
        resolveRuntime: () => ({
          target,
          endpoint,
          apiKey: "test-only-key",
        }),
        runProtocol: () => forged,
      }),
    ).rejects.toMatchObject({ code: "INVALID_PROTOCOL_RESULT" });
  });

  it.each([
    [{ total: 4, echoedMatch: 2, omitted: 2 }],
    [{ total: 5, echoedMatch: 2, omitted: 2 }],
    [{ total: 5, echoedMatch: -1, omitted: 6 }],
    [{ total: 5, echoedMatch: 2.5, omitted: 2.5 }],
    [
      {
        total: 5,
        echoedMatch: 2,
        omitted: 3,
        rawInstructions: "SECRET_PROMPT",
      },
    ],
  ])("rejects unsafe instruction ACK evidence %j", async (instructionAcks) => {
    const forged = {
      ...protocolResult(),
      instructionAcks,
    } as unknown as QwenTeachingLiveSmokeResult;

    await expect(
      runAuthorizedQwenTeachingLiveCompositionForTest(createRequest(), {
        clock: { readServerTimeMs: () => nowMs },
        consumeAuthorization: () => "consumed",
        resolveRuntime: () => ({
          target,
          endpoint,
          apiKey: "test-only-key",
        }),
        runProtocol: () => forged,
      }),
    ).rejects.toMatchObject({ code: "INVALID_PROTOCOL_RESULT" });
  });

  it("rejects a runtime endpoint that does not match the authorized fingerprint before the injected runner", async () => {
    const runProtocol = vi.fn(() => protocolResult());
    await expect(
      runAuthorizedQwenTeachingLiveCompositionForTest(createRequest(), {
        clock: { readServerTimeMs: () => nowMs },
        consumeAuthorization: () => "consumed",
        resolveRuntime: () => ({
          target,
          endpoint: "other-workspace.cn-beijing.maas.aliyuncs.com",
          apiKey: "test-only-key",
        }),
        runProtocol,
      }),
    ).rejects.toMatchObject({ code: "ENDPOINT_FINGERPRINT_MISMATCH" });
    expect(runProtocol).not.toHaveBeenCalled();
  });

  it("rejects a plan-bound price snapshot that is not the independent Qwen price card", async () => {
    const stalePricing = {
      ...pricing,
      priceSnapshotHash: "f".repeat(64),
    };
    const plan = buildTeachingSpikeLiveAuthorizationPlan({
      target,
      budgetCny: 2,
      pricing: stalePricing,
      inputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
      runId: "70000000-0000-4000-8000-000000000008",
      issuedAtMs: nowMs - 1_000,
      expiresAtMs: nowMs + 60_000,
    });
    const request = createRequest({
      plan,
      ackPlanHash: plan.planHash,
      currentPricing: stalePricing,
    });
    const consumeAuthorization = vi.fn(() => "consumed" as const);

    await expect(
      runAuthorizedQwenTeachingLiveCompositionForTest(request, {
        clock: { readServerTimeMs: () => nowMs },
        consumeAuthorization,
        resolveRuntime: () => ({
          target,
          endpoint,
          apiKey: "test-only-key",
        }),
        runProtocol: () => protocolResult(),
      }),
    ).rejects.toMatchObject({ code: "PRICING_BINDING_MISMATCH" });
    expect(consumeAuthorization).not.toHaveBeenCalled();
  });

  it("rejects all before consumption or runtime resolution", async () => {
    const request = createRequest({ provider: "all" });
    const consumeAuthorization = vi.fn(() => "consumed" as const);
    const resolveRuntime = vi.fn(() => ({
      target,
      endpoint,
      apiKey: "test-only-key",
    }));
    await expect(
      runAuthorizedQwenTeachingLiveCompositionForTest(request, {
        clock: { readServerTimeMs: () => nowMs },
        consumeAuthorization,
        resolveRuntime,
        runProtocol: () => protocolResult(),
      }),
    ).rejects.toMatchObject({ code: "QWEN_ONLY" });
    expect(consumeAuthorization).not.toHaveBeenCalled();
    expect(resolveRuntime).not.toHaveBeenCalled();
  });

  it("rejects a different Qwen model before consuming the plus-only price card", async () => {
    const flashTarget: TeachingSpikeLiveTarget = {
      ...target,
      modelId: "qwen-audio-3.0-realtime-flash",
      endpointFingerprint: qwenTeachingLiveWebSocketEndpointFingerprint(
        endpoint,
        "qwen-audio-3.0-realtime-flash",
      ),
    };
    const plan = buildTeachingSpikeLiveAuthorizationPlan({
      target: flashTarget,
      budgetCny: 2,
      pricing,
      inputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
      runId: "70000000-0000-4000-8000-000000000009",
      issuedAtMs: nowMs - 1_000,
      expiresAtMs: nowMs + 60_000,
    });
    const consumeAuthorization = vi.fn(() => "consumed" as const);

    await expect(
      runAuthorizedQwenTeachingLiveCompositionForTest(
        createRequest({
          plan,
          ackPlanHash: plan.planHash,
          currentTarget: flashTarget,
        }),
        {
          clock: { readServerTimeMs: () => nowMs },
          consumeAuthorization,
          resolveRuntime: () => ({
            target: flashTarget,
            endpoint,
            apiKey: "test-only-key",
          }),
          runProtocol: () => protocolResult(),
        },
      ),
    ).rejects.toMatchObject({ code: "QWEN_ONLY" });
    expect(consumeAuthorization).not.toHaveBeenCalled();
  });
});

function createRequest(
  overrides: Partial<TeachingSpikeLiveAuthorizationRequest> = {},
): TeachingSpikeLiveAuthorizationRequest {
  const plan = buildTeachingSpikeLiveAuthorizationPlan({
    target,
    budgetCny: 2,
    pricing,
    inputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
    runId: "70000000-0000-4000-8000-000000000007",
    issuedAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 60_000,
  });
  return {
    live: true,
    execute: true,
    interactive: true,
    provider: "qwen",
    ackPlanHash: plan.planHash,
    plan,
    currentTarget: target,
    currentInputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
    currentPricing: pricing,
    ...overrides,
  };
}

function protocolResult(): QwenTeachingLiveSmokeResult {
  return {
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
  };
}
