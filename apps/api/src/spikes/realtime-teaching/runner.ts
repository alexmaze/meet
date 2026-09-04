import { createHash } from "node:crypto";

import {
  TEACHING_SPIKE_FIXTURES,
  TEACHING_SPIKE_FIXTURE_HASH,
  TEACHING_SPIKE_FIXTURE_REVISION,
  buildTeachingSpikeBudgetPressureBase,
  compileTeachingInstructions,
  hashTeachingSpikeFixtureCatalog,
} from "./fixtures.js";
import {
  buildDoubaoInstructionsUpdateEvent,
  buildQwenInstructionsPatchEvent,
} from "./provider-events.js";
import {
  TeachingDirectiveStateError,
  TeachingDirectiveStateMachine,
  type DirectiveStateSnapshot,
} from "./state-machine.js";

export const TEACHING_SPIKE_FIXTURE_CASE_IDS = [
  "M01",
  "M02",
  "M03",
  "M04",
  "M05",
  "M06",
  "M07",
] as const;

export const TEACHING_SPIKE_PROVIDER_CASE_IDS = [
  "D01",
  "D02",
  "D03",
  "D04",
  "D05",
  "D06",
  "D07",
  "D08",
  "D09",
  "D10",
  "D11",
  "D12",
  "D13",
  "D14",
  "D15",
  "D16",
  "D17Q",
  "D17D",
  "D18",
] as const;

export type TeachingSpikeFixtureCaseId =
  (typeof TEACHING_SPIKE_FIXTURE_CASE_IDS)[number];
export type TeachingSpikeProviderCaseId =
  (typeof TEACHING_SPIKE_PROVIDER_CASE_IDS)[number];
export type TeachingSpikeProvider = "qwen" | "doubao";
export type TeachingSpikeMode = "dry-run" | "mock";

export type TeachingSpikePlan = {
  schemaVersion: 1;
  mode: TeachingSpikeMode;
  provider: TeachingSpikeProvider;
  suite: "protocol-smoke";
  fixtureRevision: string;
  fixtureHash: string;
  modelId: string;
  voiceId: string;
  connectionRevision: string;
  fixtureCaseIds: TeachingSpikeFixtureCaseId[];
  providerCaseIds: TeachingSpikeProviderCaseId[];
  limits: {
    networkConnections: 0;
    databaseReads: 0;
    databaseWrites: 0;
    responseAttempts: 0;
    budgetCny: 0;
  };
  planHash: string;
};

export type TeachingSpikeTraceEvent = {
  sequence: number;
  fixtureCaseId: TeachingSpikeFixtureCaseId;
  eventType: "instructions_update.built" | "instructions_update.simulated_ack";
  connectionState: DirectiveStateSnapshot["connection"];
  turnState: DirectiveStateSnapshot["turn"];
  revision?: number;
  instructionHash?: string;
};

export type TeachingSpikeFixtureCaseResult = {
  id: TeachingSpikeFixtureCaseId;
  status: "mock_validated" | "failed" | "not_run";
  assertions: number;
  errorCode?: string;
};

export type TeachingSpikeProviderCaseResult = {
  id: TeachingSpikeProviderCaseId;
  status: "not_run";
  reason: "NO_PROVIDER_SESSION";
};

export type TeachingSpikeReport = {
  schemaVersion: 1;
  runId: string;
  mode: TeachingSpikeMode;
  provider: TeachingSpikeProvider;
  suite: "protocol-smoke";
  planHash: string;
  startedAt: string;
  finishedAt: string;
  syntheticFixturesOnly: true;
  providerEvidence: false;
  providerSessions: 0;
  networkConnections: 0;
  credentialReads: 0;
  databaseReads: 0;
  databaseWrites: 0;
  fixtureCases: TeachingSpikeFixtureCaseResult[];
  providerCases: TeachingSpikeProviderCaseResult[];
  trace: TeachingSpikeTraceEvent[];
  summary: {
    mockValidated: number;
    fixtureFailed: number;
    fixtureNotRun: number;
    providerNotRun: number;
  };
  capabilityDecision: {
    dynamicInstructionsNextSafeTurn: "not_evaluated";
    controlledResponseGate: "not_evaluated";
    reason: "DRY_RUN_ONLY" | "MOCK_ONLY_NOT_PROVIDER_EVIDENCE";
    requiresHumanReview: true;
  };
};

type Clock = () => Date;

export function buildTeachingSpikePlan(input: {
  provider: TeachingSpikeProvider;
  mode?: TeachingSpikeMode;
}): TeachingSpikePlan {
  const mode = input.mode ?? "dry-run";
  const providerMetadata =
    input.provider === "qwen"
      ? {
          modelId: "synthetic-qwen-realtime-model",
          voiceId: "synthetic-qwen-voice",
        }
      : {
          modelId: "synthetic-doubao-realtime-model",
          voiceId: "synthetic-doubao-voice",
        };
  const unsigned = {
    schemaVersion: 1 as const,
    mode,
    provider: input.provider,
    suite: "protocol-smoke" as const,
    fixtureRevision: TEACHING_SPIKE_FIXTURE_REVISION,
    fixtureHash: TEACHING_SPIKE_FIXTURE_HASH,
    ...providerMetadata,
    connectionRevision: "mock-fixture-r1",
    fixtureCaseIds: [...TEACHING_SPIKE_FIXTURE_CASE_IDS],
    providerCaseIds: [...TEACHING_SPIKE_PROVIDER_CASE_IDS],
    limits: {
      networkConnections: 0 as const,
      databaseReads: 0 as const,
      databaseWrites: 0 as const,
      responseAttempts: 0 as const,
      budgetCny: 0 as const,
    },
  };
  return {
    ...unsigned,
    planHash: hashPlan(unsigned),
  };
}

export function runTeachingSpike(
  plan: TeachingSpikePlan,
  options: { clock?: Clock } = {},
): TeachingSpikeReport {
  verifyPlan(plan);
  const clock = options.clock ?? (() => new Date());
  const startedAt = clock().toISOString();
  const trace: TeachingSpikeTraceEvent[] = [];
  const fixtureCases =
    plan.mode === "mock"
      ? runMockProtocolSuite(plan, trace)
      : plan.fixtureCaseIds.map<TeachingSpikeFixtureCaseResult>((id) => ({
          id,
          status: "not_run",
          assertions: 0,
          errorCode: "DRY_RUN_ONLY",
        }));
  const providerCases =
    plan.providerCaseIds.map<TeachingSpikeProviderCaseResult>((id) => ({
      id,
      status: "not_run",
      reason: "NO_PROVIDER_SESSION",
    }));
  const finishedAt = clock().toISOString();

  return {
    schemaVersion: 1,
    runId: buildRunId(plan, startedAt),
    mode: plan.mode,
    provider: plan.provider,
    suite: plan.suite,
    planHash: plan.planHash,
    startedAt,
    finishedAt,
    syntheticFixturesOnly: true,
    providerEvidence: false,
    providerSessions: 0,
    networkConnections: 0,
    credentialReads: 0,
    databaseReads: 0,
    databaseWrites: 0,
    fixtureCases,
    providerCases,
    trace,
    summary: {
      mockValidated: fixtureCases.filter(
        ({ status }) => status === "mock_validated",
      ).length,
      fixtureFailed: fixtureCases.filter(({ status }) => status === "failed")
        .length,
      fixtureNotRun: fixtureCases.filter(({ status }) => status === "not_run")
        .length,
      providerNotRun: providerCases.length,
    },
    capabilityDecision: {
      dynamicInstructionsNextSafeTurn: "not_evaluated",
      controlledResponseGate: "not_evaluated",
      reason:
        plan.mode === "mock"
          ? "MOCK_ONLY_NOT_PROVIDER_EVIDENCE"
          : "DRY_RUN_ONLY",
      requiresHumanReview: true,
    },
  };
}

export function teachingSpikeReportContainsForbiddenContent(
  report: TeachingSpikeReport,
): boolean {
  const serialized = JSON.stringify(report);
  return [
    TEACHING_SPIKE_FIXTURES.base.text,
    TEACHING_SPIKE_FIXTURES.safety.text,
    TEACHING_SPIKE_FIXTURES.directiveA.text,
    TEACHING_SPIKE_FIXTURES.directiveB.text,
    TEACHING_SPIKE_FIXTURES.userText.text,
    "audio",
    "pcm",
    "base64",
    "apiKey",
    "endpoint",
  ].some((forbidden) => serialized.includes(forbidden));
}

function runMockProtocolSuite(
  plan: TeachingSpikePlan,
  trace: TeachingSpikeTraceEvent[],
): TeachingSpikeFixtureCaseResult[] {
  const base = compileTeachingInstructions({
    base: TEACHING_SPIKE_FIXTURES.base.text,
    safety: TEACHING_SPIKE_FIXTURES.safety.text,
    maxCharacters: 12_000,
  });
  const directiveA = compileTeachingInstructions({
    base: TEACHING_SPIKE_FIXTURES.base.text,
    safety: TEACHING_SPIKE_FIXTURES.safety.text,
    directive: TEACHING_SPIKE_FIXTURES.directiveA.text,
    maxCharacters: 12_000,
  });
  const directiveB = compileTeachingInstructions({
    base: TEACHING_SPIKE_FIXTURES.base.text,
    safety: TEACHING_SPIKE_FIXTURES.safety.text,
    directive: TEACHING_SPIKE_FIXTURES.directiveB.text,
    maxCharacters: 12_000,
  });
  const cases = new Map<TeachingSpikeFixtureCaseId, () => number>([
    [
      "M01",
      () => {
        const machine = new TeachingDirectiveStateMachine();
        sendUpdate(plan, machine, "M01", 1, directiveA, "apply", trace);
        assert(!machine.canStartUserTurn(), "INPUT_NOT_GATED");
        acknowledge(machine, "M01", 1, directiveA.instructionHash, trace);
        assert(machine.snapshot().activeRevision === 1, "REVISION_NOT_ACTIVE");
        completeSyntheticTurn(machine);
        assert(machine.snapshot().turn === "idle", "TURN_NOT_IDLE");
        assert(
          machine.snapshot().connection === "restore_required",
          "ONE_SHOT_DIRECTIVE_NOT_AWAITING_RESTORE",
        );
        assert(!machine.canStartUserTurn(), "NEXT_TURN_NOT_GATED_FOR_RESTORE");
        return 6;
      },
    ],
    [
      "M02",
      () => {
        const machine = new TeachingDirectiveStateMachine();
        sendUpdate(plan, machine, "M02", 1, directiveA, "apply", trace);
        acknowledge(machine, "M02", 1, directiveA.instructionHash, trace);
        completeSyntheticTurn(machine);
        sendUpdate(plan, machine, "M02", 2, base, "restore", trace);
        acknowledge(machine, "M02", 2, base.instructionHash, trace);
        assert(machine.snapshot().activeRevision === null, "BASE_NOT_RESTORED");
        return 3;
      },
    ],
    [
      "M03",
      () => {
        const machine = new TeachingDirectiveStateMachine();
        sendUpdate(plan, machine, "M03", 1, directiveA, "apply", trace);
        acknowledge(machine, "M03", 1, directiveA.instructionHash, trace);
        sendUpdate(plan, machine, "M03", 2, directiveB, "apply", trace);
        acknowledge(machine, "M03", 2, directiveB.instructionHash, trace);
        assert(machine.snapshot().activeRevision === 2, "REVISION_ORDER_LOST");
        expectStateError(
          () =>
            machine.beginApply({
              revision: 2,
              instructionHash: directiveB.instructionHash,
            }),
          "STALE_REVISION",
        );
        return 2;
      },
    ],
    [
      "M04",
      () => {
        const machine = new TeachingDirectiveStateMachine();
        sendUpdate(plan, machine, "M04", 1, directiveA, "apply", trace);
        expectStateError(
          () => machine.markUserSpeechStarted(),
          "TURN_NOT_READY",
        );
        assert(!machine.canStartUserTurn(), "INPUT_NOT_GATED");
        acknowledge(machine, "M04", 1, directiveA.instructionHash, trace);
        assert(machine.canStartUserTurn(), "INPUT_NOT_RELEASED_AFTER_ACK");
        return 3;
      },
    ],
    [
      "M05",
      () => {
        const rejected = new TeachingDirectiveStateMachine();
        rejected.beginApply({
          revision: 1,
          instructionHash: directiveA.instructionHash,
        });
        rejected.failUpdate("known_not_applied");
        assert(
          rejected.snapshot().connection === "enhancement_disabled",
          "REJECTED_UPDATE_DID_NOT_DISABLE_ENHANCEMENT",
        );

        const restoreTimeout = new TeachingDirectiveStateMachine();
        restoreTimeout.beginApply({
          revision: 1,
          instructionHash: directiveA.instructionHash,
        });
        restoreTimeout.acknowledgeUpdate({
          revision: 1,
          instructionHash: directiveA.instructionHash,
        });
        restoreTimeout.beginRestore({
          revision: 2,
          instructionHash: base.instructionHash,
        });
        restoreTimeout.failUpdate("outcome_unknown");
        assert(
          restoreTimeout.snapshot().connection === "safety_reset",
          "RESTORE_TIMEOUT_DID_NOT_REQUIRE_SAFETY_RESET",
        );
        return 2;
      },
    ],
    [
      "M06",
      () => {
        const machine = new TeachingDirectiveStateMachine();
        machine.beginApply({
          revision: 1,
          instructionHash: directiveA.instructionHash,
        });
        machine.acknowledgeUpdate({
          revision: 1,
          instructionHash: directiveA.instructionHash,
        });
        machine.disconnect();
        assert(
          machine.snapshot().connection === "closed",
          "CONNECTION_NOT_CLOSED",
        );
        assert(
          machine.snapshot().expiredOnDisconnect,
          "DIRECTIVE_NOT_EXPIRED_ON_DISCONNECT",
        );
        assert(
          machine.snapshot().activeRevision === null,
          "REVISION_REPLAYABLE",
        );
        return 3;
      },
    ],
    [
      "M07",
      () => {
        const pressureBase = buildTeachingSpikeBudgetPressureBase();
        const required = compileTeachingInstructions({
          base: pressureBase,
          safety: TEACHING_SPIKE_FIXTURES.safety.text,
          maxCharacters: 12_000,
        });
        const constrained = compileTeachingInstructions({
          base: pressureBase,
          safety: TEACHING_SPIKE_FIXTURES.safety.text,
          directive: TEACHING_SPIKE_FIXTURES.directiveA.text,
          maxCharacters: 12_000,
        });
        assert(!constrained.includedDirective, "DIRECTIVE_NOT_DROPPED");
        assert(
          constrained.droppedReason === "instruction_budget",
          "DROP_REASON_MISSING",
        );
        assert(
          constrained.instructionHash === required.instructionHash,
          "REQUIRED_INSTRUCTIONS_CHANGED",
        );
        return 3;
      },
    ],
  ]);

  return plan.fixtureCaseIds.map((id) => executeCase(id, cases.get(id)));
}

function sendUpdate(
  plan: TeachingSpikePlan,
  machine: TeachingDirectiveStateMachine,
  fixtureCaseId: TeachingSpikeFixtureCaseId,
  revision: number,
  compiled: ReturnType<typeof compileTeachingInstructions>,
  kind: "apply" | "restore",
  trace: TeachingSpikeTraceEvent[],
): void {
  if (kind === "apply") {
    machine.beginApply({ revision, instructionHash: compiled.instructionHash });
  } else {
    machine.beginRestore({
      revision,
      instructionHash: compiled.instructionHash,
    });
  }
  const eventId = `event_spike_${fixtureCaseId.toLowerCase()}_${revision}`;
  const event =
    plan.provider === "qwen"
      ? buildQwenInstructionsPatchEvent({
          eventId,
          instructions: compiled.instructions,
        })
      : buildDoubaoInstructionsUpdateEvent({
          eventId,
          model: plan.modelId,
          voice: plan.voiceId,
          instructions: compiled.instructions,
        });
  assert(event.type === "session.update", "INVALID_PROVIDER_UPDATE");
  recordTrace(trace, fixtureCaseId, "instructions_update.built", machine, {
    revision,
    instructionHash: compiled.instructionHash,
  });
}

function acknowledge(
  machine: TeachingDirectiveStateMachine,
  fixtureCaseId: TeachingSpikeFixtureCaseId,
  revision: number,
  instructionHash: string,
  trace: TeachingSpikeTraceEvent[],
): void {
  machine.acknowledgeUpdate({ revision, instructionHash });
  recordTrace(
    trace,
    fixtureCaseId,
    "instructions_update.simulated_ack",
    machine,
    { revision },
  );
}

function completeSyntheticTurn(machine: TeachingDirectiveStateMachine): void {
  machine.markUserSpeechStarted();
  machine.markUserTurnCompleted();
  machine.markResponseStarted();
  machine.markResponseDone();
}

function recordTrace(
  trace: TeachingSpikeTraceEvent[],
  fixtureCaseId: TeachingSpikeFixtureCaseId,
  eventType: TeachingSpikeTraceEvent["eventType"],
  machine: TeachingDirectiveStateMachine,
  metadata: { revision?: number; instructionHash?: string } = {},
): void {
  const snapshot = machine.snapshot();
  trace.push({
    sequence: trace.length + 1,
    fixtureCaseId,
    eventType,
    connectionState: snapshot.connection,
    turnState: snapshot.turn,
    ...metadata,
  });
}

function executeCase(
  id: TeachingSpikeFixtureCaseId,
  run: (() => number) | undefined,
): TeachingSpikeFixtureCaseResult {
  if (!run) {
    return { id, status: "failed", assertions: 0, errorCode: "CASE_MISSING" };
  }
  try {
    return { id, status: "mock_validated", assertions: run() };
  } catch (error) {
    return {
      id,
      status: "failed",
      assertions: 0,
      errorCode: safeErrorCode(error),
    };
  }
}

function verifyPlan(plan: TeachingSpikePlan): void {
  const { planHash: _planHash, ...unsigned } = plan;
  if (hashPlan(unsigned) !== plan.planHash) {
    throw new TeachingSpikePlanError("PLAN_HASH_MISMATCH");
  }
  if (
    plan.fixtureRevision !== TEACHING_SPIKE_FIXTURE_REVISION ||
    plan.fixtureHash !== TEACHING_SPIKE_FIXTURE_HASH ||
    plan.fixtureHash !== hashTeachingSpikeFixtureCatalog() ||
    JSON.stringify(plan.fixtureCaseIds) !==
      JSON.stringify(TEACHING_SPIKE_FIXTURE_CASE_IDS) ||
    JSON.stringify(plan.providerCaseIds) !==
      JSON.stringify(TEACHING_SPIKE_PROVIDER_CASE_IDS)
  ) {
    throw new TeachingSpikePlanError("FIXTURE_CATALOG_MISMATCH");
  }
  if (
    plan.limits.networkConnections !== 0 ||
    plan.limits.databaseReads !== 0 ||
    plan.limits.databaseWrites !== 0 ||
    plan.limits.responseAttempts !== 0 ||
    plan.limits.budgetCny !== 0
  ) {
    throw new TeachingSpikePlanError("NONZERO_SIDE_EFFECT_LIMIT");
  }
}

function hashPlan(value: object): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function buildRunId(plan: TeachingSpikePlan, startedAt: string): string {
  return [
    "teaching-spike",
    plan.mode,
    plan.provider,
    plan.planHash.slice(0, 12),
    startedAt.replaceAll(/[^0-9]/gu, "").slice(0, 17),
  ].join("-");
}

function assert(condition: boolean, code: string): asserts condition {
  if (!condition) throw new TeachingSpikeAssertionError(code);
}

function expectStateError(
  action: () => void,
  expectedCode: TeachingDirectiveStateError["code"],
): void {
  try {
    action();
  } catch (error) {
    if (
      error instanceof TeachingDirectiveStateError &&
      error.code === expectedCode
    ) {
      return;
    }
    throw error;
  }
  throw new TeachingSpikeAssertionError(`EXPECTED_${expectedCode}`);
}

function safeErrorCode(error: unknown): string {
  if (
    error instanceof TeachingSpikeAssertionError ||
    error instanceof TeachingDirectiveStateError ||
    error instanceof TeachingSpikePlanError
  ) {
    return error.code;
  }
  return "UNEXPECTED_SPIKE_ERROR";
}

export class TeachingSpikePlanError extends Error {
  constructor(
    public readonly code:
      | "PLAN_HASH_MISMATCH"
      | "FIXTURE_CATALOG_MISMATCH"
      | "NONZERO_SIDE_EFFECT_LIMIT",
  ) {
    super(code);
    this.name = "TeachingSpikePlanError";
  }
}

class TeachingSpikeAssertionError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "TeachingSpikeAssertionError";
  }
}
