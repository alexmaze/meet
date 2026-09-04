import type {
  ClaimTeachingInvitationResult,
  ChildCharacterLearningPlanRecord,
  TeachingContentBundle,
  TeachingPlanGenerationRequestRecord,
  LoadTeachingRuntimeResult,
  RecordValidTeachingTurnResult,
  RecoverTeachingRuntimeResult,
  TransitionTeachingDirectiveResult,
} from "@meet/database";
import { compileDeterministicTeachingContentItem } from "@meet/database";
import {
  childCharacterLearningPlanSchema,
  childTeachingAvailabilitySchema,
  learningPlanContentResponseSchema,
  learningPlanGenerationResponseSchema,
  learningPlanTargetsResponseSchema,
  publishLearningPlanContentResponseSchema,
  safeRelayTeachingStateSchema,
  TEACHING_DISCLOSURE_VERSION,
  type ChildCharacterLearningPlan,
  type ChildTeachingAvailability,
  type LearningPlanContentResponse,
  type LearningPlanGenerationResponse,
  type LearningPlanTargetsResponse,
  type PrepareConversationTeachingRequest,
  type PutLearningPlanRequest,
  type PublishLearningPlanContentRequest,
  type PublishLearningPlanContentResponse,
  type RequestLearningPlanGeneration,
  type SafeRelayTeachingState,
  type TeachingSubject,
  type UserAccount,
} from "@meet/protocol";

import type { TeachingRepository } from "./repository.js";
import {
  findQwenControlledTeachingContentForSubject,
  QWEN_CONTROLLED_TEACHING_CONTENT_IDS,
} from "./content-catalog.js";
import {
  ShortPlanGenerator,
  type PinnedShortPlanGeneration,
} from "./short-plan-generator.js";

export type TeachingServiceErrorCode =
  | "TEACHING_PLAN_MANAGEMENT_FORBIDDEN"
  | "TEACHING_CHILD_ACCESS_FORBIDDEN"
  | "TEACHING_PLAN_TARGET_NOT_FOUND"
  | "TEACHING_PLAN_REVISION_CONFLICT"
  | "TEACHING_CONFIGURATION_REVISION_CONFLICT"
  | "TEACHING_PLAN_GENERATION_CONFLICT"
  | "TEACHING_PLAN_GENERATION_NOT_FOUND"
  | "TEACHING_PLAN_GENERATION_UNSUPPORTED"
  | "TEACHING_PLAN_GENERATOR_NOT_CONFIGURED"
  | "TEACHING_PLAN_CONTENT_CONFLICT"
  | "TEACHING_CONVERSATION_NOT_FOUND"
  | "TEACHING_SERVICE_UNAVAILABLE";

export class TeachingServiceError extends Error {
  constructor(
    readonly code: TeachingServiceErrorCode,
    message: string,
    readonly statusCode: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TeachingServiceError";
  }
}

export class TeachingService {
  constructor(
    private readonly repository: TeachingRepository | null,
    private readonly now: () => Date = () => new Date(),
    private readonly shortPlanGenerator: ShortPlanGenerator = new ShortPlanGenerator(
      { resolveTextRuntime: async () => null },
    ),
  ) {}

  assertPlanManager(actor: UserAccount): void {
    if (actor.accountType !== "adult" && actor.accountType !== "admin") {
      throw new TeachingServiceError(
        "TEACHING_PLAN_MANAGEMENT_FORBIDDEN",
        "儿童账号不能配置教学计划。",
        403,
      );
    }
  }

  assertChild(actor: UserAccount): void {
    if (actor.accountType !== "child") {
      throw new TeachingServiceError(
        "TEACHING_CHILD_ACCESS_FORBIDDEN",
        "只有儿童本人可以查看或控制自己的教学支线。",
        403,
      );
    }
  }

  async listManagementTargets(
    actor: UserAccount,
  ): Promise<LearningPlanTargetsResponse> {
    this.assertPlanManager(actor);
    const result = await this.call((repository) =>
      repository.listManagementTargets(actor.id),
    );
    if (result.kind === "forbidden") throw planManagementForbidden();
    return learningPlanTargetsResponseSchema.parse(result.targets);
  }

  async listPlans(
    actor: UserAccount,
    childUserId: string,
  ): Promise<ChildCharacterLearningPlan[]> {
    this.assertPlanManager(actor);
    const result = await this.call((repository) =>
      repository.listChildPlans({ actorUserId: actor.id, childUserId }),
    );
    if (!("plans" in result)) {
      if (result.kind === "forbidden") throw planManagementForbidden();
      throw planTargetNotFound();
    }
    return result.plans.map(toPublicPlan);
  }

  async putPlan(
    actor: UserAccount,
    childUserId: string,
    characterId: string,
    input: PutLearningPlanRequest,
  ): Promise<ChildCharacterLearningPlan> {
    this.assertPlanManager(actor);
    const result = await this.call((repository) =>
      repository.putChildPlan({
        actorUserId: actor.id,
        childUserId,
        characterId,
        ...input,
        updatedAt: this.now(),
      }),
    );
    if (!("plan" in result)) {
      if (result.kind === "forbidden") throw planManagementForbidden();
      if (result.kind === "target_not_found") throw planTargetNotFound();
      throw new TeachingServiceError(
        "TEACHING_PLAN_REVISION_CONFLICT",
        "教学计划已被其他操作更新，请刷新后重试。",
        409,
      );
    }
    return toPublicPlan(result.plan);
  }

  async requestGeneration(
    actor: UserAccount,
    childUserId: string,
    characterId: string,
    input: RequestLearningPlanGeneration,
  ): Promise<LearningPlanGenerationResponse> {
    this.assertPlanManager(actor);
    const result = await this.call(async (repository) => {
      if (!repository.beginGeneration) throw generationUnavailable();
      return repository.beginGeneration({
        actorUserId: actor.id,
        childUserId,
        characterId,
        ...input,
        generationMode: "text_model",
        requestedAt: this.now(),
      });
    });
    if (!("generation" in result)) {
      throw mapGenerationRequestError(result.kind);
    }

    if (result.kind === "existing" && result.generation.status !== "queued") {
      return this.loadGeneration(
        actor,
        childUserId,
        characterId,
        result.generation.id,
      );
    }

    const started = await this.call(async (repository) => {
      if (!repository.startGeneration) throw generationUnavailable();
      return repository.startGeneration({
        generationId: result.generation.id,
        startedAt: this.now(),
      });
    });
    if (
      started.kind === "configuration_changed" ||
      started.kind === "superseded" ||
      started.kind === "invalid_input"
    ) {
      return toGenerationResponse(started.generation, null);
    }
    if (started.kind !== "started") {
      if (started.kind === "existing") {
        return this.loadGeneration(
          actor,
          childUserId,
          characterId,
          started.generation.id,
        );
      }
      throw generationConflict();
    }

    const pinned = toPinnedGeneration(started.generation);
    if (!pinned) {
      return this.persistGenerationFailure(
        actor,
        childUserId,
        characterId,
        started.generation.id,
        "model_configuration_changed",
      );
    }
    const prepared = await this.shortPlanGenerator.preparePinned(
      {
        generationMode: started.executionInput.generationMode,
        subject: started.executionInput.subject,
        difficulty: started.executionInput.difficulty,
        gradeLevel: started.executionInput.gradeLevel,
        learningGoal: started.executionInput.learningGoal,
        activityCount: started.executionInput.activityCount,
        durationDays: started.executionInput.durationDays,
      },
      pinned,
    );
    if (prepared.kind === "failed") {
      return this.persistGenerationFailure(
        actor,
        childUserId,
        characterId,
        started.generation.id,
        prepared.errorCode,
      );
    }

    let generated: Awaited<ReturnType<typeof prepared.execute>>;
    try {
      generated = await prepared.execute();
    } catch {
      return this.persistGenerationFailure(
        actor,
        childUserId,
        characterId,
        started.generation.id,
        "model_result_unknown",
      );
    }
    if (generated.kind === "failed") {
      return this.persistGenerationFailure(
        actor,
        childUserId,
        characterId,
        started.generation.id,
        generated.errorCode,
      );
    }

    let compiledItems;
    try {
      compiledItems = generated.draft.activities.map((activity) =>
        compileDeterministicTeachingContentItem(
          activity,
          generated.draft.gradeLevel,
        ),
      );
    } catch {
      return this.persistGenerationFailure(
        actor,
        childUserId,
        characterId,
        started.generation.id,
        "content_compilation_failed",
      );
    }
    const completed = await this.call(async (repository) => {
      if (!repository.completeGeneration) throw generationUnavailable();
      return repository.completeGeneration({
        generationId: started.generation.id,
        draft: generated.draft,
        compiledItems,
        actualModel: generated.actualModel,
        inputTokens: generated.usage.inputTokens,
        outputTokens: generated.usage.outputTokens,
        completedAt: this.now(),
      });
    });
    if ("content" in completed) {
      return toGenerationResponse(completed.generation, completed.content);
    }
    if ("generation" in completed) {
      return toGenerationResponse(completed.generation, null);
    }
    throw generationConflict();
  }

  async loadGeneration(
    actor: UserAccount,
    childUserId: string,
    characterId: string,
    generationId: string,
  ): Promise<LearningPlanGenerationResponse> {
    this.assertPlanManager(actor);
    const result = await this.call(async (repository) => {
      if (!repository.getGeneration) throw generationUnavailable();
      return repository.getGeneration({
        actorUserId: actor.id,
        childUserId,
        characterId,
        generationId,
      });
    });
    if (!("generation" in result)) {
      if (result.kind === "forbidden") throw planManagementForbidden();
      throw generationNotFound();
    }
    return toGenerationResponse(result.generation, result.content);
  }

  async getContent(
    actor: UserAccount,
    childUserId: string,
    characterId: string,
  ): Promise<LearningPlanContentResponse> {
    this.assertPlanManager(actor);
    const result = await this.call(async (repository) => {
      if (!repository.getContent) throw generationUnavailable();
      return repository.getContent({
        actorUserId: actor.id,
        childUserId,
        characterId,
        now: this.now(),
      });
    });
    if (!("activeContent" in result)) {
      if (result.kind === "forbidden") throw planManagementForbidden();
      throw planTargetNotFound();
    }
    return learningPlanContentResponseSchema.parse({
      activeContent: result.activeContent
        ? toContentRevision(result.activeContent)
        : null,
      latestDraft: result.latestDraft
        ? toContentRevision(result.latestDraft)
        : null,
      progress: result.progress,
      expiresAt: result.expiresAt?.toISOString() ?? null,
    });
  }

  async publishContent(
    actor: UserAccount,
    childUserId: string,
    characterId: string,
    input: PublishLearningPlanContentRequest,
  ): Promise<PublishLearningPlanContentResponse> {
    this.assertPlanManager(actor);
    const result = await this.call(async (repository) => {
      if (!repository.publishContent) throw generationUnavailable();
      return repository.publishContent({
        actorUserId: actor.id,
        childUserId,
        characterId,
        ...input,
        publishedAt: this.now(),
      });
    });
    if (!("content" in result)) {
      if (result.kind === "forbidden") throw planManagementForbidden();
      if (result.kind === "not_found") throw planTargetNotFound();
      throw contentConflict();
    }
    return publishLearningPlanContentResponseSchema.parse({
      learningPlan: toPublicPlan(result.plan),
      activeContent: toContentRevision(result.content),
    });
  }

  private async persistGenerationFailure(
    actor: UserAccount,
    childUserId: string,
    characterId: string,
    generationId: string,
    errorCode: Parameters<
      NonNullable<TeachingRepository["failGeneration"]>
    >[0]["errorCode"],
  ): Promise<LearningPlanGenerationResponse> {
    await this.call(async (repository) => {
      if (!repository.failGeneration) throw generationUnavailable();
      const result = await repository.failGeneration({
        generationId,
        errorCode,
        failedAt: this.now(),
      });
      if (!("generation" in result)) throw generationConflict();
      return result;
    });
    return this.loadGeneration(actor, childUserId, characterId, generationId);
  }

  async availability(
    actor: UserAccount,
    characterId: string,
  ): Promise<ChildTeachingAvailability> {
    this.assertChild(actor);
    const result = await this.call((repository) =>
      repository.getChildAvailability({
        actorUserId: actor.id,
        characterId,
      }),
    );
    if (result.kind === "forbidden") throw childAccessForbidden();
    if (result.kind === "unavailable") {
      return childTeachingAvailabilitySchema.parse({
        enabled: false,
        reason: result.reason,
      });
    }
    return childTeachingAvailabilitySchema.parse({
      enabled: true,
      providerCapability: "dynamic_instructions_next_safe_turn",
      subject: result.plan.subject,
      difficulty: result.plan.difficulty,
      triggerMode: result.plan.triggerMode,
      disclosureVersion: TEACHING_DISCLOSURE_VERSION,
      configurationRevision: result.plan.revision,
    });
  }

  async prepareConversation(
    actor: UserAccount,
    conversationId: string,
    input: PrepareConversationTeachingRequest,
  ): Promise<SafeRelayTeachingState> {
    this.assertChild(actor);
    const result = await this.call((repository) =>
      repository.prepareConversation({
        actorUserId: actor.id,
        conversationId,
        ...input,
        preparedAt: this.now(),
      }),
    );
    if (!("state" in result)) {
      if (result.kind === "forbidden") throw childAccessForbidden();
      if (result.kind === "revision_conflict") {
        throw configurationRevisionConflict();
      }
      throw conversationNotFound();
    }
    return toSafeState(result.state);
  }

  async muteConversation(
    actor: UserAccount,
    conversationId: string,
  ): Promise<SafeRelayTeachingState> {
    this.assertChild(actor);
    const result = await this.call((repository) =>
      repository.muteConversation({
        actorUserId: actor.id,
        conversationId,
        mutedAt: this.now(),
      }),
    );
    if (!("state" in result)) {
      if (result.kind === "forbidden") throw childAccessForbidden();
      throw conversationNotFound();
    }
    return toSafeState(result.state);
  }

  recordValidTurn(
    conversationId: string,
  ): Promise<RecordValidTeachingTurnResult> {
    return this.call((repository) =>
      repository.recordValidTurn({
        conversationId,
        recordedAt: this.now(),
      }),
    );
  }

  async claimInvitation(input: {
    conversationId: string;
    subject: TeachingSubject;
    explicitRequest: boolean;
  }): Promise<ClaimTeachingInvitationResult> {
    const contentItemIds =
      input.subject === "chinese" || input.subject === "general"
        ? []
        : QWEN_CONTROLLED_TEACHING_CONTENT_IDS.filter((id) =>
            findQwenControlledTeachingContentForSubject(id, input.subject),
          );
    const result = await this.call((repository) =>
      repository.claimInvitation({
        conversationId: input.conversationId,
        contentItemIds,
        expectedSubject: input.subject,
        explicitRequest: input.explicitRequest,
        claimedAt: this.now(),
      }),
    );
    if (result.kind !== "claimed" || result.compiledDirective !== null) {
      return result;
    }
    const content = findQwenControlledTeachingContentForSubject(
      result.contentItemId,
      input.subject,
    );
    return content
      ? {
          ...result,
          compiledDirective: content.directive,
          maximumAssistantResponses: content.maximumAssistantResponses,
        }
      : { kind: "invalid_content_item" };
  }

  markRestoring(
    conversationId: string,
    expectedRevision: number,
  ): Promise<TransitionTeachingDirectiveResult> {
    return this.call((repository) =>
      repository.markRestoring({
        conversationId,
        expectedRevision,
        updatedAt: this.now(),
      }),
    );
  }

  markCompleted(
    conversationId: string,
    expectedRevision: number,
  ): Promise<TransitionTeachingDirectiveResult> {
    return this.call((repository) =>
      repository.markCompleted({
        conversationId,
        expectedRevision,
        updatedAt: this.now(),
      }),
    );
  }

  recoverForReconnect(
    conversationId: string,
  ): Promise<RecoverTeachingRuntimeResult> {
    return this.call((repository) =>
      repository.recoverForReconnect({
        conversationId,
        recoveredAt: this.now(),
      }),
    );
  }

  loadRuntimeForReconnect(
    conversationId: string,
  ): Promise<LoadTeachingRuntimeResult> {
    return this.call((repository) =>
      repository.loadRuntimeForReconnect({
        conversationId,
        loadedAt: this.now(),
      }),
    );
  }

  private async call<T>(
    operation: (repository: TeachingRepository) => Promise<T>,
  ): Promise<T> {
    const repository = this.repository;
    if (!repository) {
      throw new TeachingServiceError(
        "TEACHING_SERVICE_UNAVAILABLE",
        "教学计划服务尚未配置数据库。",
        503,
      );
    }
    try {
      return await operation(repository);
    } catch (error) {
      if (error instanceof TeachingServiceError) throw error;
      throw new TeachingServiceError(
        "TEACHING_SERVICE_UNAVAILABLE",
        "教学计划服务暂时不可用，请稍后重试。",
        503,
        { cause: error },
      );
    }
  }
}

function toPublicPlan(
  plan: ChildCharacterLearningPlanRecord,
): ChildCharacterLearningPlan {
  return childCharacterLearningPlanSchema.parse({
    id: plan.id,
    childUserId: plan.childUserId,
    characterId: plan.characterId,
    enabled: plan.enabled,
    subject: plan.subject,
    difficulty: plan.difficulty,
    triggerMode: plan.triggerMode,
    gradeLevel: plan.gradeLevel,
    learningGoal: plan.learningGoal,
    activityCount: plan.activityCount,
    durationDays: plan.durationDays,
    activeContentRevisionId: plan.activeContentRevisionId,
    activeContentActivatedAt:
      plan.activeContentActivatedAt?.toISOString() ?? null,
    revision: plan.revision,
    createdByUserId: plan.createdByUserId,
    updatedByUserId: plan.updatedByUserId,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  });
}

function toContentRevision(content: TeachingContentBundle) {
  return {
    contentRevisionId: content.revision.id,
    revision: content.revision.revision,
    schemaVersion: content.revision.schemaVersion,
    compilerVersion: content.revision.compilerVersion,
    title: content.revision.title,
    normalizedGoal: content.revision.normalizedGoal,
    subject: content.revision.subject,
    difficulty: content.revision.difficulty,
    gradeLevel: content.revision.gradeLevel,
    activityCount: content.revision.activityCount,
    durationDays: content.revision.durationDays,
    activities: content.items.map((item) => item.structuredContent),
    createdAt: content.revision.createdAt.toISOString(),
  };
}

function toGenerationResponse(
  generation: TeachingPlanGenerationRequestRecord,
  content: TeachingContentBundle | null,
): LearningPlanGenerationResponse {
  return learningPlanGenerationResponseSchema.parse({
    generation: {
      id: generation.id,
      expectedPlanRevision: generation.expectedPlanRevision,
      generatorSource: generation.generatorSource,
      status: generation.status,
      errorCode: generation.errorCode,
      contentRevisionId: generation.outputContentRevisionId,
      requestedAt: generation.requestedAt.toISOString(),
      completedAt: generation.completedAt?.toISOString() ?? null,
    },
    draft: content ? toContentRevision(content) : null,
  });
}

function toPinnedGeneration(
  generation: TeachingPlanGenerationRequestRecord,
): PinnedShortPlanGeneration | null {
  if (
    generation.generatorSource !== "text_model" ||
    !generation.modelProfileId ||
    !generation.modelProfileRevision ||
    !generation.connectionId ||
    !generation.connectionRevision
  ) {
    return null;
  }
  return {
    expectedSource: "text_model",
    expectedBinding: {
      modelProfileId: generation.modelProfileId,
      modelProfileRevision: generation.modelProfileRevision,
      connectionId: generation.connectionId,
      connectionRevision: generation.connectionRevision,
    },
  };
}

function toSafeState(state: {
  state:
    | "unavailable"
    | "available"
    | "active"
    | "restoring"
    | "muted"
    | "completed";
  revision: number;
}): SafeRelayTeachingState {
  const controls =
    state.state === "available"
      ? { canRequest: true as const, canMute: true as const }
      : state.state === "active"
        ? { canRequest: false as const, canMute: true as const }
        : { canRequest: false as const, canMute: false as const };
  return safeRelayTeachingStateSchema.parse({
    state: state.state,
    revision: state.revision,
    ...controls,
  });
}

function planManagementForbidden(): TeachingServiceError {
  return new TeachingServiceError(
    "TEACHING_PLAN_MANAGEMENT_FORBIDDEN",
    "当前账号不能配置教学计划。",
    403,
  );
}

function childAccessForbidden(): TeachingServiceError {
  return new TeachingServiceError(
    "TEACHING_CHILD_ACCESS_FORBIDDEN",
    "只能查看或控制自己的教学支线。",
    403,
  );
}

function planTargetNotFound(): TeachingServiceError {
  return new TeachingServiceError(
    "TEACHING_PLAN_TARGET_NOT_FOUND",
    "儿童账号或家庭公共角色不存在。",
    404,
  );
}

function conversationNotFound(): TeachingServiceError {
  return new TeachingServiceError(
    "TEACHING_CONVERSATION_NOT_FOUND",
    "当前对话不存在或不能操作。",
    404,
  );
}

function configurationRevisionConflict(): TeachingServiceError {
  return new TeachingServiceError(
    "TEACHING_CONFIGURATION_REVISION_CONFLICT",
    "教学计划刚刚发生变化，请重新查看说明后再选择。",
    409,
  );
}

function generationUnavailable(): TeachingServiceError {
  return new TeachingServiceError(
    "TEACHING_SERVICE_UNAVAILABLE",
    "短期学习计划服务尚未配置。",
    503,
  );
}

function generationConflict(): TeachingServiceError {
  return new TeachingServiceError(
    "TEACHING_PLAN_GENERATION_CONFLICT",
    "短期学习计划正在生成，或学习设置刚刚发生变化。",
    409,
  );
}

function generationNotFound(): TeachingServiceError {
  return new TeachingServiceError(
    "TEACHING_PLAN_GENERATION_NOT_FOUND",
    "没有找到这次短期学习计划生成记录。",
    404,
  );
}

function contentConflict(): TeachingServiceError {
  return new TeachingServiceError(
    "TEACHING_PLAN_CONTENT_CONFLICT",
    "这份草稿不再匹配当前学习设置，请重新生成。",
    409,
  );
}

function mapGenerationRequestError(
  kind:
    | "forbidden"
    | "not_found"
    | "invalid_request"
    | "revision_conflict"
    | "learning_goal_required"
    | "unsupported_goal"
    | "generator_not_configured"
    | "generation_in_progress"
    | "idempotency_conflict",
): TeachingServiceError {
  switch (kind) {
    case "forbidden":
      return planManagementForbidden();
    case "not_found":
      return planTargetNotFound();
    case "invalid_request":
    case "learning_goal_required":
      return new TeachingServiceError(
        "TEACHING_PLAN_GENERATION_UNSUPPORTED",
        "请先选择参考阶段，并填写一个明确的短期学习目标。",
        400,
      );
    case "unsupported_goal":
      return new TeachingServiceError(
        "TEACHING_PLAN_GENERATION_UNSUPPORTED",
        "这个目标暂时不能生成安全的儿童学习草稿，请换成更明确、适龄的学习内容。",
        422,
      );
    case "generator_not_configured":
      return new TeachingServiceError(
        "TEACHING_PLAN_GENERATOR_NOT_CONFIGURED",
        "短期计划生成模型尚未配置，请先由管理员绑定并验证文本模型。",
        409,
      );
    case "revision_conflict":
    case "generation_in_progress":
    case "idempotency_conflict":
      return generationConflict();
  }
}
