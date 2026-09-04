import {
  CHARACTER_RELATIONSHIP_TRANSFER_MAX_BYTES,
  characterRelationshipTransferPackageSchema,
  relationshipTransferCharacterParamsSchema,
  relationshipTransferImportQuerySchema,
  type UserAccount,
} from "@meet/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  clearSessionCookie,
  getSafeErrorLogContext,
  getSessionToken,
  sendAuthError,
} from "../auth/http.js";
import { AuthError, type AuthService } from "../auth/service.js";
import type { AppConfig } from "../config.js";
import {
  RelationshipTransferServiceError,
  type RelationshipTransferService,
} from "../relationship-transfers/service.js";

export async function registerRelationshipTransferRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  transfers: RelationshipTransferService,
): Promise<void> {
  app.get(
    "/api/characters/:characterId/relationship-export",
    async (request, reply) => {
      noStore(reply);
      const actor = await authenticateActor(request, reply, config, auth);
      if (!actor) return;
      const params = relationshipTransferCharacterParamsSchema.safeParse(
        request.params,
      );
      if (!params.success) return invalidRequest(reply);
      try {
        const transferPackage = await transfers.export(
          actor,
          params.data.characterId,
        );
        const date = transferPackage.payload.exportedAt.slice(0, 10);
        const displayName = transferPackage.payload.character.name.replace(
          /[\r\n"\\]/g,
          "-",
        );
        reply.header("Content-Type", "application/json; charset=utf-8");
        reply.header(
          "Content-Disposition",
          `attachment; filename="meet-character-data-${date}.json"; filename*=UTF-8''${encodeURIComponent(`Meet-${displayName}-关系数据-${date}.json`)}`,
        );
        return transferPackage;
      } catch (error) {
        return sendTransferError(reply, error);
      }
    },
  );

  app.post(
    "/api/characters/:characterId/relationship-import",
    { bodyLimit: CHARACTER_RELATIONSHIP_TRANSFER_MAX_BYTES },
    async (request, reply) => {
      noStore(reply);
      const actor = await authenticateActor(request, reply, config, auth);
      if (!actor) return;
      const params = relationshipTransferCharacterParamsSchema.safeParse(
        request.params,
      );
      const query = relationshipTransferImportQuerySchema.safeParse(
        request.query,
      );
      const transferPackage =
        characterRelationshipTransferPackageSchema.safeParse(request.body);
      if (!params.success || !query.success || !transferPackage.success) {
        return invalidRequest(reply);
      }
      try {
        const result = await transfers.import(
          actor,
          params.data.characterId,
          transferPackage.data,
          query.data.confirmCharacterMismatch,
        );
        return { result };
      } catch (error) {
        return sendTransferError(reply, error);
      }
    },
  );
}

async function authenticateActor(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
  auth: AuthService,
): Promise<UserAccount | null> {
  try {
    return await auth.authenticate(getSessionToken(request, config));
  } catch (error) {
    if (error instanceof AuthError && error.statusCode === 401) {
      clearSessionCookie(reply, config);
    }
    sendTransferError(reply, error);
    return null;
  }
}

function sendTransferError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthError) return sendAuthError(reply, error);
  if (error instanceof RelationshipTransferServiceError) {
    if (error.statusCode >= 500 && error.cause) {
      reply.request.log.error(
        { ...getSafeErrorLogContext(error.cause), code: error.code },
        "Relationship transfer operation failed",
      );
    }
    return reply.code(error.statusCode).send({
      code: error.code,
      message: error.message,
    });
  }
  throw error;
}

function invalidRequest(reply: FastifyReply) {
  return reply.code(400).send({
    code: "RELATIONSHIP_TRANSFER_INVALID_PACKAGE",
    message: "请选择有效的 Meet 角色关系迁移文件。",
  });
}

function noStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
}
