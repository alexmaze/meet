import {
  memoryIdParamsSchema,
  memoryListQuerySchema,
  reviewMemoryRequestSchema,
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
import { MemoryServiceError, type MemoryService } from "../memories/service.js";

export async function registerMemoryRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  memories: MemoryService,
): Promise<void> {
  app.get("/api/memories", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateActor(request, reply, config, auth);
    if (!actor) return;
    const query = memoryListQuerySchema.safeParse(request.query);
    if (!query.success) return invalidRequest(reply);
    try {
      return { memories: await memories.list(actor, query.data) };
    } catch (error) {
      return sendMemoryError(reply, error);
    }
  });

  app.patch("/api/memories/:memoryId", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateActor(request, reply, config, auth);
    if (!actor) return;
    const params = memoryIdParamsSchema.safeParse(request.params);
    const input = reviewMemoryRequestSchema.safeParse(request.body);
    if (!params.success || !input.success) return invalidRequest(reply);
    try {
      return {
        memory: await memories.review(actor, params.data.memoryId, input.data),
      };
    } catch (error) {
      return sendMemoryError(reply, error);
    }
  });
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
    sendMemoryError(reply, error);
    return null;
  }
}

function sendMemoryError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthError) return sendAuthError(reply, error);
  if (error instanceof MemoryServiceError) {
    if (error.statusCode >= 500 && error.cause) {
      reply.request.log.error(
        { ...getSafeErrorLogContext(error.cause), code: error.code },
        "Memory repository operation failed",
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
    code: "INVALID_REQUEST",
    message: "请输入有效的记忆操作。",
  });
}

function noStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
}
