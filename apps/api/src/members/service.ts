import type {
  CreateMemberRequest,
  GuardianHistoryAccess,
  UserAccount,
} from "@meet/protocol";

import { hashPassword } from "../auth/password.js";
import type { AuthUserRecord } from "../auth/repository.js";
import {
  MemberUsernameTakenRepositoryError,
  type AdminMemberRepository,
} from "./repository.js";

export type MemberServiceErrorCode =
  | "ADMIN_REQUIRED"
  | "MEMBER_NOT_FOUND"
  | "ADMIN_ACCOUNT_PROTECTED"
  | "MEMBER_NOT_CHILD"
  | "USERNAME_TAKEN"
  | "MEMBER_SERVICE_UNAVAILABLE";

export class MemberServiceError extends Error {
  constructor(
    readonly code: MemberServiceErrorCode,
    message: string,
    readonly statusCode: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MemberServiceError";
  }
}

type PasswordHasher = (password: string) => Promise<string>;

export class MemberService {
  constructor(
    private readonly repository: AdminMemberRepository | null,
    private readonly passwordHasher: PasswordHasher = hashPassword,
    private readonly now: () => Date = () => new Date(),
  ) {}

  assertAdmin(actor: UserAccount): void {
    if (actor.accountType !== "admin") {
      throw new MemberServiceError(
        "ADMIN_REQUIRED",
        "只有管理员可以管理家庭成员。",
        403,
      );
    }
  }

  async listMembers(actor: UserAccount): Promise<UserAccount[]> {
    this.assertAdmin(actor);
    const members = await this.callRepository((repository) =>
      repository.listMembers(),
    );
    return members.map(toPublicUser);
  }

  async createMember(
    actor: UserAccount,
    input: CreateMemberRequest,
  ): Promise<UserAccount> {
    this.assertAdmin(actor);
    const repository = this.requireRepository();
    const passwordHash = await this.passwordHasher(input.password);
    const createdAt = this.now();

    try {
      const commonInput = {
        username: input.username,
        displayName: input.displayName,
        passwordHash,
        actorUserId: actor.id,
        createdAt,
      };
      const member =
        input.accountType === "child"
          ? await repository.createMember({
              ...commonInput,
              accountType: "child",
              guardianHistoryAccess: input.guardianHistoryAccess,
            })
          : await repository.createMember({
              ...commonInput,
              accountType: "adult",
            });
      return toPublicUser(member);
    } catch (error) {
      if (error instanceof MemberUsernameTakenRepositoryError) {
        throw new MemberServiceError(
          "USERNAME_TAKEN",
          "该用户名已被使用。",
          409,
        );
      }
      throw unavailableError(error);
    }
  }

  async updateChildGuardianHistoryAccess(
    actor: UserAccount,
    memberId: string,
    guardianHistoryAccess: GuardianHistoryAccess,
  ): Promise<UserAccount> {
    this.assertAdmin(actor);
    const result = await this.callRepository((repository) =>
      repository.updateChildGuardianHistoryAccess(
        memberId,
        guardianHistoryAccess,
        actor.id,
        this.now(),
      ),
    );

    switch (result.kind) {
      case "updated":
      case "unchanged":
        return toPublicUser(result.user);
      case "not_found":
        throw memberNotFoundError();
      case "admin_protected":
        throw adminProtectedError();
      case "not_child":
        throw new MemberServiceError(
          "MEMBER_NOT_CHILD",
          "只有儿童账号可以配置历史查看权限。",
          400,
        );
    }
  }

  async resetMemberPassword(
    actor: UserAccount,
    memberId: string,
    password: string,
  ): Promise<number> {
    this.assertAdmin(actor);

    // 先确认目标是家庭成员，再执行昂贵的密码派生。数据库事务还会再次
    // 校验账号类型，避免任何 Web 路径修改管理员凭据。
    const target = await this.callRepository((repository) =>
      repository.findAccountById(memberId),
    );
    if (!target) throw memberNotFoundError();
    if (target.accountType === "admin") throw adminProtectedError();

    const passwordHash = await this.passwordHasher(password);
    const result = await this.callRepository((repository) =>
      repository.resetMemberPassword(
        memberId,
        passwordHash,
        actor.id,
        this.now(),
      ),
    );
    if (result.kind === "not_found") throw memberNotFoundError();
    if (result.kind === "admin_protected") throw adminProtectedError();
    return result.revokedSessionCount;
  }

  private async callRepository<T>(
    operation: (repository: AdminMemberRepository) => Promise<T>,
  ): Promise<T> {
    const repository = this.requireRepository();
    try {
      return await operation(repository);
    } catch (error) {
      if (error instanceof MemberServiceError) throw error;
      throw unavailableError(error);
    }
  }

  private requireRepository(): AdminMemberRepository {
    if (!this.repository) {
      throw new MemberServiceError(
        "MEMBER_SERVICE_UNAVAILABLE",
        "成员管理服务尚未配置数据库。",
        503,
      );
    }
    return this.repository;
  }
}

function memberNotFoundError(): MemberServiceError {
  return new MemberServiceError("MEMBER_NOT_FOUND", "未找到该家庭成员。", 404);
}

function adminProtectedError(): MemberServiceError {
  return new MemberServiceError(
    "ADMIN_ACCOUNT_PROTECTED",
    "管理员账号不能通过成员管理接口修改。",
    403,
  );
}

function unavailableError(cause: unknown): MemberServiceError {
  return new MemberServiceError(
    "MEMBER_SERVICE_UNAVAILABLE",
    "成员管理服务暂时不可用，请稍后重试。",
    503,
    { cause },
  );
}

function toPublicUser(user: AuthUserRecord): UserAccount {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    accountType: user.accountType,
    status: user.status,
    guardianHistoryAccess: user.guardianHistoryAccess,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
