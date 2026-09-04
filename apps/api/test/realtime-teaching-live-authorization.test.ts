import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  TEACHING_SPIKE_LIVE_MAX_RESPONSE_ATTEMPTS,
  TEACHING_SPIKE_LIVE_MAX_SESSIONS,
  TEACHING_SPIKE_LIVE_MAX_INPUT_MS,
  TEACHING_SPIKE_LIVE_MAX_OUTPUT_MS,
  TEACHING_SPIKE_LIVE_RUNNER_REVISION,
  TEACHING_SPIKE_LIVE_STAGE,
  TEACHING_SPIKE_LIVE_TIMEOUTS,
  TEACHING_SPIKE_DOUBAO_LIVE_CASE_IDS,
  TEACHING_SPIKE_QWEN_LIVE_CASE_IDS,
  TeachingSpikeLiveAuthorizationError,
  authorizeTeachingSpikeLiveExecution,
  buildTeachingSpikeLiveAuthorizationPlan,
  runWithTeachingSpikeLiveAuthorization,
  type TeachingSpikeLiveAuthorizationClock,
  type TeachingSpikeLiveAuthorizationConsumptionClaim,
  type TeachingSpikeLiveAuthorizationConsumptionResult,
  type TeachingSpikeLiveAuthorizationRequest,
  type TeachingSpikeLiveTarget,
} from "../src/spikes/realtime-teaching/live-authorization.js";
import {
  TEACHING_SPIKE_FIXTURE_HASH,
  TEACHING_SPIKE_FIXTURE_REVISION,
  TEACHING_SPIKE_USER_TEXT_HASH,
} from "../src/spikes/realtime-teaching/fixtures.js";

const doubaoInputFixtureHash = "d".repeat(64);
const pricingBinding = {
  priceSnapshotHash: "9".repeat(64),
  estimatedMaxCostCny: 0.75,
};
const authorizationWindow = {
  runId: "70000000-0000-4000-8000-000000000007",
  issuedAtMs: 1_786_656_000_000,
  expiresAtMs: 1_786_656_600_000,
};
const authorizationNowMs = authorizationWindow.issuedAtMs + 1_000;

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
  endpointFingerprint: "c".repeat(64),
};

function authorizedRequest(
  overrides: Partial<TeachingSpikeLiveAuthorizationRequest> = {},
): TeachingSpikeLiveAuthorizationRequest {
  const plan = buildTeachingSpikeLiveAuthorizationPlan({
    target: qwenTarget,
    budgetCny: 2,
    pricing: pricingBinding,
    inputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
    ...authorizationWindow,
  });
  return {
    live: true,
    execute: true,
    interactive: true,
    provider: "qwen",
    ackPlanHash: plan.planHash,
    plan,
    currentTarget: qwenTarget,
    currentInputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
    currentPricing: pricingBinding,
    ...overrides,
  };
}

function serverClockAt(nowMs: number): TeachingSpikeLiveAuthorizationClock {
  return { readServerTimeMs: () => nowMs };
}

function authorizeAt(
  request: TeachingSpikeLiveAuthorizationRequest,
  nowMs = authorizationNowMs,
) {
  return authorizeTeachingSpikeLiveExecution(request, serverClockAt(nowMs));
}

function createAtomicTestConsumptionStore(
  readServerTimeMs: () => number,
  registeredClaim: TeachingSpikeLiveAuthorizationConsumptionClaim,
) {
  let consumed = false;
  return vi.fn(
    async (
      claim: TeachingSpikeLiveAuthorizationConsumptionClaim,
    ): Promise<TeachingSpikeLiveAuthorizationConsumptionResult> => {
      if (
        claim.runId !== registeredClaim.runId ||
        claim.planHash !== registeredClaim.planHash ||
        claim.expiresAtMs !== registeredClaim.expiresAtMs
      ) {
        return "claim_mismatch";
      }
      if (readServerTimeMs() >= claim.expiresAtMs) return "expired";
      if (consumed) return "already_consumed";
      consumed = true;
      await Promise.resolve();
      return "consumed";
    },
  );
}

function consumptionClaimFor(
  request: TeachingSpikeLiveAuthorizationRequest,
): TeachingSpikeLiveAuthorizationConsumptionClaim {
  return {
    runId: request.plan.runId,
    planHash: request.plan.planHash,
    expiresAtMs: request.plan.expiresAtMs,
  };
}

describe("realtime teaching live authorization", () => {
  it("builds a stable plan that binds the target, fixture, runner, limits, and timeouts", () => {
    const first = buildTeachingSpikeLiveAuthorizationPlan({
      target: qwenTarget,
      budgetCny: 1.25,
      pricing: pricingBinding,
      inputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
      ...authorizationWindow,
    });
    const reorderedTarget = {
      databaseScope: qwenTarget.databaseScope,
      databaseFingerprint: qwenTarget.databaseFingerprint,
      voiceProfileRevision: qwenTarget.voiceProfileRevision,
      voiceProfileId: qwenTarget.voiceProfileId,
      connectionRevision: qwenTarget.connectionRevision,
      connectionId: qwenTarget.connectionId,
      modelProfileRevision: qwenTarget.modelProfileRevision,
      modelProfileId: qwenTarget.modelProfileId,
      endpointFingerprint: qwenTarget.endpointFingerprint,
      voiceId: qwenTarget.voiceId,
      modelId: qwenTarget.modelId,
      provider: qwenTarget.provider,
    } satisfies TeachingSpikeLiveTarget;
    const second = buildTeachingSpikeLiveAuthorizationPlan({
      target: reorderedTarget,
      budgetCny: 1.25,
      pricing: pricingBinding,
      inputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
      ...authorizationWindow,
    });

    expect(first.planHash).toBe(second.planHash);
    expect(first).toMatchObject({
      stage: TEACHING_SPIKE_LIVE_STAGE,
      ...authorizationWindow,
      provider: "qwen",
      inputMode: "text",
      inputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
      caseIds: TEACHING_SPIKE_QWEN_LIVE_CASE_IDS,
      target: qwenTarget,
      fixtureRevision: TEACHING_SPIKE_FIXTURE_REVISION,
      fixtureHash: TEACHING_SPIKE_FIXTURE_HASH,
      runnerRevision: TEACHING_SPIKE_LIVE_RUNNER_REVISION,
      pricing: pricingBinding,
      limits: {
        maxSessions: TEACHING_SPIKE_LIVE_MAX_SESSIONS,
        maxResponseAttempts: TEACHING_SPIKE_LIVE_MAX_RESPONSE_ATTEMPTS,
        maxInputMs: TEACHING_SPIKE_LIVE_MAX_INPUT_MS,
        maxOutputMs: TEACHING_SPIKE_LIVE_MAX_OUTPUT_MS,
        budgetCny: 1.25,
        timeouts: TEACHING_SPIKE_LIVE_TIMEOUTS,
      },
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.target)).toBe(true);
  });

  it("binds the database scope into the immutable plan hash", () => {
    const isolated = authorizedRequest().plan;
    const application = buildTeachingSpikeLiveAuthorizationPlan({
      target: { ...qwenTarget, databaseScope: "application_database" },
      budgetCny: 2,
      pricing: pricingBinding,
      inputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
      ...authorizationWindow,
    });

    expect(application.planHash).not.toBe(isolated.planHash);
  });

  it("binds the Provider-specific input and evidence cases", () => {
    const qwen = buildTeachingSpikeLiveAuthorizationPlan({
      target: qwenTarget,
      budgetCny: 1,
      pricing: pricingBinding,
      inputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
      ...authorizationWindow,
    });
    const doubao = buildTeachingSpikeLiveAuthorizationPlan({
      target: doubaoTarget,
      budgetCny: 1,
      pricing: pricingBinding,
      inputFixtureHash: doubaoInputFixtureHash,
      ...authorizationWindow,
    });

    expect(qwen).toMatchObject({
      provider: "qwen",
      inputMode: "text",
      caseIds: TEACHING_SPIKE_QWEN_LIVE_CASE_IDS,
    });
    expect(doubao).toMatchObject({
      provider: "doubao",
      inputMode: "pcm16le",
      inputFixtureHash: doubaoInputFixtureHash,
      caseIds: TEACHING_SPIKE_DOUBAO_LIVE_CASE_IDS,
    });
    expect(qwen.planHash).not.toBe(doubao.planHash);
  });

  it("rejects a Qwen plan for any text fixture other than the fixed input", () => {
    expect(() =>
      buildTeachingSpikeLiveAuthorizationPlan({
        target: qwenTarget,
        budgetCny: 1,
        pricing: pricingBinding,
        inputFixtureHash: "e".repeat(64),
        ...authorizationWindow,
      }),
    ).toThrowError(
      expect.objectContaining<TeachingSpikeLiveAuthorizationError>({
        code: "INVALID_INPUT_FIXTURE",
      }),
    );
  });

  it("rejects a missing, malformed, or underfunded pricing binding", () => {
    for (const pricing of [
      undefined,
      { ...pricingBinding, priceSnapshotHash: "not-a-hash" },
      { ...pricingBinding, estimatedMaxCostCny: 1.01 },
    ]) {
      expect(() =>
        buildTeachingSpikeLiveAuthorizationPlan({
          target: qwenTarget,
          budgetCny: 1,
          pricing: pricing as typeof pricingBinding,
          inputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
          ...authorizationWindow,
        }),
      ).toThrowError(
        expect.objectContaining<TeachingSpikeLiveAuthorizationError>({
          code: "INVALID_PRICING",
        }),
      );
    }
  });

  it.each([0, -1, 2.01, 3, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an unsafe budget: %s",
    (budgetCny) => {
      expect(() =>
        buildTeachingSpikeLiveAuthorizationPlan({
          target: qwenTarget,
          budgetCny,
          pricing: pricingBinding,
          inputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
          ...authorizationWindow,
        }),
      ).toThrowError(
        expect.objectContaining<TeachingSpikeLiveAuthorizationError>({
          code: "INVALID_BUDGET",
        }),
      );
    },
  );

  it("rejects a missing, reversed, or overly long authorization window", () => {
    for (const window of [
      { ...authorizationWindow, runId: "not-a-uuid" },
      {
        ...authorizationWindow,
        expiresAtMs: authorizationWindow.issuedAtMs,
      },
      {
        ...authorizationWindow,
        expiresAtMs: authorizationWindow.issuedAtMs + 10 * 60 * 1_000 + 1,
      },
    ]) {
      expect(() =>
        buildTeachingSpikeLiveAuthorizationPlan({
          target: qwenTarget,
          budgetCny: 1,
          pricing: pricingBinding,
          inputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
          ...window,
        }),
      ).toThrowError(
        expect.objectContaining<TeachingSpikeLiveAuthorizationError>({
          code: "INVALID_AUTHORIZATION_WINDOW",
        }),
      );
    }
  });

  it.each([
    ["live", { live: false }, "LIVE_CONFIRMATION_REQUIRED"],
    ["execute", { execute: false }, "EXECUTE_CONFIRMATION_REQUIRED"],
    [
      "interactive",
      { interactive: false },
      "INTERACTIVE_CONFIRMATION_REQUIRED",
    ],
    ["all providers", { provider: "all" }, "ALL_PROVIDERS_FORBIDDEN"],
    ["ack", { ackPlanHash: "0".repeat(64) }, "ACK_PLAN_HASH_MISMATCH"],
  ] as const)("requires the %s interlock", (_name, overrides, code) => {
    expect(() => authorizeAt(authorizedRequest(overrides))).toThrowError(
      expect.objectContaining<TeachingSpikeLiveAuthorizationError>({ code }),
    );
  });

  it("rejects a Provider mismatch", () => {
    expect(() =>
      authorizeAt(authorizedRequest({ provider: "doubao" })),
    ).toThrowError(
      expect.objectContaining<TeachingSpikeLiveAuthorizationError>({
        code: "PROVIDER_MISMATCH",
      }),
    );
  });

  it("rejects expired or not-yet-valid authorization windows", () => {
    expect(() =>
      authorizeAt(authorizedRequest(), authorizationWindow.expiresAtMs),
    ).toThrowError(
      expect.objectContaining<TeachingSpikeLiveAuthorizationError>({
        code: "AUTHORIZATION_EXPIRED",
      }),
    );
    expect(() =>
      authorizeAt(authorizedRequest(), authorizationWindow.issuedAtMs - 1),
    ).toThrowError(
      expect.objectContaining<TeachingSpikeLiveAuthorizationError>({
        code: "AUTHORIZATION_EXPIRED",
      }),
    );
  });

  it("does not accept a request-supplied timestamp as authorization evidence", () => {
    const requestWithSpoofedTime = {
      ...authorizedRequest(),
      nowMs: authorizationNowMs,
    } as TeachingSpikeLiveAuthorizationRequest;

    expect(() =>
      authorizeAt(requestWithSpoofedTime, authorizationWindow.expiresAtMs),
    ).toThrowError(
      expect.objectContaining<TeachingSpikeLiveAuthorizationError>({
        code: "AUTHORIZATION_EXPIRED",
      }),
    );
  });

  it("binds the exact input fixture before credential or socket access", async () => {
    const consumeAuthorization = vi.fn(() => "consumed" as const);
    const readCredential = vi.fn(() => "test-credential");
    const openSocket = vi.fn(() => "connected");

    await expect(
      runWithTeachingSpikeLiveAuthorization(
        authorizedRequest({ currentInputFixtureHash: "e".repeat(64) }),
        {
          clock: serverClockAt(authorizationNowMs),
          consumeAuthorization,
          readCredential,
          openSocket,
        },
      ),
    ).rejects.toMatchObject({ code: "STALE_INPUT_FIXTURE" });
    expect(consumeAuthorization).not.toHaveBeenCalled();
    expect(readCredential).not.toHaveBeenCalled();
    expect(openSocket).not.toHaveBeenCalled();
  });

  it("rejects a stale target and a plan whose signed fields changed", () => {
    expect(() =>
      authorizeAt(
        authorizedRequest({
          currentTarget: { ...qwenTarget, connectionRevision: 12 },
        }),
      ),
    ).toThrowError(
      expect.objectContaining<TeachingSpikeLiveAuthorizationError>({
        code: "STALE_TARGET",
      }),
    );

    const request = authorizedRequest();
    const tamperedPlan = {
      ...request.plan,
      limits: { ...request.plan.limits, budgetCny: 1 },
    };
    expect(() =>
      authorizeAt({
        ...request,
        plan: tamperedPlan,
      }),
    ).toThrowError(
      expect.objectContaining<TeachingSpikeLiveAuthorizationError>({
        code: "PLAN_HASH_MISMATCH",
      }),
    );
  });

  it.each(["2026-08-15.7", "2026-08-15.8", "2026-08-15.9"])(
    "rejects stale runner plan %s before consuming authorization or reading credentials",
    async (runnerRevision) => {
      const request = authorizedRequest();
      const consumeAuthorization = vi.fn(() => "consumed" as const);
      const readCredential = vi.fn(() => "test-credential");
      const openSocket = vi.fn(() => "connected");

      await expect(
        runWithTeachingSpikeLiveAuthorization(
          {
            ...request,
            plan: {
              ...request.plan,
              runnerRevision,
            },
          },
          {
            clock: serverClockAt(authorizationNowMs),
            consumeAuthorization,
            readCredential,
            openSocket,
          },
        ),
      ).rejects.toMatchObject({ code: "STALE_PLAN_REVISION" });
      expect(consumeAuthorization).not.toHaveBeenCalled();
      expect(readCredential).not.toHaveBeenCalled();
      expect(openSocket).not.toHaveBeenCalled();
    },
  );

  it("authorizes only an exact, current, interactive single-Provider plan", () => {
    expect(authorizeAt(authorizedRequest())).toEqual(
      expect.objectContaining({
        authorized: true,
        provider: "qwen",
        target: qwenTarget,
      }),
    );
  });

  it.each([
    { live: false },
    { execute: false },
    { interactive: false },
    { provider: "all" as const },
    { provider: "doubao" as const },
    { ackPlanHash: "f".repeat(64) },
    { currentTarget: { ...qwenTarget, voiceProfileRevision: 6 } },
    { currentInputFixtureHash: "e".repeat(64) },
    {
      currentPricing: {
        ...pricingBinding,
        priceSnapshotHash: "8".repeat(64),
      },
    },
  ])(
    "does not read credentials or open a socket when rejected: %o",
    async (overrides) => {
      const readCredential = vi.fn(() => "test-credential");
      const openSocket = vi.fn(() => "connected");
      const consumeAuthorization = vi.fn(() => "consumed" as const);

      await expect(
        runWithTeachingSpikeLiveAuthorization(authorizedRequest(overrides), {
          clock: serverClockAt(authorizationNowMs),
          consumeAuthorization,
          readCredential,
          openSocket,
        }),
      ).rejects.toBeInstanceOf(TeachingSpikeLiveAuthorizationError);
      expect(consumeAuthorization).not.toHaveBeenCalled();
      expect(readCredential).not.toHaveBeenCalled();
      expect(openSocket).not.toHaveBeenCalled();
    },
  );

  it("calls credential and socket dependencies only after authorization", async () => {
    const consumeAuthorization = vi.fn(() => "consumed" as const);
    const readCredential = vi.fn(() => "test-credential");
    const openSocket = vi.fn(({ credential }) => `connected:${credential}`);

    await expect(
      runWithTeachingSpikeLiveAuthorization(authorizedRequest(), {
        clock: serverClockAt(authorizationNowMs),
        consumeAuthorization,
        readCredential,
        openSocket,
      }),
    ).resolves.toBe("connected:test-credential");
    expect(consumeAuthorization).toHaveBeenCalledTimes(1);
    expect(readCredential).toHaveBeenCalledTimes(1);
    expect(openSocket).toHaveBeenCalledTimes(1);
  });

  it("atomically rejects an authorization that expires before consumption", async () => {
    const request = authorizedRequest();
    let clockReads = 0;
    const readServerTimeMs = () => {
      clockReads += 1;
      return clockReads === 1
        ? authorizationNowMs
        : authorizationWindow.expiresAtMs;
    };
    const consumeAuthorization = createAtomicTestConsumptionStore(
      readServerTimeMs,
      consumptionClaimFor(request),
    );
    const readCredential = vi.fn(() => "test-credential");
    const openSocket = vi.fn(() => "connected");

    await expect(
      runWithTeachingSpikeLiveAuthorization(request, {
        clock: { readServerTimeMs },
        consumeAuthorization,
        readCredential,
        openSocket,
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_EXPIRED" });
    expect(consumeAuthorization).toHaveBeenCalledWith({
      runId: authorizationWindow.runId,
      planHash: request.plan.planHash,
      expiresAtMs: authorizationWindow.expiresAtMs,
    });
    expect(readCredential).not.toHaveBeenCalled();
    expect(openSocket).not.toHaveBeenCalled();
  });

  it("rechecks expiry after an asynchronous consumption delay", async () => {
    let nowMs = authorizationNowMs;
    const consumeAuthorization = vi.fn(async () => {
      nowMs = authorizationWindow.expiresAtMs;
      await Promise.resolve();
      return "consumed" as const;
    });
    const readCredential = vi.fn(() => "test-credential");
    const openSocket = vi.fn(() => "connected");

    await expect(
      runWithTeachingSpikeLiveAuthorization(authorizedRequest(), {
        clock: { readServerTimeMs: () => nowMs },
        consumeAuthorization,
        readCredential,
        openSocket,
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_EXPIRED" });
    expect(consumeAuthorization).toHaveBeenCalledTimes(1);
    expect(readCredential).not.toHaveBeenCalled();
    expect(openSocket).not.toHaveBeenCalled();
  });

  it("rechecks expiry after an asynchronous credential delay", async () => {
    let nowMs = authorizationNowMs;
    const consumeAuthorization = vi.fn(() => "consumed" as const);
    const readCredential = vi.fn(async () => {
      nowMs = authorizationWindow.expiresAtMs;
      await Promise.resolve();
      return "test-credential";
    });
    const openSocket = vi.fn(() => "connected");

    await expect(
      runWithTeachingSpikeLiveAuthorization(authorizedRequest(), {
        clock: { readServerTimeMs: () => nowMs },
        consumeAuthorization,
        readCredential,
        openSocket,
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_EXPIRED" });
    expect(consumeAuthorization).toHaveBeenCalledTimes(1);
    expect(readCredential).toHaveBeenCalledTimes(1);
    expect(openSocket).not.toHaveBeenCalled();
  });

  it("rejects a consumption claim that does not match the preregistered plan hash", async () => {
    const request = authorizedRequest();
    const consumeAuthorization = createAtomicTestConsumptionStore(
      () => authorizationNowMs,
      {
        ...consumptionClaimFor(request),
        planHash: "f".repeat(64),
      },
    );
    const readCredential = vi.fn(() => "test-credential");
    const openSocket = vi.fn(() => "connected");

    await expect(
      runWithTeachingSpikeLiveAuthorization(request, {
        clock: serverClockAt(authorizationNowMs),
        consumeAuthorization,
        readCredential,
        openSocket,
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_CLAIM_MISMATCH" });
    expect(readCredential).not.toHaveBeenCalled();
    expect(openSocket).not.toHaveBeenCalled();
  });

  it("allows only one concurrent execution to consume the same runId and planHash", async () => {
    const request = authorizedRequest();
    const readServerTimeMs = () => authorizationNowMs;
    const consumeAuthorization = createAtomicTestConsumptionStore(
      readServerTimeMs,
      consumptionClaimFor(request),
    );
    const readCredential = vi.fn(async () => {
      await Promise.resolve();
      return "test-credential";
    });
    const openSocket = vi.fn(() => "connected");
    const dependencies = {
      clock: { readServerTimeMs },
      consumeAuthorization,
      readCredential,
      openSocket,
    };

    const results = await Promise.allSettled([
      runWithTeachingSpikeLiveAuthorization(request, dependencies),
      runWithTeachingSpikeLiveAuthorization(request, dependencies),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "AUTHORIZATION_ALREADY_CONSUMED" },
    });
    expect(consumeAuthorization).toHaveBeenCalledTimes(2);
    expect(readCredential).toHaveBeenCalledTimes(1);
    expect(openSocket).toHaveBeenCalledTimes(1);
  });

  it("stops before credentials and sockets when the run was already consumed", async () => {
    const consumeAuthorization = vi.fn(() => "already_consumed" as const);
    const readCredential = vi.fn(() => "test-credential");
    const openSocket = vi.fn(() => "connected");

    await expect(
      runWithTeachingSpikeLiveAuthorization(authorizedRequest(), {
        clock: serverClockAt(authorizationNowMs),
        consumeAuthorization,
        readCredential,
        openSocket,
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_ALREADY_CONSUMED" });
    expect(consumeAuthorization).toHaveBeenCalledTimes(1);
    expect(readCredential).not.toHaveBeenCalled();
    expect(openSocket).not.toHaveBeenCalled();
  });

  it("has no database, environment, WebSocket, fetch, or CLI dependency", async () => {
    const source = await readFile(
      new URL(
        "../src/spikes/realtime-teaching/live-authorization.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).not.toMatch(/@meet\/database/u);
    expect(source).not.toMatch(/process\.env/u);
    expect(source).not.toMatch(/from\s+["']ws["']/u);
    expect(source).not.toMatch(/new\s+WebSocket\s*\(/u);
    expect(source).not.toMatch(/\bfetch\s*\(/u);
    expect(source).not.toMatch(/\/cli\//u);
  });
});
