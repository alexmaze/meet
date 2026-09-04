import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseTeachingSpikeCliArguments,
  runTeachingSpikeCli,
} from "../src/cli/realtime-teaching-spike.js";
import type { TeachingSpikeCliError } from "../src/cli/realtime-teaching-spike.js";
import { buildDoubaoSessionConfig } from "../src/doubao-session.js";
import {
  TEACHING_SPIKE_FIXTURES,
  buildTeachingSpikeBudgetPressureBase,
  compileTeachingInstructions,
} from "../src/spikes/realtime-teaching/fixtures.js";
import {
  buildDoubaoInstructionsUpdateEvent,
  buildQwenInstructionsPatchEvent,
  doubaoInstructionsUpdatedAckSchema,
  qwenInstructionsUpdatedAckSchema,
} from "../src/spikes/realtime-teaching/provider-events.js";
import { serializeTeachingSpikeReport } from "../src/spikes/realtime-teaching/report.js";
import {
  buildTeachingSpikePlan,
  runTeachingSpike,
  teachingSpikeReportContainsForbiddenContent,
} from "../src/spikes/realtime-teaching/runner.js";
import type { TeachingSpikePlanError } from "../src/spikes/realtime-teaching/runner.js";
import { TeachingDirectiveStateMachine } from "../src/spikes/realtime-teaching/state-machine.js";
import type { TeachingDirectiveStateError } from "../src/spikes/realtime-teaching/state-machine.js";

describe("realtime teaching Spike fixture", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds Qwen patches and full Doubao updates without a browser command", () => {
    const qwen = buildQwenInstructionsPatchEvent({
      eventId: "event-qwen-1",
      instructions: "base plus directive",
    });
    expect(qwen).toEqual({
      event_id: "event-qwen-1",
      type: "session.update",
      session: { instructions: "base plus directive" },
    });

    const doubao = buildDoubaoInstructionsUpdateEvent({
      eventId: "event-doubao-1",
      model: "fixture-model",
      voice: "fixture-voice",
      instructions: "base plus directive",
    });
    expect(doubao).toEqual({
      event_id: "event-doubao-1",
      type: "session.update",
      session: buildDoubaoSessionConfig("fixture-model", {
        instructions: "base plus directive",
        voice: "fixture-voice",
      }),
    });
  });

  it("rejects Provider update instructions above the 12K Spike ceiling", () => {
    expect(() =>
      buildQwenInstructionsPatchEvent({
        eventId: "event-qwen-large",
        instructions: "x".repeat(12_001),
      }),
    ).toThrowError(expect.objectContaining({ code: "INSTRUCTIONS_TOO_LARGE" }));
    expect(() =>
      buildDoubaoInstructionsUpdateEvent({
        eventId: "event-doubao-large",
        model: "fixture-model",
        voice: "fixture-voice",
        instructions: "x".repeat(12_001),
      }),
    ).toThrowError(expect.objectContaining({ code: "INSTRUCTIONS_TOO_LARGE" }));
  });

  it("validates Provider ACK envelopes without requiring echoed request ids", () => {
    expect(
      qwenInstructionsUpdatedAckSchema.safeParse({
        type: "session.updated",
        session: { instructions: "possibly echoed" },
      }).success,
    ).toBe(true);
    expect(
      doubaoInstructionsUpdatedAckSchema.safeParse({
        event_id: "provider-generated-id",
        type: "session.updated",
      }).success,
    ).toBe(true);
    expect(
      doubaoInstructionsUpdatedAckSchema.safeParse({ type: "session.created" })
        .success,
    ).toBe(false);
  });

  it("preserves base and safety instructions when the directive exceeds budget", () => {
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

    expect(constrained).toMatchObject({
      includedDirective: false,
      droppedReason: "instruction_budget",
      instructionHash: required.instructionHash,
    });
    expect(constrained.instructions).toBe(required.instructions);
  });

  it("rejects a dynamic directive over the fixed 600-character limit", () => {
    expect(() =>
      compileTeachingInstructions({
        base: TEACHING_SPIKE_FIXTURES.base.text,
        safety: TEACHING_SPIKE_FIXTURES.safety.text,
        directive: "过长动态段".repeat(121),
        maxCharacters: 12_000,
      }),
    ).toThrowError(expect.objectContaining({ code: "DIRECTIVE_TOO_LARGE" }));
  });

  it("serializes updates, gates input until ACK, and requires reset after restore timeout", () => {
    const compiled = compileTeachingInstructions({
      base: TEACHING_SPIKE_FIXTURES.base.text,
      safety: TEACHING_SPIKE_FIXTURES.safety.text,
      directive: TEACHING_SPIKE_FIXTURES.directiveA.text,
      maxCharacters: 12_000,
    });
    const base = compileTeachingInstructions({
      base: TEACHING_SPIKE_FIXTURES.base.text,
      safety: TEACHING_SPIKE_FIXTURES.safety.text,
      maxCharacters: 12_000,
    });
    const machine = new TeachingDirectiveStateMachine();

    machine.beginApply({
      revision: 1,
      instructionHash: compiled.instructionHash,
    });
    expect(machine.canStartUserTurn()).toBe(false);
    expect(() => machine.markUserSpeechStarted()).toThrowError(
      expect.objectContaining<TeachingDirectiveStateError>({
        code: "TURN_NOT_READY",
      }),
    );
    expect(() =>
      machine.beginApply({
        revision: 2,
        instructionHash: compiled.instructionHash,
      }),
    ).toThrowError(
      expect.objectContaining<TeachingDirectiveStateError>({
        code: "UPDATE_IN_PROGRESS",
      }),
    );

    machine.acknowledgeUpdate({
      revision: 1,
      instructionHash: compiled.instructionHash,
    });
    expect(machine.snapshot().activeRevision).toBe(1);
    machine.beginRestore({
      revision: 2,
      instructionHash: base.instructionHash,
    });
    machine.failUpdate("outcome_unknown");
    expect(machine.snapshot().connection).toBe("safety_reset");
  });

  it("rejects a mismatched ACK and blocks the next turn until one-shot instructions restore", () => {
    const compiled = compileTeachingInstructions({
      base: TEACHING_SPIKE_FIXTURES.base.text,
      safety: TEACHING_SPIKE_FIXTURES.safety.text,
      directive: TEACHING_SPIKE_FIXTURES.directiveA.text,
      maxCharacters: 12_000,
    });
    const machine = new TeachingDirectiveStateMachine();
    machine.beginApply({
      revision: 1,
      instructionHash: compiled.instructionHash,
    });
    expect(() =>
      machine.acknowledgeUpdate({
        revision: 2,
        instructionHash: compiled.instructionHash,
      }),
    ).toThrowError(expect.objectContaining({ code: "ACK_MISMATCH" }));
    expect(machine.snapshot().connection).toBe("update_pending");

    machine.acknowledgeUpdate({
      revision: 1,
      instructionHash: compiled.instructionHash,
    });
    machine.markUserSpeechStarted();
    machine.markUserTurnCompleted();
    machine.markResponseStarted();
    machine.markResponseDone();
    expect(machine.snapshot().connection).toBe("restore_required");
    expect(machine.canStartUserTurn()).toBe(false);
    expect(machine.muteSession()).toBe("restore_required");
  });

  it("turns refusal during pending or active teaching into explicit safety actions", () => {
    const compiled = compileTeachingInstructions({
      base: TEACHING_SPIKE_FIXTURES.base.text,
      safety: TEACHING_SPIKE_FIXTURES.safety.text,
      directive: TEACHING_SPIKE_FIXTURES.directiveA.text,
      maxCharacters: 12_000,
    });

    const pending = new TeachingDirectiveStateMachine();
    pending.beginApply({
      revision: 1,
      instructionHash: compiled.instructionHash,
    });
    expect(pending.muteSession()).toBe("safety_reset");
    expect(pending.snapshot().connection).toBe("safety_reset");

    const responding = new TeachingDirectiveStateMachine();
    responding.beginApply({
      revision: 1,
      instructionHash: compiled.instructionHash,
    });
    responding.acknowledgeUpdate({
      revision: 1,
      instructionHash: compiled.instructionHash,
    });
    responding.markResponseStarted();
    expect(responding.muteSession()).toBe("cancel_response_then_restore");
    responding.markResponseDone();
    expect(responding.snapshot().connection).toBe("restore_required");

    const userSpeaking = new TeachingDirectiveStateMachine();
    userSpeaking.beginApply({
      revision: 1,
      instructionHash: compiled.instructionHash,
    });
    userSpeaking.acknowledgeUpdate({
      revision: 1,
      instructionHash: compiled.instructionHash,
    });
    userSpeaking.markUserSpeechStarted();
    expect(userSpeaking.muteSession()).toBe("safety_reset");
    expect(userSpeaking.snapshot().connection).toBe("safety_reset");

    const terminal = new TeachingDirectiveStateMachine();
    terminal.beginApply({
      revision: 1,
      instructionHash: compiled.instructionHash,
    });
    terminal.failUpdate("outcome_unknown");
    expect(terminal.muteSession()).toBe("safety_reset");
    expect(terminal.snapshot().connection).toBe("safety_reset");
  });

  it.each(["qwen", "doubao"] as const)(
    "runs the %s mock suite without network, credentials, database, or capability claims",
    (provider) => {
      const plan = buildTeachingSpikePlan({ provider, mode: "mock" });
      const times = [
        new Date("2026-08-14T01:00:00.000Z"),
        new Date("2026-08-14T01:00:00.010Z"),
      ];
      const report = runTeachingSpike(plan, {
        clock: () => times.shift() ?? new Date("2026-08-14T01:00:00.010Z"),
      });

      expect(report.summary).toEqual({
        mockValidated: 7,
        fixtureFailed: 0,
        fixtureNotRun: 0,
        providerNotRun: 19,
      });
      expect(report).toMatchObject({
        mode: "mock",
        syntheticFixturesOnly: true,
        providerEvidence: false,
        providerSessions: 0,
        networkConnections: 0,
        credentialReads: 0,
        databaseReads: 0,
        databaseWrites: 0,
        capabilityDecision: {
          dynamicInstructionsNextSafeTurn: "not_evaluated",
          controlledResponseGate: "not_evaluated",
          reason: "MOCK_ONLY_NOT_PROVIDER_EVIDENCE",
          requiresHumanReview: true,
        },
      });
      expect(report.fixtureCases).toHaveLength(7);
      expect(
        report.fixtureCases.every(({ status }) => status === "mock_validated"),
      ).toBe(true);
      expect(report.providerCases).toHaveLength(19);
      expect(
        report.providerCases.every(({ status }) => status === "not_run"),
      ).toBe(true);
      expect(report.trace.length).toBeGreaterThan(0);
      expect(teachingSpikeReportContainsForbiddenContent(report)).toBe(false);
    },
  );

  it("keeps dry-run side-effect free and marks every case as not run", () => {
    const report = runTeachingSpike(
      buildTeachingSpikePlan({ provider: "qwen" }),
      { clock: () => new Date("2026-08-14T02:00:00.000Z") },
    );

    expect(report.mode).toBe("dry-run");
    expect(report.summary).toEqual({
      mockValidated: 0,
      fixtureFailed: 0,
      fixtureNotRun: 7,
      providerNotRun: 19,
    });
    expect(report.trace).toEqual([]);
    expect(report.networkConnections).toBe(0);
  });

  it("rejects a modified plan before any fixture runs", () => {
    const plan = buildTeachingSpikePlan({ provider: "qwen", mode: "mock" });
    const tampered = {
      ...plan,
      connectionRevision: "unexpected-revision",
    };

    expect(() => runTeachingSpike(tampered)).toThrowError(
      expect.objectContaining<TeachingSpikePlanError>({
        code: "PLAN_HASH_MISMATCH",
      }),
    );
  });

  it("requires a Provider and rejects live or credential-bearing CLI arguments", () => {
    expect(() => parseTeachingSpikeCliArguments([])).toThrowError(
      expect.objectContaining<TeachingSpikeCliError>({
        code: "PROVIDER_REQUIRED",
      }),
    );
    expect(() =>
      parseTeachingSpikeCliArguments(["--provider", "qwen", "--live"]),
    ).toThrowError(
      expect.objectContaining<TeachingSpikeCliError>({
        code: "LIVE_MODE_NOT_IMPLEMENTED",
      }),
    );
    expect(() =>
      parseTeachingSpikeCliArguments([
        "--provider",
        "qwen",
        "--api-key",
        "secret",
      ]),
    ).toThrowError(
      expect.objectContaining<TeachingSpikeCliError>({
        code: "UNSAFE_ARGUMENT",
      }),
    );
  });

  it("accepts the standalone separator forwarded by the root pnpm script", () => {
    expect(
      parseTeachingSpikeCliArguments([
        "--",
        "--provider",
        "qwen",
        "--mode",
        "mock",
      ]),
    ).toEqual({ provider: "qwen", mode: "mock", pretty: false });
  });

  it("prints only a sanitized mock report", () => {
    let stdout = "";
    let stderr = "";
    const exitCode = runTeachingSpikeCli(
      ["--provider", "doubao", "--mode", "mock"],
      { write: (value) => ((stdout += String(value)), true) },
      { write: (value) => ((stderr += String(value)), true) },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("MOCK_ONLY_NOT_PROVIDER_EVIDENCE");
    expect(stdout).not.toContain(TEACHING_SPIKE_FIXTURES.base.text);
    expect(stdout).not.toContain(TEACHING_SPIKE_FIXTURES.directiveA.text);
  });

  it("rejects unknown report fields at the serialization boundary", () => {
    const report = runTeachingSpike(
      buildTeachingSpikePlan({ provider: "qwen", mode: "mock" }),
    );
    const unsafeReport = { ...report, providerPayload: "secret" };

    expect(() =>
      serializeTeachingSpikeReport(unsafeReport as typeof report),
    ).toThrow();
  });

  it("does not call global network primitives during dry-run or mock", () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network forbidden");
    });
    const webSocketSpy = vi.fn(() => {
      throw new Error("network forbidden");
    });
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("WebSocket", webSocketSpy);

    runTeachingSpike(buildTeachingSpikePlan({ provider: "qwen" }));
    runTeachingSpike(
      buildTeachingSpikePlan({ provider: "doubao", mode: "mock" }),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(webSocketSpy).not.toHaveBeenCalled();
  });

  it("keeps the preflight dependency graph free of network, database, config, and environment access", async () => {
    const files = [
      "../src/cli/realtime-teaching-spike.ts",
      "../src/doubao-session.ts",
      "../src/spikes/realtime-teaching/fixtures.ts",
      "../src/spikes/realtime-teaching/provider-events.ts",
      "../src/spikes/realtime-teaching/report.ts",
      "../src/spikes/realtime-teaching/runner.ts",
      "../src/spikes/realtime-teaching/state-machine.ts",
    ];
    const source = (
      await Promise.all(
        files.map((file) => readFile(new URL(file, import.meta.url), "utf8")),
      )
    ).join("\n");

    expect(source).not.toMatch(/from\s+["']ws["']/u);
    expect(source).not.toMatch(/@meet\/database/u);
    expect(source).not.toMatch(/(?:^|\/)config\.js["']/mu);
    expect(source).not.toMatch(/process\.env/u);
    expect(source).not.toMatch(/\bfetch\s*\(/u);
    expect(source).not.toMatch(/new\s+WebSocket\s*\(/u);
    expect(source).not.toMatch(/(?:qwen|doubao)-live-adapter/u);
    expect(source).not.toMatch(/live-authorization/u);
  });
});
