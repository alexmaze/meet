import {
  apiErrorSchema,
  userAccountSchema,
  type GuardianHistoryAccess,
  type UserAccount,
} from "@meet/protocol";

import type { CreateMemberInput } from "./member-logic.js";

export class MemberApiError extends Error {
  constructor(readonly status: number | null) {
    super("家庭成员请求失败");
    this.name = "MemberApiError";
  }
}

export async function listMembers(signal: AbortSignal): Promise<UserAccount[]> {
  const response = await fetch("/api/admin/members", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  const body = await readResponseBody(response);
  if (!isRecord(body)) {
    throw new MemberApiError(response.status);
  }

  const result = userAccountSchema.array().safeParse(body.members);
  if (!result.success) {
    throw new MemberApiError(response.status);
  }
  return result.data;
}

export async function createMember(
  input: CreateMemberInput,
): Promise<UserAccount> {
  const response = await fetch("/api/admin/members", {
    method: "POST",
    credentials: "same-origin",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  return readUserResponse(response);
}

export async function updateChildHistoryAccess(
  memberId: string,
  guardianHistoryAccess: GuardianHistoryAccess,
): Promise<UserAccount> {
  const response = await fetch(memberUrl(memberId), {
    method: "PATCH",
    credentials: "same-origin",
    headers: jsonHeaders,
    body: JSON.stringify({ guardianHistoryAccess }),
  });
  return readUserResponse(response);
}

export async function resetMemberPassword(
  memberId: string,
  password: string,
): Promise<number> {
  const response = await fetch(`${memberUrl(memberId)}/reset-password`, {
    method: "POST",
    credentials: "same-origin",
    headers: jsonHeaders,
    body: JSON.stringify({ password }),
  });
  const body = await readResponseBody(response);
  if (
    !isRecord(body) ||
    body.ok !== true ||
    !Number.isInteger(body.revokedSessionCount) ||
    (body.revokedSessionCount as number) < 0
  ) {
    throw new MemberApiError(response.status);
  }
  return body.revokedSessionCount as number;
}

const jsonHeaders = {
  Accept: "application/json",
  "Content-Type": "application/json",
};

function memberUrl(memberId: string): string {
  return `/api/admin/members/${encodeURIComponent(memberId)}`;
}

async function readUserResponse(response: Response): Promise<UserAccount> {
  const body = await readResponseBody(response);
  if (!isRecord(body)) {
    throw new MemberApiError(response.status);
  }

  const result = userAccountSchema.safeParse(body.member);
  if (!result.success) {
    throw new MemberApiError(response.status);
  }
  return result.data;
}

async function readResponseBody(response: Response): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (!response.ok) {
      throw new MemberApiError(response.status);
    }
    throw new MemberApiError(response.status);
  }

  if (!response.ok) {
    // 解析既有错误结构以确认响应来自 API；展示层按状态码提供稳定文案。
    apiErrorSchema.safeParse(body);
    throw new MemberApiError(response.status);
  }

  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
