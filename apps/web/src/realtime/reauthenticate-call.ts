import {
  authenticatedUserResponseSchema,
  loginRequestSchema,
  type UserAccount,
} from "@meet/protocol";

import {
  ConversationApiError,
  requestJson,
} from "../history/conversation-api.js";

/** Re-authenticate the same account without unmounting its in-memory text queue. */
export async function reauthenticateCall(
  user: Pick<UserAccount, "id" | "username">,
  password: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await requestJson("/api/auth/login", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        loginRequestSchema.parse({ username: user.username, password }),
      ),
    });
  } catch (error) {
    throw new Error(
      error instanceof ConversationApiError && error.status === 401
        ? "密码不正确，请重试。"
        : "暂时无法重新登录，请稍后重试。",
      { cause: error },
    );
  }
  const parsed = authenticatedUserResponseSchema.safeParse(body);
  if (!parsed.success || parsed.data.user.id !== user.id) {
    // Never submit retained private text under an unexpected authenticated account.
    await requestJson("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    }).catch(() => undefined);
    throw new Error("无法确认原账号身份，尚未发送保留的文字。请联系管理员。");
  }
}
