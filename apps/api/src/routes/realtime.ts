import { qwenRealtimeModelSchema } from "@meet/protocol";
import type { FastifyInstance } from "fastify";

import { createRequireAuthHook } from "../auth/http.js";
import type { AuthService } from "../auth/service.js";
import type { AppConfig } from "../config.js";

export async function registerRealtimeRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
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

  app.get("/api/realtime/providers", { preHandler: requireAuth }, async () => ({
    providers: [
      {
        provider: "qwen" as const,
        enabled: config.qwen.enabled,
        configured: Boolean(config.qwen.apiKey && config.qwen.endpoint),
      },
      {
        provider: "doubao" as const,
        enabled: Boolean(config.doubao?.enabled),
        configured: Boolean(config.doubao?.apiKey),
      },
    ],
  }));
}
