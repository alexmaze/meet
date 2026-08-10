import {
  apiErrorSchema,
  changePasswordResponseSchema,
  type ChangePasswordRequest,
} from "@meet/protocol";

export class PasswordChangeApiError extends Error {
  constructor(
    readonly status: number | null,
    readonly serverMessage = "",
  ) {
    super("修改密码请求失败");
    this.name = "PasswordChangeApiError";
  }
}

export async function changePassword(
  input: ChangePasswordRequest,
): Promise<number> {
  let response: Response;
  try {
    response = await fetch("/api/auth/change-password", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
  } catch {
    throw new PasswordChangeApiError(null);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PasswordChangeApiError(response.status);
  }
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(body);
    throw new PasswordChangeApiError(
      response.status,
      error.success ? error.data.message : "",
    );
  }

  const result = changePasswordResponseSchema.safeParse(body);
  if (!result.success) throw new PasswordChangeApiError(response.status);
  return result.data.revokedSessionCount;
}
