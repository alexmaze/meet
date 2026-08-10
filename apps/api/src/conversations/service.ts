import type {
  AppendConversationMessagesRequest,
  ConversationMessage,
  ConversationSummary,
  CreateConversationRequest,
  UserAccount,
} from "@meet/protocol";
import {
  conversationMessageSchema,
  conversationSummarySchema,
} from "@meet/protocol";
import type {
  ConversationAggregate,
  ConversationDetailAggregate,
  ConversationMessageRecord,
} from "@meet/database";
import type { ZodType } from "zod";

import type { ConversationRepository } from "./repository.js";

export type ConversationServiceErrorCode =
  | "CONVERSATION_NOT_FOUND"
  | "CONVERSATION_ID_CONFLICT"
  | "CONVERSATION_SEQUENCE_CONFLICT"
  | "CONVERSATION_ALREADY_COMPLETED"
  | "CONVERSATION_SERVICE_UNAVAILABLE";

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
  relationshipContext?: string;
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
  }>;
};

const CONTINUITY_CHARACTER_BUDGET = 12_000;
const CONTINUITY_MESSAGE_CHARACTER_LIMIT = 2_000;
const RELATIONSHIP_CONTEXT_CHARACTER_BUDGET = 8_000;

export class ConversationService {
  constructor(
    private readonly repository: ConversationRepository | null,
    private readonly now: () => Date = () => new Date(),
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
  }> {
    const detail = await this.call((repository) =>
      repository.findReadable(
        actor.id,
        actor.accountType === "admin",
        conversationId,
      ),
    );
    if (!detail) throw notFound();
    return toDetail(detail);
  }

  async realtimeContext(
    actor: UserAccount,
    conversationId: string,
    characterId: string,
  ): Promise<ConversationRealtimeLaunchContext> {
    const context = await this.call((repository) =>
      repository.loadRealtimeContext(actor.id, conversationId, characterId),
    );
    if (!context) throw notFound();
    const messages =
      context.mode === "temporary"
        ? context.messages.filter(
            (message) => message.conversationId === conversationId,
          )
        : context.messages;
    return {
      mode: context.mode,
      relationshipContext:
        context.mode === "normal"
          ? buildRelationshipContext(
              context.summaries ?? [],
              context.memories ?? [],
            )
          : undefined,
      messages: boundContinuityMessages(messages),
    };
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
    return result.acknowledgedSequence;
  }

  async complete(
    actor: UserAccount,
    conversationId: string,
    lastSequence: number,
  ): Promise<ConversationSummary> {
    const result = await this.call((repository) =>
      repository.complete(actor.id, conversationId, lastSequence, this.now()),
    );
    if (result.kind === "not_found") throw notFound();
    if (result.kind === "sequence_conflict") throw sequenceConflict();
    return toSummary(result.conversation);
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

function boundContinuityMessages(
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
  }>,
): ConversationRealtimeLaunchContext["messages"] {
  const selected: ConversationRealtimeLaunchContext["messages"] = [];
  let remaining = CONTINUITY_CHARACTER_BUDGET;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (remaining <= 0) break;
    const message = messages[index];
    if (!message) continue;
    const text = message.text
      .trim()
      .slice(0, Math.min(CONTINUITY_MESSAGE_CHARACTER_LIMIT, remaining));
    if (!text) continue;
    selected.push({ id: message.id, role: message.role, text });
    remaining -= text.length;
  }
  return selected.reverse();
}

function buildRelationshipContext(
  summaries: Array<{ content: string }>,
  memories: Array<{ content: string }>,
): string | undefined {
  const sections: string[] = [];
  if (memories.length > 0) {
    sections.push(
      `已确认长期记忆：\n${memories.map((memory) => `- ${memory.content.trim()}`).join("\n")}`,
    );
  }
  if (summaries.length > 0) {
    sections.push(
      `此前通话摘要：\n${summaries.map((summary) => `- ${summary.content.trim()}`).join("\n")}`,
    );
  }
  if (sections.length === 0) return undefined;
  return sections.join("\n\n").slice(0, RELATIONSHIP_CONTEXT_CHARACTER_BUDGET);
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
