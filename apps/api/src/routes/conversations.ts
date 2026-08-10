import {
  appendConversationMessagesRequestSchema,
  completeConversationRequestSchema,
  conversationIdParamsSchema,
  conversationListQuerySchema,
  createConversationRequestSchema,
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
import {
  ConversationServiceError,
  type ConversationService,
} from "../conversations/service.js";
import type { AppConfig } from "../config.js";

export async function registerConversationRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  conversations: ConversationService,
): Promise<void> {
  app.post("/api/conversations", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateActor(request, reply, config, auth);
    if (!actor) return;
    const input = createConversationRequestSchema.safeParse(request.body);
    if (!input.success) return invalidRequest(reply);
    try {
      const conversation = await conversations.create(actor, input.data);
      return reply.code(201).send({ conversation });
    } catch (error) {
      return sendConversationError(reply, error);
    }
  });

  app.get("/api/conversations", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateActor(request, reply, config, auth);
    if (!actor) return;
    const query = conversationListQuerySchema.safeParse(request.query);
    if (!query.success) return invalidRequest(reply);
    try {
      return {
        conversations: await conversations.list(
          actor,
          query.data.userId,
          query.data.limit,
        ),
      };
    } catch (error) {
      return sendConversationError(reply, error);
    }
  });

  app.get("/api/conversations/:conversationId", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateActor(request, reply, config, auth);
    if (!actor) return;
    const params = conversationIdParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply);
    try {
      return await conversations.find(actor, params.data.conversationId);
    } catch (error) {
      return sendConversationError(reply, error);
    }
  });

  app.post(
    "/api/conversations/:conversationId/messages",
    async (request, reply) => {
      noStore(reply);
      const actor = await authenticateActor(request, reply, config, auth);
      if (!actor) return;
      const params = conversationIdParamsSchema.safeParse(request.params);
      const input = appendConversationMessagesRequestSchema.safeParse(
        request.body,
      );
      if (!params.success || !input.success) return invalidRequest(reply);
      try {
        return {
          acknowledgedSequence: await conversations.appendMessages(
            actor,
            params.data.conversationId,
            input.data,
          ),
        };
      } catch (error) {
        return sendConversationError(reply, error);
      }
    },
  );

  app.post(
    "/api/conversations/:conversationId/complete",
    async (request, reply) => {
      noStore(reply);
      const actor = await authenticateActor(request, reply, config, auth);
      if (!actor) return;
      const params = conversationIdParamsSchema.safeParse(request.params);
      const input = completeConversationRequestSchema.safeParse(request.body);
      if (!params.success || !input.success) return invalidRequest(reply);
      try {
        return {
          conversation: await conversations.complete(
            actor,
            params.data.conversationId,
            input.data.lastSequence,
          ),
        };
      } catch (error) {
        return sendConversationError(reply, error);
      }
    },
  );

  app.delete("/api/conversations/:conversationId", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateActor(request, reply, config, auth);
    if (!actor) return;
    const params = conversationIdParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply);
    try {
      await conversations.delete(actor, params.data.conversationId);
      return { ok: true };
    } catch (error) {
      return sendConversationError(reply, error);
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
    sendConversationError(reply, error);
    return null;
  }
}

function sendConversationError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthError) return sendAuthError(reply, error);
  if (error instanceof ConversationServiceError) {
    if (error.statusCode >= 500 && error.cause) {
      reply.request.log.error(
        { ...getSafeErrorLogContext(error.cause), code: error.code },
        "Conversation repository operation failed",
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
    message: "请输入有效的通话记录信息。",
  });
}

function noStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
}
