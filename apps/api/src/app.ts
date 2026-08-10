import fastifyCookie from "@fastify/cookie";
import fastifyWebsocket from "@fastify/websocket";
import { createDatabaseClient, type DatabaseClient } from "@meet/database";
import Fastify, { type FastifyInstance } from "fastify";

import { PostgresAuthRepository } from "./auth/postgres-repository.js";
import type { AuthRepository } from "./auth/repository.js";
import { AuthService } from "./auth/service.js";
import { PostgresCharacterRepository } from "./characters/postgres-repository.js";
import type { CharacterRepository } from "./characters/repository.js";
import { CharacterService } from "./characters/service.js";
import { PostgresConversationRepository } from "./conversations/postgres-repository.js";
import type { ConversationRepository } from "./conversations/repository.js";
import { ConversationService } from "./conversations/service.js";
import { loadConfig, type AppConfig } from "./config.js";
import { PostgresMemberRepository } from "./members/postgres-repository.js";
import type { AdminMemberRepository } from "./members/repository.js";
import { MemberService } from "./members/service.js";
import {
  QWEN_RELAY_CLIENT_MAX_MESSAGE_BYTES,
  type QwenWebSocketFactory,
} from "./qwen-websocket.js";
import { registerAdminMemberRoutes } from "./routes/admin-members.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerCharacterRoutes } from "./routes/characters.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerRealtimeRoutes } from "./routes/realtime.js";

type FetchFunction = typeof globalThis.fetch;

export type BuildAppOptions = {
  config?: AppConfig;
  fetchFunction?: FetchFunction;
  authRepository?: AuthRepository | null;
  memberRepository?: AdminMemberRepository | null;
  characterRepository?: CharacterRepository | null;
  conversationRepository?: ConversationRepository | null;
  databaseClient?: DatabaseClient | null;
  qwenWebSocketFactory?: QwenWebSocketFactory;
  logger?: boolean;
};

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const ownedDatabaseClient =
    options.databaseClient === undefined && config.database.url
      ? createDatabaseClient({ connectionString: config.database.url })
      : null;
  const databaseClient = options.databaseClient ?? ownedDatabaseClient;
  const authRepository =
    options.authRepository === undefined
      ? databaseClient
        ? new PostgresAuthRepository(databaseClient.db)
        : null
      : options.authRepository;
  const memberRepository =
    options.memberRepository === undefined
      ? databaseClient
        ? new PostgresMemberRepository(databaseClient.db)
        : null
      : options.memberRepository;
  const characterRepository =
    options.characterRepository === undefined
      ? databaseClient
        ? new PostgresCharacterRepository(databaseClient.db)
        : null
      : options.characterRepository;
  const conversationRepository =
    options.conversationRepository === undefined
      ? databaseClient
        ? new PostgresConversationRepository(databaseClient.db)
        : null
      : options.conversationRepository;
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.server.logLevel,
            redact: [
              "req.headers.authorization",
              "req.headers.cookie",
              'res.headers["set-cookie"]',
            ],
          },
    bodyLimit: 512 * 1024,
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : null;
    const clientErrorStatusCode =
      statusCode !== null && statusCode >= 400 && statusCode < 500
        ? statusCode
        : null;
    const clientError = clientErrorStatusCode !== null;
    if (!clientError) {
      request.log.error({ err: error }, "Unhandled request error");
    }
    return reply.code(clientErrorStatusCode ?? 500).send({
      code: clientError ? "INVALID_REQUEST" : "INTERNAL_SERVER_ERROR",
      message: clientError ? "请求格式不正确。" : "服务暂时不可用。",
    });
  });

  await app.register(fastifyCookie, { hook: "onRequest" });
  await app.register(fastifyWebsocket, {
    options: {
      maxPayload: QWEN_RELAY_CLIENT_MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
    },
  });
  const auth = new AuthService(authRepository, config.auth.sessionTtlMs);
  const members = new MemberService(memberRepository);
  const characters = new CharacterService(characterRepository);
  const conversations = new ConversationService(conversationRepository);

  if (ownedDatabaseClient) {
    app.addHook("onClose", () => ownedDatabaseClient.close());
  }

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

  await registerAuthRoutes(app, config, auth);
  await registerAdminMemberRoutes(app, config, auth, members);
  await registerCharacterRoutes(
    app,
    config,
    auth,
    characters,
    conversations,
    options.fetchFunction,
    options.qwenWebSocketFactory,
  );
  await registerConversationRoutes(app, config, auth, conversations);
  await registerRealtimeRoutes(app, config, auth);
  return app;
}
