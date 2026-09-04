import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  classifyTeachingTargetAvailability,
  evaluateTeachingInvitationEligibility,
  isGeneratedTeachingContentExpired,
  isDynamicTeachingRuntimeEligible,
  isDynamicTeachingModel,
  isTeachingConfigurationRevisionCurrent,
  markTeachingCompleted,
  selectFiniteTeachingContentItem,
  selectTeachingContentItemId,
  shouldClearPublishedTeachingContent,
  TEACHING_DYNAMIC_MODELS,
  TEACHING_DYNAMIC_PROVIDER,
  TEACHING_GENTLE_MIN_CONVERSATION_MS,
  TEACHING_GENTLE_MIN_INTERVAL_MS,
  TEACHING_GENTLE_MIN_VALID_USER_TURNS,
  type TeachingTargetRuntime,
} from "./teaching-operations.js";
import type { Database } from "./client.js";
import type { ConversationTeachingStateRecord } from "./schema.js";

const now = new Date("2026-08-15T08:00:00.000Z");
const plusBinding = {
  modelProfileId: "00000000-0000-4000-8000-000000000001",
  modelProfileRevision: 3,
  connectionId: "00000000-0000-4000-8000-000000000002",
  connectionRevision: 5,
} as const;
const flashBinding = {
  modelProfileId: "00000000-0000-4000-8000-000000000003",
  modelProfileRevision: 7,
  connectionId: "00000000-0000-4000-8000-000000000004",
  connectionRevision: 11,
} as const;
const capability = { bindings: [plusBinding, flashBinding] } as const;

describe("teaching database operations", () => {
  it("supports both Qwen Audio Realtime models through exact bindings", () => {
    expect(TEACHING_DYNAMIC_PROVIDER).toBe("qwen");
    expect(TEACHING_DYNAMIC_MODELS).toEqual([
      "qwen-audio-3.0-realtime-plus",
      "qwen-audio-3.0-realtime-flash",
    ]);
    expect(isDynamicTeachingModel("qwen-audio-3.0-realtime-plus")).toBe(true);
    expect(isDynamicTeachingModel("qwen-audio-3.0-realtime-flash")).toBe(true);
    expect(isDynamicTeachingModel("qwen3.5-omni-plus-realtime")).toBe(false);

    const eligible = eligibleRuntime();
    const eligibleFlash = eligibleRuntime({
      ...flashBinding,
      model: "qwen-audio-3.0-realtime-flash",
    });
    expect(isDynamicTeachingRuntimeEligible(eligible, capability)).toBe(true);
    expect(isDynamicTeachingRuntimeEligible(eligibleFlash, capability)).toBe(
      true,
    );
    expect(
      isDynamicTeachingRuntimeEligible(eligibleFlash, {
        bindings: [plusBinding],
      }),
    ).toBe(false);
    expect(isDynamicTeachingRuntimeEligible(eligible)).toBe(false);
    for (const runtime of [
      { ...eligible, modelProfileRevision: 4 },
      { ...eligible, connectionRevision: 6 },
      { ...eligible, providerVerifiedAt: null },
      { ...eligible, voiceStatus: "disabled" },
      { ...eligible, voiceVerifiedAt: null },
      { ...eligible, connectionAdapter: "doubao_realtime" },
      { ...eligible, connectionStatus: "draft" },
      { ...eligible, connectionVerifiedAt: null },
      { ...eligible, model: "qwen3.5-omni-plus-realtime" },
    ]) {
      expect(isDynamicTeachingRuntimeEligible(runtime, capability)).toBe(false);
    }
  });

  it("classifies every public character without broadening the runtime gate", () => {
    const eligible = eligibleRuntime();

    expect(classifyTeachingTargetAvailability(eligible, capability)).toEqual({
      available: true,
    });
    expect(
      classifyTeachingTargetAvailability(
        eligibleRuntime({
          ...flashBinding,
          model: "qwen-audio-3.0-realtime-flash",
        }),
        capability,
      ),
    ).toEqual({ available: true });
    expect(classifyTeachingTargetAvailability(eligible)).toEqual({
      available: false,
      reason: "configuration_not_approved",
    });
    for (const runtime of [
      { ...eligible, modelProfileId: "00000000-0000-4000-8000-000000000099" },
      {
        ...eligible,
        modelProfileRevision: plusBinding.modelProfileRevision + 1,
      },
      { ...eligible, connectionId: "00000000-0000-4000-8000-000000000098" },
      {
        ...eligible,
        connectionRevision: plusBinding.connectionRevision + 1,
      },
    ]) {
      expect(classifyTeachingTargetAvailability(runtime, capability)).toEqual({
        available: false,
        reason: "configuration_not_approved",
      });
    }

    for (const runtime of [
      { ...eligible, provider: "doubao" },
      { ...eligible, model: "qwen3.5-omni-plus-realtime" },
      { ...eligible, providerKind: "text" },
      { ...eligible, connectionAdapter: "doubao_realtime" },
    ]) {
      expect(classifyTeachingTargetAvailability(runtime, capability)).toEqual({
        available: false,
        reason: "provider_unsupported",
      });
    }

    for (const runtime of [
      { ...eligible, providerStatus: "disabled" },
      { ...eligible, providerVerifiedAt: null },
      { ...eligible, voiceStatus: "disabled" },
      { ...eligible, voiceVerifiedAt: null },
      { ...eligible, connectionStatus: "draft" },
      { ...eligible, connectionVerifiedAt: null },
      {
        ...eligible,
        connectionId: null,
        connectionRevision: null,
        connectionStatus: null,
        connectionVerifiedAt: null,
      },
    ]) {
      expect(classifyTeachingTargetAvailability(runtime, capability)).toEqual({
        available: false,
        reason: "realtime_unavailable",
      });
    }
  });

  it("binds child disclosure to the exact enabled plan revision", () => {
    expect(
      isTeachingConfigurationRevisionCurrent({ enabled: true, revision: 4 }, 4),
    ).toBe(true);
    expect(
      isTeachingConfigurationRevisionCurrent({ enabled: true, revision: 5 }, 4),
    ).toBe(false);
    expect(
      isTeachingConfigurationRevisionCurrent(
        { enabled: false, revision: 4 },
        4,
      ),
    ).toBe(false);
    expect(isTeachingConfigurationRevisionCurrent(null, 4)).toBe(false);
  });

  it("rotates controlled content deterministically across conversations", () => {
    const ids = ["english-1", "english-2"] as const;
    expect(selectTeachingContentItemId(ids, 0)).toBe("english-1");
    expect(selectTeachingContentItemId(ids, 1)).toBe("english-2");
    expect(selectTeachingContentItemId(ids, 2)).toBe("english-1");
    expect(() => selectTeachingContentItemId([], 0)).toThrow(
      "non-empty catalog",
    );
  });

  it("never wraps finite generated content and expires on the exact boundary", () => {
    const items = ["first", "second"] as const;
    expect(selectFiniteTeachingContentItem(items, 0)).toBe("first");
    expect(selectFiniteTeachingContentItem(items, 1)).toBe("second");
    expect(selectFiniteTeachingContentItem(items, 2)).toBeNull();
    expect(selectFiniteTeachingContentItem(items, -1)).toBeNull();

    const activatedAt = new Date("2026-08-01T00:00:00.000Z");
    expect(
      isGeneratedTeachingContentExpired(
        activatedAt,
        7,
        new Date("2026-08-07T23:59:59.999Z"),
      ),
    ).toBe(false);
    expect(
      isGeneratedTeachingContentExpired(
        activatedAt,
        7,
        new Date("2026-08-08T00:00:00.000Z"),
      ),
    ).toBe(true);
  });

  it("keeps published content during candidate edits and clears it only when the adult removes the goal", () => {
    const activeRevisionId = "2072f06d-c71a-47b3-94fe-35e1204b5b55";
    expect(
      shouldClearPublishedTeachingContent(
        activeRevisionId,
        "练习 2～5 的乘法口诀",
      ),
    ).toBe(false);
    expect(shouldClearPublishedTeachingContent(activeRevisionId, null)).toBe(
      true,
    );
    expect(shouldClearPublishedTeachingContent(null, null)).toBe(false);
  });

  it("clears a late active item when completion arrives after mute", async () => {
    const state: ConversationTeachingStateRecord = {
      conversationId: "9172f06d-c71a-47b3-94fe-35e1204b5b55",
      learningPlanId: "8f1b7f3d-0e1f-4a8d-9967-712f18b2d21b",
      learningPlanRevision: 1,
      subject: "science",
      difficulty: "starter",
      triggerMode: "gentle",
      disclosureVersion: "teaching-disclosure-v1",
      contentRevisionId: null,
      contentCatalogVersion: "reviewed-v1",
      state: "muted",
      muteReason: "child_request",
      validUserTurns: 6,
      invitationCount: 1,
      activeContentItemId: "science-space-gravity-v1",
      revision: 2,
      preparedAt: now,
      updatedAt: now,
    };
    let update: Record<string, unknown> | undefined;
    const events: Array<Record<string, unknown>> = [];
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            for: () => ({ limit: async () => [state] }),
          }),
        }),
      }),
      update: () => ({
        set: (value: Record<string, unknown>) => {
          update = value;
          return {
            where: () => ({
              returning: async () => [{ ...state, ...value }],
            }),
          };
        },
      }),
      insert: () => ({
        values: async (value: Record<string, unknown>) => {
          events.push(value);
        },
      }),
    };
    const db = {
      transaction: async (operation: (transaction: typeof tx) => unknown) =>
        operation(tx),
    } as unknown as Database;

    const result = await markTeachingCompleted(db, {
      conversationId: state.conversationId,
      expectedRevision: 2,
      updatedAt: now,
    });
    expect(result).toMatchObject({
      kind: "transitioned",
      state: { state: "muted", activeContentItemId: null, revision: 3 },
    });
    expect(update).toMatchObject({
      state: "muted",
      activeContentItemId: null,
      revision: 3,
    });
    expect(events[0]).toMatchObject({
      eventType: "completed",
      stateRevision: 3,
    });
  });

  it("lets an explicit child request bypass only the gentle timing gates", () => {
    expect(
      eligibility({
        triggerMode: "on_request",
        validUserTurns: 0,
        conversationStartedAt: now,
        lastTriggeredAt: now,
        explicitRequest: true,
      }),
    ).toBeNull();
    expect(eligibility({ state: "muted", explicitRequest: true })).toBe(
      "state_unavailable",
    );
    expect(eligibility({ invitationCount: 1, explicitRequest: true })).toBe(
      "already_invited",
    );
  });

  it("enforces all low-disruption gates for a gentle invitation", () => {
    expect(eligibility({ triggerMode: "on_request" })).toBe("trigger_mode");
    expect(
      eligibility({
        conversationStartedAt: new Date(
          now.getTime() - TEACHING_GENTLE_MIN_CONVERSATION_MS + 1,
        ),
      }),
    ).toBe("conversation_too_short");
    expect(
      eligibility({ validUserTurns: TEACHING_GENTLE_MIN_VALID_USER_TURNS - 1 }),
    ).toBe("insufficient_valid_turns");
    expect(
      eligibility({
        lastTriggeredAt: new Date(
          now.getTime() - TEACHING_GENTLE_MIN_INTERVAL_MS + 1,
        ),
      }),
    ).toBe("cooldown");
    expect(eligibility()).toBeNull();
  });

  it("migrates plans, reconnect-safe state, and append-only low-entropy events", () => {
    const path = fileURLToPath(
      new URL(
        "../migrations/0020_learning_plans_and_teaching_states.sql",
        import.meta.url,
      ),
    );
    const migration = readFileSync(path, "utf8");

    expect(migration).toContain(
      'CREATE TABLE "child_character_learning_plans"',
    );
    expect(migration).toContain('"last_triggered_at" timestamp with time zone');
    expect(migration).toContain('"content_cursor" integer DEFAULT 0 NOT NULL');
    expect(migration).toContain(
      '"conversation_teaching_states"."valid_user_turns" >= 0',
    );
    expect(migration).toContain(
      '"conversation_teaching_states"."invitation_count" <= 1',
    );
    expect(migration).toContain('"active_content_item_id" varchar(160)');
    expect(migration).toContain('"disclosure_version" varchar(40)');
    expect(migration).toContain(
      "\"disclosure_version\" = 'teaching-disclosure-v1'",
    );
    expect(migration).toContain(
      "ENUM('unavailable', 'available', 'active', 'restoring', 'muted', 'completed')",
    );
    expect(migration).toContain('CREATE TABLE "teaching_events"');
    expect(migration).not.toContain("guardian");
    expect(migration).not.toContain("prompt");
  });
});

function eligibleRuntime(
  overrides: Partial<TeachingTargetRuntime> = {},
): TeachingTargetRuntime {
  return { ...baseEligibleRuntime(), ...overrides };
}

function baseEligibleRuntime() {
  return {
    modelProfileId: plusBinding.modelProfileId,
    modelProfileRevision: plusBinding.modelProfileRevision,
    provider: "qwen",
    providerKind: "realtime_voice",
    model: "qwen-audio-3.0-realtime-plus",
    providerStatus: "enabled",
    providerVerifiedAt: now,
    voiceStatus: "enabled",
    voiceVerifiedAt: now,
    connectionAdapter: "qwen_realtime",
    connectionId: plusBinding.connectionId,
    connectionRevision: plusBinding.connectionRevision,
    connectionStatus: "enabled",
    connectionVerifiedAt: now,
  };
}

function eligibility(
  overrides: Partial<{
    state:
      | "unavailable"
      | "available"
      | "active"
      | "restoring"
      | "muted"
      | "completed";
    muteReason:
      "temporary_conversation" | "child_request" | "plan_disabled" | null;
    invitationCount: number;
    triggerMode: "on_request" | "gentle" | null;
    validUserTurns: number;
    conversationStartedAt: Date;
    lastTriggeredAt: Date | null;
    explicitRequest: boolean;
  }> = {},
) {
  return evaluateTeachingInvitationEligibility({
    state: {
      state: overrides.state ?? "available",
      muteReason: overrides.muteReason ?? null,
      invitationCount: overrides.invitationCount ?? 0,
      triggerMode: overrides.triggerMode ?? "gentle",
      validUserTurns:
        overrides.validUserTurns ?? TEACHING_GENTLE_MIN_VALID_USER_TURNS,
    },
    conversationStartedAt:
      overrides.conversationStartedAt ??
      new Date(now.getTime() - TEACHING_GENTLE_MIN_CONVERSATION_MS),
    lastTriggeredAt:
      overrides.lastTriggeredAt === undefined
        ? new Date(now.getTime() - TEACHING_GENTLE_MIN_INTERVAL_MS)
        : overrides.lastTriggeredAt,
    explicitRequest: overrides.explicitRequest ?? false,
    claimedAt: now,
  });
}
