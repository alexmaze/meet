import { createHash } from "node:crypto";

import { z } from "zod";

import {
  QWEN_TEACHING_LIVE_ADAPTER_ERROR_CODES,
  QWEN_TEACHING_LIVE_CHECKPOINTS,
  QWEN_TEACHING_LIVE_INSTRUCTION_ACK_DISPOSITIONS,
  QWEN_TEACHING_LIVE_MARKER_MULTIPLICITIES,
  QWEN_TEACHING_LIVE_PROVIDER_ERROR_CODE_CATEGORIES,
  QWEN_TEACHING_LIVE_PROVIDER_ERROR_PARAM_CATEGORIES,
  QWEN_TEACHING_LIVE_PROVIDER_ERROR_TYPE_CATEGORIES,
  QwenTeachingLiveAdapterError,
  getQwenTeachingLiveMarkerFailureObservation,
  type QwenTeachingLiveMarkerFailureObservation,
  type QwenTeachingLiveSafeProviderError,
} from "./qwen-live-adapter.js";
import {
  QwenTeachingLiveCompositionError,
  runAuthorizedQwenTeachingLiveComposition,
  type QwenTeachingLiveCompositionDependencies,
  type QwenTeachingLiveCompositionResult,
} from "./qwen-live-composition.js";
import {
  TEACHING_SPIKE_LIVE_MAX_BUDGET_CNY,
  TEACHING_SPIKE_LIVE_MAX_INPUT_MS,
  TEACHING_SPIKE_LIVE_MAX_OUTPUT_MS,
  TEACHING_SPIKE_LIVE_MAX_RESPONSE_ATTEMPTS,
  TEACHING_SPIKE_LIVE_MAX_SESSIONS,
  TEACHING_SPIKE_LIVE_TIMEOUTS,
  TeachingSpikeLiveAuthorizationError,
  parseTeachingSpikeLiveAuthorizationPlan,
  teachingSpikeLiveTargetSchema,
  type TeachingSpikeLiveAuthorization,
  type TeachingSpikeLiveAuthorizationRequest,
} from "./live-authorization.js";
import {
  TEACHING_SPIKE_FIXTURE_HASH,
  TEACHING_SPIKE_FIXTURE_REVISION,
  TEACHING_SPIKE_USER_TEXT_HASH,
} from "./fixtures.js";
import {
  estimateQwenTeachingSpikeUsageCostCny,
  type TeachingSpikeUsage,
} from "./pricing.js";

export const REALTIME_TEACHING_LIVE_EVIDENCE_SCHEMA_VERSION = 5 as const;

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const providerSchema = z.enum(["qwen", "doubao"]);
const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const nonnegativeCostSchema = z
  .number()
  .finite()
  .nonnegative()
  .max(1_000_000)
  .refine((value) => Number.isSafeInteger(value * 1_000_000), {
    message: "成本最多保留六位小数。",
  });
const authorizedBudgetSchema = z
  .number()
  .finite()
  .positive()
  .max(TEACHING_SPIKE_LIVE_MAX_BUDGET_CNY)
  .refine((value) => Number.isSafeInteger(value * 100), {
    message: "授权预算最多保留两位小数。",
  });
const preflightEstimatedCostSchema = z
  .number()
  .finite()
  .positive()
  .max(TEACHING_SPIKE_LIVE_MAX_BUDGET_CNY)
  .refine((value) => Number.isSafeInteger(value * 1_000_000), {
    message: "预估最大成本最多保留六位小数。",
  });

const qwenProviderTokenUsageShape = {
  totalTokens: nonnegativeSafeIntegerSchema,
  inputTokens: nonnegativeSafeIntegerSchema,
  outputTokens: nonnegativeSafeIntegerSchema,
  inputTextTokens: nonnegativeSafeIntegerSchema,
  inputAudioTokens: nonnegativeSafeIntegerSchema,
  outputTextTokens: nonnegativeSafeIntegerSchema,
  outputAudioTokens: nonnegativeSafeIntegerSchema,
};

const qwenProviderTokenUsageSchema = z
  .object(qwenProviderTokenUsageShape)
  .strict()
  .superRefine(assertQwenTokenArithmetic);

const reportProviderTokenUsageSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false) }).strict(),
  z
    .object({
      available: z.literal(true),
      ...qwenProviderTokenUsageShape,
    })
    .strict()
    .superRefine(assertQwenTokenArithmetic),
]);

const observedUsageInputSchema = z
  .object({
    inputAudioMs: nonnegativeSafeIntegerSchema,
    outputAudioMs: nonnegativeSafeIntegerSchema,
    estimatedCostCny: nonnegativeCostSchema,
  })
  .strict();

export type RealtimeTeachingLiveObservedUsageInput = z.input<
  typeof observedUsageInputSchema
>;

const reportUsageSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false) }).strict(),
  z
    .object({
      available: z.literal(true),
      inputAudioMs: nonnegativeSafeIntegerSchema,
      outputAudioMs: nonnegativeSafeIntegerSchema,
      audioDurationBasis: z.enum([
        "not_applicable_text_only",
        "caller_observed_pcm_duration",
      ]),
      providerTokens: reportProviderTokenUsageSchema,
      estimatedCostCny: nonnegativeCostSchema,
    })
    .strict(),
]);

const budgetObservationSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false) }).strict(),
  z
    .object({
      available: z.literal(true),
      estimatedCostCny: nonnegativeCostSchema,
      status: z.enum(["within_authorized_limit", "authorized_limit_exceeded"]),
    })
    .strict(),
]);

const qwenInstructionAckCountsShape = {
  total: z.literal(5),
  echoedMatch: nonnegativeSafeIntegerSchema.max(5),
  omitted: nonnegativeSafeIntegerSchema.max(5),
};

const qwenInstructionAcksSchema = z
  .object(qwenInstructionAckCountsShape)
  .strict()
  .superRefine(assertQwenInstructionAckArithmetic);

const reportInstructionAcksSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false) }).strict(),
  z
    .object({
      available: z.literal(true),
      ...qwenInstructionAckCountsShape,
    })
    .strict()
    .superRefine(assertQwenInstructionAckArithmetic),
]);

const targetEvidenceSchema = z
  .object({
    fingerprint: hashSchema,
    databaseScope: z.enum(["isolated_spike", "application_database"]),
    modelProfileRevision: z.number().int().positive(),
    connectionRevision: z.number().int().positive(),
    voiceProfileRevision: z.number().int().positive(),
  })
  .strict();

const scopeSchema = z.discriminatedUnion("upstream", [
  z
    .object({
      transport: z.literal("isolated_provider_websocket"),
      upstream: z.literal("scripted_fake_upstream"),
      transportAttempted: z.literal(true),
      relayExercised: z.literal(false),
      browserExercised: z.literal(false),
    })
    .strict(),
  z
    .object({
      transport: z.literal("isolated_provider_websocket"),
      upstream: z.literal("unattested_or_not_observed"),
      transportAttempted: z.boolean(),
      relayExercised: z.literal(false),
      browserExercised: z.literal(false),
    })
    .strict(),
  z
    .object({
      transport: z.literal("isolated_provider_websocket"),
      upstream: z.literal("attested_real_provider"),
      transportAttempted: z.literal(true),
      relayExercised: z.literal(false),
      browserExercised: z.literal(false),
    })
    .strict(),
]);

export const REALTIME_TEACHING_LIVE_FAILURE_CODES = Object.freeze([
  "AUTHORIZATION_POST_CONSUMPTION_FAILED",
  "RUNTIME_RESOLUTION_FAILED",
  "TARGET_BINDING_FAILED",
  "TRANSPORT_FAILED",
  "PROTOCOL_SEQUENCE_FAILED",
  "RESOURCE_LIMIT_EXCEEDED",
  "RESOURCE_CLEANUP_FAILED",
  "EVIDENCE_VALIDATION_FAILED",
  "UNEXPECTED_SAFE_FAILURE",
] as const);

const failureCodeSchema = z.enum(REALTIME_TEACHING_LIVE_FAILURE_CODES);
export type RealtimeTeachingLiveFailureCode = z.infer<typeof failureCodeSchema>;

const outcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("protocol_sequence_completed") }).strict(),
  z
    .object({
      status: z.literal("failed"),
      errorCode: failureCodeSchema,
    })
    .strict(),
]);

const providerErrorDiagnosticSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false) }).strict(),
  z
    .object({
      available: z.literal(true),
      typeCategory: z.enum(QWEN_TEACHING_LIVE_PROVIDER_ERROR_TYPE_CATEGORIES),
      codeCategory: z.enum(QWEN_TEACHING_LIVE_PROVIDER_ERROR_CODE_CATEGORIES),
      paramCategory: z.enum(QWEN_TEACHING_LIVE_PROVIDER_ERROR_PARAM_CATEGORIES),
    })
    .strict(),
]);

const partialInstructionAckCountsSchema = z
  .object({
    total: nonnegativeSafeIntegerSchema.min(1).max(4),
    echoedMatch: nonnegativeSafeIntegerSchema.max(4),
    omitted: nonnegativeSafeIntegerSchema.max(4),
  })
  .strict()
  .superRefine(assertPartialInstructionAckArithmetic);

const markerMultiplicityShape = {
  a: z.enum(QWEN_TEACHING_LIVE_MARKER_MULTIPLICITIES),
  b: z.enum(QWEN_TEACHING_LIVE_MARKER_MULTIPLICITIES),
  c: z.enum(QWEN_TEACHING_LIVE_MARKER_MULTIPLICITIES),
};

const markerAssertionDiagnosticSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false) }).strict(),
  z
    .object({
      available: z.literal(true),
      caseId: z.enum(["D01T", "D02T", "D03T"]),
      expectedState: z.enum(["A", "B", "C"]),
      activeInstructionAck: z.enum(
        QWEN_TEACHING_LIVE_INSTRUCTION_ACK_DISPOSITIONS,
      ),
      observedInstructionAcks: partialInstructionAckCountsSchema,
      markerMultiplicity: z.object(markerMultiplicityShape).strict(),
      hasUnexpectedText: z.literal(true),
    })
    .strict(),
]);

const markerFailureObservationSchema = z
  .object({
    caseId: z.enum(["D01T", "D02T", "D03T"]),
    expectedState: z.enum(["A", "B", "C"]),
    activeInstructionAck: z.enum(
      QWEN_TEACHING_LIVE_INSTRUCTION_ACK_DISPOSITIONS,
    ),
    observedInstructionAcks: partialInstructionAckCountsSchema,
    markerMultiplicity: z.object(markerMultiplicityShape).strict(),
    hasUnexpectedText: z.literal(true),
    progress: z
      .object({
        session: z.union([z.literal(1), z.literal(2)]),
        attempt: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        completed: z.union([z.literal(0), z.literal(1), z.literal(2)]),
        failed: z.literal(1),
      })
      .strict(),
    usage: qwenProviderTokenUsageSchema,
  })
  .strict()
  .superRefine(assertMarkerFailureObservation);

const failureDiagnosticSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false) }).strict(),
  z
    .object({
      available: z.literal(true),
      source: z.literal("qwen_live_adapter"),
      checkpoint: z.enum(QWEN_TEACHING_LIVE_CHECKPOINTS),
      adapterErrorCode: z.enum(QWEN_TEACHING_LIVE_ADAPTER_ERROR_CODES),
      providerError: providerErrorDiagnosticSchema,
      markerAssertion: markerAssertionDiagnosticSchema,
    })
    .strict()
    .superRefine(assertMarkerDiagnosticConsistency),
]);

export type RealtimeTeachingLiveFailureDiagnostic = z.input<
  typeof failureDiagnosticSchema
>;

const reportFailureCaseCountsSchema = z
  .object({
    total: z.literal(3),
    protocolSequenceCompleted: nonnegativeSafeIntegerSchema.max(3),
    failed: nonnegativeSafeIntegerSchema.max(3),
    notRun: nonnegativeSafeIntegerSchema.max(3),
  })
  .strict();

const reportProgressSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false) }).strict(),
  z
    .object({
      available: z.literal(true),
      observedSessions: nonnegativeSafeIntegerSchema.max(
        TEACHING_SPIKE_LIVE_MAX_SESSIONS,
      ),
      attemptedResponses: nonnegativeSafeIntegerSchema.max(
        TEACHING_SPIKE_LIVE_MAX_RESPONSE_ATTEMPTS,
      ),
      caseCounts: reportFailureCaseCountsSchema,
    })
    .strict()
    .superRefine((progress, context) => {
      const countedCases =
        progress.caseCounts.protocolSequenceCompleted +
        progress.caseCounts.failed +
        progress.caseCounts.notRun;
      if (countedCases !== progress.caseCounts.total) {
        context.addIssue({
          code: "custom",
          path: ["caseCounts"],
          message: "caseCounts 总数不守恒。",
        });
      }
      if (
        progress.caseCounts.protocolSequenceCompleted +
          progress.caseCounts.failed >
        progress.attemptedResponses
      ) {
        context.addIssue({
          code: "custom",
          path: ["caseCounts"],
          message: "已完成或失败的 case 不能超过 response attempts。",
        });
      }
      if (progress.attemptedResponses > 0 && progress.observedSessions === 0) {
        context.addIssue({
          code: "custom",
          path: ["attemptedResponses"],
          message: "response attempt 必须绑定已观察会话。",
        });
      }
    }),
]);

const realtimeTeachingLiveEvidenceReportSchema = z
  .object({
    schemaVersion: z.literal(REALTIME_TEACHING_LIVE_EVIDENCE_SCHEMA_VERSION),
    runId: z.uuid(),
    planHash: hashSchema,
    provider: providerSchema,
    providerEvidence: z.boolean(),
    inputMode: z.enum(["text", "pcm16le"]),
    fixtureRevision: z.literal(TEACHING_SPIKE_FIXTURE_REVISION),
    fixtureHash: z.literal(TEACHING_SPIKE_FIXTURE_HASH),
    inputFixtureHash: hashSchema,
    priceSnapshotHash: hashSchema,
    target: targetEvidenceSchema,
    budget: z
      .object({
        authorizedCny: authorizedBudgetSchema,
        preflightEstimatedMaximumCny: preflightEstimatedCostSchema,
        observation: budgetObservationSchema,
      })
      .strict(),
    sessions: z
      .object({
        authorized: z.literal(TEACHING_SPIKE_LIVE_MAX_SESSIONS),
      })
      .strict(),
    responses: z
      .object({
        authorized: z.literal(TEACHING_SPIKE_LIVE_MAX_RESPONSE_ATTEMPTS),
      })
      .strict(),
    progress: reportProgressSchema,
    instructionAcks: reportInstructionAcksSchema,
    usage: reportUsageSchema,
    scope: scopeSchema,
    outcome: outcomeSchema,
    diagnostic: failureDiagnosticSchema,
    capabilityDecision: z
      .object({
        status: z.literal("not_evaluated"),
        reason: z.literal("insufficient_sample"),
        protocolSequenceCompletedIsCapabilityPassed: z.literal(false),
        requiresHumanReview: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .superRefine((report, context) => {
    const attested = report.scope.upstream === "attested_real_provider";
    if (report.providerEvidence !== attested) {
      addReportIssue(
        context,
        ["providerEvidence"],
        "providerEvidence 必须与私有 transport attestation 一致。",
      );
    }
    if (
      (report.provider === "qwen" && report.inputMode !== "text") ||
      (report.provider === "doubao" && report.inputMode !== "pcm16le")
    ) {
      addReportIssue(context, ["inputMode"], "inputMode 与 Provider 不匹配。");
    }
    if (
      report.budget.preflightEstimatedMaximumCny > report.budget.authorizedCny
    ) {
      addReportIssue(
        context,
        ["budget", "preflightEstimatedMaximumCny"],
        "预估最大成本不能超过授权预算。",
      );
    }
    if (report.usage.available !== report.budget.observation.available) {
      addReportIssue(context, ["usage"], "用量与成本可用性必须一致。");
    }
    if (report.usage.available && !report.progress.available) {
      addReportIssue(context, ["usage"], "已观察用量必须绑定已观察进度。");
    }
    if (report.usage.available && report.budget.observation.available) {
      const expectedBudgetStatus =
        report.usage.estimatedCostCny <= report.budget.authorizedCny
          ? "within_authorized_limit"
          : "authorized_limit_exceeded";
      if (
        report.budget.observation.estimatedCostCny !==
          report.usage.estimatedCostCny ||
        report.budget.observation.status !== expectedBudgetStatus
      ) {
        addReportIssue(
          context,
          ["budget", "observation"],
          "预算观察值必须与用量成本一致。",
        );
      }
      if (
        (report.provider === "qwen" &&
          !report.usage.providerTokens.available) ||
        (report.provider === "doubao" && report.usage.providerTokens.available)
      ) {
        addReportIssue(
          context,
          ["usage", "providerTokens"],
          "Provider Token 用量与 Provider 不匹配。",
        );
      }
      if (
        report.provider === "qwen" &&
        (report.usage.inputAudioMs !== 0 || report.usage.outputAudioMs !== 0)
      ) {
        addReportIssue(
          context,
          ["usage"],
          "Qwen 纯文本 smoke 不得记录输入或输出音频时长。",
        );
      }
      if (
        (report.provider === "qwen" &&
          report.usage.audioDurationBasis !== "not_applicable_text_only") ||
        (report.provider === "doubao" &&
          report.usage.audioDurationBasis !== "caller_observed_pcm_duration")
      ) {
        addReportIssue(
          context,
          ["usage", "audioDurationBasis"],
          "音频时长口径与 Provider 不匹配。",
        );
      }
    }
    if (
      report.progress.available &&
      report.progress.attemptedResponses > 0 &&
      !report.scope.transportAttempted
    ) {
      addReportIssue(
        context,
        ["progress", "attemptedResponses"],
        "response attempt 必须有 transport attempt。",
      );
    }
    if (
      report.instructionAcks.available !==
      (report.provider === "qwen" &&
        report.outcome.status === "protocol_sequence_completed")
    ) {
      addReportIssue(
        context,
        ["instructionAcks"],
        "Instruction ACK 证据必须且只能来自完成的 Qwen 协议结果。",
      );
    }

    if (report.outcome.status === "protocol_sequence_completed") {
      if (
        report.diagnostic.available ||
        !report.progress.available ||
        report.progress.observedSessions !== TEACHING_SPIKE_LIVE_MAX_SESSIONS ||
        report.progress.attemptedResponses !==
          TEACHING_SPIKE_LIVE_MAX_RESPONSE_ATTEMPTS ||
        report.progress.caseCounts.protocolSequenceCompleted !== 3 ||
        report.progress.caseCounts.failed !== 0 ||
        report.progress.caseCounts.notRun !== 0 ||
        !report.usage.available ||
        !report.budget.observation.available ||
        report.budget.observation.status !== "within_authorized_limit" ||
        report.scope.upstream === "unattested_or_not_observed"
      ) {
        addReportIssue(
          context,
          ["outcome"],
          "成功 outcome 必须绑定完整且预算内的 2-session/3-response 结果。",
        );
      }
    } else {
      if (
        report.providerEvidence ||
        report.scope.upstream !== "unattested_or_not_observed"
      ) {
        addReportIssue(
          context,
          ["outcome"],
          "失败报告不得升级为 Provider evidence。",
        );
      }
      if (
        report.diagnostic.available &&
        (report.provider !== "qwen" ||
          classifyQwenAdapterErrorCode(report.diagnostic.adapterErrorCode) !==
            report.outcome.errorCode)
      ) {
        addReportIssue(
          context,
          ["diagnostic"],
          "诊断字段必须与 Qwen Adapter 的固定错误分类一致。",
        );
      }
      if (
        report.diagnostic.available &&
        report.diagnostic.providerError.available !==
          (report.diagnostic.adapterErrorCode === "PROVIDER_ERROR")
      ) {
        addReportIssue(
          context,
          ["diagnostic", "providerError"],
          "Provider error 诊断必须且只能绑定 PROVIDER_ERROR。",
        );
      }
      if (
        report.diagnostic.available &&
        report.diagnostic.providerError.available &&
        !report.scope.transportAttempted
      ) {
        addReportIssue(
          context,
          ["diagnostic", "providerError"],
          "Provider error 诊断必须绑定 transport attempt。",
        );
      }
      if (
        report.diagnostic.available &&
        report.diagnostic.markerAssertion.available
      ) {
        const markerAssertion = report.diagnostic.markerAssertion;
        const expected = markerFailureExpectation(markerAssertion.caseId);
        if (
          report.provider !== "qwen" ||
          report.outcome.errorCode !== "PROTOCOL_SEQUENCE_FAILED" ||
          !report.scope.transportAttempted ||
          !report.progress.available ||
          report.progress.observedSessions !== expected.progress.session ||
          report.progress.attemptedResponses !== expected.progress.attempt ||
          report.progress.caseCounts.protocolSequenceCompleted !==
            expected.progress.completed ||
          report.progress.caseCounts.failed !== 1 ||
          report.progress.caseCounts.notRun !==
            2 - expected.progress.completed ||
          !report.usage.available ||
          !report.usage.providerTokens.available ||
          !report.budget.observation.available
        ) {
          addReportIssue(
            context,
            ["diagnostic", "markerAssertion"],
            "Marker 失败诊断必须绑定同一已完成响应的 Qwen 进度、Token 用量与成本观察。",
          );
        }
      }
    }
  });

type RealtimeTeachingLiveEvidenceReportPayload = z.infer<
  typeof realtimeTeachingLiveEvidenceReportSchema
>;

const liveEvidenceReportBrand: unique symbol = Symbol(
  "RealtimeTeachingLiveEvidenceReport",
);

export type RealtimeTeachingLiveEvidenceReport =
  RealtimeTeachingLiveEvidenceReportPayload &
    Readonly<{ [liveEvidenceReportBrand]: true }>;

const issuedLiveEvidenceReports = new WeakSet<object>();

type ProtocolCaseId = "D01T" | "D02T" | "D03T" | "D01" | "D02" | "D03";

function completedCaseSchema(id: ProtocolCaseId, expectedMarkerCount: 0 | 1) {
  return z
    .object({
      id: z.literal(id),
      status: z.literal("protocol_sequence_completed"),
      expectedMarkerCount: z.literal(expectedMarkerCount),
      forbiddenMarkerCount: z.literal(0),
    })
    .strict();
}

const coreScopeSchema = z
  .object({
    transport: z.literal("isolated_provider_websocket"),
    relayExercised: z.literal(false),
    browserExercised: z.literal(false),
  })
  .strict();

const coreProtocolResultCommon = {
  providerEvidence: z.literal(false),
  fixtureRevision: z.literal(TEACHING_SPIKE_FIXTURE_REVISION),
  fixtureHash: z.literal(TEACHING_SPIKE_FIXTURE_HASH),
  scope: coreScopeSchema,
  upstreamSessions: z.literal(TEACHING_SPIKE_LIVE_MAX_SESSIONS),
  responseAttempts: z.literal(TEACHING_SPIKE_LIVE_MAX_RESPONSE_ATTEMPTS),
};

const coreProtocolResultSchema = z.discriminatedUnion("provider", [
  z
    .object({
      ...coreProtocolResultCommon,
      schemaVersion: z.literal(3),
      provider: z.literal("qwen"),
      inputMode: z.literal("text"),
      inputFixtureHash: z.literal(TEACHING_SPIKE_USER_TEXT_HASH),
      instructionAcks: qwenInstructionAcksSchema,
      usage: qwenProviderTokenUsageSchema,
      cases: z.tuple([
        completedCaseSchema("D01T", 1),
        completedCaseSchema("D02T", 1),
        completedCaseSchema("D03T", 1),
      ]),
    })
    .strict(),
  z
    .object({
      ...coreProtocolResultCommon,
      schemaVersion: z.literal(1),
      provider: z.literal("doubao"),
      inputMode: z.literal("pcm16le"),
      inputFixtureHash: hashSchema,
      cases: z.tuple([
        completedCaseSchema("D01", 1),
        completedCaseSchema("D02", 0),
        completedCaseSchema("D03", 1),
      ]),
    })
    .strict(),
]);

export type RealtimeTeachingCoreProtocolResult = z.input<
  typeof coreProtocolResultSchema
>;

const authorizationSchema = z
  .object({
    authorized: z.literal(true),
    runId: z.uuid(),
    provider: providerSchema,
    planHash: hashSchema,
    inputMode: z.enum(["text", "pcm16le"]),
    inputFixtureHash: hashSchema,
    expiresAtMs: z.number().int().nonnegative().safe(),
    caseIds: z.union([
      z.tuple([z.literal("D01T"), z.literal("D02T"), z.literal("D03T")]),
      z.tuple([z.literal("D01"), z.literal("D02"), z.literal("D03")]),
    ]),
    target: teachingSpikeLiveTargetSchema,
    pricing: z
      .object({
        priceSnapshotHash: hashSchema,
        estimatedMaxCostCny: preflightEstimatedCostSchema,
      })
      .strict(),
    limits: z
      .object({
        maxSessions: z.literal(TEACHING_SPIKE_LIVE_MAX_SESSIONS),
        maxResponseAttempts: z.literal(
          TEACHING_SPIKE_LIVE_MAX_RESPONSE_ATTEMPTS,
        ),
        maxInputMs: z.literal(TEACHING_SPIKE_LIVE_MAX_INPUT_MS),
        maxOutputMs: z.literal(TEACHING_SPIKE_LIVE_MAX_OUTPUT_MS),
        budgetCny: authorizedBudgetSchema,
        timeouts: z
          .object({
            connectMs: z.literal(TEACHING_SPIKE_LIVE_TIMEOUTS.connectMs),
            updateAckMs: z.literal(TEACHING_SPIKE_LIVE_TIMEOUTS.updateAckMs),
            responseMs: z.literal(TEACHING_SPIKE_LIVE_TIMEOUTS.responseMs),
            totalRunMs: z.literal(TEACHING_SPIKE_LIVE_TIMEOUTS.totalRunMs),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const failureProgressSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false) }).strict(),
  z
    .object({
      available: z.literal(true),
      observedSessions: nonnegativeSafeIntegerSchema.max(
        TEACHING_SPIKE_LIVE_MAX_SESSIONS,
      ),
      attemptedResponses: nonnegativeSafeIntegerSchema.max(
        TEACHING_SPIKE_LIVE_MAX_RESPONSE_ATTEMPTS,
      ),
      protocolSequenceCompleted: nonnegativeSafeIntegerSchema.max(3),
      failed: nonnegativeSafeIntegerSchema.max(3),
    })
    .strict()
    .superRefine((progress, context) => {
      if (
        progress.protocolSequenceCompleted + progress.failed >
        progress.attemptedResponses
      ) {
        context.addIssue({
          code: "custom",
          message: "已完成或失败的 case 不能超过 response attempts。",
        });
      }
      if (progress.attemptedResponses > 0 && progress.observedSessions === 0) {
        context.addIssue({
          code: "custom",
          message: "response attempt 必须绑定已观察会话。",
        });
      }
    }),
]);

export type RealtimeTeachingLiveFailureProgress = z.input<
  typeof failureProgressSchema
>;

// This symbol is deliberately module-private. The only call site that can
// possess it invokes the non-injectable production composition directly.
const productionTransportAttestation = Symbol(
  "RealtimeTeachingProductionTransportAttestation",
);
type ProductionTransportAttestation = typeof productionTransportAttestation;

export function buildRealtimeTeachingLiveEvidenceReport(input: {
  authorization: TeachingSpikeLiveAuthorization;
  protocolResult: RealtimeTeachingCoreProtocolResult;
  priceSnapshotHash: string;
  usage: RealtimeTeachingLiveObservedUsageInput;
}): RealtimeTeachingLiveEvidenceReport {
  return buildCompletedEvidenceReport(input);
}

export function buildRealtimeTeachingLiveFailureEvidenceReport(input: {
  authorization: TeachingSpikeLiveAuthorization;
  priceSnapshotHash: string;
  errorCode: RealtimeTeachingLiveFailureCode;
  transportAttempted: boolean;
  progress: RealtimeTeachingLiveFailureProgress;
  diagnostic?: RealtimeTeachingLiveFailureDiagnostic;
}): RealtimeTeachingLiveEvidenceReport {
  return buildFailureEvidenceReport(input);
}

/**
 * The only public promotion path for Qwen Provider evidence. It calls the
 * production composition whose WebSocket factory is fixed internally; no
 * fake transport or attestation mint is accepted as input. A failure after
 * one-time authorization consumption returns a redacted, non-evidence report.
 */
export async function runAuthorizedQwenTeachingLiveCompositionAndBuildEvidence(input: {
  request: TeachingSpikeLiveAuthorizationRequest;
  dependencies: QwenTeachingLiveCompositionDependencies;
}): Promise<RealtimeTeachingLiveEvidenceReport> {
  // Capture every caller-controlled field before the first asynchronous
  // boundary. TTY callbacks, credential resolvers, and Provider transports may
  // retain and mutate their original objects; those mutations must never alter
  // the authorization or evidence for this run.
  const request = snapshotAuthorizationRequest(input.request);
  let authorizationConsumed = false;
  let consumedAuthorization: TeachingSpikeLiveAuthorization | undefined;
  let completedComposition: QwenTeachingLiveCompositionResult | undefined;
  const dependencies = input.dependencies;

  try {
    completedComposition = await runAuthorizedQwenTeachingLiveComposition(
      request,
      {
        ...dependencies,
        consumeAuthorization: async (claim) => {
          const result = await dependencies.consumeAuthorization(claim);
          if (result === "consumed") authorizationConsumed = true;
          return result;
        },
        resolveRuntime: async (authorization) => {
          consumedAuthorization = authorization;
          try {
            return await dependencies.resolveRuntime(authorization);
          } catch {
            throw new RuntimeResolutionFailure();
          }
        },
      },
    );
    const authorization = authorizationFromComposition(completedComposition);
    return buildCompletedEvidenceReport(
      {
        authorization,
        protocolResult:
          completedComposition.protocol as unknown as RealtimeTeachingCoreProtocolResult,
        priceSnapshotHash: authorization.pricing.priceSnapshotHash,
        usage: deriveQwenObservedUsage(completedComposition.protocol.usage),
      },
      productionTransportAttestation,
    );
  } catch (error) {
    if (!authorizationConsumed) {
      throw evidenceError("LIVE_RUN_FAILED_BEFORE_AUTHORIZATION_CONSUMED");
    }
    const authorization =
      completedComposition?.authorization ??
      consumedAuthorization ??
      authorizationFromPlanSnapshot(request.plan);
    const completedProtocol = completedComposition?.protocol;
    const markerFailureObservation =
      getQwenTeachingLiveMarkerFailureObservation(error);
    return buildFailureEvidenceReport({
      authorization,
      priceSnapshotHash: authorization.pricing.priceSnapshotHash,
      errorCode: classifySafeFailure(error),
      transportAttempted:
        completedComposition !== undefined ||
        error instanceof QwenTeachingLiveAdapterError,
      progress:
        markerFailureObservation !== undefined
          ? markerFailureProgress(markerFailureObservation)
          : completedProtocol === undefined
            ? { available: false }
            : {
                available: true,
                observedSessions: completedProtocol.upstreamSessions,
                attemptedResponses: completedProtocol.responseAttempts,
                protocolSequenceCompleted: completedProtocol.cases.length,
                failed: 0,
              },
      diagnostic: safeFailureDiagnostic(error, markerFailureObservation),
      ...(markerFailureObservation === undefined
        ? {}
        : { markerFailureObservation }),
      ...(completedProtocol === undefined
        ? {}
        : {
            completedProtocolResult:
              completedProtocol as unknown as RealtimeTeachingCoreProtocolResult,
          }),
    });
  }
}

export function serializeRealtimeTeachingLiveEvidenceReport(
  report: unknown,
  pretty = false,
): string {
  const parsed = realtimeTeachingLiveEvidenceReportSchema.safeParse(report);
  if (!parsed.success) throw evidenceError("INVALID_REPORT");
  if (
    typeof report !== "object" ||
    report === null ||
    !issuedLiveEvidenceReports.has(report)
  ) {
    throw evidenceError("INVALID_REPORT");
  }
  return JSON.stringify(parsed.data, null, pretty ? 2 : 0);
}

function buildCompletedEvidenceReport(
  input: {
    authorization: TeachingSpikeLiveAuthorization;
    protocolResult: RealtimeTeachingCoreProtocolResult;
    priceSnapshotHash: string;
    usage: RealtimeTeachingLiveObservedUsageInput;
  },
  attestation?: ProductionTransportAttestation,
): RealtimeTeachingLiveEvidenceReport {
  const authorization = parseAuthorization(input.authorization);
  const protocolResult = parseProtocolResult(input.protocolResult);
  const priceSnapshotHash = parseHash(
    input.priceSnapshotHash,
    "INVALID_PRICE_SNAPSHOT_HASH",
  );
  const observedUsage = parseObservedUsage(input.usage);
  assertPriceSnapshotMatchesAuthorization(authorization, priceSnapshotHash);
  assertProtocolMatchesAuthorization(authorization, protocolResult);
  assertObservedUsageMatchesProtocol(protocolResult, observedUsage);
  assertUsageWithinProtocolLimits(authorization, observedUsage);

  const providerEvidence = attestation === productionTransportAttestation;
  const usage = {
    available: true as const,
    ...observedUsage,
    audioDurationBasis:
      protocolResult.provider === "qwen"
        ? ("not_applicable_text_only" as const)
        : ("caller_observed_pcm_duration" as const),
    providerTokens:
      protocolResult.provider === "qwen"
        ? ({ available: true as const, ...protocolResult.usage } as const)
        : ({ available: false as const } as const),
  };

  return issueReport({
    ...commonReportFields(authorization, priceSnapshotHash),
    providerEvidence,
    budget: {
      authorizedCny: authorization.limits.budgetCny,
      preflightEstimatedMaximumCny: authorization.pricing.estimatedMaxCostCny,
      observation: {
        available: true as const,
        estimatedCostCny: observedUsage.estimatedCostCny,
        status:
          observedUsage.estimatedCostCny <= authorization.limits.budgetCny
            ? ("within_authorized_limit" as const)
            : ("authorized_limit_exceeded" as const),
      },
    },
    sessions: {
      authorized: TEACHING_SPIKE_LIVE_MAX_SESSIONS,
    },
    responses: {
      authorized: TEACHING_SPIKE_LIVE_MAX_RESPONSE_ATTEMPTS,
    },
    progress: {
      available: true as const,
      observedSessions: protocolResult.upstreamSessions,
      attemptedResponses: protocolResult.responseAttempts,
      caseCounts: {
        total: 3 as const,
        protocolSequenceCompleted: 3,
        failed: 0,
        notRun: 0,
      },
    },
    instructionAcks:
      protocolResult.provider === "qwen"
        ? {
            available: true as const,
            total: 5 as const,
            echoedMatch: protocolResult.instructionAcks.echoedMatch,
            omitted: protocolResult.instructionAcks.omitted,
          }
        : ({ available: false as const } as const),
    usage,
    scope: {
      transport: "isolated_provider_websocket" as const,
      upstream: providerEvidence
        ? ("attested_real_provider" as const)
        : ("scripted_fake_upstream" as const),
      transportAttempted: true as const,
      relayExercised: false as const,
      browserExercised: false as const,
    },
    outcome: { status: "protocol_sequence_completed" as const },
    diagnostic: { available: false as const },
    capabilityDecision: capabilityDecision(),
  });
}

function buildFailureEvidenceReport(input: {
  authorization: TeachingSpikeLiveAuthorization;
  priceSnapshotHash: string;
  errorCode: RealtimeTeachingLiveFailureCode;
  transportAttempted: boolean;
  progress: RealtimeTeachingLiveFailureProgress;
  diagnostic?: RealtimeTeachingLiveFailureDiagnostic;
  completedProtocolResult?: RealtimeTeachingCoreProtocolResult;
  markerFailureObservation?: QwenTeachingLiveMarkerFailureObservation;
}): RealtimeTeachingLiveEvidenceReport {
  const authorization = parseAuthorization(input.authorization);
  const priceSnapshotHash = parseHash(
    input.priceSnapshotHash,
    "INVALID_PRICE_SNAPSHOT_HASH",
  );
  assertPriceSnapshotMatchesAuthorization(authorization, priceSnapshotHash);
  const errorCode = failureCodeSchema.safeParse(input.errorCode);
  if (!errorCode.success) throw evidenceError("INVALID_FAILURE_CODE");
  const progress = failureProgressSchema.safeParse(input.progress);
  if (!progress.success) throw evidenceError("INVALID_FAILURE_PROGRESS");
  const diagnostic = failureDiagnosticSchema.safeParse(
    input.diagnostic ?? { available: false },
  );
  if (!diagnostic.success) throw evidenceError("INVALID_FAILURE_DIAGNOSTIC");
  const markerFailureObservation =
    input.markerFailureObservation === undefined
      ? undefined
      : markerFailureObservationSchema.safeParse(
          input.markerFailureObservation,
        );
  if (markerFailureObservation?.success === false) {
    throw evidenceError("INVALID_FAILURE_DIAGNOSTIC");
  }
  const markerObservation = markerFailureObservation?.data;
  const diagnosticMarkerAvailable =
    diagnostic.data.available && diagnostic.data.markerAssertion.available;
  if (diagnosticMarkerAvailable !== (markerObservation !== undefined)) {
    throw evidenceError("INVALID_FAILURE_DIAGNOSTIC");
  }
  if (
    markerObservation !== undefined &&
    (!diagnostic.data.available ||
      !diagnostic.data.markerAssertion.available ||
      canonicalJson(diagnostic.data.markerAssertion) !==
        canonicalJson(markerAssertionDiagnostic(markerObservation)))
  ) {
    throw evidenceError("INVALID_FAILURE_DIAGNOSTIC");
  }
  if (typeof input.transportAttempted !== "boolean") {
    throw evidenceError("INVALID_FAILURE_PROGRESS");
  }
  if (
    progress.data.available &&
    progress.data.attemptedResponses > 0 &&
    !input.transportAttempted
  ) {
    throw evidenceError("INVALID_FAILURE_PROGRESS");
  }

  const completedProtocol =
    input.completedProtocolResult === undefined
      ? undefined
      : parseProtocolResult(input.completedProtocolResult);
  if (completedProtocol !== undefined && markerObservation !== undefined) {
    throw evidenceError("INVALID_FAILURE_PROGRESS");
  }
  let observedUsage: z.infer<typeof observedUsageInputSchema> | undefined;
  let qwenProviderUsage:
    z.infer<typeof qwenProviderTokenUsageSchema> | undefined;
  if (completedProtocol !== undefined) {
    assertProtocolMatchesAuthorization(authorization, completedProtocol);
    if (
      !progress.data.available ||
      progress.data.observedSessions !== completedProtocol.upstreamSessions ||
      progress.data.attemptedResponses !== completedProtocol.responseAttempts ||
      progress.data.protocolSequenceCompleted !==
        completedProtocol.cases.length ||
      progress.data.failed !== 0
    ) {
      throw evidenceError("INVALID_FAILURE_PROGRESS");
    }
    if (completedProtocol.provider === "qwen") {
      qwenProviderUsage = completedProtocol.usage;
      observedUsage = parseObservedUsage(
        deriveQwenObservedUsage(completedProtocol.usage),
      );
    }
  }
  if (markerObservation !== undefined) {
    if (
      authorization.provider !== "qwen" ||
      errorCode.data !== "PROTOCOL_SEQUENCE_FAILED" ||
      !input.transportAttempted ||
      !progress.data.available ||
      progress.data.observedSessions !== markerObservation.progress.session ||
      progress.data.attemptedResponses !== markerObservation.progress.attempt ||
      progress.data.protocolSequenceCompleted !==
        markerObservation.progress.completed ||
      progress.data.failed !== markerObservation.progress.failed
    ) {
      throw evidenceError("INVALID_FAILURE_PROGRESS");
    }
    qwenProviderUsage = markerObservation.usage;
    observedUsage = parseObservedUsage(
      deriveQwenObservedUsage(markerObservation.usage),
    );
    assertUsageWithinProtocolLimits(authorization, observedUsage);
  }

  const budgetObservation =
    observedUsage === undefined
      ? ({ available: false as const } as const)
      : ({
          available: true as const,
          estimatedCostCny: observedUsage.estimatedCostCny,
          status:
            observedUsage.estimatedCostCny <= authorization.limits.budgetCny
              ? ("within_authorized_limit" as const)
              : ("authorized_limit_exceeded" as const),
        } as const);
  const usage =
    observedUsage === undefined || qwenProviderUsage === undefined
      ? ({ available: false as const } as const)
      : ({
          available: true as const,
          ...observedUsage,
          audioDurationBasis: "not_applicable_text_only" as const,
          providerTokens: {
            available: true as const,
            ...qwenProviderUsage,
          },
        } as const);

  const reportProgress = !progress.data.available
    ? ({ available: false as const } as const)
    : ({
        available: true as const,
        observedSessions: progress.data.observedSessions,
        attemptedResponses: progress.data.attemptedResponses,
        caseCounts: {
          total: 3 as const,
          protocolSequenceCompleted: progress.data.protocolSequenceCompleted,
          failed: progress.data.failed,
          notRun:
            3 -
            (progress.data.protocolSequenceCompleted + progress.data.failed),
        },
      } as const);

  return issueReport({
    ...commonReportFields(authorization, priceSnapshotHash),
    providerEvidence: false,
    budget: {
      authorizedCny: authorization.limits.budgetCny,
      preflightEstimatedMaximumCny: authorization.pricing.estimatedMaxCostCny,
      observation: budgetObservation,
    },
    sessions: {
      authorized: TEACHING_SPIKE_LIVE_MAX_SESSIONS,
    },
    responses: {
      authorized: TEACHING_SPIKE_LIVE_MAX_RESPONSE_ATTEMPTS,
    },
    progress: reportProgress,
    instructionAcks: { available: false as const },
    usage,
    scope: {
      transport: "isolated_provider_websocket" as const,
      upstream: "unattested_or_not_observed" as const,
      transportAttempted: input.transportAttempted,
      relayExercised: false as const,
      browserExercised: false as const,
    },
    outcome: {
      status: "failed" as const,
      errorCode: errorCode.data,
    },
    diagnostic: diagnostic.data,
    capabilityDecision: capabilityDecision(),
  });
}

function commonReportFields(
  authorization: z.infer<typeof authorizationSchema>,
  priceSnapshotHash: string,
) {
  return {
    schemaVersion: REALTIME_TEACHING_LIVE_EVIDENCE_SCHEMA_VERSION,
    runId: authorization.runId,
    planHash: authorization.planHash,
    provider: authorization.provider,
    inputMode: authorization.inputMode,
    fixtureRevision: TEACHING_SPIKE_FIXTURE_REVISION,
    fixtureHash: TEACHING_SPIKE_FIXTURE_HASH,
    inputFixtureHash: authorization.inputFixtureHash,
    priceSnapshotHash,
    target: {
      fingerprint: fingerprintTarget(authorization.target),
      databaseScope: authorization.target.databaseScope,
      modelProfileRevision: authorization.target.modelProfileRevision,
      connectionRevision: authorization.target.connectionRevision,
      voiceProfileRevision: authorization.target.voiceProfileRevision,
    },
  };
}

function capabilityDecision() {
  return {
    status: "not_evaluated" as const,
    reason: "insufficient_sample" as const,
    protocolSequenceCompletedIsCapabilityPassed: false as const,
    requiresHumanReview: true as const,
  };
}

function issueReport(input: unknown): RealtimeTeachingLiveEvidenceReport {
  const parsed = realtimeTeachingLiveEvidenceReportSchema.safeParse(input);
  if (!parsed.success) throw evidenceError("INVALID_REPORT");
  const issuedReport = deepFreeze(parsed.data);
  issuedLiveEvidenceReports.add(issuedReport);
  return issuedReport as RealtimeTeachingLiveEvidenceReport;
}

function parseAuthorization(
  input: TeachingSpikeLiveAuthorization,
): z.infer<typeof authorizationSchema> {
  const parsed = authorizationSchema.safeParse(input);
  if (!parsed.success) throw evidenceError("INVALID_AUTHORIZATION");
  if (
    parsed.data.provider !== parsed.data.target.provider ||
    parsed.data.pricing.estimatedMaxCostCny > parsed.data.limits.budgetCny ||
    (parsed.data.provider === "qwen" &&
      (parsed.data.inputMode !== "text" ||
        parsed.data.inputFixtureHash !== TEACHING_SPIKE_USER_TEXT_HASH ||
        canonicalJson(parsed.data.caseIds) !==
          canonicalJson(["D01T", "D02T", "D03T"]))) ||
    (parsed.data.provider === "doubao" &&
      (parsed.data.inputMode !== "pcm16le" ||
        canonicalJson(parsed.data.caseIds) !==
          canonicalJson(["D01", "D02", "D03"])))
  ) {
    throw evidenceError("INVALID_AUTHORIZATION");
  }
  return parsed.data;
}

function parseProtocolResult(
  input: RealtimeTeachingCoreProtocolResult,
): z.infer<typeof coreProtocolResultSchema> {
  const parsed = coreProtocolResultSchema.safeParse(input);
  if (!parsed.success) throw evidenceError("INVALID_PROTOCOL_RESULT");
  return parsed.data;
}

function parseObservedUsage(
  input: RealtimeTeachingLiveObservedUsageInput,
): z.infer<typeof observedUsageInputSchema> {
  const parsed = observedUsageInputSchema.safeParse(input);
  if (!parsed.success) throw evidenceError("INVALID_USAGE");
  return parsed.data;
}

function assertProtocolMatchesAuthorization(
  authorization: z.infer<typeof authorizationSchema>,
  protocolResult: z.infer<typeof coreProtocolResultSchema>,
): void {
  if (
    protocolResult.provider !== authorization.provider ||
    protocolResult.inputMode !== authorization.inputMode ||
    protocolResult.inputFixtureHash !== authorization.inputFixtureHash ||
    canonicalJson(protocolResult.cases.map(({ id }) => id)) !==
      canonicalJson(authorization.caseIds)
  ) {
    throw evidenceError("PROTOCOL_AUTHORIZATION_MISMATCH");
  }
}

function assertPriceSnapshotMatchesAuthorization(
  authorization: z.infer<typeof authorizationSchema>,
  priceSnapshotHash: string,
): void {
  if (priceSnapshotHash !== authorization.pricing.priceSnapshotHash) {
    throw evidenceError("PRICE_SNAPSHOT_MISMATCH");
  }
}

function assertUsageWithinProtocolLimits(
  authorization: z.infer<typeof authorizationSchema>,
  usage: z.infer<typeof observedUsageInputSchema>,
): void {
  const maximumInputMs =
    authorization.limits.maxInputMs * authorization.limits.maxResponseAttempts;
  const maximumOutputMs =
    authorization.limits.maxOutputMs * authorization.limits.maxResponseAttempts;
  if (
    usage.inputAudioMs > maximumInputMs ||
    usage.outputAudioMs > maximumOutputMs ||
    usage.estimatedCostCny > authorization.limits.budgetCny ||
    (authorization.provider === "qwen" &&
      (usage.inputAudioMs !== 0 || usage.outputAudioMs !== 0))
  ) {
    throw evidenceError("USAGE_LIMIT_EXCEEDED");
  }
}

function assertObservedUsageMatchesProtocol(
  protocolResult: z.infer<typeof coreProtocolResultSchema>,
  observedUsage: z.infer<typeof observedUsageInputSchema>,
): void {
  if (protocolResult.provider !== "qwen") return;
  const derived = deriveQwenObservedUsage(protocolResult.usage);
  if (canonicalJson(derived) !== canonicalJson(observedUsage)) {
    throw evidenceError("INVALID_USAGE");
  }
}

/** Qwen smoke is text-only; cost is derived only from its strict token usage. */
function deriveQwenObservedUsage(
  usage: TeachingSpikeUsage,
): RealtimeTeachingLiveObservedUsageInput {
  if (usage.inputAudioTokens !== 0 || usage.outputAudioTokens !== 0) {
    throw evidenceError("INVALID_USAGE");
  }
  let estimatedCostCny: number;
  try {
    estimatedCostCny = estimateQwenTeachingSpikeUsageCostCny(usage);
  } catch {
    throw evidenceError("INVALID_USAGE");
  }
  return {
    inputAudioMs: 0,
    outputAudioMs: 0,
    estimatedCostCny,
  };
}

function snapshotAuthorizationRequest(
  input: TeachingSpikeLiveAuthorizationRequest,
): TeachingSpikeLiveAuthorizationRequest {
  const plan = parseTeachingSpikeLiveAuthorizationPlan(input.plan);
  const currentTarget = teachingSpikeLiveTargetSchema.safeParse(
    input.currentTarget,
  );
  const currentPricing = authorizationSchema.shape.pricing.safeParse(
    input.currentPricing,
  );
  const currentInputFixtureHash = hashSchema.safeParse(
    input.currentInputFixtureHash,
  );
  if (
    !currentTarget.success ||
    !currentPricing.success ||
    !currentInputFixtureHash.success
  ) {
    throw evidenceError("INVALID_AUTHORIZATION");
  }
  return deepFreeze({
    live: input.live,
    execute: input.execute,
    interactive: input.interactive,
    provider: input.provider,
    ackPlanHash: input.ackPlanHash,
    plan,
    currentTarget: currentTarget.data,
    currentInputFixtureHash: currentInputFixtureHash.data,
    currentPricing: currentPricing.data,
  });
}

function authorizationFromComposition(
  composition: QwenTeachingLiveCompositionResult,
): TeachingSpikeLiveAuthorization {
  const authorization = parseAuthorization(composition.authorization);
  if (
    composition.provider !== "qwen" ||
    composition.providerEvidence !== false ||
    authorization.provider !== "qwen" ||
    authorization.inputMode !== "text"
  ) {
    throw evidenceError("INVALID_COMPOSITION_RESULT");
  }
  return deepFreeze(authorization);
}

function authorizationFromPlanSnapshot(
  plan: TeachingSpikeLiveAuthorizationRequest["plan"],
): TeachingSpikeLiveAuthorization {
  return deepFreeze({
    authorized: true,
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

function classifySafeFailure(error: unknown): RealtimeTeachingLiveFailureCode {
  if (error instanceof RuntimeResolutionFailure) {
    return "RUNTIME_RESOLUTION_FAILED";
  }
  if (error instanceof TeachingSpikeLiveAuthorizationError) {
    return "AUTHORIZATION_POST_CONSUMPTION_FAILED";
  }
  if (error instanceof QwenTeachingLiveCompositionError) {
    return "TARGET_BINDING_FAILED";
  }
  if (error instanceof QwenTeachingLiveAdapterError) {
    return classifyQwenAdapterErrorCode(error.code);
  }
  if (error instanceof RealtimeTeachingLiveEvidenceError) {
    return "EVIDENCE_VALIDATION_FAILED";
  }
  return "UNEXPECTED_SAFE_FAILURE";
}

function safeFailureDiagnostic(
  error: unknown,
  markerFailureObservation?: QwenTeachingLiveMarkerFailureObservation,
): RealtimeTeachingLiveFailureDiagnostic {
  if (
    !(error instanceof QwenTeachingLiveAdapterError) ||
    error.checkpoint === undefined
  ) {
    return { available: false };
  }
  return {
    available: true,
    source: "qwen_live_adapter",
    checkpoint: error.checkpoint,
    adapterErrorCode: error.code,
    providerError: safeProviderErrorDiagnostic(error),
    markerAssertion:
      markerFailureObservation === undefined
        ? { available: false }
        : markerAssertionDiagnostic(markerFailureObservation),
  };
}

function markerAssertionDiagnostic(
  observation: QwenTeachingLiveMarkerFailureObservation,
) {
  return {
    available: true as const,
    caseId: observation.caseId,
    expectedState: observation.expectedState,
    activeInstructionAck: observation.activeInstructionAck,
    observedInstructionAcks: {
      total: observation.observedInstructionAcks.total,
      echoedMatch: observation.observedInstructionAcks.echoedMatch,
      omitted: observation.observedInstructionAcks.omitted,
    },
    markerMultiplicity: {
      a: observation.markerMultiplicity.a,
      b: observation.markerMultiplicity.b,
      c: observation.markerMultiplicity.c,
    },
    hasUnexpectedText: requireUnexpectedMarkerText(
      observation.hasUnexpectedText,
    ),
  };
}

function requireUnexpectedMarkerText(value: boolean): true {
  if (value !== true) {
    throw evidenceError("INVALID_FAILURE_DIAGNOSTIC");
  }
  return true;
}

function markerFailureProgress(
  observation: QwenTeachingLiveMarkerFailureObservation,
): RealtimeTeachingLiveFailureProgress {
  return {
    available: true,
    observedSessions: observation.progress.session,
    attemptedResponses: observation.progress.attempt,
    protocolSequenceCompleted: observation.progress.completed,
    failed: observation.progress.failed,
  };
}

function safeProviderErrorDiagnostic(
  error: QwenTeachingLiveAdapterError,
): z.input<typeof providerErrorDiagnosticSchema> {
  if (error.code !== "PROVIDER_ERROR") return { available: false };
  const providerError = copySafeProviderError(error.providerError);
  return {
    available: true,
    typeCategory: providerError.typeCategory,
    codeCategory: providerError.codeCategory,
    paramCategory: providerError.paramCategory,
  };
}

function copySafeProviderError(
  providerError: QwenTeachingLiveSafeProviderError | undefined,
): QwenTeachingLiveSafeProviderError {
  return {
    typeCategory: providerError?.typeCategory ?? "missing",
    codeCategory: providerError?.codeCategory ?? "missing",
    paramCategory: providerError?.paramCategory ?? "missing",
  };
}

function classifyQwenAdapterErrorCode(
  code: (typeof QWEN_TEACHING_LIVE_ADAPTER_ERROR_CODES)[number],
): RealtimeTeachingLiveFailureCode {
  if (code === "SOCKET_CLOSE_TIMEOUT") {
    return "RESOURCE_CLEANUP_FAILED";
  }
  if (
    code === "UPSTREAM_SESSION_BYTES_EXCEEDED" ||
    code === "UPSTREAM_SESSION_EVENTS_EXCEEDED" ||
    code === "UPSTREAM_INBOX_OVERFLOW" ||
    code === "RESPONSE_USAGE_EXCEEDS_RESERVATION" ||
    code === "RESPONSE_USAGE_OVERFLOW" ||
    code === "RESPONSE_TRANSCRIPT_TOO_LARGE"
  ) {
    return "RESOURCE_LIMIT_EXCEEDED";
  }
  if (
    code === "NETWORK_ERROR" ||
    code === "SOCKET_OPEN_TIMEOUT" ||
    code === "CONNECTION_CLOSED"
  ) {
    return "TRANSPORT_FAILED";
  }
  return "PROTOCOL_SEQUENCE_FAILED";
}

class RuntimeResolutionFailure extends Error {
  constructor() {
    super("RUNTIME_RESOLUTION_FAILED");
    this.name = "RuntimeResolutionFailure";
  }
}

function assertQwenTokenArithmetic(
  usage: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    inputTextTokens: number;
    inputAudioTokens: number;
    outputTextTokens: number;
    outputAudioTokens: number;
  },
  context: z.RefinementCtx,
): void {
  if (
    usage.totalTokens !== usage.inputTokens + usage.outputTokens ||
    usage.inputTokens !== usage.inputTextTokens + usage.inputAudioTokens ||
    usage.outputTokens !== usage.outputTextTokens + usage.outputAudioTokens ||
    usage.inputAudioTokens !== 0 ||
    usage.outputAudioTokens !== 0
  ) {
    context.addIssue({
      code: "custom",
      message: "Qwen 纯文本七维 Token 用量必须守恒且音频 Token 为零。",
    });
  }
}

function assertQwenInstructionAckArithmetic(
  instructionAcks: {
    total: 5;
    echoedMatch: number;
    omitted: number;
  },
  context: z.RefinementCtx,
): void {
  if (
    instructionAcks.echoedMatch + instructionAcks.omitted !==
    instructionAcks.total
  ) {
    context.addIssue({
      code: "custom",
      message: "Qwen Instruction ACK 分类计数必须合计为 5。",
    });
  }
}

function assertPartialInstructionAckArithmetic(
  instructionAcks: {
    total: number;
    echoedMatch: number;
    omitted: number;
  },
  context: z.RefinementCtx,
): void {
  if (
    instructionAcks.echoedMatch + instructionAcks.omitted !==
    instructionAcks.total
  ) {
    context.addIssue({
      code: "custom",
      message: "部分 Instruction ACK 分类计数必须等于已观察总数。",
    });
  }
}

const MARKER_FAILURE_EXPECTATIONS = Object.freeze({
  D01T: {
    expectedState: "A",
    checkpoint: "d01t_case",
    ackTotal: 1,
    progress: { session: 1, attempt: 1, completed: 0, failed: 1 },
  },
  D02T: {
    expectedState: "C",
    checkpoint: "d02t_case",
    ackTotal: 2,
    progress: { session: 1, attempt: 2, completed: 1, failed: 1 },
  },
  D03T: {
    expectedState: "B",
    checkpoint: "d03t_case",
    ackTotal: 4,
    progress: { session: 2, attempt: 3, completed: 2, failed: 1 },
  },
} as const);

function markerFailureExpectation(caseId: "D01T" | "D02T" | "D03T") {
  return MARKER_FAILURE_EXPECTATIONS[caseId];
}

function assertMarkerDiagnosticConsistency(
  diagnostic: {
    adapterErrorCode: (typeof QWEN_TEACHING_LIVE_ADAPTER_ERROR_CODES)[number];
    checkpoint: (typeof QWEN_TEACHING_LIVE_CHECKPOINTS)[number];
    markerAssertion: z.infer<typeof markerAssertionDiagnosticSchema>;
  },
  context: z.RefinementCtx,
): void {
  const markerAssertion = diagnostic.markerAssertion;
  const markerFailure =
    diagnostic.adapterErrorCode === "MARKER_ASSERTION_FAILED";
  if (markerFailure !== markerAssertion.available) {
    context.addIssue({
      code: "custom",
      path: ["markerAssertion"],
      message: "MARKER_ASSERTION_FAILED 必须且只能携带安全 Marker 断言诊断。",
    });
    return;
  }
  if (!markerAssertion.available) return;
  const expected = markerFailureExpectation(markerAssertion.caseId);
  if (
    diagnostic.checkpoint !== expected.checkpoint ||
    markerAssertion.expectedState !== expected.expectedState ||
    markerAssertion.observedInstructionAcks.total !== expected.ackTotal
  ) {
    context.addIssue({
      code: "custom",
      path: ["markerAssertion"],
      message: "Marker case、checkpoint、预期状态与 ACK 总数不匹配。",
    });
  }
  assertMarkerObservationDetails(markerAssertion, context, ["markerAssertion"]);
}

function assertMarkerFailureObservation(
  observation: {
    caseId: "D01T" | "D02T" | "D03T";
    expectedState: "A" | "B" | "C";
    activeInstructionAck: "echoed_match" | "omitted";
    observedInstructionAcks: {
      total: number;
      echoedMatch: number;
      omitted: number;
    };
    markerMultiplicity: {
      a: "zero" | "one" | "multiple";
      b: "zero" | "one" | "multiple";
      c: "zero" | "one" | "multiple";
    };
    hasUnexpectedText: true;
    progress: {
      session: 1 | 2;
      attempt: 1 | 2 | 3;
      completed: 0 | 1 | 2;
      failed: 1;
    };
  },
  context: z.RefinementCtx,
): void {
  const expected = markerFailureExpectation(observation.caseId);
  if (
    observation.expectedState !== expected.expectedState ||
    observation.observedInstructionAcks.total !== expected.ackTotal ||
    canonicalJson(observation.progress) !== canonicalJson(expected.progress)
  ) {
    context.addIssue({
      code: "custom",
      message:
        "Marker failure observation 的状态、ACK 总数或进度与 case 不匹配。",
    });
  }
  assertMarkerObservationDetails(observation, context, []);
}

function assertMarkerObservationDetails(
  observation: {
    caseId: "D01T" | "D02T" | "D03T";
    activeInstructionAck: "echoed_match" | "omitted";
    observedInstructionAcks: {
      echoedMatch: number;
      omitted: number;
    };
    markerMultiplicity: {
      a: "zero" | "one" | "multiple";
      b: "zero" | "one" | "multiple";
      c: "zero" | "one" | "multiple";
    };
    hasUnexpectedText: true;
  },
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  const activeCount =
    observation.activeInstructionAck === "echoed_match"
      ? observation.observedInstructionAcks.echoedMatch
      : observation.observedInstructionAcks.omitted;
  if (activeCount < 1) {
    context.addIssue({
      code: "custom",
      path: [...path, "activeInstructionAck"],
      message: "活动指令 ACK 必须出现在已观察 ACK 分类中。",
    });
  }
}

function addReportIssue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

function parseHash(
  input: unknown,
  errorCode: RealtimeTeachingLiveEvidenceErrorCode,
): string {
  const parsed = hashSchema.safeParse(input);
  if (!parsed.success) throw evidenceError(errorCode);
  return parsed.data;
}

function fingerprintTarget(
  target: z.infer<typeof teachingSpikeLiveTargetSchema>,
): string {
  return createHash("sha256")
    .update(canonicalJson(target), "utf8")
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

export type RealtimeTeachingLiveEvidenceErrorCode =
  | "INVALID_AUTHORIZATION"
  | "INVALID_PRICE_SNAPSHOT_HASH"
  | "PRICE_SNAPSHOT_MISMATCH"
  | "INVALID_PROTOCOL_RESULT"
  | "PROTOCOL_AUTHORIZATION_MISMATCH"
  | "INVALID_USAGE"
  | "USAGE_LIMIT_EXCEEDED"
  | "INVALID_FAILURE_CODE"
  | "INVALID_FAILURE_PROGRESS"
  | "INVALID_FAILURE_DIAGNOSTIC"
  | "INVALID_COMPOSITION_RESULT"
  | "LIVE_RUN_FAILED_BEFORE_AUTHORIZATION_CONSUMED"
  | "INVALID_REPORT";

export class RealtimeTeachingLiveEvidenceError extends Error {
  constructor(public readonly code: RealtimeTeachingLiveEvidenceErrorCode) {
    super(code);
    this.name = "RealtimeTeachingLiveEvidenceError";
  }
}

function evidenceError(
  code: RealtimeTeachingLiveEvidenceErrorCode,
): RealtimeTeachingLiveEvidenceError {
  return new RealtimeTeachingLiveEvidenceError(code);
}
