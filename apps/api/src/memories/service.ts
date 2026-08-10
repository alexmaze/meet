import type { CharacterMemoryAggregate } from "@meet/database";
import {
  characterMemorySchema,
  type CharacterMemory,
  type ReviewMemoryRequest,
  type UserAccount,
} from "@meet/protocol";

import type { MemoryRepository } from "./repository.js";

export type MemoryServiceErrorCode =
  | "MEMORY_NOT_FOUND"
  | "MEMORY_INVALID_STATE"
  | "MEMORY_CONTENT_CONFLICT"
  | "MEMORY_SERVICE_UNAVAILABLE";

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
  ) {}

  async list(
    actor: UserAccount,
    input: {
      userId?: string;
      status?: "active" | "suggested";
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
      repository.list(target, input.status, input.limit),
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
