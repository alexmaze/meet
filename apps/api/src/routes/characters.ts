import {
  characterIdParamsSchema,
  conversationRealtimeQuerySchema,
  createCharacterRequestSchema,
  deleteCharacterRequestSchema,
  emptyCharacterActionRequestSchema,
  qwenRealtimeModelSchema,
  updateCharacterRequestSchema,
  updateCharacterVisibilityRequestSchema,
  voiceProfileIdParamsSchema,
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
import { LoginRateLimiter } from "../auth/login-rate-limit.js";
import {
  CharacterServiceError,
  type CharacterService,
} from "../characters/service.js";
import {
  ConversationServiceError,
  type ConversationService,
} from "../conversations/service.js";
import type { AppConfig } from "../config.js";
import {
  generateQwenVoicePreview,
  QwenVoicePreviewError,
} from "../qwen-voice-preview.js";
import {
  isAllowedWebSocketOrigin,
  relayQwenWebSocket,
  type QwenWebSocketFactory,
} from "../qwen-websocket.js";
import { exchangeQwenOffer, QwenGatewayError } from "../qwen.js";

type FetchFunction = typeof globalThis.fetch;

export async function registerCharacterRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  characterService: CharacterService,
  conversationService: ConversationService,
  fetchFunction?: FetchFunction,
  qwenWebSocketFactory?: QwenWebSocketFactory,
): Promise<void> {
  const realtimeHandshakeRateLimiter = new LoginRateLimiter(20, 60_000);
  const voicePreviewRateLimiter = new LoginRateLimiter(10, 60_000);
  const websocketContexts = new WeakMap<
    FastifyRequest,
    {
      model: ReturnType<typeof qwenRealtimeModelSchema.parse>;
      voice: string;
      instructions: string;
      relationshipContext?: string;
      history: Array<{
        id: string;
        role: "user" | "assistant";
        text: string;
      }>;
    }
  >();
  app.get("/api/characters", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateActor(request, reply, config, auth);
    if (!actor) return;
    try {
      return { characters: await characterService.list(actor) };
    } catch (error) {
      return sendCharacterError(reply, error);
    }
  });

  app.get("/api/characters/catalog", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateActor(request, reply, config, auth);
    if (!actor) return;
    try {
      return await characterService.catalog();
    } catch (error) {
      return sendCharacterError(reply, error);
    }
  });

  app.post(
    "/api/characters/voices/:voiceProfileId/preview",
    async (request, reply) => {
      noStore(reply);
      const actor = await authenticateActor(request, reply, config, auth);
      if (!actor) return;
      try {
        const params = voiceProfileIdParamsSchema.safeParse(request.params);
        if (!params.success) return invalidCharacterRequest(reply);
        const runtime = await characterService.voicePreviewRuntime(
          actor,
          params.data.voiceProfileId,
        );
        const model = qwenRealtimeModelSchema.safeParse(runtime.model);
        if (runtime.provider !== "qwen" || !model.success) {
          throw new CharacterServiceError(
            "CHARACTER_REALTIME_UNAVAILABLE",
            "该声音当前不支持在线试听。",
            409,
          );
        }
        if (!config.qwen.enabled) {
          return reply.code(503).send({
            code: "REALTIME_SPIKE_DISABLED",
            message: "千问实时服务未启用。",
          });
        }

        const rateLimit = voicePreviewRateLimiter.consume(
          `${actor.id}:${request.ip}`,
        );
        if (!rateLimit.allowed) {
          reply.header("Retry-After", String(rateLimit.retryAfterSeconds));
          return reply.code(429).send({
            code: "RATE_LIMITED",
            message: "音色试听过于频繁，请稍后再试。",
          });
        }

        const wav = await generateQwenVoicePreview({
          config: config.qwen,
          model: model.data,
          voice: runtime.voice,
          webSocketFactory: qwenWebSocketFactory,
        });
        return reply
          .type("audio/wav")
          .header("Content-Length", String(wav.byteLength))
          .send(wav);
      } catch (error) {
        if (error instanceof QwenVoicePreviewError) {
          request.log.warn(
            { code: error.code },
            "Qwen voice preview generation failed",
          );
          return reply.code(error.statusCode).send({
            code: error.code,
            message: error.message,
          });
        }
        return sendCharacterError(reply, error);
      }
    },
  );

  app.post("/api/characters", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateActor(request, reply, config, auth);
    if (!actor) return;
    try {
      // 权限先于 body 校验，确保儿童对任何角色写请求都稳定得到 403。
      characterService.assertWriter(actor);
      const input = createCharacterRequestSchema.safeParse(request.body);
      if (!input.success) return invalidCharacterRequest(reply);
      const character = await characterService.create(actor, input.data);
      return reply.code(201).send({ character });
    } catch (error) {
      return sendCharacterError(reply, error);
    }
  });

  app.get("/api/characters/:characterId", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateActor(request, reply, config, auth);
    if (!actor) return;
    const params = characterIdParamsSchema.safeParse(request.params);
    if (!params.success) return invalidCharacterRequest(reply);
    try {
      return {
        character: await characterService.find(actor, params.data.characterId),
      };
    } catch (error) {
      return sendCharacterError(reply, error);
    }
  });

  app.patch("/api/characters/:characterId", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateActor(request, reply, config, auth);
    if (!actor) return;
    try {
      characterService.assertWriter(actor);
      const params = characterIdParamsSchema.safeParse(request.params);
      const input = updateCharacterRequestSchema.safeParse(request.body);
      if (!params.success || !input.success) {
        return invalidCharacterRequest(reply);
      }
      return {
        character: await characterService.update(
          actor,
          params.data.characterId,
          input.data,
        ),
      };
    } catch (error) {
      return sendCharacterError(reply, error);
    }
  });

  app.patch(
    "/api/characters/:characterId/visibility",
    async (request, reply) => {
      noStore(reply);
      const actor = await authenticateActor(request, reply, config, auth);
      if (!actor) return;
      try {
        characterService.assertVisibilityWriter(actor);
        const params = characterIdParamsSchema.safeParse(request.params);
        const input = updateCharacterVisibilityRequestSchema.safeParse(
          request.body,
        );
        if (!params.success || !input.success) {
          return invalidCharacterRequest(reply);
        }
        return {
          character: await characterService.updateVisibility(
            actor,
            params.data.characterId,
            input.data.revision,
            input.data.visibility,
          ),
        };
      } catch (error) {
        return sendCharacterError(reply, error);
      }
    },
  );

  app.post("/api/characters/:characterId/copy", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateActor(request, reply, config, auth);
    if (!actor) return;
    try {
      characterService.assertWriter(actor);
      const params = characterIdParamsSchema.safeParse(request.params);
      const input = emptyCharacterActionRequestSchema.safeParse(request.body);
      if (!params.success || !isJsonRequest(request) || !input.success) {
        return invalidCharacterRequest(reply);
      }
      const character = await characterService.copy(
        actor,
        params.data.characterId,
      );
      return reply.code(201).send({ character });
    } catch (error) {
      return sendCharacterError(reply, error);
    }
  });

  app.post("/api/characters/:characterId/restore", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateActor(request, reply, config, auth);
    if (!actor) return;
    try {
      characterService.assertRestorer(actor);
      const params = characterIdParamsSchema.safeParse(request.params);
      const input = emptyCharacterActionRequestSchema.safeParse(request.body);
      if (!params.success || !isJsonRequest(request) || !input.success) {
        return invalidCharacterRequest(reply);
      }
      return {
        character: await characterService.restore(
          actor,
          params.data.characterId,
        ),
      };
    } catch (error) {
      return sendCharacterError(reply, error);
    }
  });

  app.delete("/api/characters/:characterId", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateActor(request, reply, config, auth);
    if (!actor) return;
    try {
      characterService.assertWriter(actor);
      const params = characterIdParamsSchema.safeParse(request.params);
      const input = deleteCharacterRequestSchema.safeParse(request.body);
      if (!params.success || !input.success) {
        return invalidCharacterRequest(reply);
      }
      await characterService.delete(
        actor,
        params.data.characterId,
        input.data.revision,
      );
      return { ok: true };
    } catch (error) {
      return sendCharacterError(reply, error);
    }
  });

  app.get("/api/characters/:characterId/runtime", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateActor(request, reply, config, auth);
    if (!actor) return;
    const params = characterIdParamsSchema.safeParse(request.params);
    if (!params.success) return invalidCharacterRequest(reply);
    try {
      return await characterService.runtime(actor, params.data.characterId);
    } catch (error) {
      return sendCharacterError(reply, error);
    }
  });

  app.post(
    "/api/characters/:characterId/realtime/sessions",
    async (request, reply) => {
      noStore(reply);
      const actor = await authenticateActor(request, reply, config, auth);
      if (!actor) return;
      const params = characterIdParamsSchema.safeParse(request.params);
      if (!params.success) return invalidCharacterRequest(reply);

      try {
        // 先解析角色可见性，再检查传输参数，避免通过错误差异枚举私人角色。
        const runtime = await characterService.runtime(
          actor,
          params.data.characterId,
        );
        if (
          Object.keys((request.query ?? {}) as Record<string, unknown>).length >
          0
        ) {
          return invalidCharacterRequest(reply);
        }
        if (
          request.headers["content-type"]?.split(";", 1)[0]?.trim() !==
          "application/sdp"
        ) {
          return invalidCharacterRequest(reply);
        }
        if (
          runtime.realtime.provider !== "qwen" ||
          !qwenRealtimeModelSchema.safeParse(runtime.realtime.model).success
        ) {
          throw new CharacterServiceError(
            "CHARACTER_REALTIME_UNAVAILABLE",
            "该角色当前没有可用的千问实时模型。",
            409,
          );
        }
        if (!config.qwen.enabled) {
          return reply.code(503).send({
            code: "REALTIME_SPIKE_DISABLED",
            message: "千问实时服务未启用。",
          });
        }

        const rateLimit = realtimeHandshakeRateLimiter.consume(
          `${actor.id}:${request.ip}`,
        );
        if (!rateLimit.allowed) {
          reply.header("Retry-After", String(rateLimit.retryAfterSeconds));
          return reply.code(429).send({
            code: "RATE_LIMITED",
            message: "实时连接尝试过于频繁，请稍后再试。",
          });
        }

        const model = qwenRealtimeModelSchema.parse(runtime.realtime.model);
        const answerSdp = await exchangeQwenOffer(
          config.qwen,
          model,
          request.body as string,
          fetchFunction,
        );
        return reply.type("application/sdp").send(answerSdp);
      } catch (error) {
        if (error instanceof QwenGatewayError) {
          request.log.warn(
            { code: error.code, upstreamRequestId: error.requestId },
            "Qwen realtime handshake failed",
          );
          return reply.code(error.statusCode).send({
            code: error.code,
            message: error.message,
            requestId: error.requestId,
          });
        }
        return sendCharacterError(reply, error);
      }
    },
  );

  app.get(
    "/api/characters/:characterId/realtime/websocket",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        noStore(reply);
        if (
          !isAllowedWebSocketOrigin({
            origin: request.headers.origin,
            host: request.headers.host,
            remoteAddress: request.raw.socket?.remoteAddress,
            cookieSecure: config.auth.cookieSecure,
          })
        ) {
          return reply.code(403).send({
            code: "ORIGIN_FORBIDDEN",
            message: "实时连接来源无效。",
          });
        }

        const actor = await authenticateActor(request, reply, config, auth);
        if (!actor) return;
        const params = characterIdParamsSchema.safeParse(request.params);
        if (!params.success) return invalidCharacterRequest(reply);

        try {
          // 角色可见性检查必须早于传输参数检查，避免枚举私人角色。
          const runtime = await characterService.runtime(
            actor,
            params.data.characterId,
          );
          const query = conversationRealtimeQuerySchema.safeParse(
            request.query,
          );
          if (!query.success) {
            return invalidCharacterRequest(reply);
          }
          const continuity = await conversationService.realtimeContext(
            actor,
            query.data.conversationId,
            params.data.characterId,
          );
          const model = qwenRealtimeModelSchema.safeParse(
            runtime.realtime.model,
          );
          if (runtime.realtime.provider !== "qwen" || !model.success) {
            throw new CharacterServiceError(
              "CHARACTER_REALTIME_UNAVAILABLE",
              "该角色当前没有可用的千问实时模型。",
              409,
            );
          }
          if (!config.qwen.enabled) {
            return reply.code(503).send({
              code: "REALTIME_SPIKE_DISABLED",
              message: "千问实时服务未启用。",
            });
          }
          if (!config.qwen.apiKey || !config.qwen.endpoint) {
            return reply.code(503).send({
              code: "QWEN_NOT_CONFIGURED",
              message: "服务端尚未配置千问实时服务。",
            });
          }

          const rateLimit = realtimeHandshakeRateLimiter.consume(
            `${actor.id}:${request.ip}`,
          );
          if (!rateLimit.allowed) {
            reply.header("Retry-After", String(rateLimit.retryAfterSeconds));
            return reply.code(429).send({
              code: "RATE_LIMITED",
              message: "实时连接尝试过于频繁，请稍后再试。",
            });
          }

          websocketContexts.set(request, {
            model: model.data,
            voice: runtime.realtime.voice,
            instructions: runtime.realtime.instructions,
            relationshipContext: continuity.relationshipContext,
            history: continuity.messages,
          });
        } catch (error) {
          return sendCharacterError(reply, error);
        }
      },
    },
    (socket, request) => {
      const context = websocketContexts.get(request);
      websocketContexts.delete(request);
      if (!context) {
        socket.close(1011, "Realtime context missing");
        return;
      }
      relayQwenWebSocket({
        client: socket,
        config: config.qwen,
        model: context.model,
        runtime: {
          voice: context.voice,
          instructions: context.instructions,
          relationshipContext: context.relationshipContext,
          history: context.history,
        },
        webSocketFactory: qwenWebSocketFactory,
      });
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
    sendCharacterError(reply, error);
    return null;
  }
}

function sendCharacterError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthError) return sendAuthError(reply, error);
  if (error instanceof ConversationServiceError) {
    if (error.statusCode >= 500 && error.cause) {
      reply.request.log.error(
        { ...getSafeErrorLogContext(error.cause), code: error.code },
        "Conversation repository operation failed during realtime setup",
      );
    }
    return reply.code(error.statusCode).send({
      code: error.code,
      message: error.message,
    });
  }
  if (error instanceof CharacterServiceError) {
    if (error.statusCode >= 500 && error.cause) {
      reply.request.log.error(
        { ...getSafeErrorLogContext(error.cause), code: error.code },
        "Character repository operation failed",
      );
    }
    return reply.code(error.statusCode).send({
      code: error.code,
      message: error.message,
    });
  }
  throw error;
}

function invalidCharacterRequest(reply: FastifyReply) {
  return reply.code(400).send({
    code: "INVALID_REQUEST",
    message: "请输入有效的角色信息。",
  });
}

function isJsonRequest(request: FastifyRequest): boolean {
  return (
    request.headers["content-type"]?.split(";", 1)[0]?.trim() ===
    "application/json"
  );
}

function noStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
}
