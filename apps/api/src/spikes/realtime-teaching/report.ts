import { z } from "zod";

import {
  TEACHING_SPIKE_FIXTURE_CASE_IDS,
  TEACHING_SPIKE_PROVIDER_CASE_IDS,
  type TeachingSpikeReport,
} from "./runner.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const errorCodeSchema = z.string().regex(/^[A-Z0-9_]{1,96}$/u);

export const teachingSpikeReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().regex(/^[a-z0-9-]{20,160}$/u),
    mode: z.enum(["dry-run", "mock"]),
    provider: z.enum(["qwen", "doubao"]),
    suite: z.literal("protocol-smoke"),
    planHash: hashSchema,
    startedAt: z.string().min(20).max(40),
    finishedAt: z.string().min(20).max(40),
    syntheticFixturesOnly: z.literal(true),
    providerEvidence: z.literal(false),
    providerSessions: z.literal(0),
    networkConnections: z.literal(0),
    credentialReads: z.literal(0),
    databaseReads: z.literal(0),
    databaseWrites: z.literal(0),
    fixtureCases: z.array(
      z
        .object({
          id: z.enum(TEACHING_SPIKE_FIXTURE_CASE_IDS),
          status: z.enum(["mock_validated", "failed", "not_run"]),
          assertions: z.number().int().nonnegative(),
          errorCode: errorCodeSchema.optional(),
        })
        .strict(),
    ),
    providerCases: z.array(
      z
        .object({
          id: z.enum(TEACHING_SPIKE_PROVIDER_CASE_IDS),
          status: z.literal("not_run"),
          reason: z.literal("NO_PROVIDER_SESSION"),
        })
        .strict(),
    ),
    trace: z.array(
      z
        .object({
          sequence: z.number().int().positive(),
          fixtureCaseId: z.enum(TEACHING_SPIKE_FIXTURE_CASE_IDS),
          eventType: z.enum([
            "instructions_update.built",
            "instructions_update.simulated_ack",
          ]),
          connectionState: z.enum([
            "active",
            "update_pending",
            "restore_required",
            "enhancement_disabled",
            "safety_reset",
            "closed",
          ]),
          turnState: z.enum([
            "idle",
            "user_active",
            "awaiting_response",
            "assistant_active",
          ]),
          revision: z.number().int().positive().optional(),
          instructionHash: hashSchema.optional(),
        })
        .strict(),
    ),
    summary: z
      .object({
        mockValidated: z.number().int().nonnegative(),
        fixtureFailed: z.number().int().nonnegative(),
        fixtureNotRun: z.number().int().nonnegative(),
        providerNotRun: z.number().int().nonnegative(),
      })
      .strict(),
    capabilityDecision: z
      .object({
        dynamicInstructionsNextSafeTurn: z.literal("not_evaluated"),
        controlledResponseGate: z.literal("not_evaluated"),
        reason: z.enum(["DRY_RUN_ONLY", "MOCK_ONLY_NOT_PROVIDER_EVIDENCE"]),
        requiresHumanReview: z.literal(true),
      })
      .strict(),
  })
  .strict();

export function serializeTeachingSpikeReport(
  report: TeachingSpikeReport,
  pretty = false,
): string {
  const safeReport = teachingSpikeReportSchema.parse(report);
  return JSON.stringify(safeReport, null, pretty ? 2 : 0);
}
