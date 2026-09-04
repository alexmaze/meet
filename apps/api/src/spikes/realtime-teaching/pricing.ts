import { createHash } from "node:crypto";

import { z } from "zod";

import { TEACHING_SPIKE_LIVE_MAX_RESPONSE_ATTEMPTS } from "./live-authorization.js";

export const TEACHING_SPIKE_PRICE_SNAPSHOT_SCHEMA_VERSION = 2 as const;

const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().safe();

export const teachingSpikeQwenPriceSnapshotSchema = z
  .object({
    schemaVersion: z.literal(TEACHING_SPIKE_PRICE_SNAPSHOT_SCHEMA_VERSION),
    provider: z.literal("qwen"),
    model: z.literal("qwen-audio-3.0-realtime-plus"),
    region: z.literal("cn-beijing"),
    currency: z.literal("CNY"),
    capturedAt: z.iso.date(),
    sourceUrl: z.literal(
      "https://help.aliyun.com/zh/model-studio/qwen-audio-3-0-realtime-plus",
    ),
    billingRulesUrl: z.literal(
      "https://help.aliyun.com/zh/model-studio/model-pricing",
    ),
    unit: z.literal("per_million_tokens"),
    ratesCny: z
      .object({
        inputText: z.literal(5),
        inputAudio: z.literal(40),
        outputText: z.literal(40),
        outputAudio: z.literal(150),
      })
      .strict(),
    estimationPolicy: z
      .object({
        outputMode: z.literal("text"),
        maxInputTextTokensPerResponse: z.literal(16_384),
        maxOutputTextTokensPerResponse: z.literal(8_192),
        requiredInputAudioTokens: z.literal(0),
        requiredOutputAudioTokens: z.literal(0),
      })
      .strict(),
  })
  .strict();

export type TeachingSpikeQwenPriceSnapshot = z.infer<
  typeof teachingSpikeQwenPriceSnapshotSchema
>;

/**
 * Versioned copy of the public list price used only for this bounded smoke.
 * Free-tier or promotional discounts are deliberately ignored.
 */
export const TEACHING_SPIKE_QWEN_PRICE_SNAPSHOT = deepFreeze(
  teachingSpikeQwenPriceSnapshotSchema.parse({
    schemaVersion: TEACHING_SPIKE_PRICE_SNAPSHOT_SCHEMA_VERSION,
    provider: "qwen",
    model: "qwen-audio-3.0-realtime-plus",
    region: "cn-beijing",
    currency: "CNY",
    capturedAt: "2026-08-14",
    sourceUrl:
      "https://help.aliyun.com/zh/model-studio/qwen-audio-3-0-realtime-plus",
    billingRulesUrl: "https://help.aliyun.com/zh/model-studio/model-pricing",
    unit: "per_million_tokens",
    ratesCny: {
      inputText: 5,
      inputAudio: 40,
      outputText: 40,
      outputAudio: 150,
    },
    estimationPolicy: {
      outputMode: "text",
      maxInputTextTokensPerResponse: 16_384,
      maxOutputTextTokensPerResponse: 8_192,
      requiredInputAudioTokens: 0,
      requiredOutputAudioTokens: 0,
    },
  }),
);

export type TeachingSpikeUsage = Readonly<{
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  inputTextTokens: number;
  inputAudioTokens: number;
  outputTextTokens: number;
  outputAudioTokens: number;
}>;

export type TeachingSpikePricingBinding = Readonly<{
  priceSnapshotHash: string;
  estimatedMaxCostCny: number;
}>;

export function hashTeachingSpikePriceSnapshot(
  snapshot: TeachingSpikeQwenPriceSnapshot,
): string {
  const parsed = teachingSpikeQwenPriceSnapshotSchema.parse(snapshot);
  return sha256(canonicalJson(parsed));
}

export function buildQwenTeachingSpikePricingBinding(): TeachingSpikePricingBinding {
  const snapshot = TEACHING_SPIKE_QWEN_PRICE_SNAPSHOT;
  const rates = snapshot.ratesCny;
  const perResponseMicroCny =
    snapshot.estimationPolicy.maxInputTextTokensPerResponse * rates.inputText +
    snapshot.estimationPolicy.maxOutputTextTokensPerResponse * rates.outputText;
  const totalMicroCny =
    perResponseMicroCny * TEACHING_SPIKE_LIVE_MAX_RESPONSE_ATTEMPTS;

  return deepFreeze({
    priceSnapshotHash: hashTeachingSpikePriceSnapshot(snapshot),
    estimatedMaxCostCny: totalMicroCny / 1_000_000,
  });
}

export function estimateQwenTeachingSpikeUsageCostCny(
  usage: TeachingSpikeUsage,
): number {
  const parsed = parseUsage(usage);
  const rates = TEACHING_SPIKE_QWEN_PRICE_SNAPSHOT.ratesCny;
  const microCny =
    parsed.inputTextTokens * rates.inputText +
    parsed.inputAudioTokens * rates.inputAudio +
    parsed.outputTextTokens * rates.outputText +
    parsed.outputAudioTokens * rates.outputAudio;
  if (!Number.isSafeInteger(microCny)) {
    throw new TeachingSpikePricingError("USAGE_COST_OVERFLOW");
  }
  return microCny / 1_000_000;
}

export class TeachingSpikePricingError extends Error {
  constructor(public readonly code: "INVALID_USAGE" | "USAGE_COST_OVERFLOW") {
    super(code);
    this.name = "TeachingSpikePricingError";
  }
}

function parseUsage(usage: TeachingSpikeUsage): TeachingSpikeUsage {
  const parsed = z
    .object({
      totalTokens: nonnegativeSafeIntegerSchema,
      inputTokens: nonnegativeSafeIntegerSchema,
      outputTokens: nonnegativeSafeIntegerSchema,
      inputTextTokens: nonnegativeSafeIntegerSchema,
      inputAudioTokens: nonnegativeSafeIntegerSchema,
      outputTextTokens: nonnegativeSafeIntegerSchema,
      outputAudioTokens: nonnegativeSafeIntegerSchema,
    })
    .strict()
    .safeParse(usage);
  if (
    !parsed.success ||
    parsed.data.inputAudioTokens !== 0 ||
    parsed.data.outputAudioTokens !== 0 ||
    parsed.data.inputTokens !==
      parsed.data.inputTextTokens + parsed.data.inputAudioTokens ||
    parsed.data.outputTokens !==
      parsed.data.outputTextTokens + parsed.data.outputAudioTokens ||
    parsed.data.totalTokens !==
      parsed.data.inputTokens + parsed.data.outputTokens
  ) {
    throw new TeachingSpikePricingError("INVALID_USAGE");
  }
  return parsed.data;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
