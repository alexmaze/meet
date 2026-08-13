import {
  appendConversationMessages,
  completeConversation,
  createConversation,
  deleteOwnedConversation,
  findReadableConversation,
  isGuardianReadableHistoryTarget,
  loadConversationRealtimeContext,
  loadActiveCharacterMemoriesByIds,
  listConversations,
  type Database,
  type ConversationCheckpointHook,
  type ConversationCompletionHook,
} from "@meet/database";

import type { ConversationRepository } from "./repository.js";

export class PostgresConversationRepository implements ConversationRepository {
  constructor(
    private readonly db: Database,
    private readonly onCompleted?: ConversationCompletionHook,
    private readonly onCheckpoint?: ConversationCheckpointHook,
  ) {}

  create(
    actorUserId: string,
    input: Parameters<ConversationRepository["create"]>[1],
    startedAt: Date,
  ) {
    return createConversation(this.db, {
      ...input,
      actorUserId,
      startedAt,
    });
  }

  list(targetUserId: string, limit: number) {
    return listConversations(this.db, targetUserId, limit);
  }

  isGuardianReadableTarget(targetUserId: string) {
    return isGuardianReadableHistoryTarget(this.db, targetUserId);
  }

  findReadable(
    actorUserId: string,
    actorCanReadChildren: boolean,
    conversationId: string,
  ) {
    return findReadableConversation(this.db, {
      actorUserId,
      actorCanReadChildren,
      conversationId,
    });
  }

  loadRealtimeContext(
    actorUserId: string,
    conversationId: string,
    characterId: string,
    runtimeSnapshot?: Parameters<
      ConversationRepository["loadRealtimeContext"]
    >[3],
  ) {
    return loadConversationRealtimeContext(this.db, {
      actorUserId,
      conversationId,
      characterId,
      runtimeSnapshot,
    });
  }

  loadActiveMemoriesByIds(
    actorUserId: string,
    characterId: string,
    memoryIds: string[],
  ) {
    return loadActiveCharacterMemoriesByIds(this.db, {
      userId: actorUserId,
      characterId,
      memoryIds,
    });
  }

  appendMessages(
    actorUserId: string,
    conversationId: string,
    messages: Parameters<ConversationRepository["appendMessages"]>[2],
    updatedAt: Date,
  ) {
    return appendConversationMessages(this.db, {
      actorUserId,
      conversationId,
      messages,
      updatedAt,
      onCheckpoint: this.onCheckpoint,
    });
  }

  complete(
    actorUserId: string,
    conversationId: string,
    lastSequence: number,
    endedAt: Date,
  ) {
    return completeConversation(this.db, {
      actorUserId,
      conversationId,
      lastSequence,
      endedAt,
      onCompleted: this.onCompleted,
    });
  }

  delete(actorUserId: string, conversationId: string) {
    return deleteOwnedConversation(this.db, actorUserId, conversationId);
  }
}
