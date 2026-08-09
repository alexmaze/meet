import type { GuardianHistoryAccess } from "@meet/protocol";

import type { AuthUserRecord } from "../auth/repository.js";

export class MemberUsernameTakenRepositoryError extends Error {
  constructor() {
    super("The canonical username is already in use.");
    this.name = "MemberUsernameTakenRepositoryError";
  }
}

type CreateMemberBaseInput = {
  username: string;
  displayName: string;
  passwordHash: string;
  actorUserId: string;
  createdAt: Date;
};

export type CreateMemberRepositoryInput = CreateMemberBaseInput &
  (
    | { accountType: "adult"; guardianHistoryAccess?: never }
    | {
        accountType: "child";
        guardianHistoryAccess: GuardianHistoryAccess;
      }
  );

export type UpdateGuardianResult =
  | { kind: "updated"; user: AuthUserRecord }
  | { kind: "unchanged"; user: AuthUserRecord }
  | { kind: "not_found" | "admin_protected" | "not_child" };

export type ResetMemberPasswordResult =
  | { kind: "reset"; revokedSessionCount: number }
  | { kind: "not_found" }
  | { kind: "admin_protected" };

export interface AdminMemberRepository {
  listMembers(): Promise<AuthUserRecord[]>;
  findAccountById(userId: string): Promise<AuthUserRecord | null>;
  createMember(input: CreateMemberRepositoryInput): Promise<AuthUserRecord>;
  updateChildGuardianHistoryAccess(
    userId: string,
    guardianHistoryAccess: GuardianHistoryAccess,
    actorUserId: string,
    changedAt: Date,
  ): Promise<UpdateGuardianResult>;
  resetMemberPassword(
    userId: string,
    passwordHash: string,
    actorUserId: string,
    changedAt: Date,
  ): Promise<ResetMemberPasswordResult>;
}
