import type {
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";

import type { AppConfig } from "../config.js";
import { AuthError } from "./service.js";
import type { AuthService } from "./service.js";

export function createRequireAuthHook(
  auth: AuthService,
  config: AppConfig,
): preHandlerHookHandler {
  return async (request, reply) => {
    try {
      await auth.authenticate(request.cookies[config.auth.cookieName]);
    } catch (error) {
      if (error instanceof AuthError && error.statusCode === 401) {
        clearSessionCookie(reply, config);
      }
      sendAuthError(reply, error);
    }
  };
}

export function getSessionToken(
  request: FastifyRequest,
  config: AppConfig,
): string | undefined {
  return request.cookies[config.auth.cookieName];
}

export function getBearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token || undefined;
}

export function getRequestCredential(
  request: FastifyRequest,
  config: AppConfig,
): { kind: "session" | "device"; token: string } | undefined {
  const sessionToken = getSessionToken(request, config);
  if (sessionToken) {
    return { kind: "session", token: sessionToken };
  }
  const bearerToken = getBearerToken(request);
  if (bearerToken) {
    return { kind: "device", token: bearerToken };
  }
  return undefined;
}

export function setSessionCookie(
  reply: FastifyReply,
  config: AppConfig,
  token: string,
  expiresAt: Date,
): void {
  reply.setCookie(config.auth.cookieName, token, {
    ...getBaseCookieOptions(config),
    expires: expiresAt,
  });
}

export function clearSessionCookie(
  reply: FastifyReply,
  config: AppConfig,
): void {
  reply.clearCookie(config.auth.cookieName, getBaseCookieOptions(config));
}

export function sendAuthError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthError) {
    if (error.statusCode >= 500 && error.cause) {
      reply.request.log.error(
        { ...getSafeErrorLogContext(error.cause), code: error.code },
        "Authentication repository operation failed",
      );
    }
    return reply.code(error.statusCode).send({
      code: error.code,
      message: error.message,
    });
  }
  throw error;
}

export function getSafeErrorLogContext(error: unknown): Record<string, string> {
  if (typeof error !== "object" || error === null) {
    return { causeType: typeof error };
  }

  const context: Record<string, string> = {
    causeName:
      error instanceof Error && error.name ? error.name : "UnknownError",
  };
  for (const key of ["code", "constraint", "table"] as const) {
    const value = Reflect.get(error, key);
    if (typeof value === "string" && value.length <= 160) {
      context[`cause${key[0]?.toUpperCase()}${key.slice(1)}`] = value;
    }
  }
  return context;
}

function getBaseCookieOptions(config: AppConfig) {
  return {
    httpOnly: true,
    path: "/api",
    sameSite: "lax" as const,
    secure: config.auth.cookieSecure,
  };
}
