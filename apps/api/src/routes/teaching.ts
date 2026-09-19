import {
  childTeachingAvailabilityParamsSchema,
  learningPlanListQuerySchema,
  learningPlanGenerationParamsSchema,
  learningPlanParamsSchema,
  publishLearningPlanContentRequestSchema,
  muteConversationTeachingRequestSchema,
  prepareConversationTeachingRequestSchema,
  putLearningPlanRequestSchema,
  requestLearningPlanGenerationSchema,
  teachingConversationParamsSchema,
  type UserAccount,
} from "@meet/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  getSafeErrorLogContext,
  sendAuthError,
} from "../auth/http.js";
import { AuthError, type AuthService } from "../auth/service.js";
import { authenticateRequestActor } from "../auth/request-actor.js";
import type { AppConfig } from "../config.js";
import type { DeviceService } from "../devices/service.js";
import {
  TeachingServiceError,
  type TeachingService,
} from "../teaching/service.js";

export async function registerTeachingRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  teaching: TeachingService,
  devices: DeviceService,
): Promise<void> {
  app.get("/api/teaching/targets", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateActor(
      request,
      reply,
      config,
      auth,
      devices,
    );
    if (!actor) return;
    if (!authorizePlanManager(reply, teaching, actor)) return;
    try {
      return await teaching.listManagementTargets(actor);
    } catch (error) {
      return sendTeachingError(reply, error);
    }
  });

  app.get("/api/teaching/plans", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateActor(
      request,
      reply,
      config,
      auth,
      devices,
    );
    if (!actor) return;
    if (!authorizePlanManager(reply, teaching, actor)) return;
    const query = learningPlanListQuerySchema.safeParse(request.query);
    if (!query.success) return invalidRequest(reply);
    try {
      return {
        learningPlans: await teaching.listPlans(actor, query.data.childUserId),
      };
    } catch (error) {
      return sendTeachingError(reply, error);
    }
  });

  app.put(
    "/api/teaching/plans/:childUserId/:characterId",
    async (request, reply) => {
      noStore(reply);
      const actor = await authenticateActor(
      request,
      reply,
      config,
      auth,
      devices,
    );
      if (!actor) return;
      if (!authorizePlanManager(reply, teaching, actor)) return;
      const params = learningPlanParamsSchema.safeParse(request.params);
      const input = putLearningPlanRequestSchema.safeParse(request.body);
      if (!params.success || !input.success) return invalidRequest(reply);
      try {
        return {
          learningPlan: await teaching.putPlan(
            actor,
            params.data.childUserId,
            params.data.characterId,
            input.data,
          ),
        };
      } catch (error) {
        return sendTeachingError(reply, error);
      }
    },
  );

  app.post(
    "/api/teaching/plans/:childUserId/:characterId/generations",
    async (request, reply) => {
      noStore(reply);
      const actor = await authenticateActor(
      request,
      reply,
      config,
      auth,
      devices,
    );
      if (!actor) return;
      if (!authorizePlanManager(reply, teaching, actor)) return;
      const params = learningPlanParamsSchema.safeParse(request.params);
      const input = requestLearningPlanGenerationSchema.safeParse(request.body);
      if (!params.success || !input.success) return invalidRequest(reply);
      try {
        return await teaching.requestGeneration(
          actor,
          params.data.childUserId,
          params.data.characterId,
          input.data,
        );
      } catch (error) {
        return sendTeachingError(reply, error);
      }
    },
  );

  app.get(
    "/api/teaching/plans/:childUserId/:characterId/generations/:generationId",
    async (request, reply) => {
      noStore(reply);
      const actor = await authenticateActor(
      request,
      reply,
      config,
      auth,
      devices,
    );
      if (!actor) return;
      if (!authorizePlanManager(reply, teaching, actor)) return;
      const params = learningPlanGenerationParamsSchema.safeParse(
        request.params,
      );
      if (!params.success) return invalidRequest(reply);
      try {
        return await teaching.loadGeneration(
          actor,
          params.data.childUserId,
          params.data.characterId,
          params.data.generationId,
        );
      } catch (error) {
        return sendTeachingError(reply, error);
      }
    },
  );

  app.get(
    "/api/teaching/plans/:childUserId/:characterId/content",
    async (request, reply) => {
      noStore(reply);
      const actor = await authenticateActor(
      request,
      reply,
      config,
      auth,
      devices,
    );
      if (!actor) return;
      if (!authorizePlanManager(reply, teaching, actor)) return;
      const params = learningPlanParamsSchema.safeParse(request.params);
      if (!params.success) return invalidRequest(reply);
      try {
        return await teaching.getContent(
          actor,
          params.data.childUserId,
          params.data.characterId,
        );
      } catch (error) {
        return sendTeachingError(reply, error);
      }
    },
  );

  app.post(
    "/api/teaching/plans/:childUserId/:characterId/content/publish",
    async (request, reply) => {
      noStore(reply);
      const actor = await authenticateActor(
      request,
      reply,
      config,
      auth,
      devices,
    );
      if (!actor) return;
      if (!authorizePlanManager(reply, teaching, actor)) return;
      const params = learningPlanParamsSchema.safeParse(request.params);
      const input = publishLearningPlanContentRequestSchema.safeParse(
        request.body,
      );
      if (!params.success || !input.success) return invalidRequest(reply);
      try {
        return await teaching.publishContent(
          actor,
          params.data.childUserId,
          params.data.characterId,
          input.data,
        );
      } catch (error) {
        return sendTeachingError(reply, error);
      }
    },
  );

  app.get("/api/teaching/availability/:characterId", async (request, reply) => {
    noStore(reply);
    const actor = await authenticateActor(
      request,
      reply,
      config,
      auth,
      devices,
    );
    if (!actor) return;
    if (!authorizeChild(reply, teaching, actor)) return;
    const params = childTeachingAvailabilityParamsSchema.safeParse(
      request.params,
    );
    if (!params.success) return invalidRequest(reply);
    try {
      return {
        teaching: await teaching.availability(actor, params.data.characterId),
      };
    } catch (error) {
      return sendTeachingError(reply, error);
    }
  });

  app.post(
    "/api/conversations/:conversationId/teaching/prepare",
    async (request, reply) => {
      noStore(reply);
      const requestActor = await authenticateRequestActor(
        request,
        reply,
        config,
        auth,
        devices,
        { onError: (error) => sendTeachingError(reply, error) },
      );
      if (!requestActor) return;
      const actor = requestActor.user;
      if (!authorizeChild(reply, teaching, actor)) return;
      const params = teachingConversationParamsSchema.safeParse(request.params);
      const input = prepareConversationTeachingRequestSchema.safeParse(
        request.body,
      );
      if (!params.success || !input.success) return invalidRequest(reply);
      const prepareInput =
        requestActor.authKind === "device" && actor.accountType === "child"
          ? ({ choice: "chat_only" } as const)
          : input.data;
      try {
        return {
          teaching: await teaching.prepareConversation(
            actor,
            params.data.conversationId,
            prepareInput,
          ),
        };
      } catch (error) {
        return sendTeachingError(reply, error);
      }
    },
  );

  app.post(
    "/api/conversations/:conversationId/teaching/mute",
    async (request, reply) => {
      noStore(reply);
      const actor = await authenticateActor(
      request,
      reply,
      config,
      auth,
      devices,
    );
      if (!actor) return;
      if (!authorizeChild(reply, teaching, actor)) return;
      const params = teachingConversationParamsSchema.safeParse(request.params);
      const input = muteConversationTeachingRequestSchema.safeParse(
        request.body,
      );
      if (!params.success || !input.success) return invalidRequest(reply);
      try {
        return {
          teaching: await teaching.muteConversation(
            actor,
            params.data.conversationId,
          ),
        };
      } catch (error) {
        return sendTeachingError(reply, error);
      }
    },
  );
}

async function authenticateActor(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
  auth: AuthService,
  devices: DeviceService,
): Promise<UserAccount | null> {
  const actor = await authenticateRequestActor(
    request,
    reply,
    config,
    auth,
    devices,
    { onError: (error) => sendTeachingError(reply, error) },
  );
  return actor?.user ?? null;
}

function authorizePlanManager(
  reply: FastifyReply,
  teaching: TeachingService,
  actor: UserAccount,
): boolean {
  try {
    teaching.assertPlanManager(actor);
    return true;
  } catch (error) {
    sendTeachingError(reply, error);
    return false;
  }
}

function authorizeChild(
  reply: FastifyReply,
  teaching: TeachingService,
  actor: UserAccount,
): boolean {
  try {
    teaching.assertChild(actor);
    return true;
  } catch (error) {
    sendTeachingError(reply, error);
    return false;
  }
}

function sendTeachingError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthError) return sendAuthError(reply, error);
  if (error instanceof TeachingServiceError) {
    if (error.statusCode >= 500 && error.cause) {
      reply.request.log.error(
        { ...getSafeErrorLogContext(error.cause), code: error.code },
        "Teaching repository operation failed",
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
    message: "请输入有效的教学计划操作。",
  });
}

function noStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
}
