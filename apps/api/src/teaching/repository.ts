import type {
  ChildTeachingAvailabilityResult,
  BeginTeachingPlanGenerationResult,
  CompleteTeachingPlanGenerationResult,
  FailTeachingPlanGenerationResult,
  GetTeachingPlanContentResult,
  GetTeachingPlanGenerationResult,
  ClaimTeachingInvitationResult,
  ListChildLearningPlansResult,
  LoadTeachingRuntimeResult,
  ListTeachingManagementTargetsResult,
  MuteConversationTeachingResult,
  PrepareConversationTeachingResult,
  PutChildLearningPlanResult,
  PublishTeachingPlanContentResult,
  RecordValidTeachingTurnResult,
  RecoverTeachingRuntimeResult,
  TransitionTeachingDirectiveResult,
  StartTeachingPlanGenerationResult,
  CompiledTeachingContentItem,
} from "@meet/database";
import type {
  GeneratedTeachingPlanDraft,
  PrepareConversationTeachingRequest,
  PublishLearningPlanContentRequest,
  PutLearningPlanRequest,
  RequestLearningPlanGeneration,
  TeachingPlanGenerationErrorCode,
  TeachingSubject,
} from "@meet/protocol";

export interface TeachingRepository {
  listManagementTargets(
    actorUserId: string,
  ): Promise<ListTeachingManagementTargetsResult>;
  listChildPlans(input: {
    actorUserId: string;
    childUserId: string;
  }): Promise<ListChildLearningPlansResult>;
  putChildPlan(
    input: PutLearningPlanRequest & {
      actorUserId: string;
      childUserId: string;
      characterId: string;
      updatedAt: Date;
    },
  ): Promise<PutChildLearningPlanResult>;
  beginGeneration?: (
    input: RequestLearningPlanGeneration & {
      actorUserId: string;
      childUserId: string;
      characterId: string;
      requestedAt: Date;
    },
  ) => Promise<BeginTeachingPlanGenerationResult>;
  startGeneration?: (input: {
    generationId: string;
    startedAt: Date;
  }) => Promise<StartTeachingPlanGenerationResult>;
  completeGeneration?: (input: {
    generationId: string;
    draft: GeneratedTeachingPlanDraft;
    compiledItems: readonly CompiledTeachingContentItem[];
    actualModel?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    completedAt: Date;
  }) => Promise<CompleteTeachingPlanGenerationResult>;
  failGeneration?: (input: {
    generationId: string;
    errorCode: TeachingPlanGenerationErrorCode;
    failedAt: Date;
  }) => Promise<FailTeachingPlanGenerationResult>;
  getGeneration?: (input: {
    actorUserId: string;
    childUserId: string;
    characterId: string;
    generationId: string;
  }) => Promise<GetTeachingPlanGenerationResult>;
  getContent?: (input: {
    actorUserId: string;
    childUserId: string;
    characterId: string;
    now: Date;
  }) => Promise<GetTeachingPlanContentResult>;
  publishContent?: (
    input: PublishLearningPlanContentRequest & {
      actorUserId: string;
      childUserId: string;
      characterId: string;
      publishedAt: Date;
    },
  ) => Promise<PublishTeachingPlanContentResult>;
  getChildAvailability(input: {
    actorUserId: string;
    characterId: string;
  }): Promise<ChildTeachingAvailabilityResult>;
  prepareConversation(
    input: PrepareConversationTeachingRequest & {
      actorUserId: string;
      conversationId: string;
      preparedAt: Date;
    },
  ): Promise<PrepareConversationTeachingResult>;
  muteConversation(input: {
    actorUserId: string;
    conversationId: string;
    mutedAt: Date;
  }): Promise<MuteConversationTeachingResult>;
  recordValidTurn(input: {
    conversationId: string;
    recordedAt: Date;
  }): Promise<RecordValidTeachingTurnResult>;
  claimInvitation(input: {
    conversationId: string;
    contentItemIds: readonly string[];
    expectedSubject: TeachingSubject;
    explicitRequest: boolean;
    claimedAt: Date;
  }): Promise<ClaimTeachingInvitationResult>;
  markRestoring(input: {
    conversationId: string;
    expectedRevision: number;
    updatedAt: Date;
  }): Promise<TransitionTeachingDirectiveResult>;
  markCompleted(input: {
    conversationId: string;
    expectedRevision: number;
    updatedAt: Date;
  }): Promise<TransitionTeachingDirectiveResult>;
  recoverForReconnect(input: {
    conversationId: string;
    recoveredAt: Date;
  }): Promise<RecoverTeachingRuntimeResult>;
  loadRuntimeForReconnect(input: {
    conversationId: string;
    loadedAt: Date;
  }): Promise<LoadTeachingRuntimeResult>;
}
