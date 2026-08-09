import Fastify, { type FastifyInstance } from "fastify";

import { loadConfig, type AppConfig } from "./config.js";
import { registerRealtimeRoutes } from "./routes/realtime.js";

type FetchFunction = typeof globalThis.fetch;

export type BuildAppOptions = {
  config?: AppConfig;
  fetchFunction?: FetchFunction;
  logger?: boolean;
};

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const app = Fastify({
    logger:
      options.logger === false ? false : { level: config.server.logLevel },
    bodyLimit: 512 * 1024,
  });

  app.addContentTypeParser(
    "application/sdp",
    { parseAs: "string", bodyLimit: 512 * 1024 },
    (_request, body, done) => done(null, body),
  );

  app.get("/api/health", async () => ({
    service: "meet-api",
    status: "ok",
    now: new Date().toISOString(),
  }));

  await registerRealtimeRoutes(app, config, options.fetchFunction);
  return app;
}
