import {
  bindDeviceRequestSchema,
  createPairingSessionRequestSchema,
  deviceIdParamsSchema,
  pairingSessionIdParamsSchema,
  updateDeviceMeRequestSchema,
} from "@meet/protocol";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  getSafeErrorLogContext,
  sendAuthError,
} from "../auth/http.js";
import { AuthError, type AuthService } from "../auth/service.js";
import { LoginRateLimiter } from "../auth/login-rate-limit.js";
import { authenticateRequestActor } from "../auth/request-actor.js";
import type { AppConfig } from "../config.js";
import {
  DeviceServiceError,
  type DeviceService,
} from "../devices/service.js";

export async function registerDeviceRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  devices: DeviceService,
): Promise<void> {
  const pairingCreateRateLimiter = new LoginRateLimiter(5, 60_000);

  app.post("/api/devices/pairing-sessions", async (request, reply) => {
    noStore(reply);
    const rateLimit = pairingCreateRateLimiter.consume(request.ip);
    if (!rateLimit.allowed) {
      reply.header("Retry-After", String(rateLimit.retryAfterSeconds));
      return reply.code(429).send({
        code: "RATE_LIMITED",
        message: "配对请求过于频繁，请稍后再试。",
      });
    }

    const input = createPairingSessionRequestSchema.safeParse(
      request.body ?? {},
    );
    if (!input.success) {
      return invalidRequest(reply);
    }

    try {
      return await devices.createPairingSession(input.data);
    } catch (error) {
      return sendDeviceError(reply, error);
    }
  });

  app.get("/api/devices/pairing-sessions/:id", async (request, reply) => {
    noStore(reply);
    const params = pairingSessionIdParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply);
    try {
      return await devices.getPairingSession(params.data.id);
    } catch (error) {
      return sendDeviceError(reply, error);
    }
  });

  app.post("/api/devices/bindings", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateRequestActor(
      request,
      reply,
      config,
      auth,
      devices,
      {
        requiredKind: "session",
        onError: (error) => sendDeviceError(reply, error),
      },
    );
    if (!actor) return;
    const input = bindDeviceRequestSchema.safeParse(request.body);
    if (!input.success) return invalidRequest(reply);
    try {
      return {
        device: await devices.bindByCode(actor.user, input.data.code),
      };
    } catch (error) {
      return sendDeviceError(reply, error);
    }
  });

  app.get("/api/devices", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateRequestActor(
      request,
      reply,
      config,
      auth,
      devices,
      {
        requiredKind: "session",
        onError: (error) => sendDeviceError(reply, error),
      },
    );
    if (!actor) return;
    try {
      return { devices: await devices.listDevices(actor.user) };
    } catch (error) {
      return sendDeviceError(reply, error);
    }
  });

  app.delete("/api/devices/:id", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateRequestActor(
      request,
      reply,
      config,
      auth,
      devices,
      {
        requiredKind: "session",
        onError: (error) => sendDeviceError(reply, error),
      },
    );
    if (!actor) return;
    const params = deviceIdParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply);
    try {
      await devices.revokeDevice(actor.user, params.data.id);
      return { ok: true };
    } catch (error) {
      return sendDeviceError(reply, error);
    }
  });

  app.patch("/api/devices/me", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateRequestActor(
      request,
      reply,
      config,
      auth,
      devices,
      {
        requiredKind: "device",
        onError: (error) => sendDeviceError(reply, error),
      },
    );
    if (!actor || !actor.deviceId) return;
    const input = updateDeviceMeRequestSchema.safeParse(request.body);
    if (!input.success) return invalidRequest(reply);
    try {
      return {
        device: await devices.updateMe(
          actor.user,
          actor.deviceId,
          input.data,
        ),
      };
    } catch (error) {
      return sendDeviceError(reply, error);
    }
  });
}

function sendDeviceError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthError) return sendAuthError(reply, error);
  if (error instanceof DeviceServiceError) {
    if (error.statusCode >= 500 && error.cause) {
      reply.request.log.error(
        { ...getSafeErrorLogContext(error.cause), code: error.code },
        "Device repository operation failed",
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
    message: "请输入有效的设备配对信息。",
  });
}

function noStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
}
