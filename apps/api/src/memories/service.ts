import type {
  CharacterMemoryAggregate,
  MemoryIndexDiagnosticRecord,
} from "@meet/database";
import {
  resolveSemanticMemoryStore,
  type SemanticMemoryStoreSource,
} from "@meet/memory";
import {
  characterMemorySchema,
  mem0DiagnosticsResponseSchema,
  mem0SearchResponseSchema,
  type CharacterMemory,
  type Mem0DiagnosticsResponse,
  type Mem0SearchResponse,
  type ReviewMemoryRequest,
  type UserAccount,
} from "@meet/protocol";

import type { MemoryRepository } from "./repository.js";

export type MemoryServiceErrorCode =
  | "MEMORY_NOT_FOUND"
  | "MEMORY_INVALID_STATE"
  | "MEMORY_CONTENT_CONFLICT"
  | "MEMORY_SERVICE_UNAVAILABLE"
  | "MEM0_NOT_ENABLED"
  | "MEM0_DIAGNOSTICS_UNAVAILABLE";

export class MemoryServiceError extends Error {
  constructor(
    readonly code: MemoryServiceErrorCode,
    message: string,
    readonly statusCode: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MemoryServiceError";
  }
}

export class MemoryService {
  constructor(
    private readonly repository: MemoryRepository | null,
    private readonly now: () => Date = () => new Date(),
    private readonly semanticMemoryStore?: SemanticMemoryStoreSource,
  ) {}

  async list(
    actor: UserAccount,
    input: {
      userId?: string;
      status?: "active" | "suggested";
      characterId?: string;
      sourceConversationId?: string;
      limit: number;
    },
  ): Promise<CharacterMemory[]> {
    const target = input.userId ?? actor.id;
    if (target !== actor.id) {
      if (actor.accountType !== "admin") throw notFound();
      const readable = await this.call((repository) =>
        repository.isGuardianReadableTarget(target),
      );
      if (!readable) throw notFound();
    }
    const memories = await this.call((repository) =>
      repository.list(target, input.status, input.limit, {
        characterId: input.characterId,
        sourceConversationId: input.sourceConversationId,
      }),
    );
    return memories.map(toPublicMemory);
  }

  async review(
    actor: UserAccount,
    memoryId: string,
    review: ReviewMemoryRequest,
  ): Promise<CharacterMemory> {
    const result = await this.call((repository) =>
      repository.review(actor.id, memoryId, review, this.now()),
    );
    if (result.kind === "not_found") throw notFound();
    if (result.kind === "invalid_state") {
      throw new MemoryServiceError(
        "MEMORY_INVALID_STATE",
        "这条记忆已经处理，不能重复执行该操作。",
        409,
      );
    }
    if (result.kind === "content_conflict") {
      throw new MemoryServiceError(
        "MEMORY_CONTENT_CONFLICT",
        "相同内容的记忆已经存在。",
        409,
      );
    }
    return toPublicMemory(result.memory);
  }

  async mem0Diagnostics(
    actor: UserAccount,
    input: {
      userId?: string;
      characterId?: string;
      limit: number;
    },
  ): Promise<Mem0DiagnosticsResponse> {
    const targetUserId = await this.authorizeTarget(actor, input.userId);
    const repository = this.repository;
    if (!repository?.listIndexDiagnostics) throw unavailable();

    let records: MemoryIndexDiagnosticRecord[];
    try {
      records = await repository.listIndexDiagnostics(
        targetUserId,
        input.characterId,
        input.limit,
      );
    } catch (error) {
      throw unavailable(error);
    }

    const store = await this.resolveDiagnosticsStore();
    const rawItems =
      store?.list === undefined
        ? []
        : await this.callMem0(() =>
            store.list!({
              userId: targetUserId,
              characterId: input.characterId,
              limit: input.limit,
            }),
          );
    const rawByLocalId = new Map(
      rawItems.flatMap((item) =>
        item.localMemoryId ? [[item.localMemoryId, item] as const] : [],
      ),
    );
    const knownMemoryIds = new Set(records.map(({ memory }) => memory.id));

    return mem0DiagnosticsResponseSchema.parse({
      enabled: Boolean(store),
      indexRevision: store?.indexRevision ?? null,
      items: records.map(({ memory, character, index }) => {
        const raw = rawByLocalId.get(memory.id);
        return {
          memoryId: memory.id,
          character,
          content: memory.content,
          memoryStatus: memory.status,
          expectedInMem0: memory.status === "active",
          indexStatus: index?.status ?? "not_indexed",
          externalId: index?.externalId ?? null,
          indexRevision: index?.indexRevision ?? null,
          attemptCount: index?.attemptCount ?? 0,
          lastErrorCode: index?.lastErrorCode ?? null,
          syncedAt: index?.syncedAt?.toISOString() ?? null,
          existsInMem0: Boolean(raw),
          mem0Content: raw?.content ?? null,
          contentMatches: raw
            ? raw.content.trim() === memory.content.trim()
            : null,
        };
      }),
      orphaned: rawItems
        .filter(
          (item) =>
            !item.localMemoryId || !knownMemoryIds.has(item.localMemoryId),
        )
        .map((item) => ({
          externalId: item.externalId,
          localMemoryId: item.localMemoryId ?? null,
          content: item.content,
        })),
    });
  }

  async searchMem0(
    actor: UserAccount,
    input: {
      userId?: string;
      characterId: string;
      query: string;
      limit: number;
      threshold: number;
    },
  ): Promise<Mem0SearchResponse> {
    const targetUserId = await this.authorizeTarget(actor, input.userId);
    const store = await this.resolveDiagnosticsStore();
    if (!store) {
      throw new MemoryServiceError(
        "MEM0_NOT_ENABLED",
        "尚未启用长期记忆向量化模型。",
        409,
      );
    }
    const results = await this.callMem0(() =>
      store.search({
        userId: targetUserId,
        characterId: input.characterId,
        query: input.query,
        limit: input.limit,
        threshold: input.threshold,
      }),
    );
    return mem0SearchResponseSchema.parse({
      indexRevision: store.indexRevision ?? null,
      results: results.map((item) => ({
        externalId: item.externalId,
        localMemoryId: item.localMemoryId ?? null,
        content: item.content,
        score: item.score ?? null,
      })),
    });
  }

  private async authorizeTarget(actor: UserAccount, requestedUserId?: string) {
    const target = requestedUserId ?? actor.id;
    if (target === actor.id) return target;
    if (actor.accountType !== "admin") throw notFound();
    const readable = await this.call((repository) =>
      repository.isGuardianReadableTarget(target),
    );
    if (!readable) throw notFound();
    return target;
  }

  private async resolveDiagnosticsStore() {
    try {
      return await resolveSemanticMemoryStore(this.semanticMemoryStore);
    } catch (error) {
      throw diagnosticsUnavailable(error);
    }
  }

  private async callMem0<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw diagnosticsUnavailable(error);
    }
  }

  private async call<T>(
    operation: (repository: MemoryRepository) => Promise<T>,
  ): Promise<T> {
    if (!this.repository) throw unavailable();
    try {
      return await operation(this.repository);
    } catch (error) {
      if (error instanceof MemoryServiceError) throw error;
      throw unavailable(error);
    }
  }
}

function toPublicMemory(aggregate: CharacterMemoryAggregate): CharacterMemory {
  return characterMemorySchema.parse({
    id: aggregate.memory.id,
    userId: aggregate.memory.userId,
    character: aggregate.character,
    sourceConversationId: aggregate.memory.sourceConversationId,
    sourceExcerpt: aggregate.memory.sourceExcerpt,
    content: aggregate.memory.content,
    confidence: aggregate.memory.confidence,
    status: aggregate.memory.status,
    createdAt: aggregate.memory.createdAt.toISOString(),
    updatedAt: aggregate.memory.updatedAt.toISOString(),
    reviewedAt: aggregate.memory.reviewedAt?.toISOString() ?? null,
  });
}

function notFound(): MemoryServiceError {
  return new MemoryServiceError("MEMORY_NOT_FOUND", "没有找到这条记忆。", 404);
}

function unavailable(cause?: unknown): MemoryServiceError {
  return new MemoryServiceError(
    "MEMORY_SERVICE_UNAVAILABLE",
    "记忆服务暂时不可用，请稍后重试。",
    503,
    cause === undefined ? undefined : { cause },
  );
}

function diagnosticsUnavailable(cause?: unknown): MemoryServiceError {
  return new MemoryServiceError(
    "MEM0_DIAGNOSTICS_UNAVAILABLE",
    "Mem0 诊断暂时不可用，请检查向量模型、pgvector 和 Worker 状态。",
    503,
    cause === undefined ? undefined : { cause },
  );
}
