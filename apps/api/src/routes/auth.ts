import {
  changePasswordRequestSchema,
  loginRequestSchema,
} from "@meet/protocol";
import type { FastifyInstance } from "fastify";

import {
  clearSessionCookie,
  getSessionToken,
  sendAuthError,
  setSessionCookie,
} from "../auth/http.js";
import { LoginRateLimiter } from "../auth/login-rate-limit.js";
import { authenticateRequestActor } from "../auth/request-actor.js";
import { AuthError, type AuthService } from "../auth/service.js";
import type { AppConfig } from "../config.js";
import type { DeviceService } from "../devices/service.js";

export async function registerAuthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  devices: DeviceService,
): Promise<void> {
  const loginRateLimiter = new LoginRateLimiter(
    config.auth.loginMaxAttempts,
    config.auth.loginWindowMs,
  );

  app.post("/api/auth/login", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const input = loginRequestSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({
        code: "INVALID_REQUEST",
        message: "请输入有效的用户名和密码。",
      });
    }

    // 先按来源 IP 限制昂贵的 scrypt 工作，避免通过轮换用户名绕过。
    const rateLimitKey = request.ip;
    const rateLimit = loginRateLimiter.consume(rateLimitKey);
    if (!rateLimit.allowed) {
      reply.header("Retry-After", String(rateLimit.retryAfterSeconds));
      return reply.code(429).send({
        code: "RATE_LIMITED",
        message: "登录尝试过于频繁，请稍后再试。",
      });
    }

    try {
      const result = await auth.login(input.data.username, input.data.password);
      loginRateLimiter.reset(rateLimitKey);
      setSessionCookie(reply, config, result.sessionToken, result.expiresAt);
      return { user: result.user };
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.get("/api/auth/me", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const actor = await authenticateRequestActor(
      request,
      reply,
      config,
      auth,
      devices,
    );
    if (!actor) return;
    return { user: actor.user };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const sessionToken = getSessionToken(request, config);
    clearSessionCookie(reply, config);

    try {
      await auth.logout(sessionToken);
      return { ok: true };
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.post("/api/auth/change-password", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const input = changePasswordRequestSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({
        code: "INVALID_REQUEST",
        message: "请输入当前密码和新密码。",
      });
    }

    const rateLimitKey = `${request.ip}:change-password`;
    const rateLimit = loginRateLimiter.consume(rateLimitKey);
    if (!rateLimit.allowed) {
      reply.header("Retry-After", String(rateLimit.retryAfterSeconds));
      return reply.code(429).send({
        code: "RATE_LIMITED",
        message: "密码验证尝试过于频繁，请稍后再试。",
      });
    }

    try {
      const revokedSessionCount = await auth.changePassword(
        getSessionToken(request, config),
        input.data.currentPassword,
        input.data.newPassword,
      );
      loginRateLimiter.reset(rateLimitKey);
      return { ok: true, revokedSessionCount };
    } catch (error) {
      if (error instanceof AuthError && error.statusCode === 401) {
        clearSessionCookie(reply, config);
      }
      return sendAuthError(reply, error);
    }
  });
}
