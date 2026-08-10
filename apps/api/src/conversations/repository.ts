import type {
  AppendConversationMessagesRequest,
  ConversationMode,
} from "@meet/protocol";
import type {
  AppendConversationMessagesResult,
  CompleteConversationResult,
  ConversationAggregate,
  ConversationDetailAggregate,
  ConversationRealtimeContext,
  CreateConversationResult,
} from "@meet/database";

export interface ConversationRepository {
  create(
    actorUserId: string,
    input: { id: string; characterId: string; mode: ConversationMode },
    startedAt: Date,
  ): Promise<CreateConversationResult>;
  list(targetUserId: string, limit: number): Promise<ConversationAggregate[]>;
  isGuardianReadableTarget(targetUserId: string): Promise<boolean>;
  findReadable(
    actorUserId: string,
    actorCanReadChildren: boolean,
    conversationId: string,
  ): Promise<ConversationDetailAggregate | null>;
  loadRealtimeContext(
    actorUserId: string,
    conversationId: string,
    characterId: string,
  ): Promise<ConversationRealtimeContext | null>;
  appendMessages(
    actorUserId: string,
    conversationId: string,
    messages: AppendConversationMessagesRequest["messages"],
    updatedAt: Date,
  ): Promise<AppendConversationMessagesResult>;
  complete(
    actorUserId: string,
    conversationId: string,
    lastSequence: number,
    endedAt: Date,
  ): Promise<CompleteConversationResult>;
  delete(actorUserId: string, conversationId: string): Promise<boolean>;
}
