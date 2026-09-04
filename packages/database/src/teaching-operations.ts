import {
  generatedTeachingPlanDraftSchema,
  type GeneratedTeachingPlanDraft,
  type LearningPlanTargetTeachingAvailability,
  type PrepareConversationTeachingRequest,
  type PutLearningPlanRequest,
  type TeachingSubject,
} from "@meet/protocol";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Database } from "./client.js";
import {
  compileDeterministicTeachingContentItem,
  hashTeachingContent,
  hashTeachingDirective,
  type CompiledTeachingContentItem,
} from "./teaching-plan-generation-operations.js";
import {
  childCharacterLearningPlans,
  characters,
  conversations,
  conversationTeachingStates,
  modelConnections,
  providerProfiles,
  teachingContentItems,
  teachingContentRevisions,
  teachingEvents,
  userAccounts,
  voiceProfiles,
  type ChildCharacterLearningPlanRecord,
  type ConversationTeachingStateRecord,
} from "./schema.js";

export const TEACHING_DYNAMIC_PROVIDER = "qwen" as const;
export const TEACHING_DYNAMIC_MODELS = [
  "qwen-audio-3.0-realtime-plus",
  "qwen-audio-3.0-realtime-flash",
] as const;
export const TEACHING_GENTLE_MIN_CONVERSATION_MS = 5 * 60 * 1_000;
export const TEACHING_GENTLE_MIN_VALID_USER_TURNS = 6;
export const TEACHING_GENTLE_MIN_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export type DynamicTeachingRuntimeBinding = Readonly<{
  modelProfileId: string;
  modelProfileRevision: number;
  connectionId: string;
  connectionRevision: number;
}>;

export type DynamicTeachingCapabilityBinding = Readonly<{
  bindings: readonly DynamicTeachingRuntimeBinding[];
}>;

export type TeachingManagementTargets = {
  children: Array<{ id: string; displayName: string }>;
  characters: Array<{
    id: string;
    name: string;
    teachingAvailability: LearningPlanTargetTeachingAvailability;
  }>;
};

export type TeachingTargetRuntime = Readonly<{
  modelProfileId: string;
  modelProfileRevision: number;
  provider: string;
  model: string;
  providerKind: string;
  providerStatus: string;
  providerVerifiedAt: Date | null;
  voiceStatus: string;
  voiceVerifiedAt: Date | null;
  connectionAdapter: string | null;
  connectionId: string | null;
  connectionRevision: number | null;
  connectionStatus: string | null;
  connectionVerifiedAt: Date | null;
}>;

export type ListTeachingManagementTargetsResult =
  | { kind: "allowed"; targets: TeachingManagementTargets }
  | { kind: "forbidden" };

export type ListChildLearningPlansResult =
  | { kind: "allowed"; plans: ChildCharacterLearningPlanRecord[] }
  | { kind: "forbidden" | "target_not_found" };

export type PutChildLearningPlanResult =
  | {
      kind: "created" | "updated" | "unchanged";
      plan: ChildCharacterLearningPlanRecord;
    }
  | { kind: "forbidden" | "target_not_found" | "revision_conflict" };

export type ChildTeachingAvailabilityResult =
  | { kind: "forbidden" }
  | {
      kind: "available";
      plan: Pick<
        ChildCharacterLearningPlanRecord,
        "subject" | "difficulty" | "triggerMode" | "revision"
      >;
    }
  | {
      kind: "unavailable";
      reason:
        "no_enabled_plan" | "character_unavailable" | "provider_unsupported";
    };

export type PrepareConversationTeachingResult =
  | {
      kind: "created" | "existing" | "muted";
      state: ConversationTeachingStateRecord;
    }
  | { kind: "forbidden" | "not_found" | "revision_conflict" };

export type MuteConversationTeachingResult =
  | {
      kind: "muted" | "unchanged";
      state: ConversationTeachingStateRecord;
    }
  | { kind: "forbidden" | "not_found" };

export type RecordValidTeachingTurnResult =
  | { kind: "recorded"; validUserTurns: number }
  | { kind: "ignored" | "not_found" };

export type TeachingInvitationIneligibilityReason =
  | "state_unavailable"
  | "already_invited"
  | "trigger_mode"
  | "conversation_too_short"
  | "insufficient_valid_turns"
  | "cooldown"
  | "content_exhausted"
  | "content_expired"
  | "configuration_changed";

export type ClaimTeachingInvitationResult =
  | {
      kind: "claimed";
      state: ConversationTeachingStateRecord;
      contentCursor: number;
      contentItemId: string;
      compiledDirective: string | null;
      maximumAssistantResponses: 2;
    }
  | {
      kind: "not_eligible";
      reason: TeachingInvitationIneligibilityReason;
    }
  | { kind: "not_found" | "invalid_content_item" };

export type TransitionTeachingDirectiveResult =
  | {
      kind: "transitioned" | "unchanged";
      state: ConversationTeachingStateRecord;
    }
  | { kind: "not_found" | "revision_conflict" | "invalid_state" };

export type RecoverTeachingRuntimeResult =
  | {
      kind: "recovered" | "unchanged";
      state: ConversationTeachingStateRecord;
    }
  | { kind: "not_found" };

export type LoadTeachingRuntimeResult =
  | {
      kind: "loaded";
      state: ConversationTeachingStateRecord;
      conversationStartedAt: Date;
      provider: string;
      model: string;
    }
  | { kind: "not_found" };

export async function listTeachingManagementTargets(
  db: Database,
  actorUserId: string,
  capability?: DynamicTeachingCapabilityBinding,
): Promise<ListTeachingManagementTargetsResult> {
  const actor = await findActiveActor(db, actorUserId);
  if (!isPlanManager(actor)) return { kind: "forbidden" };

  const [children, publicCharacters] = await Promise.all([
    db
      .select({ id: userAccounts.id, displayName: userAccounts.displayName })
      .from(userAccounts)
      .where(
        and(
          eq(userAccounts.accountType, "child"),
          eq(userAccounts.status, "active"),
        ),
      )
      .orderBy(asc(userAccounts.displayName), asc(userAccounts.id)),
    db
      .select({
        id: characters.id,
        name: characters.name,
        modelProfileId: providerProfiles.id,
        modelProfileRevision: providerProfiles.revision,
        provider: providerProfiles.provider,
        model: providerProfiles.model,
        providerKind: providerProfiles.kind,
        providerStatus: providerProfiles.status,
        providerVerifiedAt: providerProfiles.verifiedAt,
        voiceStatus: voiceProfiles.status,
        voiceVerifiedAt: voiceProfiles.verifiedAt,
        connectionAdapter: modelConnections.adapter,
        connectionId: modelConnections.id,
        connectionRevision: modelConnections.revision,
        connectionStatus: modelConnections.status,
        connectionVerifiedAt: modelConnections.verifiedAt,
      })
      .from(characters)
      .innerJoin(
        providerProfiles,
        eq(characters.providerProfileId, providerProfiles.id),
      )
      .innerJoin(
        voiceProfiles,
        and(
          eq(characters.voiceProfileId, voiceProfiles.id),
          eq(voiceProfiles.providerProfileId, providerProfiles.id),
        ),
      )
      .leftJoin(
        modelConnections,
        eq(providerProfiles.connectionId, modelConnections.id),
      )
      .where(
        and(
          isNull(characters.deletedAt),
          inArray(characters.visibility, ["builtin", "family"]),
        ),
      )
      .orderBy(asc(characters.name), asc(characters.id)),
  ]);

  return {
    kind: "allowed",
    targets: {
      children,
      characters: publicCharacters.map(({ id, name, ...runtime }) => ({
        id,
        name,
        teachingAvailability: classifyTeachingTargetAvailability(
          runtime,
          capability,
        ),
      })),
    },
  };
}

export async function listChildLearningPlans(
  db: Database,
  input: { actorUserId: string; childUserId: string },
): Promise<ListChildLearningPlansResult> {
  const [actor, child] = await Promise.all([
    findActiveActor(db, input.actorUserId),
    findActiveChild(db, input.childUserId),
  ]);
  if (!isPlanManager(actor)) return { kind: "forbidden" };
  if (!child) return { kind: "target_not_found" };
  const plans = await db
    .select()
    .from(childCharacterLearningPlans)
    .where(eq(childCharacterLearningPlans.childUserId, child.id))
    .orderBy(
      asc(childCharacterLearningPlans.characterId),
      asc(childCharacterLearningPlans.id),
    );
  return { kind: "allowed", plans };
}

export async function putChildLearningPlan(
  db: Database,
  input: PutLearningPlanRequest & {
    actorUserId: string;
    childUserId: string;
    characterId: string;
    updatedAt?: Date;
  },
): Promise<PutChildLearningPlanResult> {
  const updatedAt = input.updatedAt ?? new Date();
  return db.transaction(async (tx) => {
    const [actor, child, character] = await Promise.all([
      findActiveActor(tx, input.actorUserId, true),
      findActiveChild(tx, input.childUserId, true),
      findPublicTeachingCharacter(tx, input.characterId, true),
    ]);
    if (!isPlanManager(actor)) return { kind: "forbidden" };
    if (!child || !character) return { kind: "target_not_found" };

    const [existing] = await tx
      .select()
      .from(childCharacterLearningPlans)
      .where(
        and(
          eq(childCharacterLearningPlans.childUserId, child.id),
          eq(childCharacterLearningPlans.characterId, character.id),
        ),
      )
      .for("update")
      .limit(1);

    if (!existing) {
      if (input.expectedRevision !== null) {
        return { kind: "revision_conflict" };
      }
      const [created] = await tx
        .insert(childCharacterLearningPlans)
        .values({
          childUserId: child.id,
          characterId: character.id,
          enabled: input.enabled,
          subject: input.subject,
          difficulty: input.difficulty,
          triggerMode: input.triggerMode,
          gradeLevel: input.gradeLevel,
          learningGoal: input.learningGoal,
          activityCount: input.activityCount,
          durationDays: input.durationDays,
          revision: 1,
          createdByUserId: actor.id,
          updatedByUserId: actor.id,
          createdAt: updatedAt,
          updatedAt,
        })
        .returning();
      if (!created) throw new Error("Learning plan insert did not return.");
      return { kind: "created", plan: created };
    }

    if (input.expectedRevision !== existing.revision) {
      return { kind: "revision_conflict" };
    }
    if (
      existing.enabled === input.enabled &&
      existing.subject === input.subject &&
      existing.difficulty === input.difficulty &&
      existing.triggerMode === input.triggerMode &&
      existing.gradeLevel === input.gradeLevel &&
      existing.learningGoal === input.learningGoal &&
      existing.activityCount === input.activityCount &&
      existing.durationDays === input.durationDays
    ) {
      return { kind: "unchanged", plan: existing };
    }

    const nextRevision = existing.revision + 1;
    const explicitlyRemovedGeneratedGoal = shouldClearPublishedTeachingContent(
      existing.activeContentRevisionId,
      input.learningGoal,
    );
    const [updated] = await tx
      .update(childCharacterLearningPlans)
      .set({
        enabled: input.enabled,
        subject: input.subject,
        difficulty: input.difficulty,
        triggerMode: input.triggerMode,
        gradeLevel: input.gradeLevel,
        learningGoal: input.learningGoal,
        activityCount: input.activityCount,
        durationDays: input.durationDays,
        ...(explicitlyRemovedGeneratedGoal
          ? {
              activeContentRevisionId: null,
              activeContentActivatedAt: null,
              contentCursor: 0,
            }
          : {}),
        revision: nextRevision,
        updatedByUserId: actor.id,
        updatedAt,
      })
      .where(
        and(
          eq(childCharacterLearningPlans.id, existing.id),
          eq(childCharacterLearningPlans.revision, existing.revision),
        ),
      )
      .returning();
    if (!updated) return { kind: "revision_conflict" };

    if (existing.enabled && !updated.enabled) {
      await muteStatesForDisabledPlan(tx, updated.id, actor.id, updatedAt);
    }
    return { kind: "updated", plan: updated };
  });
}

export async function getChildTeachingAvailability(
  db: Database,
  input: { actorUserId: string; characterId: string },
  capability?: DynamicTeachingCapabilityBinding,
): Promise<ChildTeachingAvailabilityResult> {
  const actor = await findActiveActor(db, input.actorUserId);
  if (actor?.accountType !== "child") return { kind: "forbidden" };

  const character = await findPublicCharacterRuntime(db, input.characterId);
  if (!character) {
    return { kind: "unavailable", reason: "character_unavailable" };
  }
  if (!isDynamicTeachingRuntimeEligible(character, capability)) {
    return { kind: "unavailable", reason: "provider_unsupported" };
  }
  const [plan] = await db
    .select()
    .from(childCharacterLearningPlans)
    .where(
      and(
        eq(childCharacterLearningPlans.childUserId, actor.id),
        eq(childCharacterLearningPlans.characterId, character.id),
        eq(childCharacterLearningPlans.enabled, true),
      ),
    )
    .limit(1);
  if (!plan) {
    return { kind: "unavailable", reason: "no_enabled_plan" };
  }
  let effectiveSubject = plan.subject;
  let effectiveDifficulty = plan.difficulty;
  if (plan.activeContentRevisionId !== null) {
    if (plan.activeContentActivatedAt === null) {
      return { kind: "unavailable", reason: "no_enabled_plan" };
    }
    const activeContent = await loadValidatedGeneratedRuntimeContent(
      db,
      plan.activeContentRevisionId,
      plan,
    );
    if (
      !activeContent ||
      isGeneratedTeachingContentExpired(
        plan.activeContentActivatedAt,
        activeContent.draft.durationDays,
        new Date(),
      ) ||
      plan.contentCursor >= activeContent.items.length
    ) {
      return { kind: "unavailable", reason: "no_enabled_plan" };
    }
    effectiveSubject = activeContent.draft.subject;
    effectiveDifficulty = activeContent.draft.difficulty;
  } else if (plan.learningGoal !== null || plan.subject === "chinese") {
    return { kind: "unavailable", reason: "no_enabled_plan" };
  }
  return {
    kind: "available",
    plan: {
      subject: effectiveSubject,
      difficulty: effectiveDifficulty,
      triggerMode: plan.triggerMode,
      revision: plan.revision,
    },
  };
}

export async function prepareConversationTeaching(
  db: Database,
  input: PrepareConversationTeachingRequest & {
    actorUserId: string;
    conversationId: string;
    preparedAt?: Date;
  },
  capability?: DynamicTeachingCapabilityBinding,
): Promise<PrepareConversationTeachingResult> {
  const preparedAt = input.preparedAt ?? new Date();
  return db.transaction(async (tx) => {
    const actor = await findActiveActor(tx, input.actorUserId, true);
    if (actor?.accountType !== "child") return { kind: "forbidden" };

    const [conversation] = await tx
      .select({
        id: conversations.id,
        characterId: conversations.characterId,
        mode: conversations.mode,
        provider: conversations.provider,
        model: conversations.model,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, input.conversationId),
          eq(conversations.userId, actor.id),
          eq(conversations.status, "active"),
        ),
      )
      .for("update")
      .limit(1);
    if (!conversation) return { kind: "not_found" };

    const [existing] = await tx
      .select()
      .from(conversationTeachingStates)
      .where(eq(conversationTeachingStates.conversationId, conversation.id))
      .for("update")
      .limit(1);
    if (existing) {
      if (input.choice === "chat_only" && existing.state !== "muted") {
        const muted = await persistChildMute(
          tx,
          existing,
          actor.id,
          preparedAt,
        );
        const recovered = await recoverTeachingRuntimeState(
          tx,
          muted,
          preparedAt,
        );
        return { kind: "muted", state: recovered };
      }
      if (existing.activeContentItemId !== null) {
        return {
          kind: "existing",
          state: await recoverTeachingRuntimeState(tx, existing, preparedAt),
        };
      }
      return { kind: "existing", state: existing };
    }

    let snapshot;
    if (conversation.mode === "temporary") {
      snapshot = {
        state: "muted" as const,
        muteReason: "temporary_conversation" as const,
      };
    } else if (input.choice === "chat_only") {
      snapshot = {
        state: "muted" as const,
        muteReason: "child_request" as const,
      };
    } else {
      const resolved = await resolveConversationTeachingSnapshot(
        tx,
        actor.id,
        conversation.characterId,
        input.expectedConfigurationRevision,
        input.acknowledgedDisclosureVersion,
        conversation.provider === TEACHING_DYNAMIC_PROVIDER &&
          isDynamicTeachingModel(conversation.model),
        capability,
        preparedAt,
      );
      if (resolved.kind === "revision_conflict") return resolved;
      snapshot = resolved.snapshot;
    }
    const [created] = await tx
      .insert(conversationTeachingStates)
      .values({
        conversationId: conversation.id,
        ...snapshot,
        revision: 1,
        preparedAt,
        updatedAt: preparedAt,
      })
      .returning();
    if (!created) throw new Error("Teaching state insert did not return.");

    const eventTypes: Array<"prepared" | "child_muted"> = ["prepared"];
    if (created.muteReason === "child_request") eventTypes.push("child_muted");
    await tx.insert(teachingEvents).values(
      eventTypes.map((eventType) => ({
        conversationId: conversation.id,
        learningPlanId: created.learningPlanId,
        eventType,
        actorUserId: actor.id,
        stateRevision: created.revision,
        createdAt: preparedAt,
      })),
    );
    return { kind: "created", state: created };
  });
}

export async function muteConversationTeaching(
  db: Database,
  input: {
    actorUserId: string;
    conversationId: string;
    mutedAt?: Date;
  },
): Promise<MuteConversationTeachingResult> {
  const mutedAt = input.mutedAt ?? new Date();
  return db.transaction(async (tx) => {
    const actor = await findActiveActor(tx, input.actorUserId, true);
    if (actor?.accountType !== "child") return { kind: "forbidden" };
    const [conversation] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, input.conversationId),
          eq(conversations.userId, actor.id),
          eq(conversations.status, "active"),
        ),
      )
      .for("update")
      .limit(1);
    if (!conversation) return { kind: "not_found" };
    const [state] = await tx
      .select()
      .from(conversationTeachingStates)
      .where(eq(conversationTeachingStates.conversationId, conversation.id))
      .for("update")
      .limit(1);
    if (!state) return { kind: "not_found" };
    if (state.state === "muted") return { kind: "unchanged", state };
    return {
      kind: "muted",
      state: await persistChildMute(tx, state, actor.id, mutedAt),
    };
  });
}

export async function recordValidTeachingTurn(
  db: Database,
  input: { conversationId: string; recordedAt?: Date },
): Promise<RecordValidTeachingTurnResult> {
  const recordedAt = input.recordedAt ?? new Date();
  return db.transaction(async (tx) => {
    const [conversation] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, input.conversationId),
          eq(conversations.status, "active"),
        ),
      )
      .for("update")
      .limit(1);
    if (!conversation) return { kind: "not_found" };
    const [state] = await tx
      .select()
      .from(conversationTeachingStates)
      .where(eq(conversationTeachingStates.conversationId, conversation.id))
      .for("update")
      .limit(1);
    if (!state) return { kind: "not_found" };
    if (state.state !== "available" || state.muteReason !== null) {
      return { kind: "ignored" };
    }
    const [updated] = await tx
      .update(conversationTeachingStates)
      .set({
        validUserTurns: state.validUserTurns + 1,
        updatedAt: recordedAt,
      })
      .where(
        and(
          eq(conversationTeachingStates.conversationId, state.conversationId),
          eq(conversationTeachingStates.revision, state.revision),
        ),
      )
      .returning({ validUserTurns: conversationTeachingStates.validUserTurns });
    if (!updated) throw new Error("Teaching turn update lost its row lock.");
    return { kind: "recorded", validUserTurns: updated.validUserTurns };
  });
}

export async function claimTeachingInvitation(
  db: Database,
  input: {
    conversationId: string;
    contentItemIds: readonly string[];
    expectedSubject: TeachingSubject;
    explicitRequest: boolean;
    claimedAt?: Date;
  },
): Promise<ClaimTeachingInvitationResult> {
  const contentItemIds = input.contentItemIds.map((item) => item.trim());
  if (
    contentItemIds.length > 100 ||
    new Set(contentItemIds).size !== contentItemIds.length ||
    contentItemIds.some((item) => item.length === 0 || item.length > 160)
  ) {
    return { kind: "invalid_content_item" };
  }
  const claimedAt = input.claimedAt ?? new Date();
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ learningPlanId: conversationTeachingStates.learningPlanId })
      .from(conversationTeachingStates)
      .where(
        eq(conversationTeachingStates.conversationId, input.conversationId),
      )
      .limit(1);
    if (!candidate?.learningPlanId) {
      return candidate
        ? { kind: "not_eligible", reason: "state_unavailable" }
        : { kind: "not_found" };
    }

    const [plan] = await tx
      .select()
      .from(childCharacterLearningPlans)
      .where(eq(childCharacterLearningPlans.id, candidate.learningPlanId))
      .for("update")
      .limit(1);
    if (!plan?.enabled) {
      return { kind: "not_eligible", reason: "state_unavailable" };
    }
    const [conversation] = await tx
      .select({ id: conversations.id, startedAt: conversations.startedAt })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, input.conversationId),
          eq(conversations.status, "active"),
          eq(conversations.mode, "normal"),
        ),
      )
      .for("update")
      .limit(1);
    if (!conversation) return { kind: "not_found" };
    const [state] = await tx
      .select()
      .from(conversationTeachingStates)
      .where(eq(conversationTeachingStates.conversationId, conversation.id))
      .for("update")
      .limit(1);
    if (
      !state ||
      state.learningPlanId !== plan.id ||
      state.subject !== input.expectedSubject
    ) {
      return { kind: "not_found" };
    }
    if (state.learningPlanRevision !== plan.revision) {
      return { kind: "not_eligible", reason: "configuration_changed" };
    }
    const ineligibleReason = evaluateTeachingInvitationEligibility({
      state: {
        state: state.state,
        muteReason: state.muteReason,
        invitationCount: state.invitationCount,
        triggerMode: state.triggerMode,
        validUserTurns: state.validUserTurns,
      },
      conversationStartedAt: conversation.startedAt,
      lastTriggeredAt: plan.lastTriggeredAt,
      explicitRequest: input.explicitRequest,
      claimedAt,
    });
    if (ineligibleReason) {
      return { kind: "not_eligible", reason: ineligibleReason };
    }

    let contentItemId: string;
    let compiledDirective: string | null = null;
    let maximumAssistantResponses = 2 as const;
    if (state.contentRevisionId !== null) {
      if (
        !["generated-v1", "generated-v2"].includes(
          state.contentCatalogVersion ?? "",
        ) ||
        plan.activeContentRevisionId !== state.contentRevisionId ||
        plan.activeContentActivatedAt === null
      ) {
        return { kind: "not_eligible", reason: "state_unavailable" };
      }
      const content = await loadValidatedGeneratedRuntimeContent(
        tx,
        state.contentRevisionId,
        plan,
      );
      if (!content) {
        return { kind: "not_eligible", reason: "state_unavailable" };
      }
      const expectedCatalogVersion =
        content.draft.schemaVersion === "generated-teaching-plan-v2"
          ? "generated-v2"
          : "generated-v1";
      if (state.contentCatalogVersion !== expectedCatalogVersion) {
        return { kind: "not_eligible", reason: "state_unavailable" };
      }
      if (
        isGeneratedTeachingContentExpired(
          plan.activeContentActivatedAt,
          content.draft.durationDays,
          claimedAt,
        )
      ) {
        return { kind: "not_eligible", reason: "content_expired" };
      }
      const selected = selectFiniteTeachingContentItem(
        content.items,
        plan.contentCursor,
      );
      if (!selected) {
        return { kind: "not_eligible", reason: "content_exhausted" };
      }
      contentItemId = selected.itemKey;
      compiledDirective = selected.directive;
      maximumAssistantResponses = 2;
    } else {
      if (
        plan.learningGoal !== null ||
        plan.subject === "chinese" ||
        state.contentCatalogVersion !== "reviewed-v1" ||
        contentItemIds.length === 0
      ) {
        return { kind: "invalid_content_item" };
      }
      contentItemId = selectTeachingContentItemId(
        contentItemIds,
        plan.contentCursor,
      );
    }

    const nextStateRevision = state.revision + 1;
    const nextContentCursor = plan.contentCursor + 1;
    await tx
      .update(childCharacterLearningPlans)
      .set({
        lastTriggeredAt: claimedAt,
        contentCursor: nextContentCursor,
      })
      .where(eq(childCharacterLearningPlans.id, plan.id));
    const [claimed] = await tx
      .update(conversationTeachingStates)
      .set({
        state: "active",
        invitationCount: 1,
        activeContentItemId: contentItemId,
        revision: nextStateRevision,
        updatedAt: claimedAt,
      })
      .where(
        and(
          eq(conversationTeachingStates.conversationId, state.conversationId),
          eq(conversationTeachingStates.revision, state.revision),
        ),
      )
      .returning();
    if (!claimed) throw new Error("Teaching claim lost its row lock.");
    await tx.insert(teachingEvents).values({
      conversationId: state.conversationId,
      learningPlanId: plan.id,
      eventType: "invitation_claimed",
      stateRevision: nextStateRevision,
      createdAt: claimedAt,
    });
    return {
      kind: "claimed",
      state: claimed,
      contentCursor: nextContentCursor,
      contentItemId,
      compiledDirective,
      maximumAssistantResponses,
    };
  });
}

export function evaluateTeachingInvitationEligibility(input: {
  state: Pick<
    ConversationTeachingStateRecord,
    | "state"
    | "muteReason"
    | "invitationCount"
    | "triggerMode"
    | "validUserTurns"
  >;
  conversationStartedAt: Date;
  lastTriggeredAt: Date | null;
  explicitRequest: boolean;
  claimedAt: Date;
}): TeachingInvitationIneligibilityReason | null {
  if (input.state.state !== "available" || input.state.muteReason !== null) {
    return "state_unavailable";
  }
  if (input.state.invitationCount !== 0) return "already_invited";
  if (input.explicitRequest) return null;
  if (input.state.triggerMode !== "gentle") return "trigger_mode";
  if (
    input.claimedAt.getTime() - input.conversationStartedAt.getTime() <
    TEACHING_GENTLE_MIN_CONVERSATION_MS
  ) {
    return "conversation_too_short";
  }
  if (input.state.validUserTurns < TEACHING_GENTLE_MIN_VALID_USER_TURNS) {
    return "insufficient_valid_turns";
  }
  if (
    input.lastTriggeredAt &&
    input.claimedAt.getTime() - input.lastTriggeredAt.getTime() <
      TEACHING_GENTLE_MIN_INTERVAL_MS
  ) {
    return "cooldown";
  }
  return null;
}

export async function markTeachingRestoring(
  db: Database,
  input: {
    conversationId: string;
    expectedRevision: number;
    updatedAt?: Date;
  },
): Promise<TransitionTeachingDirectiveResult> {
  return transitionTeachingDirective(db, {
    ...input,
    eventType: "restoring",
    allowedStates: ["active", "muted"],
    resolveState: () => "restoring",
  });
}

export async function markTeachingCompleted(
  db: Database,
  input: {
    conversationId: string;
    expectedRevision: number;
    updatedAt?: Date;
  },
): Promise<TransitionTeachingDirectiveResult> {
  return transitionTeachingDirective(db, {
    ...input,
    eventType: "completed",
    allowedStates: ["active", "restoring", "muted"],
    resolveState: (state) =>
      state.muteReason === null ? "completed" : "muted",
    clearActiveContentItem: true,
  });
}

export async function recoverTeachingRuntimeForReconnect(
  db: Database,
  input: { conversationId: string; recoveredAt?: Date },
): Promise<RecoverTeachingRuntimeResult> {
  const recoveredAt = input.recoveredAt ?? new Date();
  return db.transaction(async (tx) => {
    const [state] = await tx
      .select()
      .from(conversationTeachingStates)
      .where(
        eq(conversationTeachingStates.conversationId, input.conversationId),
      )
      .for("update")
      .limit(1);
    if (!state) return { kind: "not_found" };
    if (state.activeContentItemId === null) {
      return { kind: "unchanged", state };
    }
    return {
      kind: "recovered",
      state: await recoverTeachingRuntimeState(tx, state, recoveredAt),
    };
  });
}

export async function loadTeachingRuntimeForReconnect(
  db: Database,
  input: { conversationId: string; loadedAt?: Date },
): Promise<LoadTeachingRuntimeResult> {
  const loadedAt = input.loadedAt ?? new Date();
  return db.transaction(async (tx) => {
    const [conversation] = await tx
      .select({
        id: conversations.id,
        startedAt: conversations.startedAt,
        provider: conversations.provider,
        model: conversations.model,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, input.conversationId),
          eq(conversations.status, "active"),
        ),
      )
      .for("update")
      .limit(1);
    if (!conversation) return { kind: "not_found" };
    const [state] = await tx
      .select()
      .from(conversationTeachingStates)
      .where(eq(conversationTeachingStates.conversationId, conversation.id))
      .for("update")
      .limit(1);
    if (!state) return { kind: "not_found" };
    return {
      kind: "loaded",
      state: await recoverTeachingRuntimeState(tx, state, loadedAt),
      conversationStartedAt: conversation.startedAt,
      provider: conversation.provider,
      model: conversation.model,
    };
  });
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Queryable = Database | Transaction;

async function findActiveActor(
  db: Queryable,
  actorUserId: string,
  lock = false,
) {
  const query = db
    .select({
      id: userAccounts.id,
      accountType: userAccounts.accountType,
    })
    .from(userAccounts)
    .where(
      and(eq(userAccounts.id, actorUserId), eq(userAccounts.status, "active")),
    );
  const rows = lock ? await query.for("update").limit(1) : await query.limit(1);
  return rows[0] ?? null;
}

async function findActiveChild(
  db: Queryable,
  childUserId: string,
  lock = false,
) {
  const query = db
    .select({ id: userAccounts.id })
    .from(userAccounts)
    .where(
      and(
        eq(userAccounts.id, childUserId),
        eq(userAccounts.accountType, "child"),
        eq(userAccounts.status, "active"),
      ),
    );
  const rows = lock ? await query.for("update").limit(1) : await query.limit(1);
  return rows[0] ?? null;
}

function isPlanManager(
  actor: { accountType: "admin" | "adult" | "child" } | null,
): actor is { accountType: "admin" | "adult"; id: string } {
  return actor?.accountType === "admin" || actor?.accountType === "adult";
}

async function findPublicTeachingCharacter(
  db: Queryable,
  characterId: string,
  lock = false,
) {
  const query = db
    .select({ id: characters.id })
    .from(characters)
    .where(
      and(
        eq(characters.id, characterId),
        isNull(characters.deletedAt),
        inArray(characters.visibility, ["builtin", "family"]),
      ),
    );
  const rows = lock ? await query.for("update").limit(1) : await query.limit(1);
  return rows[0] ?? null;
}

async function findPublicCharacterRuntime(db: Queryable, characterId: string) {
  const [runtime] = await db
    .select({
      id: characters.id,
      modelProfileId: providerProfiles.id,
      modelProfileRevision: providerProfiles.revision,
      provider: providerProfiles.provider,
      model: providerProfiles.model,
      providerKind: providerProfiles.kind,
      providerStatus: providerProfiles.status,
      providerVerifiedAt: providerProfiles.verifiedAt,
      voiceStatus: voiceProfiles.status,
      voiceVerifiedAt: voiceProfiles.verifiedAt,
      connectionAdapter: modelConnections.adapter,
      connectionId: modelConnections.id,
      connectionRevision: modelConnections.revision,
      connectionStatus: modelConnections.status,
      connectionVerifiedAt: modelConnections.verifiedAt,
    })
    .from(characters)
    .innerJoin(
      providerProfiles,
      eq(characters.providerProfileId, providerProfiles.id),
    )
    .innerJoin(
      voiceProfiles,
      and(
        eq(characters.voiceProfileId, voiceProfiles.id),
        eq(voiceProfiles.providerProfileId, providerProfiles.id),
      ),
    )
    .leftJoin(
      modelConnections,
      eq(providerProfiles.connectionId, modelConnections.id),
    )
    .where(
      and(
        eq(characters.id, characterId),
        isNull(characters.deletedAt),
        inArray(characters.visibility, ["builtin", "family"]),
      ),
    )
    .limit(1);
  return runtime ?? null;
}

export function isDynamicTeachingRuntimeEligible(
  runtime: TeachingTargetRuntime,
  capability?: DynamicTeachingCapabilityBinding,
): boolean {
  return (
    isDynamicTeachingBindingApproved(runtime, capability) &&
    runtime.provider === TEACHING_DYNAMIC_PROVIDER &&
    isDynamicTeachingModel(runtime.model) &&
    runtime.providerKind === "realtime_voice" &&
    runtime.providerStatus === "enabled" &&
    runtime.providerVerifiedAt !== null &&
    runtime.voiceStatus === "enabled" &&
    runtime.voiceVerifiedAt !== null &&
    runtime.connectionAdapter === "qwen_realtime" &&
    runtime.connectionStatus === "enabled" &&
    runtime.connectionVerifiedAt !== null
  );
}

export function classifyTeachingTargetAvailability(
  runtime: TeachingTargetRuntime,
  capability?: DynamicTeachingCapabilityBinding,
): LearningPlanTargetTeachingAvailability {
  if (
    runtime.provider !== TEACHING_DYNAMIC_PROVIDER ||
    !isDynamicTeachingModel(runtime.model) ||
    runtime.providerKind !== "realtime_voice" ||
    (runtime.connectionAdapter !== null &&
      runtime.connectionAdapter !== "qwen_realtime")
  ) {
    return { available: false, reason: "provider_unsupported" };
  }

  if (
    runtime.providerStatus !== "enabled" ||
    runtime.providerVerifiedAt === null ||
    runtime.voiceStatus !== "enabled" ||
    runtime.voiceVerifiedAt === null ||
    runtime.connectionId === null ||
    runtime.connectionRevision === null ||
    runtime.connectionAdapter === null ||
    runtime.connectionStatus !== "enabled" ||
    runtime.connectionVerifiedAt === null
  ) {
    return { available: false, reason: "realtime_unavailable" };
  }

  return isDynamicTeachingRuntimeEligible(runtime, capability)
    ? { available: true }
    : { available: false, reason: "configuration_not_approved" };
}

export function isDynamicTeachingModel(
  model: string,
): model is (typeof TEACHING_DYNAMIC_MODELS)[number] {
  return (TEACHING_DYNAMIC_MODELS as readonly string[]).includes(model);
}

export function isDynamicTeachingBindingApproved(
  runtime: Pick<
    TeachingTargetRuntime,
    | "modelProfileId"
    | "modelProfileRevision"
    | "connectionId"
    | "connectionRevision"
  >,
  capability?: DynamicTeachingCapabilityBinding,
): boolean {
  return (
    capability?.bindings.some(
      (binding) =>
        runtime.modelProfileId === binding.modelProfileId &&
        runtime.modelProfileRevision === binding.modelProfileRevision &&
        runtime.connectionId === binding.connectionId &&
        runtime.connectionRevision === binding.connectionRevision,
    ) === true
  );
}

export function isTeachingConfigurationRevisionCurrent<
  T extends { enabled: boolean; revision: number },
>(plan: T | null, expectedConfigurationRevision: number): plan is T {
  return (
    plan !== null &&
    plan.enabled &&
    plan.revision === expectedConfigurationRevision
  );
}

export function selectTeachingContentItemId(
  contentItemIds: readonly string[],
  contentCursor: number,
): string {
  const selected = contentItemIds[contentCursor % contentItemIds.length];
  if (selected === undefined) {
    throw new Error("Teaching content rotation requires a non-empty catalog.");
  }
  return selected;
}

export function shouldClearPublishedTeachingContent(
  activeContentRevisionId: string | null,
  nextLearningGoal: string | null,
): boolean {
  return activeContentRevisionId !== null && nextLearningGoal === null;
}

export function selectFiniteTeachingContentItem<T>(
  contentItems: readonly T[],
  contentCursor: number,
): T | null {
  if (!Number.isInteger(contentCursor) || contentCursor < 0) return null;
  return contentItems[contentCursor] ?? null;
}

export function isGeneratedTeachingContentExpired(
  activatedAt: Date,
  durationDays: number,
  checkedAt: Date,
): boolean {
  return (
    !Number.isInteger(durationDays) ||
    durationDays <= 0 ||
    checkedAt.getTime() >=
      activatedAt.getTime() + durationDays * 24 * 60 * 60 * 1_000
  );
}

async function loadValidatedGeneratedRuntimeContent(
  db: Queryable,
  contentRevisionId: string,
  plan: ChildCharacterLearningPlanRecord,
): Promise<{
  draft: GeneratedTeachingPlanDraft;
  items: CompiledTeachingContentItem[];
} | null> {
  const [revision] = await db
    .select()
    .from(teachingContentRevisions)
    .where(
      and(
        eq(teachingContentRevisions.id, contentRevisionId),
        eq(teachingContentRevisions.learningPlanId, plan.id),
      ),
    )
    .limit(1);
  if (!revision) {
    return null;
  }
  const storedItems = await db
    .select()
    .from(teachingContentItems)
    .where(eq(teachingContentItems.contentRevisionId, revision.id))
    .orderBy(asc(teachingContentItems.position));
  const parsedDraft = generatedTeachingPlanDraftSchema.safeParse({
    schemaVersion: revision.schemaVersion,
    compilerVersion: revision.compilerVersion,
    title: revision.title,
    normalizedGoal: revision.normalizedGoal,
    subject: revision.subject,
    difficulty: revision.difficulty,
    gradeLevel: revision.gradeLevel,
    activityCount: revision.activityCount,
    durationDays: revision.durationDays,
    activities: storedItems.map((item) => item.structuredContent),
  });
  if (!parsedDraft.success || storedItems.length !== revision.activityCount) {
    return null;
  }

  const canonicalItems: CompiledTeachingContentItem[] = [];
  const canonicalByKey = new Map<string, CompiledTeachingContentItem>();
  for (const [index, activity] of parsedDraft.data.activities.entries()) {
    const stored = storedItems[index];
    if (
      !stored ||
      stored.itemKey !== activity.key ||
      stored.position !== activity.order ||
      stored.kind !== activity.kind ||
      stored.maximumAssistantResponses !== 2
    ) {
      return null;
    }
    let canonical: CompiledTeachingContentItem;
    try {
      canonical = compileDeterministicTeachingContentItem(
        activity,
        parsedDraft.data.gradeLevel,
      );
    } catch {
      return null;
    }
    if (
      stored.compiledDirective !== canonical.directive ||
      stored.directiveHash !== hashTeachingDirective(canonical.directive)
    ) {
      return null;
    }
    canonicalItems.push(canonical);
    canonicalByKey.set(canonical.itemKey, canonical);
  }
  if (
    hashTeachingContent(parsedDraft.data, canonicalByKey) !==
    revision.contentHash
  ) {
    return null;
  }
  return { draft: parsedDraft.data, items: canonicalItems };
}

async function resolveConversationTeachingSnapshot(
  tx: Transaction,
  childUserId: string,
  characterId: string,
  expectedConfigurationRevision: number,
  acknowledgedDisclosureVersion: "teaching-disclosure-v1",
  conversationSupportsDynamicTeaching: boolean,
  capability: DynamicTeachingCapabilityBinding | undefined,
  preparedAt: Date,
) {
  const [plan] = await tx
    .select()
    .from(childCharacterLearningPlans)
    .where(
      and(
        eq(childCharacterLearningPlans.childUserId, childUserId),
        eq(childCharacterLearningPlans.characterId, characterId),
      ),
    )
    .limit(1);
  const currentPlan = plan ?? null;
  if (
    !isTeachingConfigurationRevisionCurrent(
      currentPlan,
      expectedConfigurationRevision,
    )
  ) {
    return { kind: "revision_conflict" as const };
  }
  const activeGeneratedContent =
    currentPlan.activeContentRevisionId !== null
      ? await loadValidatedGeneratedRuntimeContent(
          tx,
          currentPlan.activeContentRevisionId,
          currentPlan,
        )
      : null;
  const activeGeneratedContentIsCurrent =
    activeGeneratedContent !== null &&
    currentPlan.activeContentActivatedAt !== null &&
    !isGeneratedTeachingContentExpired(
      currentPlan.activeContentActivatedAt,
      activeGeneratedContent.draft.durationDays,
      preparedAt,
    ) &&
    currentPlan.contentCursor < activeGeneratedContent.items.length;
  const requiresGeneratedContent =
    currentPlan.activeContentRevisionId !== null ||
    currentPlan.learningGoal !== null ||
    currentPlan.subject === "chinese";
  if (requiresGeneratedContent && !activeGeneratedContentIsCurrent) {
    return {
      kind: "resolved" as const,
      snapshot: { state: "unavailable" as const },
    };
  }
  const runtime = await findPublicCharacterRuntime(tx, characterId);
  if (
    !conversationSupportsDynamicTeaching ||
    !runtime ||
    !isDynamicTeachingRuntimeEligible(runtime, capability)
  ) {
    return {
      kind: "resolved" as const,
      snapshot: { state: "unavailable" as const },
    };
  }
  return {
    kind: "resolved" as const,
    snapshot: {
      learningPlanId: currentPlan.id,
      learningPlanRevision: currentPlan.revision,
      subject: activeGeneratedContentIsCurrent
        ? activeGeneratedContent.draft.subject
        : currentPlan.subject,
      difficulty: activeGeneratedContentIsCurrent
        ? activeGeneratedContent.draft.difficulty
        : currentPlan.difficulty,
      triggerMode: currentPlan.triggerMode,
      disclosureVersion: acknowledgedDisclosureVersion,
      contentRevisionId: activeGeneratedContentIsCurrent
        ? currentPlan.activeContentRevisionId
        : null,
      contentCatalogVersion: activeGeneratedContentIsCurrent
        ? activeGeneratedContent.draft.schemaVersion ===
          "generated-teaching-plan-v2"
          ? ("generated-v2" as const)
          : ("generated-v1" as const)
        : ("reviewed-v1" as const),
      state: "available" as const,
    },
  };
}

async function persistChildMute(
  tx: Transaction,
  state: ConversationTeachingStateRecord,
  actorUserId: string,
  mutedAt: Date,
): Promise<ConversationTeachingStateRecord> {
  const nextRevision = state.revision + 1;
  const [muted] = await tx
    .update(conversationTeachingStates)
    .set({
      state: "muted",
      muteReason: "child_request",
      revision: nextRevision,
      updatedAt: mutedAt,
    })
    .where(
      and(
        eq(conversationTeachingStates.conversationId, state.conversationId),
        eq(conversationTeachingStates.revision, state.revision),
      ),
    )
    .returning();
  if (!muted) throw new Error("Teaching state mute lost its row lock.");
  await tx.insert(teachingEvents).values({
    conversationId: state.conversationId,
    learningPlanId: state.learningPlanId,
    eventType: "child_muted",
    actorUserId,
    stateRevision: nextRevision,
    createdAt: mutedAt,
  });
  return muted;
}

async function muteStatesForDisabledPlan(
  tx: Transaction,
  learningPlanId: string,
  actorUserId: string,
  mutedAt: Date,
): Promise<void> {
  const muted = await tx
    .update(conversationTeachingStates)
    .set({
      state: "muted",
      muteReason: "plan_disabled",
      revision: sql`${conversationTeachingStates.revision} + 1`,
      updatedAt: mutedAt,
    })
    .where(
      and(
        eq(conversationTeachingStates.learningPlanId, learningPlanId),
        inArray(conversationTeachingStates.state, [
          "available",
          "active",
          "restoring",
        ]),
      ),
    )
    .returning({
      conversationId: conversationTeachingStates.conversationId,
      learningPlanId: conversationTeachingStates.learningPlanId,
      stateRevision: conversationTeachingStates.revision,
    });
  if (muted.length === 0) return;
  await tx.insert(teachingEvents).values(
    muted.map((state) => ({
      conversationId: state.conversationId,
      learningPlanId: state.learningPlanId,
      eventType: "plan_disabled" as const,
      actorUserId,
      stateRevision: state.stateRevision,
      createdAt: mutedAt,
    })),
  );
}

async function recoverTeachingRuntimeState(
  tx: Transaction,
  state: ConversationTeachingStateRecord,
  recoveredAt: Date,
): Promise<ConversationTeachingStateRecord> {
  if (
    state.activeContentItemId === null ||
    !["active", "restoring", "muted"].includes(state.state)
  ) {
    return state;
  }
  const nextRevision = state.revision + 1;
  const [recovered] = await tx
    .update(conversationTeachingStates)
    .set({
      state: state.muteReason === null ? "completed" : "muted",
      activeContentItemId: null,
      revision: nextRevision,
      updatedAt: recoveredAt,
    })
    .where(
      and(
        eq(conversationTeachingStates.conversationId, state.conversationId),
        eq(conversationTeachingStates.revision, state.revision),
      ),
    )
    .returning();
  if (!recovered) throw new Error("Teaching recovery lost its row lock.");
  await tx.insert(teachingEvents).values({
    conversationId: state.conversationId,
    learningPlanId: state.learningPlanId,
    eventType: "completed",
    stateRevision: nextRevision,
    createdAt: recoveredAt,
  });
  return recovered;
}

async function transitionTeachingDirective(
  db: Database,
  input: {
    conversationId: string;
    expectedRevision: number;
    updatedAt?: Date;
    eventType: "restoring" | "completed";
    allowedStates: ConversationTeachingStateRecord["state"][];
    resolveState: (
      state: ConversationTeachingStateRecord,
    ) => "restoring" | "muted" | "completed";
    clearActiveContentItem?: boolean;
  },
): Promise<TransitionTeachingDirectiveResult> {
  const updatedAt = input.updatedAt ?? new Date();
  return db.transaction(async (tx) => {
    const [state] = await tx
      .select()
      .from(conversationTeachingStates)
      .where(
        eq(conversationTeachingStates.conversationId, input.conversationId),
      )
      .for("update")
      .limit(1);
    if (!state) return { kind: "not_found" };
    if (state.revision !== input.expectedRevision) {
      return { kind: "revision_conflict" };
    }
    const nextState = input.resolveState(state);
    if (
      state.state === nextState &&
      (!input.clearActiveContentItem || state.activeContentItemId === null)
    ) {
      return { kind: "unchanged", state };
    }
    if (!input.allowedStates.includes(state.state)) {
      return { kind: "invalid_state" };
    }
    if (!state.activeContentItemId) return { kind: "invalid_state" };
    const nextRevision = state.revision + 1;
    const [updated] = await tx
      .update(conversationTeachingStates)
      .set({
        state: nextState,
        ...(input.clearActiveContentItem ? { activeContentItemId: null } : {}),
        revision: nextRevision,
        updatedAt,
      })
      .where(
        and(
          eq(conversationTeachingStates.conversationId, state.conversationId),
          eq(conversationTeachingStates.revision, state.revision),
        ),
      )
      .returning();
    if (!updated) throw new Error("Teaching transition lost its row lock.");
    await tx.insert(teachingEvents).values({
      conversationId: state.conversationId,
      learningPlanId: state.learningPlanId,
      eventType: input.eventType,
      stateRevision: nextRevision,
      createdAt: updatedAt,
    });
    return { kind: "transitioned", state: updated };
  });
}
