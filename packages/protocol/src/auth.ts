import { z } from "zod";

export const accountTypeSchema = z.enum(["admin", "adult", "child"]);

export type AccountType = z.infer<typeof accountTypeSchema>;

export const accountStatusSchema = z.enum(["active", "disabled"]);

export type AccountStatus = z.infer<typeof accountStatusSchema>;

export const guardianHistoryAccessSchema = z.enum(["allowed", "denied"]);

export type GuardianHistoryAccess = z.infer<typeof guardianHistoryAccessSchema>;

export const usernameSchema = z.string().trim().min(1).max(64);

// Meet 第一版没有 MFA；新设密码遵循当前无 MFA 账号至少 15 个字符的基线。
export const passwordSchema = z.string().min(15).max(256);

export const userAccountSchema = z.object({
  id: z.uuid(),
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(80),
  accountType: accountTypeSchema,
  status: accountStatusSchema,
  guardianHistoryAccess: guardianHistoryAccessSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type UserAccount = z.infer<typeof userAccountSchema>;

export const loginRequestSchema = z.object({
  username: usernameSchema,
  // 登录接口只限制上限，避免在校验阶段泄露密码策略差异。
  password: z.string().min(1).max(256),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const authenticatedUserResponseSchema = z.object({
  user: userAccountSchema,
});

export type AuthenticatedUserResponse = z.infer<
  typeof authenticatedUserResponseSchema
>;

export const logoutResponseSchema = z.object({
  ok: z.literal(true),
});

export const apiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

export const memberAccountTypeSchema = z.enum(["adult", "child"]);

export type MemberAccountType = z.infer<typeof memberAccountTypeSchema>;

const createMemberBaseSchema = {
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(80),
  password: passwordSchema,
};

export const createMemberRequestSchema = z.discriminatedUnion("accountType", [
  z
    .object({
      ...createMemberBaseSchema,
      accountType: z.literal("adult"),
    })
    .strict(),
  z
    .object({
      ...createMemberBaseSchema,
      accountType: z.literal("child"),
      guardianHistoryAccess: guardianHistoryAccessSchema.default("allowed"),
    })
    .strict(),
]);

export type CreateMemberRequest = z.infer<typeof createMemberRequestSchema>;

export const memberResponseSchema = z.object({
  member: userAccountSchema,
});

export type MemberResponse = z.infer<typeof memberResponseSchema>;

export const memberListResponseSchema = z.object({
  members: z.array(userAccountSchema),
});

export type MemberListResponse = z.infer<typeof memberListResponseSchema>;

export const memberIdParamsSchema = z
  .object({
    memberId: z.uuid(),
  })
  .strict();

export const updateMemberGuardianHistoryAccessRequestSchema = z
  .object({
    guardianHistoryAccess: guardianHistoryAccessSchema,
  })
  .strict();

export type UpdateMemberGuardianHistoryAccessRequest = z.infer<
  typeof updateMemberGuardianHistoryAccessRequestSchema
>;

export const resetMemberPasswordRequestSchema = z
  .object({
    password: passwordSchema,
  })
  .strict();

export type ResetMemberPasswordRequest = z.infer<
  typeof resetMemberPasswordRequestSchema
>;

export const resetMemberPasswordResponseSchema = z.object({
  ok: z.literal(true),
  revokedSessionCount: z.number().int().nonnegative(),
});

export type ResetMemberPasswordResponse = z.infer<
  typeof resetMemberPasswordResponseSchema
>;
