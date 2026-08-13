import type { FastifyInstance } from "fastify";

import { createRequireAuthHook } from "../auth/http.js";
import type { AuthService } from "../auth/service.js";
import type { AppConfig } from "../config.js";
import type { ModelSettingsService } from "../model-settings/service.js";

export async function registerRealtimeRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  modelSettings: ModelSettingsService,
): Promise<void> {
  const requireAuth = createRequireAuthHook(auth, config);

  app.get("/api/realtime/providers", { preHandler: requireAuth }, async () => ({
    providers: await modelSettings.providerAvailability(),
  }));
}
