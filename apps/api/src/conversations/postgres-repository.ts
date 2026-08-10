import {
  appendConversationMessages,
  completeConversation,
  createConversation,
  deleteOwnedConversation,
  findReadableConversation,
  isGuardianReadableHistoryTarget,
  loadConversationRealtimeContext,
  listConversations,
  type Database,
} from "@meet/database";

import type { ConversationRepository } from "./repository.js";

export class PostgresConversationRepository implements ConversationRepository {
  constructor(private readonly db: Database) {}

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
  ) {
    return loadConversationRealtimeContext(this.db, {
      actorUserId,
      conversationId,
      characterId,
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
    });
  }

  delete(actorUserId: string, conversationId: string) {
    return deleteOwnedConversation(this.db, actorUserId, conversationId);
  }
}
