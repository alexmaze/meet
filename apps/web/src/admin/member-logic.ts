import {
  passwordSchema,
  usernameSchema,
  type GuardianHistoryAccess,
  type UserAccount,
} from "@meet/protocol";

export type CreatableAccountType = "adult" | "child";

export type CreateMemberDraft = {
  username: string;
  displayName: string;
  password: string;
  passwordConfirmation: string;
  accountType: CreatableAccountType;
  guardianHistoryAccess: GuardianHistoryAccess;
};

export type CreateMemberInput = {
  username: string;
  displayName: string;
  password: string;
  accountType: CreatableAccountType;
  guardianHistoryAccess?: GuardianHistoryAccess;
};

type ValidationResult<T> =
  { ok: true; value: T } | { ok: false; message: string };

export function validateCreateMember(
  draft: CreateMemberDraft,
): ValidationResult<CreateMemberInput> {
  const username = usernameSchema.safeParse(draft.username);
  if (!username.success) {
    return { ok: false, message: "请输入不超过 64 个字符的用户名。" };
  }

  const displayName = draft.displayName.trim();
  if (!displayName || displayName.length > 80) {
    return { ok: false, message: "请输入不超过 80 个字符的显示名称。" };
  }

  const password = passwordSchema.safeParse(draft.password);
  if (!password.success) {
    return {
      ok: false,
      message: "密码需为 15–256 个字符，开头和结尾的空格也会计入密码。",
    };
  }

  if (draft.password !== draft.passwordConfirmation) {
    return { ok: false, message: "两次输入的密码不一致。" };
  }

  return {
    ok: true,
    value: {
      username: username.data,
      displayName,
      password: password.data,
      accountType: draft.accountType,
      ...(draft.accountType === "child"
        ? { guardianHistoryAccess: draft.guardianHistoryAccess }
        : {}),
    },
  };
}

export function validatePasswordReset(
  password: string,
  confirmation: string,
): ValidationResult<string> {
  const result = passwordSchema.safeParse(password);
  if (!result.success) {
    return {
      ok: false,
      message: "新密码需为 15–256 个字符，开头和结尾的空格也会计入密码。",
    };
  }

  if (password !== confirmation) {
    return { ok: false, message: "两次输入的新密码不一致。" };
  }

  return { ok: true, value: result.data };
}

export function getMemberErrorMessage(
  status: number | null,
  operation: "list" | "create" | "update" | "reset",
): string {
  if (status === null) {
    return "无法连接家庭成员服务，请检查网络后重试。";
  }

  if (status === 401) {
    return "登录状态已失效，请退出后重新登录。";
  }

  if (status === 403) {
    return "当前账号没有管理家庭成员的权限。";
  }

  if (status === 409) {
    return operation === "create"
      ? "这个用户名已被使用，请换一个用户名。"
      : "成员信息已发生变化，请刷新后重试。";
  }

  if (status === 503) {
    return "家庭成员服务暂不可用，请稍后重试。";
  }

  if (status === 404) {
    return "没有找到这个家庭成员，列表可能已发生变化。";
  }

  if (status === 400 || status === 422) {
    return "提交内容不符合要求，请检查后重试。";
  }

  return operation === "list"
    ? "暂时无法读取家庭成员，请稍后重试。"
    : "操作没有完成，请稍后重试。";
}

const accountTypeOrder: Record<UserAccount["accountType"], number> = {
  admin: 0,
  adult: 1,
  child: 2,
};

export function sortMembers(members: UserAccount[]): UserAccount[] {
  return [...members].sort((left, right) => {
    const typeDifference =
      accountTypeOrder[left.accountType] - accountTypeOrder[right.accountType];
    if (typeDifference !== 0) {
      return typeDifference;
    }

    return left.displayName.localeCompare(right.displayName, "zh-CN");
  });
}
