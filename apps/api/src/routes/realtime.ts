import {
  qwenRealtimeModelSchema,
  type QwenRealtimeModel,
} from "@meet/protocol";
import type { FastifyInstance } from "fastify";

import { createRequireAuthHook } from "../auth/http.js";
import type { AuthService } from "../auth/service.js";
import type { AppConfig } from "../config.js";
import { exchangeQwenOffer, QwenGatewayError } from "../qwen.js";

type FetchFunction = typeof globalThis.fetch;

export async function registerRealtimeRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  fetchFunction?: FetchFunction,
): Promise<void> {
  const requireAuth = createRequireAuthHook(auth, config);

  app.get(
    "/api/realtime/qwen/config",
    { preHandler: requireAuth },
    async () => ({
      enabled: config.qwen.enabled,
      configured: Boolean(config.qwen.apiKey && config.qwen.endpoint),
      region: config.qwen.region,
      model: config.qwen.model,
      availableModels: qwenRealtimeModelSchema.options,
      voice: config.qwen.voice,
      defaultInstructions: config.qwen.instructions,
    }),
  );

  app.post(
    "/api/realtime/qwen/sessions",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!config.qwen.enabled) {
        return reply.code(503).send({
          code: "REALTIME_SPIKE_DISABLED",
          message: "千问实时技术验证未启用。",
        });
      }

      const query = request.query as { model?: unknown };
      const modelResult = qwenRealtimeModelSchema.safeParse(
        query.model ?? config.qwen.model,
      );
      if (!modelResult.success) {
        return reply.code(400).send({
          code: "INVALID_MODEL",
          message: "不支持的千问实时模型。",
        });
      }

      try {
        const answerSdp = await exchangeQwenOffer(
          config.qwen,
          modelResult.data as QwenRealtimeModel,
          request.body as string,
          fetchFunction,
        );
        return reply.type("application/sdp").send(answerSdp);
      } catch (error) {
        if (error instanceof QwenGatewayError) {
          request.log.warn(
            {
              code: error.code,
              upstreamRequestId: error.requestId,
            },
            "Qwen realtime handshake failed",
          );
          return reply.code(error.statusCode).send({
            code: error.code,
            message: error.message,
            requestId: error.requestId,
          });
        }

        throw error;
      }
    },
  );
}
