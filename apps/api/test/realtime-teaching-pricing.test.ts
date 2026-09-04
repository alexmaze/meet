import { describe, expect, it } from "vitest";

import {
  TEACHING_SPIKE_QWEN_PRICE_SNAPSHOT,
  buildQwenTeachingSpikePricingBinding,
  estimateQwenTeachingSpikeUsageCostCny,
  hashTeachingSpikePriceSnapshot,
} from "../src/spikes/realtime-teaching/pricing.js";
import type { TeachingSpikePricingError } from "../src/spikes/realtime-teaching/pricing.js";

describe("realtime teaching live pricing", () => {
  it("pins a reproducible official Qwen list-price snapshot", () => {
    const binding = buildQwenTeachingSpikePricingBinding();

    expect(binding).toEqual({
      priceSnapshotHash: hashTeachingSpikePriceSnapshot(
        TEACHING_SPIKE_QWEN_PRICE_SNAPSHOT,
      ),
      estimatedMaxCostCny: 1.2288,
    });
    expect(binding.priceSnapshotHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(binding.priceSnapshotHash).toBe(
      "ebe72fd28a29a7243b2246e71123993159404ac171626933bc40f86c27b786f6",
    );
    expect(Object.isFrozen(TEACHING_SPIKE_QWEN_PRICE_SNAPSHOT)).toBe(true);
    expect(Object.isFrozen(binding)).toBe(true);
  });

  it("estimates reported token usage without relying on promotions", () => {
    expect(
      estimateQwenTeachingSpikeUsageCostCny({
        totalTokens: 377,
        inputTokens: 336,
        outputTokens: 41,
        inputTextTokens: 336,
        inputAudioTokens: 0,
        outputTextTokens: 41,
        outputAudioTokens: 0,
      }),
    ).toBe(0.00332);
  });

  it("rejects audio usage because the authorized smoke is text-only", () => {
    expect(() =>
      estimateQwenTeachingSpikeUsageCostCny({
        totalTokens: 2,
        inputTokens: 1,
        outputTokens: 1,
        inputTextTokens: 0,
        inputAudioTokens: 1,
        outputTextTokens: 1,
        outputAudioTokens: 0,
      }),
    ).toThrowError(
      expect.objectContaining<TeachingSpikePricingError>({
        code: "INVALID_USAGE",
      }),
    );
  });

  it("rejects inconsistent or unsafe usage aggregates", () => {
    expect(() =>
      estimateQwenTeachingSpikeUsageCostCny({
        totalTokens: 2,
        inputTokens: 1,
        outputTokens: 1,
        inputTextTokens: 0,
        inputAudioTokens: 0,
        outputTextTokens: 1,
        outputAudioTokens: 0,
      }),
    ).toThrowError(
      expect.objectContaining<TeachingSpikePricingError>({
        code: "INVALID_USAGE",
      }),
    );
  });
});
