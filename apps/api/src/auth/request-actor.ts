import type { UserAccount } from "@meet/protocol";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { AppConfig } from "../config.js";
import {
  DeviceServiceError,
  type DeviceService,
} from "../devices/service.js";
import {
  clearSessionCookie,
  getRequestCredential,
  sendAuthError,
} from "./http.js";
import { AuthError, type AuthService } from "./service.js";

export type RequestActor = {
  user: UserAccount;
  deviceId?: string;
  authKind: "session" | "device";
};

export async function authenticateRequestActor(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
  auth: AuthService,
  devices: DeviceService,
  options?: {
    requiredKind?: "session" | "device";
    onError?: (error: unknown) => void;
  },
): Promise<RequestActor | null> {
  const sendError =
    options?.onError ??
    ((error: unknown) => {
      sendAuthError(reply, error);
    });

  const credential = getRequestCredential(request, config);
  if (!credential) {
    sendError(
      new AuthError("AUTHENTICATION_REQUIRED", "请先登录。", 401),
    );
    return null;
  }

  try {
    if (credential.kind === "session") {
      if (options?.requiredKind === "device") {
        sendError(
          new DeviceServiceError(
            "DEVICE_AUTH_REQUIRED",
            "该操作需要设备凭证。",
            401,
          ),
        );
        return null;
      }
      const user = await auth.authenticate(credential.token);
      return { user, authKind: "session" };
    }

    if (options?.requiredKind === "session") {
      sendError(
        new DeviceServiceError(
          "SESSION_AUTH_REQUIRED",
          "该操作需要浏览器登录。",
          401,
        ),
      );
      return null;
    }

    const deviceAuth = await devices.authenticateCredential(credential.token);
    return {
      user: deviceAuth.user,
      deviceId: deviceAuth.deviceId,
      authKind: "device",
    };
  } catch (error) {
    if (
      credential.kind === "session" &&
      error instanceof AuthError &&
      error.statusCode === 401
    ) {
      clearSessionCookie(reply, config);
    }
    if (error instanceof DeviceServiceError) {
      if (error.statusCode === 401) {
        sendError(
          new AuthError("AUTHENTICATION_REQUIRED", error.message, 401),
        );
        return null;
      }
      reply.code(error.statusCode).send({
        code: error.code,
        message: error.message,
      });
      return null;
    }
    sendError(error);
    return null;
  }
}
