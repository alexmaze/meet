import { and, asc, eq, isNull, sql } from "drizzle-orm";

import type { Database } from "./client.js";
import {
  accountSecurityAuditEvents,
  loginSessions,
  passwordCredentials,
  userAccounts,
  type UserAccount,
} from "./schema.js";
import { canonicalizeUsername } from "./username.js";

export class MemberUsernameAlreadyExistsError extends Error {
  constructor() {
    super("A user account with this canonical username already exists.");
    this.name = "MemberUsernameAlreadyExistsError";
  }
}

type CreateMemberBaseInput = {
  id?: string;
  username: string;
  displayName: string;
  passwordHash: string;
  actorUserId: string;
  createdAt?: Date;
};

export type CreateMemberAccountInput = CreateMemberBaseInput &
  (
    | {
        accountType: "adult";
        guardianHistoryAccess?: never;
      }
    | {
        accountType: "child";
        guardianHistoryAccess: "allowed" | "denied";
      }
  );

/** Creates the account, credential, and audit event as one atomic operation. */
export async function createMemberAccount(
  db: Database,
  input: CreateMemberAccountInput,
): Promise<UserAccount> {
  const createdAt = input.createdAt ?? new Date();
  const usernameCanonical = canonicalizeUsername(input.username);

  if (usernameCanonical.length === 0) {
    throw new TypeError("Username must not be empty.");
  }

  return db.transaction(async (tx) => {
    const [account] = await tx
      .insert(userAccounts)
      .values({
        ...(input.id === undefined ? {} : { id: input.id }),
        username: input.username.trim(),
        usernameCanonical,
        displayName: input.displayName.trim(),
        accountType: input.accountType,
        status: "active",
        guardianHistoryAccess:
          input.accountType === "child" ? input.guardianHistoryAccess : null,
        createdAt,
        updatedAt: createdAt,
      })
      .onConflictDoNothing({ target: userAccounts.usernameCanonical })
      .returning();

    if (!account) {
      throw new MemberUsernameAlreadyExistsError();
    }

    await tx.insert(passwordCredentials).values({
      userId: account.id,
      passwordHash: input.passwordHash,
      passwordChangedAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    });

    await tx.insert(accountSecurityAuditEvents).values({
      eventType: "member_account_created",
      actorType: "user",
      actorUserId: input.actorUserId,
      targetUserId: account.id,
      details: {
        accountType: account.accountType,
        guardianHistoryAccess: account.guardianHistoryAccess,
      },
      createdAt,
    });

    return account;
  });
}

export async function listMemberAccounts(db: Database): Promise<UserAccount[]> {
  return db
    .select()
    .from(userAccounts)
    .orderBy(
      sql`case when ${userAccounts.accountType} = 'admin' then 0 else 1 end`,
      asc(userAccounts.createdAt),
      asc(userAccounts.id),
    );
}

export type UpdateChildGuardianHistoryAccessResult =
  | { kind: "updated"; account: UserAccount }
  | { kind: "unchanged"; account: UserAccount }
  | { kind: "not_found" | "admin_protected" | "not_child" };

export type UpdateChildGuardianHistoryAccessInput = {
  targetUserId: string;
  guardianHistoryAccess: "allowed" | "denied";
  actorUserId: string;
  changedAt?: Date;
};

/**
 * Changes the child-specific guardian setting under a row lock. Repeating the
 * same value is deliberately audit-free so retries remain idempotent.
 */
export async function updateChildGuardianHistoryAccess(
  db: Database,
  input: UpdateChildGuardianHistoryAccessInput,
): Promise<UpdateChildGuardianHistoryAccessResult> {
  const changedAt = input.changedAt ?? new Date();

  return db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(userAccounts)
      .where(eq(userAccounts.id, input.targetUserId))
      .for("update")
      .limit(1);

    if (!account) return { kind: "not_found" };
    if (account.accountType === "admin") return { kind: "admin_protected" };
    if (account.accountType !== "child") return { kind: "not_child" };
    if (account.guardianHistoryAccess === input.guardianHistoryAccess) {
      return { kind: "unchanged", account };
    }

    const [updatedAccount] = await tx
      .update(userAccounts)
      .set({
        guardianHistoryAccess: input.guardianHistoryAccess,
        updatedAt: changedAt,
      })
      .where(eq(userAccounts.id, account.id))
      .returning();

    if (!updatedAccount) {
      throw new Error("Failed to update the child guardian history access.");
    }

    await tx.insert(accountSecurityAuditEvents).values({
      eventType: "guardian_history_access_changed",
      actorType: "user",
      actorUserId: input.actorUserId,
      targetUserId: account.id,
      details: {
        previous: account.guardianHistoryAccess,
        current: input.guardianHistoryAccess,
      },
      createdAt: changedAt,
    });

    return { kind: "updated", account: updatedAccount };
  });
}

export type ResetMemberPasswordResult =
  | {
      kind: "reset";
      account: UserAccount;
      revokedSessionCount: number;
    }
  | { kind: "not_found" }
  | { kind: "admin_protected" };

export type ResetMemberPasswordInput = {
  targetUserId: string;
  passwordHash: string;
  actorUserId: string;
  changedAt?: Date;
};

/** Password replacement, session revocation, and audit are one transaction. */
export async function resetMemberPassword(
  db: Database,
  input: ResetMemberPasswordInput,
): Promise<ResetMemberPasswordResult> {
  const changedAt = input.changedAt ?? new Date();

  return db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(userAccounts)
      .where(eq(userAccounts.id, input.targetUserId))
      .for("update")
      .limit(1);

    if (!account) return { kind: "not_found" };
    if (account.accountType === "admin") return { kind: "admin_protected" };

    const updatedCredentials = await tx
      .update(passwordCredentials)
      .set({
        passwordHash: input.passwordHash,
        passwordChangedAt: changedAt,
        updatedAt: changedAt,
      })
      .where(eq(passwordCredentials.userId, account.id))
      .returning({ userId: passwordCredentials.userId });

    if (updatedCredentials.length !== 1) {
      throw new Error("Member password credential is missing.");
    }

    const revokedSessions = await tx
      .update(loginSessions)
      .set({
        revokedAt: changedAt,
        revocationReason: "password_reset",
      })
      .where(
        and(
          eq(loginSessions.userId, account.id),
          isNull(loginSessions.revokedAt),
        ),
      )
      .returning({ id: loginSessions.id });

    await tx.insert(accountSecurityAuditEvents).values({
      eventType: "password_reset",
      actorType: "user",
      actorUserId: input.actorUserId,
      targetUserId: account.id,
      details: { revokedSessionCount: revokedSessions.length },
      createdAt: changedAt,
    });

    return {
      kind: "reset",
      account,
      revokedSessionCount: revokedSessions.length,
    };
  });
}
