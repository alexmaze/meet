import { changePasswordRequestSchema } from "@meet/protocol";

export type PasswordChangeInput = {
  currentPassword: string;
  newPassword: string;
};

type ValidationResult =
  { ok: true; value: PasswordChangeInput } | { ok: false; message: string };

export function validatePasswordChange(
  currentPassword: string,
  newPassword: string,
  confirmation: string,
): ValidationResult {
  if (!currentPassword) {
    return { ok: false, message: "请输入当前密码。" };
  }
  if (!newPassword) {
    return { ok: false, message: "请输入新密码。" };
  }
  if (newPassword !== confirmation) {
    return { ok: false, message: "两次输入的新密码不一致。" };
  }

  const result = changePasswordRequestSchema.safeParse({
    currentPassword,
    newPassword,
  });
  if (!result.success) {
    return { ok: false, message: "密码不能超过 256 个字符。" };
  }
  return { ok: true, value: result.data };
}

export function getPasswordChangeErrorMessage(
  status: number | null,
  serverMessage = "",
): string {
  if (status === null) return "无法连接账号服务，请检查网络后重试。";
  if (status === 400 && serverMessage) return serverMessage;
  if (status === 401) return "登录状态已失效，请重新登录。";
  if (status === 429) return "密码验证尝试过于频繁，请稍后再试。";
  if (status === 503) return "账号服务暂不可用，请稍后重试。";
  return "密码修改失败，请稍后重试。";
}
