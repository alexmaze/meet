import cookie from "@fastify/cookie";
import type {
  ChildCharacterLearningPlanRecord,
  ConversationTeachingStateRecord,
  TeachingContentBundle,
  TeachingPlanGenerationRequestRecord,
} from "@meet/database";
import {
  hashTeachingLearningGoal,
  validateCompiledTeachingContentItems,
} from "@meet/database";
import {
  modelGeneratedTeachingPlanDraftSchema,
  type GeneratedTeachingPlanDraft,
  type UserAccount,
} from "@meet/protocol";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { AuthError, type AuthService } from "../src/auth/service.js";
import type { AppConfig } from "../src/config.js";
import { registerTeachingRoutes } from "../src/routes/teaching.js";
import type { TeachingRepository } from "../src/teaching/repository.js";
import { TeachingService } from "../src/teaching/service.js";
import {
  ShortPlanGenerator,
  type ShortPlanTextRuntime,
} from "../src/teaching/short-plan-generator.js";

const fixedNow = new Date("2026-08-15T08:00:00.000Z");
const admin = account("4d1c2e31-ad0e-4fa9-9ae8-ae3497069116", "admin");
const adult = account("4d1c2e31-ad0e-4fa9-9ae8-ae3497069117", "adult");
const child = account("4d1c2e31-ad0e-4fa9-9ae8-ae3497069118", "child");
const childUserId = child.id;
const characterId = "c437c71e-f209-4f7d-8f98-1c1e239d4202";
const flashCharacterId = "d437c71e-f209-4f7d-8f98-1c1e239d4202";
const unsupportedCharacterId = "b437c71e-f209-4f7d-8f98-1c1e239d4202";
const unapprovedCharacterId = "a437c71e-f209-4f7d-8f98-1c1e239d4202";
const unavailableCharacterId = "9437c71e-f209-4f7d-8f98-1c1e239d4202";
const conversationId = "9172f06d-c71a-47b3-94fe-35e1204b5b55";
const generationProfileId = "2dd4d817-d1e8-48af-b6bd-9d30e3084cca";
const generationConnectionId = "f5596637-da31-4c14-861d-4e88b994aa76";

const config: AppConfig = {
  server: { host: "127.0.0.1", port: 8787, logLevel: "silent" },
  database: {},
  auth: {
    cookieName: "meet_session",
    cookieSecure: false,
    sessionTtlMs: 30 * 24 * 60 * 60 * 1_000,
    loginMaxAttempts: 10,
    loginWindowMs: 300_000,
  },
  qwen: {
    enabled: false,
    region: "cn-beijing",
    model: "qwen-audio-3.0-realtime-plus",
    voice: "longanqian",
    instructions: "测试",
    requestTimeoutMs: 15_000,
  },
};

describe("teaching routes", () => {
  it("requires login and authorizes roles before parsing management input", async () => {
    const repository = teachingRepository();
    const app = await testApp(repository);

    expect(
      (await app.inject({ method: "GET", url: "/api/teaching/targets" }))
        .statusCode,
    ).toBe(401);
    const childWrite = await injectAs(app, child, {
      method: "PUT",
      url: "/api/teaching/plans/not-a-child/not-a-character",
      payload: { prompt: "should never be parsed as a plan" },
    });
    expect(childWrite.statusCode).toBe(403);
    expect(childWrite.json()).toMatchObject({
      code: "TEACHING_PLAN_MANAGEMENT_FORBIDDEN",
    });
    expect(repository.putChildPlan).not.toHaveBeenCalled();

    const childGeneration = await injectAs(app, child, {
      method: "POST",
      url: "/api/teaching/plans/not-a-child/not-a-character/generations",
      payload: { prompt: "不要解析这段内容" },
    });
    expect(childGeneration.statusCode).toBe(403);
    expect(repository.beginGeneration).not.toHaveBeenCalled();

    const adultAvailability = await injectAs(app, adult, {
      method: "GET",
      url: "/api/teaching/availability/not-a-character",
    });
    expect(adultAvailability.statusCode).toBe(403);
    expect(repository.getChildAvailability).not.toHaveBeenCalled();
    await app.close();
  });

  it("lets active adults and admins manage purpose-limited plans with CAS", async () => {
    const repository = teachingRepository();
    const app = await testApp(repository);

    for (const actor of [adult, admin]) {
      const targets = await injectAs(app, actor, {
        method: "GET",
        url: "/api/teaching/targets",
      });
      expect(targets.statusCode).toBe(200);
      expect(targets.json()).toEqual({
        children: [{ id: childUserId, displayName: "child" }],
        characters: managementTargetCharacters(),
      });
      expect(JSON.stringify(targets.json())).not.toContain("username");
      expect(JSON.stringify(targets.json())).not.toContain("modelProfileId");
      expect(JSON.stringify(targets.json())).not.toContain("connectionId");
      expect(JSON.stringify(targets.json())).not.toContain("revision");
    }

    const response = await injectAs(app, adult, {
      method: "PUT",
      url: `/api/teaching/plans/${childUserId}/${characterId}`,
      payload: {
        expectedRevision: 1,
        enabled: true,
        subject: "english",
        difficulty: "starter",
        triggerMode: "gentle",
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      learningPlan: {
        childUserId,
        characterId,
        revision: 1,
        subject: "english",
      },
    });
    expect(response.json().learningPlan).not.toHaveProperty("lastTriggeredAt");
    expect(response.json().learningPlan).not.toHaveProperty("contentCursor");
    expect(repository.putChildPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: adult.id,
        childUserId,
        characterId,
        expectedRevision: 1,
        updatedAt: fixedNow,
      }),
    );
    await app.close();
  });

  it("allows an unsupported public character plan to be saved without enabling its runtime", async () => {
    const repository = teachingRepository();
    vi.mocked(repository.putChildPlan).mockResolvedValueOnce({
      kind: "created",
      plan: learningPlanRecord({ characterId: unsupportedCharacterId }),
    });
    const app = await testApp(repository);
    const response = await injectAs(app, adult, {
      method: "PUT",
      url: `/api/teaching/plans/${childUserId}/${unsupportedCharacterId}`,
      payload: {
        expectedRevision: null,
        enabled: true,
        subject: "science",
        difficulty: "starter",
        triggerMode: "on_request",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      learningPlan: {
        childUserId,
        characterId: unsupportedCharacterId,
        enabled: true,
      },
    });
    expect(repository.putChildPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: adult.id,
        childUserId,
        characterId: unsupportedCharacterId,
      }),
    );
    await app.close();
  });

  it("maps stale revisions and missing public targets without exposing which check failed", async () => {
    const repository = teachingRepository();
    vi.mocked(repository.putChildPlan)
      .mockResolvedValueOnce({ kind: "revision_conflict" })
      .mockResolvedValueOnce({ kind: "target_not_found" });
    const app = await testApp(repository);
    const request = {
      method: "PUT" as const,
      url: `/api/teaching/plans/${childUserId}/${characterId}`,
      payload: {
        expectedRevision: 1,
        enabled: true,
        subject: "science",
        difficulty: "growing",
        triggerMode: "on_request",
      },
    };

    expect((await injectAs(app, adult, request)).statusCode).toBe(409);
    const notFound = await injectAs(app, adult, request);
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toEqual({
      code: "TEACHING_PLAN_TARGET_NOT_FOUND",
      message: "儿童账号或家庭公共角色不存在。",
    });
    await app.close();
  });

  it("generates, previews, and publishes a finite model-authored plan", async () => {
    const repository = teachingRepository();
    let completedContent: TeachingContentBundle | null = null;
    const queued = generationRecord({ status: "queued" });
    const running = generationRecord({
      status: "running",
      startedAt: fixedNow,
    });
    const snapshot = generationSnapshot();
    vi.mocked(repository.beginGeneration!).mockResolvedValue({
      kind: "queued",
      generation: queued,
      inputSnapshot: snapshot,
    });
    vi.mocked(repository.startGeneration!).mockResolvedValue({
      kind: "started",
      generation: running,
      executionInput: generationExecutionInput(),
    });
    vi.mocked(repository.completeGeneration!).mockImplementation(
      async (input) => {
        expect(input.draft.activities).toHaveLength(4);
        expect(input.draft.activities).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "model_generated_activity",
              activityType: "multiple_choice",
            }),
          ]),
        );
        expect(input.compiledItems).toHaveLength(4);
        expect(
          validateCompiledTeachingContentItems(
            input.draft.activities,
            input.compiledItems,
            input.draft.gradeLevel,
          )?.size,
        ).toBe(4);
        expect(JSON.stringify(input.compiledItems)).not.toContain(
          generationExecutionInput().learningGoal,
        );
        const content = contentBundle(input.draft);
        completedContent = content;
        return {
          kind: "completed" as const,
          generation: generationRecord({
            status: "succeeded",
            outputContentRevisionId: content.revision.id,
            startedAt: fixedNow,
            completedAt: fixedNow,
          }),
          content,
        };
      },
    );
    const resolveTextRuntime = vi.fn(async () => generationTextRuntime());
    const fetchFunction = vi.fn(async () =>
      modelCompletionResponse(modelGenerationOutput()),
    ) as unknown as typeof globalThis.fetch;
    const app = await testApp(
      repository,
      new ShortPlanGenerator({ resolveTextRuntime, fetchFunction }),
    );
    const response = await injectAs(app, adult, {
      method: "POST",
      url: `/api/teaching/plans/${childUserId}/${characterId}/generations`,
      payload: {
        expectedPlanRevision: 1,
        clientRequestId: "f7e8177f-5e33-45fe-8f65-6f4553d221e0",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      generation: {
        status: "succeeded",
        generatorSource: "text_model",
      },
      draft: {
        subject: "math",
        gradeLevel: "grade_2",
        activityCount: 4,
        durationDays: 14,
      },
    });
    expect(JSON.stringify(response.json())).not.toContain("directive");
    expect(JSON.stringify(response.json())).not.toContain("prompt");
    expect(repository.beginGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ generationMode: "text_model" }),
    );
    expect(resolveTextRuntime).toHaveBeenCalledWith({
      modelProfileId: generationProfileId,
      modelProfileRevision: 3,
      connectionId: generationConnectionId,
      connectionRevision: 5,
    });
    expect(fetchFunction).toHaveBeenCalledOnce();

    if (!completedContent) throw new Error("Expected generated content.");
    vi.mocked(repository.getContent!).mockResolvedValueOnce({
      kind: "allowed",
      plan: learningPlanRecord(),
      activeContent: null,
      latestDraft: completedContent,
      progress: null,
      expiresAt: null,
    });
    const preview = await injectAs(app, adult, {
      method: "GET",
      url: `/api/teaching/plans/${childUserId}/${characterId}/content`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      activeContent: null,
      latestDraft: { subject: "math", durationDays: 14 },
    });

    vi.mocked(repository.publishContent!).mockResolvedValueOnce({
      kind: "published",
      plan: learningPlanRecord({
        revision: 2,
        activeContentRevisionId: completedContent.revision.id,
        activeContentActivatedAt: fixedNow,
      }),
      content: completedContent,
    });
    const published = await injectAs(app, adult, {
      method: "POST",
      url: `/api/teaching/plans/${childUserId}/${characterId}/content/publish`,
      payload: {
        expectedPlanRevision: 1,
        contentRevisionId: completedContent.revision.id,
        reviewConfirmed: true,
      },
    });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({
      learningPlan: {
        revision: 2,
        activeContentRevisionId: completedContent.revision.id,
      },
      activeContent: { subject: "math", activityCount: 4 },
    });
    await app.close();
  });

  it("rejects legacy generation modes and reports a missing text binding explicitly", async () => {
    const repository = teachingRepository();
    vi.mocked(repository.beginGeneration!).mockResolvedValue({
      kind: "generator_not_configured",
    });
    const app = await testApp(repository);
    const request = {
      method: "POST" as const,
      url: `/api/teaching/plans/${childUserId}/${characterId}/generations`,
      payload: {
        expectedPlanRevision: 1,
        clientRequestId: "8fb99621-feb0-4a2e-87cb-833dfc22cb2b",
      },
    };

    const legacy = await injectAs(app, adult, {
      ...request,
      payload: { ...request.payload, generationMode: "auto" },
    });
    expect(legacy.statusCode).toBe(400);
    expect(repository.beginGeneration).not.toHaveBeenCalled();

    const unavailable = await injectAs(app, adult, request);
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.json()).toEqual({
      code: "TEACHING_PLAN_GENERATOR_NOT_CONFIGURED",
      message: "短期计划生成模型尚未配置，请先由管理员绑定并验证文本模型。",
    });
    expect(repository.beginGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ generationMode: "text_model" }),
    );
    expect(repository.startGeneration).not.toHaveBeenCalled();
    await app.close();
  });

  it("shows the same safe child summary for approved Plus and Flash targets", async () => {
    const repository = teachingRepository();
    const app = await testApp(repository);
    for (const targetCharacterId of [characterId, flashCharacterId]) {
      const response = await injectAs(app, child, {
        method: "GET",
        url: `/api/teaching/availability/${targetCharacterId}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        teaching: {
          enabled: true,
          providerCapability: "dynamic_instructions_next_safe_turn",
          subject: "english",
          difficulty: "starter",
          triggerMode: "gentle",
          disclosureVersion: "teaching-disclosure-v1",
          configurationRevision: 1,
        },
      });
      expect(JSON.stringify(response.json())).not.toContain("revision");
      expect(JSON.stringify(response.json())).not.toContain(adult.id);
    }
    await app.close();
  });

  it("keeps a saved unsupported character plan unavailable to the child runtime", async () => {
    const repository = teachingRepository();
    vi.mocked(repository.getChildAvailability).mockResolvedValueOnce({
      kind: "unavailable",
      reason: "provider_unsupported",
    });
    const app = await testApp(repository);
    const response = await injectAs(app, child, {
      method: "GET",
      url: `/api/teaching/availability/${unsupportedCharacterId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      teaching: { enabled: false, reason: "provider_unsupported" },
    });
    await app.close();
  });

  it("lets only the child prepare or mute an owned conversation with safe state", async () => {
    const repository = teachingRepository();
    const app = await testApp(repository);
    const prepared = await injectAs(app, child, {
      method: "POST",
      url: `/api/conversations/${conversationId}/teaching/prepare`,
      payload: {
        choice: "enabled",
        expectedConfigurationRevision: 1,
        acknowledgedDisclosureVersion: "teaching-disclosure-v1",
      },
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json()).toEqual({
      teaching: {
        state: "available",
        revision: 1,
        canRequest: true,
        canMute: true,
      },
    });
    expect(repository.prepareConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        choice: "enabled",
        expectedConfigurationRevision: 1,
        acknowledgedDisclosureVersion: "teaching-disclosure-v1",
      }),
    );

    const chatOnly = await injectAs(app, child, {
      method: "POST",
      url: `/api/conversations/${conversationId}/teaching/prepare`,
      payload: { choice: "chat_only" },
    });
    expect(chatOnly.json()).toEqual({
      teaching: {
        state: "muted",
        revision: 2,
        canRequest: false,
        canMute: false,
      },
    });

    const muted = await injectAs(app, child, {
      method: "POST",
      url: `/api/conversations/${conversationId}/teaching/mute`,
      payload: {},
    });
    expect(muted.statusCode).toBe(200);
    expect(muted.json().teaching).toMatchObject({
      state: "muted",
      canRequest: false,
      canMute: false,
    });
    expect(
      (
        await injectAs(app, child, {
          method: "POST",
          url: `/api/conversations/${conversationId}/teaching/mute`,
          payload: { reason: "hidden" },
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });

  it("exposes atomic runtime callbacks without adding event-read APIs", async () => {
    const repository = teachingRepository();
    const service = new TeachingService(repository, () => fixedNow);
    await service.recordValidTurn(conversationId);
    await service.claimInvitation({
      conversationId,
      subject: "science",
      explicitRequest: false,
    });
    await service.markRestoring(conversationId, 2);
    await service.markCompleted(conversationId, 3);
    await service.recoverForReconnect(conversationId);
    await service.loadRuntimeForReconnect(conversationId);

    expect(repository.recordValidTurn).toHaveBeenCalledWith({
      conversationId,
      recordedAt: fixedNow,
    });
    expect(repository.claimInvitation).toHaveBeenCalledWith({
      conversationId,
      contentItemIds: ["science-space-gravity-v1"],
      expectedSubject: "science",
      explicitRequest: false,
      claimedAt: fixedNow,
    });
    expect(repository.recoverForReconnect).toHaveBeenCalledWith({
      conversationId,
      recoveredAt: fixedNow,
    });
    expect(repository.loadRuntimeForReconnect).toHaveBeenCalledWith({
      conversationId,
      loadedAt: fixedNow,
    });
  });

  it.each(["chinese", "general"] as const)(
    "uses only published generated content for the %s subject",
    async (subject) => {
      const repository = teachingRepository();
      vi.mocked(repository.claimInvitation).mockResolvedValue({
        kind: "claimed",
        state: teachingState("active", 2),
        contentCursor: 1,
        contentItemId: "f9cc27c1-0525-4502-a36f-090bcb554031",
        compiledDirective: "canonical generated directive",
        maximumAssistantResponses: 2,
      });
      const service = new TeachingService(repository, () => fixedNow);

      const result = await service.claimInvitation({
        conversationId,
        subject,
        explicitRequest: true,
      });

      expect(repository.claimInvitation).toHaveBeenCalledWith({
        conversationId,
        contentItemIds: [],
        expectedSubject: subject,
        explicitRequest: true,
        claimedAt: fixedNow,
      });
      expect(result).toMatchObject({
        kind: "claimed",
        compiledDirective: "canonical generated directive",
      });
    },
  );

  it("returns 409 when the disclosed configuration changes before prepare", async () => {
    const repository = teachingRepository();
    vi.mocked(repository.prepareConversation).mockResolvedValue({
      kind: "revision_conflict",
    });
    const app = await testApp(repository);
    const missingDisclosure = await injectAs(app, child, {
      method: "POST",
      url: `/api/conversations/${conversationId}/teaching/prepare`,
      payload: { choice: "enabled", expectedConfigurationRevision: 1 },
    });
    expect(missingDisclosure.statusCode).toBe(400);
    const invalidDisclosure = await injectAs(app, child, {
      method: "POST",
      url: `/api/conversations/${conversationId}/teaching/prepare`,
      payload: {
        choice: "enabled",
        expectedConfigurationRevision: 1,
        acknowledgedDisclosureVersion: "teaching-disclosure-v0",
      },
    });
    expect(invalidDisclosure.statusCode).toBe(400);
    expect(repository.prepareConversation).not.toHaveBeenCalled();
    const response = await injectAs(app, child, {
      method: "POST",
      url: `/api/conversations/${conversationId}/teaching/prepare`,
      payload: {
        choice: "enabled",
        expectedConfigurationRevision: 1,
        acknowledgedDisclosureVersion: "teaching-disclosure-v1",
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: "TEACHING_CONFIGURATION_REVISION_CONFLICT",
      message: "教学计划刚刚发生变化，请重新查看说明后再选择。",
    });
    await app.close();
  });
});

async function testApp(
  repository: TeachingRepository,
  shortPlanGenerator?: ShortPlanGenerator,
) {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  const users = new Map([
    [admin.username, admin],
    [adult.username, adult],
    [child.username, child],
  ]);
  const auth = {
    async authenticate(token: string | undefined) {
      const actor = token ? users.get(token) : undefined;
      if (!actor) {
        throw new AuthError("AUTHENTICATION_REQUIRED", "请先登录。", 401);
      }
      return actor;
    },
  } as unknown as AuthService;
  await registerTeachingRoutes(
    app,
    config,
    auth,
    new TeachingService(repository, () => fixedNow, shortPlanGenerator),
  );
  return app;
}

function injectAs(
  app: Awaited<ReturnType<typeof testApp>>,
  actor: UserAccount,
  options: Parameters<typeof app.inject>[0],
) {
  const headers = {
    ...(typeof options === "object" && "headers" in options
      ? options.headers
      : {}),
    cookie: `meet_session=${actor.username}`,
  };
  return app.inject({ ...options, headers });
}

function teachingRepository(): TeachingRepository {
  const plan = learningPlanRecord();
  return {
    listManagementTargets: vi.fn(async () => ({
      kind: "allowed" as const,
      targets: {
        children: [{ id: childUserId, displayName: "child" }],
        characters: managementTargetCharacters(),
      },
    })),
    listChildPlans: vi.fn(async () => ({
      kind: "allowed" as const,
      plans: [plan],
    })),
    putChildPlan: vi.fn(async () => ({ kind: "updated" as const, plan })),
    beginGeneration: vi.fn(async () => ({ kind: "not_found" as const })),
    startGeneration: vi.fn(async () => ({ kind: "not_found" as const })),
    completeGeneration: vi.fn(async () => ({ kind: "not_found" as const })),
    failGeneration: vi.fn(async () => ({ kind: "not_found" as const })),
    getGeneration: vi.fn(async () => ({ kind: "not_found" as const })),
    getContent: vi.fn(async () => ({ kind: "not_found" as const })),
    publishContent: vi.fn(async () => ({ kind: "not_found" as const })),
    getChildAvailability: vi.fn(async () => ({
      kind: "available" as const,
      plan: {
        subject: "english" as const,
        difficulty: "starter" as const,
        triggerMode: "gentle" as const,
        revision: 1,
      },
    })),
    prepareConversation: vi.fn(async (input) => ({
      kind:
        input.choice === "chat_only"
          ? ("muted" as const)
          : ("created" as const),
      state:
        input.choice === "chat_only"
          ? teachingState("muted", 2)
          : teachingState("available", 1),
    })),
    muteConversation: vi.fn(async () => ({
      kind: "muted" as const,
      state: teachingState("muted", 2),
    })),
    recordValidTurn: vi.fn(async () => ({
      kind: "recorded" as const,
      validUserTurns: 6,
    })),
    claimInvitation: vi.fn(async () => ({
      kind: "claimed" as const,
      state: teachingState("active", 2),
      contentCursor: 1,
      contentItemId: "english-space-orbit-v1",
      compiledDirective: null,
      maximumAssistantResponses: 2 as const,
    })),
    markRestoring: vi.fn(async () => ({
      kind: "transitioned" as const,
      state: teachingState("restoring", 3),
    })),
    markCompleted: vi.fn(async () => ({
      kind: "transitioned" as const,
      state: teachingState("completed", 4),
    })),
    recoverForReconnect: vi.fn(async () => ({
      kind: "recovered" as const,
      state: teachingState("completed", 4),
    })),
    loadRuntimeForReconnect: vi.fn(async () => ({
      kind: "loaded" as const,
      state: teachingState("available", 1),
      conversationStartedAt: fixedNow,
      provider: "qwen",
      model: "qwen-audio-3.0-realtime-plus",
    })),
  };
}

function learningPlanRecord(
  overrides: Partial<ChildCharacterLearningPlanRecord> = {},
): ChildCharacterLearningPlanRecord {
  return {
    id: "8f1b7f3d-0e1f-4a8d-9967-712f18b2d21b",
    childUserId,
    characterId,
    enabled: true,
    subject: "english",
    difficulty: "starter",
    triggerMode: "gentle",
    gradeLevel: "unspecified",
    learningGoal: null,
    activityCount: 4,
    durationDays: 7,
    activeContentRevisionId: null,
    activeContentActivatedAt: null,
    lastTriggeredAt: null,
    contentCursor: 0,
    revision: 1,
    createdByUserId: adult.id,
    updatedByUserId: adult.id,
    createdAt: fixedNow,
    updatedAt: fixedNow,
    ...overrides,
  };
}

function generationSnapshot() {
  return {
    schemaVersion: "teaching-plan-generation-input-v3" as const,
    generationMode: "text_model" as const,
    generatorSource: "text_model" as const,
    subject: "math" as const,
    difficulty: "starter" as const,
    gradeLevel: "grade_2" as const,
    goalHash: hashTeachingLearningGoal("练习 2～5 的乘法口诀"),
    activityCount: 4,
    durationDays: 14 as const,
  };
}

function generationExecutionInput() {
  return {
    generationMode: "text_model" as const,
    generatorSource: "text_model" as const,
    subject: "math" as const,
    difficulty: "starter" as const,
    gradeLevel: "grade_2" as const,
    learningGoal: "练习 2～5 的乘法口诀",
    activityCount: 4,
    durationDays: 14 as const,
  };
}

function generationRecord(
  overrides: Partial<TeachingPlanGenerationRequestRecord> = {},
): TeachingPlanGenerationRequestRecord {
  return {
    id: "e76ff2d4-9dc2-4205-a406-bc2890938c13",
    learningPlanId: learningPlanRecord().id,
    clientRequestId: "f7e8177f-5e33-45fe-8f65-6f4553d221e0",
    expectedPlanRevision: 1,
    generationMode: "text_model",
    generatorSource: "text_model",
    status: "queued",
    inputSnapshot: generationSnapshot(),
    inputHash: "a".repeat(64),
    modelProfileId: generationProfileId,
    modelProfileRevision: 3,
    connectionId: generationConnectionId,
    connectionRevision: 5,
    outputContentRevisionId: null,
    actualModel: null,
    inputTokens: null,
    outputTokens: null,
    errorCode: null,
    requestedByUserId: adult.id,
    requestedAt: fixedNow,
    startedAt: null,
    completedAt: null,
    updatedAt: fixedNow,
    ...overrides,
  };
}

function modelGenerationDraft() {
  return modelGeneratedTeachingPlanDraftSchema.parse({
    schemaVersion: "generated-teaching-plan-v2",
    compilerVersion: "model-generated-teaching-content-v2",
    title: "乘法口诀四步学习计划",
    normalizedGoal: "理解并练习 2 到 5 范围内的基础乘法事实。",
    subject: "math",
    difficulty: "starter",
    gradeLevel: "grade_2",
    activityCount: 4,
    durationDays: 14,
    activities: [
      {
        kind: "model_generated_activity",
        key: "groups-and-counts",
        order: 1,
        title: "认识相同小组",
        objective: "理解乘法表示若干个相同数量的小组。",
        knowledgeSource: "model_only",
        activityType: "explain_and_reflect",
        teachingText:
          "三个小组每组有两个物品，一共有六个物品，可以写成三乘二等于六。",
        reflectionPrompt: "你能说说三乘二里的三表示什么吗？",
        exampleResponse: "表示有三个相同的小组。",
        feedbackText: "先看有几个小组，再看每组有几个物品。",
      },
      {
        kind: "model_generated_activity",
        key: "two-times-four",
        order: 2,
        title: "选择正确结果",
        objective: "练习二乘四的乘法事实。",
        knowledgeSource: "model_only",
        activityType: "multiple_choice",
        questionText: "二乘四等于多少？",
        choices: [
          { id: "a", text: "六" },
          { id: "b", text: "八" },
          { id: "c", text: "十" },
        ],
        correctChoiceId: "b",
        answerExplanation: "两个四相加是八，所以二乘四等于八。",
        hintText: "可以把四加两次。",
      },
      {
        kind: "model_generated_activity",
        key: "three-times-four",
        order: 3,
        title: "说出乘法答案",
        objective: "练习三乘四的乘法事实。",
        knowledgeSource: "model_only",
        activityType: "short_answer",
        questionText: "三乘四等于多少？",
        acceptedAnswers: ["十二", "12"],
        answerExplanation: "三个四相加是十二。",
        hintText: "从四开始连续加三次。",
      },
      {
        kind: "model_generated_activity",
        key: "five-times-two",
        order: 4,
        title: "完成最后一题",
        objective: "练习五乘二的乘法事实。",
        knowledgeSource: "model_only",
        activityType: "multiple_choice",
        questionText: "五乘二等于多少？",
        choices: [
          { id: "a", text: "七" },
          { id: "b", text: "十" },
          { id: "c", text: "十二" },
        ],
        correctChoiceId: "b",
        answerExplanation: "五个二相加是十。",
        hintText: "数一数五组两个。",
      },
    ],
  });
}

function modelGenerationOutput() {
  const draft = modelGenerationDraft();
  return {
    kind: "plan" as const,
    title: draft.title,
    normalizedGoal: draft.normalizedGoal,
    activities: draft.activities,
  };
}

function generationTextRuntime(): ShortPlanTextRuntime {
  return {
    profile: {
      id: generationProfileId,
      connectionId: generationConnectionId,
      revision: 3,
      kind: "text",
      status: "enabled",
      verifiedAt: fixedNow,
      model: "qwen-flash",
    },
    connection: {
      id: generationConnectionId,
      revision: 5,
      adapter: "openai_chat_completions",
      status: "enabled",
      verifiedAt: fixedNow,
      endpoint: "https://models.example.test/v1",
      apiKey: "private-test-key",
      compatibilityPreset: "dashscope",
    },
  };
}

function modelCompletionResponse(draft: unknown): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-teaching-test",
      object: "chat.completion",
      created: 1_787_000_000,
      model: "qwen-flash",
      system_fingerprint: null,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: JSON.stringify(draft) },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 80, completion_tokens: 240, total_tokens: 320 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function contentBundle(
  draft: GeneratedTeachingPlanDraft,
): TeachingContentBundle {
  const contentRevisionId = "ae26d42e-310f-4dc7-b7c8-f02c8526d971";
  const itemIds = [
    "14b02570-44eb-4ae2-9ea4-b19fa3a99901",
    "14b02570-44eb-4ae2-9ea4-b19fa3a99902",
    "14b02570-44eb-4ae2-9ea4-b19fa3a99903",
    "14b02570-44eb-4ae2-9ea4-b19fa3a99904",
    "14b02570-44eb-4ae2-9ea4-b19fa3a99905",
    "14b02570-44eb-4ae2-9ea4-b19fa3a99906",
    "14b02570-44eb-4ae2-9ea4-b19fa3a99907",
    "14b02570-44eb-4ae2-9ea4-b19fa3a99908",
  ];
  return {
    revision: {
      id: contentRevisionId,
      learningPlanId: learningPlanRecord().id,
      revision: 1,
      generationRequestId: generationRecord().id,
      schemaVersion: draft.schemaVersion,
      compilerVersion: draft.compilerVersion,
      title: draft.title,
      normalizedGoal: draft.normalizedGoal,
      subject: draft.subject,
      difficulty: draft.difficulty,
      gradeLevel: draft.gradeLevel,
      activityCount: draft.activityCount,
      durationDays: draft.durationDays,
      contentHash: "b".repeat(64),
      createdByUserId: adult.id,
      createdAt: fixedNow,
    },
    items: draft.activities.map((activity, index) => ({
      id: itemIds[index]!,
      contentRevisionId,
      itemKey: activity.key,
      position: activity.order,
      kind: activity.kind,
      structuredContent: activity,
      compiledDirective: `controlled-${activity.key}`,
      directiveHash: "c".repeat(64),
      maximumAssistantResponses: 2,
      createdAt: fixedNow,
    })),
  };
}

function managementTargetCharacters() {
  return [
    {
      id: characterId,
      name: "奥特曼 Plus",
      teachingAvailability: { available: true as const },
    },
    {
      id: flashCharacterId,
      name: "奥特曼 Flash",
      teachingAvailability: { available: true as const },
    },
    {
      id: unsupportedCharacterId,
      name: "豆包伙伴",
      teachingAvailability: {
        available: false as const,
        reason: "provider_unsupported" as const,
      },
    },
    {
      id: unapprovedCharacterId,
      name: "未批准的千问角色",
      teachingAvailability: {
        available: false as const,
        reason: "configuration_not_approved" as const,
      },
    },
    {
      id: unavailableCharacterId,
      name: "尚未配置好的角色",
      teachingAvailability: {
        available: false as const,
        reason: "realtime_unavailable" as const,
      },
    },
  ];
}

function teachingState(
  state: ConversationTeachingStateRecord["state"],
  revision: number,
): ConversationTeachingStateRecord {
  const hasPlan = state !== "unavailable";
  const muted = state === "muted";
  const hasActiveItem = state === "active" || state === "restoring";
  return {
    conversationId,
    learningPlanId: hasPlan ? learningPlanRecord().id : null,
    learningPlanRevision: hasPlan ? 1 : null,
    subject: hasPlan ? "english" : null,
    difficulty: hasPlan ? "starter" : null,
    triggerMode: hasPlan ? "gentle" : null,
    disclosureVersion: hasPlan ? "teaching-disclosure-v1" : null,
    contentRevisionId: null,
    contentCatalogVersion: hasPlan ? "reviewed-v1" : null,
    state,
    muteReason: muted ? "child_request" : null,
    validUserTurns: 6,
    invitationCount: hasActiveItem || state === "completed" ? 1 : 0,
    activeContentItemId: hasActiveItem ? "science-001" : null,
    revision,
    preparedAt: fixedNow,
    updatedAt: fixedNow,
  };
}

function account(
  id: string,
  accountType: "admin" | "adult" | "child",
): UserAccount {
  return {
    id,
    username: accountType,
    displayName: accountType,
    accountType,
    status: "active",
    guardianHistoryAccess: accountType === "child" ? "allowed" : null,
    createdAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
  };
}
