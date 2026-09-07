import type {
  AppendConversationMessagesRequest,
  ConversationMode,
  ConversationRuntimeSnapshot,
  ConversationWriter,
  PrepareConversationRequest,
  CompleteConversationRequest,
} from "@meet/protocol";
import type {
  AppendConversationMessagesResult,
  CompleteConversationResult,
  ConversationAggregate,
  ConversationDetailAggregate,
  ConversationRealtimeContext,
  CreateConversationResult,
  ConversationLifecycleAggregate,
  prepareConversation,
  heartbeatConversationWriter,
  attachConversationConnection,
  heartbeatConversationConnection,
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
    runtimeSnapshot?: ConversationRuntimeSnapshot,
  ): Promise<ConversationRealtimeContext | null>;
  loadActiveMemoriesByIds(
    actorUserId: string,
    characterId: string,
    memoryIds: string[],
  ): Promise<Array<{ id: string; content: string; updatedAt: Date }>>;
  appendMessages(
    actorUserId: string,
    conversationId: string,
    messages: AppendConversationMessagesRequest["messages"],
    updatedAt: Date,
    writer: ConversationWriter,
  ): Promise<AppendConversationMessagesResult>;
  complete(
    actorUserId: string,
    conversationId: string,
    input: CompleteConversationRequest,
    endedAt: Date,
  ): Promise<CompleteConversationResult>;
  prepare(
    actorUserId: string,
    conversationId: string,
    input: PrepareConversationRequest,
    now: Date,
  ): ReturnType<typeof prepareConversation>;
  readLifecycle(
    conversationId: string,
    requestId?: string,
  ): Promise<ConversationLifecycleAggregate | null>;
  overview(
    actorUserId: string,
    characterId?: string,
  ): Promise<{ pending: string[]; recent: string[] }>;
  heartbeatWriter(
    actorUserId: string,
    conversationId: string,
    writer: ConversationWriter,
    now: Date,
  ): ReturnType<typeof heartbeatConversationWriter>;
  attachConnection(
    actorUserId: string,
    conversationId: string,
    writer: ConversationWriter,
    connectionId: string,
    now: Date,
  ): ReturnType<typeof attachConversationConnection>;
  heartbeatConnection(
    actorUserId: string,
    conversationId: string,
    writer: ConversationWriter,
    connectionId: string,
    now: Date,
    options?: { active?: boolean; activity?: boolean },
  ): ReturnType<typeof heartbeatConversationConnection>;
  detachConnection(
    actorUserId: string,
    conversationId: string,
    writer: ConversationWriter,
    connectionId: string,
    now: Date,
  ): Promise<void>;
  delete(actorUserId: string, conversationId: string): Promise<boolean>;
}
