import {
  appendConversationMessages,
  prepareConversation,
  readConversationLifecycle,
  listConversationOverviewIds,
  heartbeatConversationWriter,
  attachConversationConnection,
  heartbeatConversationConnection,
  detachConversationConnection,
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
    writer: Parameters<ConversationRepository["appendMessages"]>[4],
  ) {
    return appendConversationMessages(this.db, {
      actorUserId,
      conversationId,
      messages,
      updatedAt,
      writer,
      onCheckpoint: this.onCheckpoint,
    });
  }

  complete(
    actorUserId: string,
    conversationId: string,
    input: Parameters<ConversationRepository["complete"]>[2],
    endedAt: Date,
  ) {
    return completeConversation(this.db, {
      actorUserId,
      conversationId,
      ...input,
      endedAt,
      onCompleted: this.onCompleted,
    });
  }

  prepare(
    actorUserId: string,
    conversationId: string,
    input: Parameters<ConversationRepository["prepare"]>[2],
    now: Date,
  ) {
    return prepareConversation(this.db, {
      ...input,
      actorUserId,
      conversationId,
      now,
    });
  }
  readLifecycle(conversationId: string, requestId?: string) {
    return readConversationLifecycle(this.db, conversationId, requestId);
  }
  overview(actorUserId: string, characterId?: string) {
    return listConversationOverviewIds(this.db, actorUserId, characterId);
  }
  heartbeatWriter(
    actorUserId: string,
    conversationId: string,
    writer: Parameters<ConversationRepository["heartbeatWriter"]>[2],
    now: Date,
  ) {
    return heartbeatConversationWriter(this.db, {
      actorUserId,
      conversationId,
      writer,
      now,
    });
  }
  attachConnection(
    actorUserId: string,
    conversationId: string,
    writer: Parameters<ConversationRepository["attachConnection"]>[2],
    connectionId: string,
    now: Date,
  ) {
    return attachConversationConnection(this.db, {
      actorUserId,
      conversationId,
      writer,
      connectionId,
      now,
    });
  }
  heartbeatConnection(
    actorUserId: string,
    conversationId: string,
    writer: Parameters<ConversationRepository["heartbeatConnection"]>[2],
    connectionId: string,
    now: Date,
    options?: { active?: boolean; activity?: boolean },
  ) {
    return heartbeatConversationConnection(this.db, {
      actorUserId,
      conversationId,
      writer,
      connectionId,
      now,
      ...options,
    });
  }
  detachConnection(
    actorUserId: string,
    conversationId: string,
    writer: Parameters<ConversationRepository["detachConnection"]>[2],
    connectionId: string,
    now: Date,
  ) {
    return detachConversationConnection(this.db, {
      actorUserId,
      conversationId,
      writer,
      connectionId,
      now,
    });
  }

  delete(actorUserId: string, conversationId: string) {
    return deleteOwnedConversation(this.db, actorUserId, conversationId);
  }
}
