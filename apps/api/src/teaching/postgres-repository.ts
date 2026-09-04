import {
  beginTeachingPlanGeneration,
  claimTeachingInvitation,
  completeTeachingPlanGeneration,
  failTeachingPlanGeneration,
  getChildTeachingAvailability,
  getTeachingPlanContent,
  getTeachingPlanGeneration,
  listChildLearningPlans,
  loadTeachingRuntimeForReconnect,
  listTeachingManagementTargets,
  markTeachingCompleted,
  markTeachingRestoring,
  muteConversationTeaching,
  prepareConversationTeaching,
  publishTeachingPlanContent,
  putChildLearningPlan,
  recordValidTeachingTurn,
  recoverTeachingRuntimeForReconnect,
  startTeachingPlanGeneration,
  type DynamicTeachingCapabilityBinding,
  type Database,
} from "@meet/database";

import type { TeachingRepository } from "./repository.js";

export class PostgresTeachingRepository implements TeachingRepository {
  constructor(
    private readonly db: Database,
    private readonly capability?: DynamicTeachingCapabilityBinding,
  ) {}

  listManagementTargets(actorUserId: string) {
    return listTeachingManagementTargets(this.db, actorUserId, this.capability);
  }

  listChildPlans(input: Parameters<TeachingRepository["listChildPlans"]>[0]) {
    return listChildLearningPlans(this.db, input);
  }

  putChildPlan(input: Parameters<TeachingRepository["putChildPlan"]>[0]) {
    return putChildLearningPlan(this.db, input);
  }

  beginGeneration(
    input: Parameters<NonNullable<TeachingRepository["beginGeneration"]>>[0],
  ) {
    return beginTeachingPlanGeneration(this.db, input);
  }

  startGeneration(
    input: Parameters<NonNullable<TeachingRepository["startGeneration"]>>[0],
  ) {
    return startTeachingPlanGeneration(this.db, input);
  }

  completeGeneration(
    input: Parameters<NonNullable<TeachingRepository["completeGeneration"]>>[0],
  ) {
    return completeTeachingPlanGeneration(this.db, input);
  }

  failGeneration(
    input: Parameters<NonNullable<TeachingRepository["failGeneration"]>>[0],
  ) {
    return failTeachingPlanGeneration(this.db, input);
  }

  getGeneration(
    input: Parameters<NonNullable<TeachingRepository["getGeneration"]>>[0],
  ) {
    return getTeachingPlanGeneration(this.db, input);
  }

  getContent(
    input: Parameters<NonNullable<TeachingRepository["getContent"]>>[0],
  ) {
    return getTeachingPlanContent(this.db, input);
  }

  publishContent(
    input: Parameters<NonNullable<TeachingRepository["publishContent"]>>[0],
  ) {
    return publishTeachingPlanContent(this.db, input);
  }

  getChildAvailability(
    input: Parameters<TeachingRepository["getChildAvailability"]>[0],
  ) {
    return getChildTeachingAvailability(this.db, input, this.capability);
  }

  prepareConversation(
    input: Parameters<TeachingRepository["prepareConversation"]>[0],
  ) {
    return prepareConversationTeaching(this.db, input, this.capability);
  }

  muteConversation(
    input: Parameters<TeachingRepository["muteConversation"]>[0],
  ) {
    return muteConversationTeaching(this.db, input);
  }

  recordValidTurn(input: Parameters<TeachingRepository["recordValidTurn"]>[0]) {
    return recordValidTeachingTurn(this.db, input);
  }

  claimInvitation(input: Parameters<TeachingRepository["claimInvitation"]>[0]) {
    if (!this.capability) {
      return Promise.resolve({
        kind: "not_eligible" as const,
        reason: "state_unavailable" as const,
      });
    }
    return claimTeachingInvitation(this.db, input);
  }

  markRestoring(input: Parameters<TeachingRepository["markRestoring"]>[0]) {
    return markTeachingRestoring(this.db, input);
  }

  markCompleted(input: Parameters<TeachingRepository["markCompleted"]>[0]) {
    return markTeachingCompleted(this.db, input);
  }

  recoverForReconnect(
    input: Parameters<TeachingRepository["recoverForReconnect"]>[0],
  ) {
    return recoverTeachingRuntimeForReconnect(this.db, input);
  }

  loadRuntimeForReconnect(
    input: Parameters<TeachingRepository["loadRuntimeForReconnect"]>[0],
  ) {
    return loadTeachingRuntimeForReconnect(this.db, input);
  }
}
