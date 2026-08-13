import {
  createManagedVoiceRequestSchema,
  createModelConnectionRequestSchema,
  createModelProfileRequestSchema,
  modelPurposeSchema,
  modelSettingsIdParamsSchema,
  testModelProfileRequestSchema,
  updateModelBindingRequestSchema,
  updateModelConnectionRequestSchema,
  updateModelProfileRequestSchema,
  type UserAccount,
} from "@meet/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  clearSessionCookie,
  getSafeErrorLogContext,
  getSessionToken,
  sendAuthError,
} from "../auth/http.js";
import { AuthError, type AuthService } from "../auth/service.js";
import type { AppConfig } from "../config.js";
import {
  ModelSettingsServiceError,
  type ModelSettingsService,
} from "../model-settings/service.js";

export async function registerAdminModelSettingsRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  service: ModelSettingsService,
): Promise<void> {
  const admin = async (request: FastifyRequest, reply: FastifyReply) =>
    authenticateAdmin(request, reply, config, auth, service);

  app.get("/api/admin/model-settings", async (request, reply) => {
    noStore(reply);
    const actor = await admin(request, reply);
    if (!actor) return;
    try {
      return await service.list(actor);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/admin/model-connections", async (request, reply) => {
    noStore(reply);
    const actor = await admin(request, reply);
    if (!actor) return;
    const input = createModelConnectionRequestSchema.safeParse(request.body);
    if (!input.success) return invalid(reply);
    try {
      return reply.code(201).send({
        connection: await service.createConnection(actor, input.data),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch("/api/admin/model-connections/:id", async (request, reply) => {
    noStore(reply);
    const actor = await admin(request, reply);
    if (!actor) return;
    const params = modelSettingsIdParamsSchema.safeParse(request.params);
    const input = updateModelConnectionRequestSchema.safeParse(request.body);
    if (!params.success || !input.success) return invalid(reply);
    try {
      await service.updateConnection(actor, params.data.id, input.data);
      return { ok: true };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/admin/models", async (request, reply) => {
    noStore(reply);
    const actor = await admin(request, reply);
    if (!actor) return;
    const input = createModelProfileRequestSchema.safeParse(request.body);
    if (!input.success) return invalid(reply);
    try {
      const id = await service.createModel(actor, input.data);
      return reply.code(201).send({ id });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch("/api/admin/models/:id", async (request, reply) => {
    noStore(reply);
    const actor = await admin(request, reply);
    if (!actor) return;
    const params = modelSettingsIdParamsSchema.safeParse(request.params);
    const input = updateModelProfileRequestSchema.safeParse(request.body);
    if (!params.success || !input.success) return invalid(reply);
    try {
      await service.updateModel(actor, params.data.id, input.data);
      return { ok: true };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete("/api/admin/models/:id", async (request, reply) => {
    noStore(reply);
    const actor = await admin(request, reply);
    if (!actor) return;
    const params = modelSettingsIdParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply);
    try {
      await service.deleteModel(actor, params.data.id);
      return reply.code(204).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/admin/models/:id/test", async (request, reply) => {
    noStore(reply);
    const actor = await admin(request, reply);
    if (!actor) return;
    const params = modelSettingsIdParamsSchema.safeParse(request.params);
    const input = testModelProfileRequestSchema.safeParse(request.body ?? {});
    if (!params.success || !input.success) return invalid(reply);
    try {
      await service.testModel(actor, params.data.id, input.data.voiceProfileId);
      return { ok: true };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/admin/models/:id/voices", async (request, reply) => {
    noStore(reply);
    const actor = await admin(request, reply);
    if (!actor) return;
    const params = modelSettingsIdParamsSchema.safeParse(request.params);
    const input = createManagedVoiceRequestSchema.safeParse(request.body);
    if (!params.success || !input.success) return invalid(reply);
    try {
      return reply.code(201).send({
        id: await service.createVoice(actor, params.data.id, input.data),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.put("/api/admin/model-bindings/:purpose", async (request, reply) => {
    noStore(reply);
    const actor = await admin(request, reply);
    if (!actor) return;
    const params = z
      .object({ purpose: modelPurposeSchema })
      .strict()
      .safeParse(request.params);
    const input = updateModelBindingRequestSchema.safeParse(request.body);
    if (!params.success || !input.success) return invalid(reply);
    try {
      await service.bind(actor, params.data.purpose, input.data.modelProfileId);
      return { ok: true };
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

async function authenticateAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
  auth: AuthService,
  service: ModelSettingsService,
): Promise<UserAccount | null> {
  try {
    const actor = await auth.authenticate(getSessionToken(request, config));
    service.assertAdmin(actor);
    return actor;
  } catch (error) {
    if (error instanceof AuthError && error.statusCode === 401) {
      clearSessionCookie(reply, config);
    }
    sendError(reply, error);
    return null;
  }
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthError) return sendAuthError(reply, error);
  if (error instanceof ModelSettingsServiceError) {
    if (error.statusCode >= 500 && error.cause) {
      reply.request.log.error(
        { ...getSafeErrorLogContext(error.cause), code: error.code },
        "Model settings operation failed",
      );
    }
    return reply.code(error.statusCode).send({
      code: error.code,
      message: error.message,
    });
  }
  throw error;
}

function invalid(reply: FastifyReply) {
  return reply.code(400).send({
    code: "INVALID_REQUEST",
    message: "模型设置内容无效。",
  });
}

function noStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
}
