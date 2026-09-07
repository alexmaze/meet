import type {
  AppendConversationMessagesRequest,
  ConversationMessage,
  ConversationRuntimeSnapshot,
  ConversationSummary,
  CreateConversationRequest,
  UserAccount,
  ConversationWriter,
  PrepareConversationRequest,
  PrepareConversationResponse,
  CompleteConversationRequest,
  ConversationContinuityStatus,
  ConversationOverviewResponse,
} from "@meet/protocol";
import {
  conversationMessageSchema,
  conversationSummarySchema,
} from "@meet/protocol";
import {
  CONVERSATION_LEASE_MS,
  CONVERSATION_HEARTBEAT_MS,
  hasLiveConnection,
  hasLiveWriter,
  connectedDuration,
} from "@meet/database";
import type {
  ConversationAggregate,
  ConversationDetailAggregate,
  ConversationMessageRecord,
  ConversationRealtimeContext,
  ConversationLifecycleAggregate,
  ConversationControlFailure,
} from "@meet/database";
import {
  resolveSemanticMemoryStore,
  type SemanticMemoryStoreSource,
} from "@meet/memory";
import type { ZodType } from "zod";

import type { ConversationRepository } from "./repository.js";
import {
  assembleConversationContext,
  type ContextDiagnostics,
} from "./context-assembler.js";

export type ConversationServiceErrorCode =
  | "CONVERSATION_NOT_FOUND"
  | "CONVERSATION_ID_CONFLICT"
  | "CONVERSATION_SEQUENCE_CONFLICT"
  | "CONVERSATION_ALREADY_COMPLETED"
  | "CONVERSATION_SERVICE_UNAVAILABLE"
  | "CONVERSATION_IN_USE"
  | "CONVERSATION_WRITER_STALE"
  | "CONVERSATION_REQUEST_CONFLICT"
  | "CONVERSATION_CHARACTER_UNAVAILABLE"
  | "CONVERSATION_END_PENDING"
  | "CONVERSATION_MESSAGES_MISSING";

export class ConversationServiceError extends Error {
  constructor(
    readonly code: ConversationServiceErrorCode,
    message: string,
    readonly statusCode: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConversationServiceError";
  }
}

export type ConversationRealtimeLaunchContext = {
  mode: "normal" | "temporary";
  runtimeSnapshot: ConversationRuntimeSnapshot | null;
  relationshipContext?: string;
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
  }>;
  diagnostics: ContextDiagnostics;
};

export class ConversationService {
  constructor(
    private readonly repository: ConversationRepository | null,
    private readonly now: () => Date = () => new Date(),
    private readonly semanticMemoryStore?: SemanticMemoryStoreSource,
    private readonly semanticMemoryOptions: {
      limit: number;
      threshold?: number;
    } = { limit: 8, threshold: 0.35 },
  ) {}

  async create(
    actor: UserAccount,
    input: CreateConversationRequest,
  ): Promise<ConversationSummary> {
    const result = await this.call((repository) =>
      repository.create(actor.id, input, this.now()),
    );
    if (result.kind === "character_not_found") throw notFound();
    if (result.kind === "id_conflict") {
      throw new ConversationServiceError(
        "CONVERSATION_ID_CONFLICT",
        "这个会话标识已经被其他会话使用。",
        409,
      );
    }
    return toSummary(result.conversation);
  }

  async list(
    actor: UserAccount,
    targetUserId: string | undefined,
    limit: number,
  ): Promise<ConversationSummary[]> {
    const target = targetUserId ?? actor.id;
    if (target !== actor.id) {
      if (actor.accountType !== "admin") throw notFound();
      const readable = await this.call((repository) =>
        repository.isGuardianReadableTarget(target),
      );
      if (!readable) throw notFound();
    }
    const conversations = await this.call((repository) =>
      repository.list(target, limit),
    );
    return conversations.map(toSummary);
  }

  async find(
    actor: UserAccount,
    conversationId: string,
  ): Promise<{
    conversation: ConversationSummary;
    messages: ConversationMessage[];
    continuity: ConversationContinuityStatus;
  }> {
    const detail = await this.call((repository) =>
      repository.findReadable(
        actor.id,
        actor.accountType === "admin",
        conversationId,
      ),
    );
    if (!detail) throw notFound();
    return {
      ...toDetail(detail),
      continuity: await this.status(actor, conversationId),
    };
  }

  async realtimeContext(
    actor: UserAccount,
    conversationId: string,
    characterId: string,
    runtimeSnapshot?: ConversationRuntimeSnapshot,
  ): Promise<ConversationRealtimeLaunchContext> {
    const context = await this.call((repository) =>
      runtimeSnapshot
        ? repository.loadRealtimeContext(
            actor.id,
            conversationId,
            characterId,
            runtimeSnapshot,
          )
        : repository.loadRealtimeContext(actor.id, conversationId, characterId),
    );
    if (!context) throw notFound();
    const effectiveRuntimeSnapshot =
      context.runtimeSnapshot ?? runtimeSnapshot ?? null;
    const messages = context.messages.filter((message) => {
      if (message.conversationId === conversationId) return true;
      return (
        context.mode === "normal" && message.conversationStatus === "completed"
      );
    });
    const recall = await this.recallMemories(
      actor.id,
      characterId,
      conversationId,
      context,
    );
    const assembled = assembleConversationContext({
      runtimeSnapshot: effectiveRuntimeSnapshot,
      messages,
      summaries: context.mode === "normal" ? context.summaries : [],
      memories: context.mode === "normal" ? recall.memories : [],
      checkpoint: context.checkpoint,
    });
    assembled.diagnostics.memoryRecall = recall.diagnostics;
    return {
      mode: context.mode,
      runtimeSnapshot: effectiveRuntimeSnapshot,
      relationshipContext: assembled.relationshipContext,
      messages: assembled.messages,
      diagnostics: assembled.diagnostics,
    };
  }

  private async recallMemories(
    actorUserId: string,
    characterId: string,
    conversationId: string,
    context: ConversationRealtimeContext,
  ): Promise<{
    memories: ConversationRealtimeContext["memories"];
    diagnostics: ContextDiagnostics["memoryRecall"];
  }> {
    if (context.mode !== "normal" || !this.semanticMemoryStore) {
      return {
        memories: context.memories,
        diagnostics: {
          mode: "disabled",
          queryMessageCount: 0,
          hitCount: 0,
        },
      };
    }
    let store;
    try {
      store = await resolveSemanticMemoryStore(this.semanticMemoryStore);
    } catch {
      return {
        memories: context.memories,
        diagnostics: {
          mode: "fallback",
          queryMessageCount: 0,
          hitCount: 0,
        },
      };
    }
    if (!store) {
      return {
        memories: context.memories,
        diagnostics: {
          mode: "disabled",
          queryMessageCount: 0,
          hitCount: 0,
        },
      };
    }
    const query = buildMemoryRecallQuery(context.messages, conversationId);
    if (!query.text) {
      return {
        memories: context.memories,
        diagnostics: {
          mode: "fallback",
          queryMessageCount: 0,
          hitCount: 0,
        },
      };
    }
    try {
      const hits = await store.search({
        userId: actorUserId,
        characterId,
        query: query.text,
        limit: this.semanticMemoryOptions.limit,
        threshold: this.semanticMemoryOptions.threshold,
      });
      const memoryIds = hits
        .map(({ localMemoryId }) => localMemoryId)
        .filter((id): id is string => Boolean(id && UUID_PATTERN.test(id)));
      const semanticMemories = await this.call((repository) =>
        repository.loadActiveMemoriesByIds(actorUserId, characterId, memoryIds),
      );
      const byId = new Map(
        semanticMemories.map((memory) => [memory.id, memory]),
      );
      const ranked = memoryIds.flatMap((id) => {
        const memory = byId.get(id);
        return memory ? [memory] : [];
      });
      return {
        memories: mergeMemories(ranked, context.memories),
        diagnostics: {
          mode: "semantic",
          queryMessageCount: query.messageCount,
          hitCount: ranked.length,
        },
      };
    } catch {
      return {
        memories: context.memories,
        diagnostics: {
          mode: "fallback",
          queryMessageCount: query.messageCount,
          hitCount: 0,
        },
      };
    }
  }

  async appendMessages(
    actor: UserAccount,
    conversationId: string,
    input: AppendConversationMessagesRequest,
  ): Promise<number> {
    const result = await this.call((repository) =>
      repository.appendMessages(
        actor.id,
        conversationId,
        input.messages,
        this.now(),
        input.writer,
      ),
    );
    if (result.kind === "not_found") throw notFound();
    if (result.kind === "completed") {
      throw new ConversationServiceError(
        "CONVERSATION_ALREADY_COMPLETED",
        "通话已经结束，不能再写入消息。",
        409,
      );
    }
    if (result.kind === "sequence_conflict") throw sequenceConflict();
    if (result.kind === "messages_missing")
      throw new ConversationServiceError(
        "CONVERSATION_MESSAGES_MISSING",
        "还有已完成文字尚未保存，请先重试同步；若原文字已丢失，可确认只保留已收到的内容。",
        409,
      );
    if (!("acknowledgedSequence" in result)) throw controlError(result.kind);
    return result.acknowledgedSequence;
  }

  async complete(
    actor: UserAccount,
    conversationId: string,
    input: CompleteConversationRequest,
  ): Promise<ConversationSummary> {
    const result = await this.call((repository) =>
      repository.complete(actor.id, conversationId, input, this.now()),
    );
    if (result.kind === "not_found") throw notFound();
    if (result.kind === "sequence_conflict") throw sequenceConflict();
    if (result.kind === "messages_missing")
      throw new ConversationServiceError(
        "CONVERSATION_MESSAGES_MISSING",
        "还有已完成文字尚未保存，请先重试同步；若原文字已丢失，可确认只保留已收到的内容。",
        409,
      );
    if (!("conversation" in result)) throw controlError(result.kind);
    return toSummary(result.conversation);
  }

  async status(
    actor: UserAccount,
    conversationId: string,
    clientId?: string,
    requestId?: string,
  ): Promise<ConversationContinuityStatus> {
    const lifecycle = await this.call((repository) =>
      repository.readLifecycle(conversationId, requestId),
    );
    if (!lifecycle) throw notFound();
    if (lifecycle.aggregate.conversation.userId !== actor.id) {
      const readable = await this.call((repository) =>
        repository.findReadable(
          actor.id,
          actor.accountType === "admin",
          conversationId,
        ),
      );
      if (!readable) throw notFound();
    }
    return presentConversationLifecycle(
      lifecycle,
      actor.id,
      clientId,
      this.now(),
    );
  }

  async overview(
    actor: UserAccount,
    clientId?: string,
    characterId?: string,
  ): Promise<ConversationOverviewResponse> {
    const ids = await this.call((repository) =>
      repository.overview(actor.id, characterId),
    );
    const load = async (id: string) => {
      const lifecycle = await this.call((repository) =>
        repository.readLifecycle(id),
      );
      if (!lifecycle || lifecycle.aggregate.conversation.userId !== actor.id)
        return null;
      return presentConversationLifecycle(
        lifecycle,
        actor.id,
        clientId,
        this.now(),
      );
    };
    const [pending, recent] = await Promise.all([
      Promise.all(ids.pending.map(load)),
      Promise.all(ids.recent.map(load)),
    ]);
    return {
      pending: pending.filter(
        (item): item is ConversationContinuityStatus => item !== null,
      ),
      pendingCount: pending.filter(Boolean).length,
      recent: recent.filter(
        (item): item is ConversationContinuityStatus => item !== null,
      ),
    };
  }

  async prepare(
    actor: UserAccount,
    conversationId: string,
    input: PrepareConversationRequest,
  ): Promise<PrepareConversationResponse> {
    const result = await this.call((repository) =>
      repository.prepare(actor.id, conversationId, input, this.now()),
    );
    if (result.kind !== "prepared") throw controlError(result.kind);
    const runtime = result.runtimeSnapshot;
    return {
      status: await this.status(actor, conversationId, input.clientId),
      writer: result.writer,
      launch:
        input.intent === "finish"
          ? "finish"
          : result.hasConnected
            ? "resume"
            : "initial",
      realtime:
        input.intent === "connect" && runtime
          ? {
              provider: runtime.provider,
              realtimeModelProfileId: runtime.realtimeModelProfileId,
              model: runtime.model,
              voice: runtime.voice,
              firstSpeaker: result.hasConnected ? "user" : runtime.firstSpeaker,
              openingLine: result.hasConnected ? null : runtime.openingLine,
            }
          : null,
    };
  }

  async heartbeatWriter(
    actor: UserAccount,
    conversationId: string,
    writer: ConversationWriter,
  ): Promise<void> {
    const result = await this.call((repository) =>
      repository.heartbeatWriter(actor.id, conversationId, writer, this.now()),
    );
    if (result.kind !== "renewed") throw controlError(result.kind);
  }

  async attachConnection(
    actor: UserAccount,
    conversationId: string,
    writer: ConversationWriter,
    connectionId: string,
  ): Promise<{
    initial: boolean;
    heartbeatIntervalMs: number;
    leaseDurationMs: number;
  }> {
    const result = await this.call((repository) =>
      repository.attachConnection(
        actor.id,
        conversationId,
        writer,
        connectionId,
        this.now(),
      ),
    );
    if (result.kind !== "attached") throw controlError(result.kind);
    return {
      initial: result.initial,
      heartbeatIntervalMs: CONVERSATION_HEARTBEAT_MS,
      leaseDurationMs: CONVERSATION_LEASE_MS,
    };
  }

  async heartbeatConnection(
    actor: UserAccount,
    conversationId: string,
    writer: ConversationWriter,
    connectionId: string,
    options?: { active?: boolean; activity?: boolean },
  ): Promise<void> {
    const result = await this.call((repository) =>
      repository.heartbeatConnection(
        actor.id,
        conversationId,
        writer,
        connectionId,
        this.now(),
        options,
      ),
    );
    if (result.kind !== "renewed") throw controlError(result.kind);
  }

  async detachConnection(
    actor: UserAccount,
    conversationId: string,
    writer: ConversationWriter,
    connectionId: string,
  ): Promise<void> {
    await this.call((repository) =>
      repository.detachConnection(
        actor.id,
        conversationId,
        writer,
        connectionId,
        this.now(),
      ),
    );
  }

  async delete(actor: UserAccount, conversationId: string): Promise<void> {
    const deleted = await this.call((repository) =>
      repository.delete(actor.id, conversationId),
    );
    if (!deleted) throw notFound();
  }

  private async call<T>(
    operation: (repository: ConversationRepository) => Promise<T>,
  ): Promise<T> {
    const repository = this.repository;
    if (!repository) throw unavailable();
    try {
      return await operation(repository);
    } catch (error) {
      if (error instanceof ConversationServiceError) throw error;
      throw unavailable(error);
    }
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function buildMemoryRecallQuery(
  messages: ConversationRealtimeContext["messages"],
  conversationId: string,
): { text: string; messageCount: number } {
  const currentUserMessages = messages.filter(
    (message) =>
      message.conversationId === conversationId && message.role === "user",
  );
  const candidates =
    currentUserMessages.length > 0
      ? currentUserMessages
      : messages.filter((message) => message.role === "user");
  const selected = candidates.slice(-6);
  const text = selected
    .map((message) => message.text.trim())
    .filter(Boolean)
    .join("\n")
    .slice(-1_600)
    .trim();
  return { text, messageCount: selected.length };
}

function mergeMemories<T extends { id: string }>(
  semantic: T[],
  recent: T[],
): T[] {
  const seen = new Set<string>();
  return [...semantic, ...recent].filter((memory) => {
    if (seen.has(memory.id)) return false;
    seen.add(memory.id);
    return true;
  });
}

function toDetail(detail: ConversationDetailAggregate) {
  return {
    conversation: toSummary(detail),
    messages: detail.messages.map(toMessage),
  };
}

function toSummary(aggregate: ConversationAggregate): ConversationSummary {
  const record = aggregate.conversation;
  return parsePublic(conversationSummarySchema, {
    id: record.id,
    userId: record.userId,
    character: aggregate.character,
    mode: record.mode,
    status: record.status,
    messageCount: record.messageCount,
    lastSequence: record.lastSequence,
    provider: record.provider,
    model: record.model,
    voice: record.voice,
    startedAt: record.startedAt.toISOString(),
    endedAt: record.endedAt?.toISOString() ?? null,
    updatedAt: record.updatedAt.toISOString(),
  });
}

function toMessage(record: ConversationMessageRecord): ConversationMessage {
  return parsePublic(conversationMessageSchema, {
    id: record.id,
    conversationId: record.conversationId,
    sequence: record.sequence,
    role: record.role,
    status: record.status,
    text: record.text,
    providerEventId: record.providerEventId,
    createdAt: record.createdAt.toISOString(),
  });
}

function parsePublic<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw unavailable(parsed.error);
  return parsed.data;
}

function notFound(): ConversationServiceError {
  return new ConversationServiceError(
    "CONVERSATION_NOT_FOUND",
    "没有找到这条通话记录。",
    404,
  );
}

function sequenceConflict(): ConversationServiceError {
  return new ConversationServiceError(
    "CONVERSATION_SEQUENCE_CONFLICT",
    "消息顺序与服务端记录不一致，请重新载入通话记录。",
    409,
  );
}

function unavailable(cause?: unknown): ConversationServiceError {
  return new ConversationServiceError(
    "CONVERSATION_SERVICE_UNAVAILABLE",
    "通话记录服务暂时不可用，请稍后重试。",
    503,
    cause === undefined ? undefined : { cause },
  );
}

export function presentConversationLifecycle(
  value: ConversationLifecycleAggregate,
  actorUserId: string,
  clientId: string | undefined,
  now: Date,
): ConversationContinuityStatus {
  const { aggregate, control, operation } = value;
  const completed = aggregate.conversation.status === "completed";
  const emptyCompleted = completed && aggregate.conversation.messageCount === 0;
  const isOwner = aggregate.conversation.userId === actorUserId;
  const live = Boolean(control && hasLiveConnection(control, now));
  const occupied = Boolean(
    control &&
    hasLiveWriter(control, now) &&
    control.writerClientId !== clientId,
  );
  const knownLease = Boolean(control && hasLiveWriter(control, now));
  const inUse = live || occupied;
  const state = completed
    ? "completed"
    : live
      ? control?.connectionStartedAt
        ? "connected"
        : "connecting"
      : knownLease
        ? control?.hasConnected
          ? "recovering"
          : "connecting"
        : "interrupted";
  const endOperation = operation?.kind === "finish" ? operation : null;
  return {
    conversation: toSummary(aggregate),
    connectionState: state,
    writerClientId: isOwner ? (control?.writerClientId ?? null) : null,
    writerEpoch: isOwner ? (control?.writerEpoch ?? 0) : 0,
    leaseExpiresAt: isOwner
      ? (control?.leaseExpiresAt?.toISOString() ?? null)
      : null,
    lastActivityAt:
      control?.lastActivityAt?.toISOString() ??
      aggregate.conversation.endedAt?.toISOString() ??
      null,
    lastSavedAt: control?.lastSavedAt?.toISOString() ?? null,
    connectedDurationMs: control ? connectedDuration(control, now) : 0,
    finalizedAt: control?.finalizedAt?.toISOString() ?? null,
    hasConnected:
      control?.hasConnected ?? aggregate.conversation.messageCount > 0,
    endRequestId: isOwner
      ? (endOperation?.requestId ?? control?.endRequestId ?? null)
      : null,
    endTargetSequence: isOwner
      ? (endOperation?.targetSequence ?? control?.endTargetSequence ?? null)
      : null,
    isOwner,
    canResume:
      isOwner &&
      !completed &&
      !inUse &&
      value.characterAvailable &&
      !control?.endRequestId,
    canFinish: isOwner && !completed && !inUse,
    unavailableReason: completed
      ? "completed"
      : inUse
        ? "in_use"
        : !value.characterAvailable
          ? "character_unavailable"
          : null,
    summary: {
      state:
        emptyCompleted &&
        value.summary.status === null &&
        value.summary.content === null
          ? "not_applicable"
          : analysisState(value.summary.status, value.summary.content !== null),
      content: value.summary.content,
    },
    memory: {
      state:
        aggregate.conversation.mode === "temporary" ||
        (emptyCompleted && value.memory.status === null)
          ? "not_applicable"
          : analysisState(value.memory.status, false),
      activeCount: value.memory.activeCount,
      suggestedCount: value.memory.suggestedCount,
    },
  };
}
function analysisState(
  status: string | null,
  hasResult: boolean,
): ConversationContinuityStatus["summary"]["state"] {
  if (status === "waiting_configuration") return "not_configured";
  if (status === "queued") return "processing";
  if (status === "failed") return "failed";
  if (status === "completed" || hasResult) return "completed";
  return "not_started";
}
function controlError(
  kind: ConversationControlFailure | "completed",
): ConversationServiceError {
  if (kind === "not_found") return notFound();
  if (kind === "completed" || kind === "already_completed")
    return new ConversationServiceError(
      "CONVERSATION_ALREADY_COMPLETED",
      "这次通话已经结束，请查看保存结果。",
      409,
    );
  const errors = {
    in_use: [
      "CONVERSATION_IN_USE",
      "这次通话仍在其他页面或设备中使用，请回到原设备继续。",
    ],
    writer_stale: [
      "CONVERSATION_WRITER_STALE",
      "通话控制状态已更新，请重新确认后继续。",
    ],
    request_conflict: [
      "CONVERSATION_REQUEST_CONFLICT",
      "这次操作的标识已被使用，请查询原操作结果。",
    ],
    character_unavailable: [
      "CONVERSATION_CHARACTER_UNAVAILABLE",
      "原角色已不可用，仍可查看记录并结束保存。",
    ],
    ending: [
      "CONVERSATION_END_PENDING",
      "这次通话正在等待保存结束，请先处理尚未保存的文字。",
    ],
  } as const;
  const [code, message] = errors[kind];
  return new ConversationServiceError(code, message, 409);
}
