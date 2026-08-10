import {
  createMemberRequestSchema,
  memberIdParamsSchema,
  resetMemberPasswordRequestSchema,
  updateMemberGuardianHistoryAccessRequestSchema,
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
import { MemberServiceError, type MemberService } from "../members/service.js";

export async function registerAdminMemberRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  members: MemberService,
): Promise<void> {
  app.get("/api/admin/members", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const actor = await authenticateAdmin(
      request,
      reply,
      config,
      auth,
      members,
    );
    if (!actor) return;

    try {
      return { members: await members.listMembers(actor) };
    } catch (error) {
      return sendMemberError(reply, error);
    }
  });

  app.post("/api/admin/members", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const actor = await authenticateAdmin(
      request,
      reply,
      config,
      auth,
      members,
    );
    if (!actor) return;

    const input = createMemberRequestSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({
        code: "INVALID_REQUEST",
        message: "请输入有效的成员账号信息。",
      });
    }

    try {
      const member = await members.createMember(actor, input.data);
      return reply.code(201).send({ member });
    } catch (error) {
      return sendMemberError(reply, error);
    }
  });

  app.patch("/api/admin/members/:memberId", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const actor = await authenticateAdmin(
      request,
      reply,
      config,
      auth,
      members,
    );
    if (!actor) return;

    const params = memberIdParamsSchema.safeParse(request.params);
    const input = updateMemberGuardianHistoryAccessRequestSchema.safeParse(
      request.body,
    );
    if (!params.success || !input.success) {
      return reply.code(400).send({
        code: "INVALID_REQUEST",
        message: "请输入有效的儿童历史查看权限。",
      });
    }

    try {
      const member = await members.updateChildGuardianHistoryAccess(
        actor,
        params.data.memberId,
        input.data.guardianHistoryAccess,
      );
      return { member };
    } catch (error) {
      return sendMemberError(reply, error);
    }
  });

  app.post(
    "/api/admin/members/:memberId/reset-password",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const actor = await authenticateAdmin(
        request,
        reply,
        config,
        auth,
        members,
      );
      if (!actor) return;

      const params = memberIdParamsSchema.safeParse(request.params);
      const input = resetMemberPasswordRequestSchema.safeParse(request.body);
      if (!params.success || !input.success) {
        return reply.code(400).send({
          code: "INVALID_REQUEST",
          message: "请输入有效的新密码。",
        });
      }

      try {
        const revokedSessionCount = await members.resetMemberPassword(
          actor,
          params.data.memberId,
          input.data.password,
        );
        return { ok: true, revokedSessionCount };
      } catch (error) {
        return sendMemberError(reply, error);
      }
    },
  );
}

async function authenticateAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
  auth: AuthService,
  members: MemberService,
): Promise<UserAccount | null> {
  try {
    const actor = await auth.authenticate(getSessionToken(request, config));
    members.assertAdmin(actor);
    return actor;
  } catch (error) {
    if (error instanceof AuthError && error.statusCode === 401) {
      clearSessionCookie(reply, config);
    }
    sendMemberError(reply, error);
    return null;
  }
}

function sendMemberError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthError) {
    return sendAuthError(reply, error);
  }
  if (error instanceof MemberServiceError) {
    if (error.statusCode >= 500 && error.cause) {
      reply.request.log.error(
        { ...getSafeErrorLogContext(error.cause), code: error.code },
        "Member repository operation failed",
      );
    }
    return reply.code(error.statusCode).send({
      code: error.code,
      message: error.message,
    });
  }
  throw error;
}
