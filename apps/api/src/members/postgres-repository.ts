import {
  createMemberAccount,
  listMemberAccounts,
  MemberUsernameAlreadyExistsError,
  resetMemberPassword,
  updateChildGuardianHistoryAccess,
  userAccounts,
  type Database,
  type UserAccount,
} from "@meet/database";
import { eq } from "drizzle-orm";

import type { AuthUserRecord } from "../auth/repository.js";
import {
  MemberUsernameTakenRepositoryError,
  type AdminMemberRepository,
  type CreateMemberRepositoryInput,
  type ResetMemberPasswordResult,
  type UpdateGuardianResult,
} from "./repository.js";

export class PostgresMemberRepository implements AdminMemberRepository {
  constructor(private readonly db: Database) {}

  async listMembers(): Promise<AuthUserRecord[]> {
    const accounts = await listMemberAccounts(this.db);
    return accounts.map(toAuthUser);
  }

  async findAccountById(userId: string): Promise<AuthUserRecord | null> {
    const [account] = await this.db
      .select()
      .from(userAccounts)
      .where(eq(userAccounts.id, userId))
      .limit(1);
    return account ? toAuthUser(account) : null;
  }

  async createMember(
    input: CreateMemberRepositoryInput,
  ): Promise<AuthUserRecord> {
    try {
      const account = await createMemberAccount(this.db, input);
      return toAuthUser(account);
    } catch (error) {
      if (error instanceof MemberUsernameAlreadyExistsError) {
        throw new MemberUsernameTakenRepositoryError();
      }
      throw error;
    }
  }

  async updateChildGuardianHistoryAccess(
    userId: string,
    guardianHistoryAccess: "allowed" | "denied",
    actorUserId: string,
    changedAt: Date,
  ): Promise<UpdateGuardianResult> {
    const result = await updateChildGuardianHistoryAccess(this.db, {
      targetUserId: userId,
      guardianHistoryAccess,
      actorUserId,
      changedAt,
    });
    if (result.kind === "updated" || result.kind === "unchanged") {
      return { kind: result.kind, user: toAuthUser(result.account) };
    }
    return result;
  }

  async resetMemberPassword(
    userId: string,
    passwordHash: string,
    actorUserId: string,
    changedAt: Date,
  ): Promise<ResetMemberPasswordResult> {
    const result = await resetMemberPassword(this.db, {
      targetUserId: userId,
      passwordHash,
      actorUserId,
      changedAt,
    });
    if (result.kind !== "reset") return result;
    return {
      kind: "reset",
      revokedSessionCount: result.revokedSessionCount,
    };
  }
}

function toAuthUser(account: UserAccount): AuthUserRecord {
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    accountType: account.accountType,
    status: account.status,
    guardianHistoryAccess: account.guardianHistoryAccess,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}
