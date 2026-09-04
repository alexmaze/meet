import { createHash, randomUUID } from "node:crypto";

import {
  CHARACTER_RELATIONSHIP_TRANSFER_MAX_BYTES,
  CHARACTER_RELATIONSHIP_TRANSFER_SCHEMA_VERSION,
  characterRelationshipTransferPackageSchema,
  characterRelationshipTransferPayloadSchema,
  relationshipTransferImportResultSchema,
  type CharacterRelationshipTransferPackage,
  type CharacterRelationshipTransferPayload,
  type RelationshipTransferImportResult,
  type UserAccount,
} from "@meet/protocol";

import type { RelationshipTransferRepository } from "./repository.js";

export type RelationshipTransferServiceErrorCode =
  | "RELATIONSHIP_TRANSFER_NOT_FOUND"
  | "RELATIONSHIP_TRANSFER_INVALID_PACKAGE"
  | "RELATIONSHIP_TRANSFER_INTEGRITY_FAILED"
  | "RELATIONSHIP_TRANSFER_TOO_LARGE"
  | "RELATIONSHIP_TRANSFER_CHARACTER_MISMATCH"
  | "RELATIONSHIP_TRANSFER_CONFLICT"
  | "RELATIONSHIP_TRANSFER_SERVICE_UNAVAILABLE";

export class RelationshipTransferServiceError extends Error {
  constructor(
    readonly code: RelationshipTransferServiceErrorCode,
    message: string,
    readonly statusCode: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RelationshipTransferServiceError";
  }
}

export class RelationshipTransferService {
  constructor(
    private readonly repository: RelationshipTransferRepository | null,
    private readonly now: () => Date = () => new Date(),
    private readonly createTransferId: () => string = randomUUID,
  ) {}

  async export(
    actor: UserAccount,
    characterId: string,
  ): Promise<CharacterRelationshipTransferPackage> {
    const data = await this.call((repository) =>
      repository.export(actor.id, characterId),
    );
    if (!data) throw notFound();
    if (
      data.conversations.length > 1_000 ||
      data.memories.length > 5_000 ||
      data.conversations.some(
        (conversation) => conversation.messages.length > 20_000,
      )
    ) {
      throw tooLarge();
    }
    const payload = characterRelationshipTransferPayloadSchema.parse({
      transferId: this.createTransferId(),
      exportedAt: this.now().toISOString(),
      ...data,
    });
    const result = characterRelationshipTransferPackageSchema.parse({
      kind: "meet-character-relationship-transfer",
      schemaVersion: CHARACTER_RELATIONSHIP_TRANSFER_SCHEMA_VERSION,
      payload,
      integritySha256: relationshipTransferPayloadChecksum(payload),
    });
    if (
      Buffer.byteLength(JSON.stringify(result), "utf8") >
      CHARACTER_RELATIONSHIP_TRANSFER_MAX_BYTES
    ) {
      throw tooLarge();
    }
    return result;
  }

  async import(
    actor: UserAccount,
    targetCharacterId: string,
    transferPackage: CharacterRelationshipTransferPackage,
    confirmCharacterMismatch: boolean,
  ): Promise<RelationshipTransferImportResult> {
    const parsed =
      characterRelationshipTransferPackageSchema.safeParse(transferPackage);
    if (!parsed.success) throw invalidPackage();
    const serializedSize = Buffer.byteLength(
      JSON.stringify(parsed.data),
      "utf8",
    );
    if (serializedSize > CHARACTER_RELATIONSHIP_TRANSFER_MAX_BYTES) {
      throw tooLarge();
    }
    const expectedChecksum = relationshipTransferPayloadChecksum(
      parsed.data.payload,
    );
    if (expectedChecksum !== parsed.data.integritySha256) {
      throw new RelationshipTransferServiceError(
        "RELATIONSHIP_TRANSFER_INTEGRITY_FAILED",
        "迁移文件校验失败，文件可能不完整或已被修改。",
        400,
      );
    }
    const imported = await this.call((repository) =>
      repository.import({
        actorUserId: actor.id,
        targetCharacterId,
        packageChecksum: parsed.data.integritySha256,
        payload: parsed.data.payload,
        confirmCharacterMismatch,
        importedAt: this.now(),
      }),
    );
    if (imported.kind === "character_not_found") throw notFound();
    if (imported.kind === "character_mismatch") {
      throw new RelationshipTransferServiceError(
        "RELATIONSHIP_TRANSFER_CHARACTER_MISMATCH",
        `迁移文件属于“${parsed.data.payload.character.name}”，当前选择的是“${imported.targetCharacterName}”。确认后才能导入。`,
        409,
      );
    }
    if (imported.kind === "transfer_conflict") {
      throw new RelationshipTransferServiceError(
        "RELATIONSHIP_TRANSFER_CONFLICT",
        "同一个迁移标识已经用于另一份文件或另一个角色。",
        409,
      );
    }
    return relationshipTransferImportResultSchema.parse(imported.result);
  }

  private async call<T>(
    operation: (repository: RelationshipTransferRepository) => Promise<T>,
  ): Promise<T> {
    if (!this.repository) throw unavailable();
    try {
      return await operation(this.repository);
    } catch (error) {
      if (error instanceof RelationshipTransferServiceError) throw error;
      throw unavailable(error);
    }
  }
}

export function relationshipTransferPayloadChecksum(
  payload: CharacterRelationshipTransferPayload,
): string {
  return createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

function notFound(): RelationshipTransferServiceError {
  return new RelationshipTransferServiceError(
    "RELATIONSHIP_TRANSFER_NOT_FOUND",
    "没有找到这个角色，或当前账号不能使用它。",
    404,
  );
}

function invalidPackage(): RelationshipTransferServiceError {
  return new RelationshipTransferServiceError(
    "RELATIONSHIP_TRANSFER_INVALID_PACKAGE",
    "请选择有效的 Meet 角色关系迁移文件。",
    400,
  );
}

function tooLarge(): RelationshipTransferServiceError {
  return new RelationshipTransferServiceError(
    "RELATIONSHIP_TRANSFER_TOO_LARGE",
    "迁移数据超过 25 MB，请先清理不需要的历史记录后重试。",
    413,
  );
}

function unavailable(cause?: unknown): RelationshipTransferServiceError {
  return new RelationshipTransferServiceError(
    "RELATIONSHIP_TRANSFER_SERVICE_UNAVAILABLE",
    "角色数据迁移服务暂时不可用，请稍后重试。",
    503,
    cause === undefined ? undefined : { cause },
  );
}
