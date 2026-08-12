import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import {
  CHARACTER_AVATAR_MAX_BYTES,
  mediaIdParamsSchema,
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
import type { AppConfig } from "../config.js";
import { MediaServiceError, type MediaService } from "../media/service.js";

export async function registerMediaRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  media: MediaService,
): Promise<void> {
  app.post(
    "/api/media/character-avatars",
    { bodyLimit: CHARACTER_AVATAR_MAX_BYTES },
    async (request, reply) => {
      noStore(reply);
      const actor = await authenticateActor(request, reply, config, auth);
      if (!actor) return;
      const contentType = request.headers["content-type"]
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (!Buffer.isBuffer(request.body) || !contentType) {
        return invalidAvatarRequest(reply);
      }
      try {
        const uploaded = await media.uploadCharacterAvatar(actor, {
          body: request.body,
          contentType,
        });
        return reply.code(201).send(uploaded);
      } catch (error) {
        return sendMediaError(reply, error);
      }
    },
  );

  app.get("/api/media/:mediaId", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateActor(request, reply, config, auth);
    if (!actor) return;
    const params = mediaIdParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply);
    try {
      return { media: await media.find(actor, params.data.mediaId) };
    } catch (error) {
      return sendMediaError(reply, error);
    }
  });

  app.get("/api/media/:mediaId/content", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateActor(request, reply, config, auth);
    if (!actor) return;
    const params = mediaIdParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply);
    try {
      const opened = await media.open(actor, params.data.mediaId);
      reply.header("Content-Type", opened.media.contentType);
      reply.header("Content-Length", opened.media.sizeBytes.toString());
      reply.header("Content-Disposition", "inline");
      reply.header("X-Content-Type-Options", "nosniff");
      return reply.send(Readable.fromWeb(opened.body as NodeReadableStream));
    } catch (error) {
      return sendMediaError(reply, error);
    }
  });

  app.delete("/api/media/:mediaId", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateActor(request, reply, config, auth);
    if (!actor) return;
    const params = mediaIdParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply);
    try {
      await media.delete(actor, params.data.mediaId);
      return reply.code(204).send();
    } catch (error) {
      return sendMediaError(reply, error);
    }
  });

  app.post("/api/media/:mediaId/retain", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateActor(request, reply, config, auth);
    if (!actor) return;
    const params = mediaIdParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply);
    try {
      return { media: await media.retain(actor, params.data.mediaId) };
    } catch (error) {
      return sendMediaError(reply, error);
    }
  });
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
    sendMediaError(reply, error);
    return null;
  }
}

function sendMediaError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthError) return sendAuthError(reply, error);
  if (error instanceof MediaServiceError) {
    if (error.statusCode >= 500 && error.cause) {
      reply.request.log.error(
        { ...getSafeErrorLogContext(error.cause), code: error.code },
        "Media operation failed",
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
    message: "请输入有效的媒体标识。",
  });
}

function invalidAvatarRequest(reply: FastifyReply) {
  return reply.code(400).send({
    code: "MEDIA_INVALID_CHARACTER_AVATAR",
    message: "请选择有效的 JPG、PNG 或 WebP 图片，文件不能超过 5 MB。",
  });
}

function noStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "private, no-store");
}
