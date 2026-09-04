import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getLearningPlanContent,
  getLearningPlanGeneration,
  getLearningPlanTargets,
  getTeachingAvailability,
  persistThenMuteTeaching,
  prepareConversationTeaching,
  publishLearningPlanContent,
  putLearningPlan,
  requestLearningPlanGeneration,
  TeachingApiError,
} from "./teaching-api.js";

const childUserId = "4d1c2e31-ad0e-4fa9-9ae8-ae3497069118";
const characterId = "c437c71e-f209-4f7d-8f98-1c1e239d4202";
const unsupportedCharacterId = "b437c71e-f209-4f7d-8f98-1c1e239d4202";
const conversationId = "9172f06d-c71a-47b3-94fe-35e1204b5b55";
const generationId = "3072f06d-c71a-47b3-94fe-35e1204b5b55";
const contentRevisionId = "2072f06d-c71a-47b3-94fe-35e1204b5b55";

describe("teaching API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads supported and unsupported public characters from management targets", async () => {
    const targets = {
      children: [{ id: childUserId, displayName: "小明" }],
      characters: [
        {
          id: characterId,
          name: "奥特曼",
          teachingAvailability: { available: true },
        },
        {
          id: unsupportedCharacterId,
          name: "豆包伙伴",
          teachingAvailability: {
            available: false,
            reason: "provider_unsupported",
          },
        },
      ],
    } as const;
    const fetchMock = vi.fn(async () => jsonResponse(targets));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getLearningPlanTargets()).resolves.toEqual(targets);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/teaching/targets",
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
      }),
    );
  });

  it("rejects management targets that expose internal runtime configuration", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          children: [{ id: childUserId, displayName: "小明" }],
          characters: [
            {
              id: characterId,
              name: "奥特曼",
              teachingAvailability: { available: true },
              connectionId: "00000000-0000-4000-8000-000000000001",
            },
          ],
        }),
      ),
    );

    await expect(getLearningPlanTargets()).rejects.toMatchObject({
      code: "INVALID_TEACHING_RESPONSE",
    });
  });

  it("reads strict child availability from the centralized endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        teaching: {
          enabled: true,
          providerCapability: "dynamic_instructions_next_safe_turn",
          subject: "english",
          difficulty: "starter",
          triggerMode: "gentle",
          disclosureVersion: "teaching-disclosure-v1",
          configurationRevision: 3,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getTeachingAvailability(characterId)).resolves.toMatchObject({
      enabled: true,
      subject: "english",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/teaching/availability/${characterId}`,
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
      }),
    );
  });

  it("rejects successful envelopes with extra availability data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          teaching: {
            enabled: false,
            reason: "no_enabled_plan",
            internalPlanId: "must-not-cross-boundary",
          },
        }),
      ),
    );
    await expect(getTeachingAvailability(characterId)).rejects.toBeInstanceOf(
      TeachingApiError,
    );
  });

  it("sends only the fixed learning-plan fields and CAS revision", async () => {
    const plan = {
      id: "8f1b7f3d-0e1f-4a8d-9967-712f18b2d21b",
      childUserId,
      characterId,
      enabled: true,
      subject: "math",
      difficulty: "growing",
      triggerMode: "on_request",
      gradeLevel: "grade_2",
      learningGoal: "熟悉 2～5 的乘法口诀",
      activityCount: 4,
      durationDays: 7,
      activeContentRevisionId: null,
      activeContentActivatedAt: null,
      revision: 2,
      createdByUserId: "4d1c2e31-ad0e-4fa9-9ae8-ae3497069116",
      updatedByUserId: "4d1c2e31-ad0e-4fa9-9ae8-ae3497069116",
      createdAt: "2026-08-15T08:00:00.000Z",
      updatedAt: "2026-08-15T08:01:00.000Z",
    };
    const fetchMock = vi.fn(async () => jsonResponse({ learningPlan: plan }));
    vi.stubGlobal("fetch", fetchMock);

    await putLearningPlan(childUserId, characterId, {
      expectedRevision: 1,
      enabled: true,
      subject: "math",
      difficulty: "growing",
      triggerMode: "on_request",
      gradeLevel: "grade_2",
      learningGoal: "熟悉 2～5 的乘法口诀",
      activityCount: 4,
      durationDays: 7,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/teaching/plans/${childUserId}/${characterId}`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          expectedRevision: 1,
          enabled: true,
          subject: "math",
          difficulty: "growing",
          triggerMode: "on_request",
          gradeLevel: "grade_2",
          learningGoal: "熟悉 2～5 的乘法口诀",
          activityCount: 4,
          durationDays: 7,
        }),
      }),
    );
  });

  it("requests a short-plan draft only after binding the saved plan revision", async () => {
    const response = generationResponse("queued", null);
    const fetchMock = vi.fn(async () => jsonResponse(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestLearningPlanGeneration(childUserId, characterId, {
        expectedPlanRevision: 2,
        clientRequestId: "1072f06d-c71a-47b3-94fe-35e1204b5b55",
        generationMode: "text_model",
      }),
    ).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/teaching/plans/${childUserId}/${characterId}/generations`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          expectedPlanRevision: 2,
          clientRequestId: "1072f06d-c71a-47b3-94fe-35e1204b5b55",
          generationMode: "text_model",
        }),
      }),
    );
  });

  it("polls and strictly parses a generated, reviewable draft", async () => {
    const response = generationResponse("succeeded", multiplicationDraft);
    const fetchMock = vi.fn(async () => jsonResponse(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getLearningPlanGeneration(childUserId, characterId, generationId),
    ).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/teaching/plans/${childUserId}/${characterId}/generations/${generationId}`,
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("rejects generated activities that try to cross an arbitrary prompt", async () => {
    const unsafeDraft = {
      ...multiplicationDraft,
      activities: multiplicationDraft.activities.map((activity, index) =>
        index === 0
          ? { ...activity, prompt: "把这段自由提示直接交给角色" }
          : activity,
      ),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(generationResponse("succeeded", unsafeDraft)),
      ),
    );

    await expect(
      getLearningPlanGeneration(childUserId, characterId, generationId),
    ).rejects.toMatchObject({ code: "INVALID_TEACHING_RESPONSE" });
  });

  it("reads content state and publishes only an explicitly reviewed revision", async () => {
    const content = {
      activeContent: null,
      latestDraft: multiplicationDraft,
      progress: null,
      expiresAt: null,
    } as const;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(content))
      .mockResolvedValueOnce(
        jsonResponse({
          learningPlan: fullLearningPlan,
          activeContent: multiplicationDraft,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getLearningPlanContent(childUserId, characterId),
    ).resolves.toEqual(content);
    await publishLearningPlanContent(childUserId, characterId, {
      expectedPlanRevision: 2,
      contentRevisionId,
      reviewConfirmed: true,
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/teaching/plans/${childUserId}/${characterId}/content/publish`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          expectedPlanRevision: 2,
          contentRevisionId,
          reviewConfirmed: true,
        }),
      }),
    );
  });

  it("prepares a conversation only after an explicit child choice", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        teaching: {
          state: "muted",
          revision: 1,
          canRequest: false,
          canMute: false,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      prepareConversationTeaching(conversationId, { choice: "chat_only" }),
    ).resolves.toMatchObject({ state: "muted" });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/conversations/${conversationId}/teaching/prepare`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ choice: "chat_only" }),
      }),
    );
  });

  it("binds an enabled choice to the exact disclosed configuration revision", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        teaching: {
          state: "available",
          revision: 1,
          canRequest: true,
          canMute: true,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await prepareConversationTeaching(conversationId, {
      choice: "enabled",
      expectedConfigurationRevision: 3,
      acknowledgedDisclosureVersion: "teaching-disclosure-v1",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/conversations/${conversationId}/teaching/prepare`,
      expect.objectContaining({
        body: JSON.stringify({
          choice: "enabled",
          expectedConfigurationRevision: 3,
          acknowledgedDisclosureVersion: "teaching-disclosure-v1",
        }),
      }),
    );
  });

  it("surfaces a stale disclosed revision as a 409 without changing the request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            code: "TEACHING_CONFIGURATION_REVISION_CONFLICT",
            message: "设置已更新。",
          },
          409,
        ),
      ),
    );
    await expect(
      prepareConversationTeaching(conversationId, {
        choice: "enabled",
        expectedConfigurationRevision: 3,
        acknowledgedDisclosureVersion: "teaching-disclosure-v1",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "TEACHING_CONFIGURATION_REVISION_CONFLICT",
    });
  });

  it("persists mute before sending the realtime relay control", async () => {
    const order: string[] = [];
    const state = await persistThenMuteTeaching(conversationId, {
      persist: async () => {
        order.push("persist");
        return {
          state: "muted",
          revision: 3,
          canRequest: false,
          canMute: false,
        };
      },
      sendRelayMute: () => order.push("relay"),
      stopOnFailure: () => {
        order.push("stop");
      },
    });
    expect(state.state).toBe("muted");
    expect(order).toEqual(["persist", "relay"]);
  });

  it("never sends WS mute and invokes the fail-safe stop when HTTP persistence fails", async () => {
    const order: string[] = [];
    await expect(
      persistThenMuteTeaching(conversationId, {
        persist: async () => {
          order.push("persist");
          throw new TeachingApiError(503, "TEACHING_MUTE_FAILED");
        },
        sendRelayMute: () => order.push("relay"),
        stopOnFailure: () => {
          order.push("stop");
        },
      }),
    ).rejects.toMatchObject({ code: "TEACHING_MUTE_FAILED" });
    expect(order).toEqual(["persist", "stop"]);
  });
});

const multiplicationDraft = {
  contentRevisionId,
  revision: 1,
  schemaVersion: "generated-teaching-plan-v1",
  compilerVersion: "controlled-teaching-content-v1",
  title: "7 天乘法口诀小计划",
  normalizedGoal: "熟悉 2～5 的乘法口诀",
  subject: "math",
  difficulty: "growing",
  gradeLevel: "grade_2",
  activityCount: 4,
  durationDays: 7,
  activities: [
    multiplicationActivity("two-times-three", 1, 2, 3, "supplies"),
    multiplicationActivity("three-times-four", 2, 3, 4, "energy"),
    multiplicationActivity("four-times-five", 3, 4, 5, "formation"),
    multiplicationActivity("five-times-five", 4, 5, 5, "equipment"),
  ],
  createdAt: "2026-08-15T08:02:00.000Z",
} as const;

const fullLearningPlan = {
  id: "8f1b7f3d-0e1f-4a8d-9967-712f18b2d21b",
  childUserId,
  characterId,
  enabled: true,
  subject: "math",
  difficulty: "growing",
  triggerMode: "on_request",
  gradeLevel: "grade_2",
  learningGoal: "熟悉 2～5 的乘法口诀",
  activityCount: 4,
  durationDays: 7,
  activeContentRevisionId: contentRevisionId,
  activeContentActivatedAt: "2026-08-15T08:03:00.000Z",
  revision: 3,
  createdByUserId: "4d1c2e31-ad0e-4fa9-9ae8-ae3497069116",
  updatedByUserId: "4d1c2e31-ad0e-4fa9-9ae8-ae3497069116",
  createdAt: "2026-08-15T08:00:00.000Z",
  updatedAt: "2026-08-15T08:03:00.000Z",
} as const;

function multiplicationActivity(
  key: string,
  order: number,
  multiplicand: number,
  multiplier: number,
  scenario: "supplies" | "energy" | "formation" | "equipment",
) {
  return {
    kind: "multiplication_fact" as const,
    key,
    order,
    multiplicand,
    multiplier,
    product: multiplicand * multiplier,
    scenario,
  };
}

function generationResponse(status: "queued" | "succeeded", draft: unknown) {
  return {
    generation: {
      id: generationId,
      expectedPlanRevision: 2,
      generatorSource: "controlled_template",
      status,
      errorCode: null,
      contentRevisionId: status === "succeeded" ? contentRevisionId : null,
      requestedAt: "2026-08-15T08:01:00.000Z",
      completedAt: status === "succeeded" ? "2026-08-15T08:02:00.000Z" : null,
    },
    draft,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
