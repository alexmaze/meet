import {
  canonicalizeUsername,
  changeOwnPassword,
  createLoginSessionIfCredentialCurrent,
  initializeFirstAdmin,
  loginSessions,
  passwordCredentials,
  resetPasswordAndRevokeSessions,
  userAccounts,
  type Database,
  type UserAccount,
} from "@meet/database";
import { and, eq, gt, isNull } from "drizzle-orm";

import type {
  AdminAccountRepository,
  AuthUserRecord,
  ChangeOwnPasswordResult,
  CredentialRecord,
  InitialAdminInput,
  LoginSessionRecord,
} from "./repository.js";

export class PostgresAuthRepository implements AdminAccountRepository {
  constructor(private readonly db: Database) {}

  async findCredentialByUsername(
    username: string,
  ): Promise<CredentialRecord | null> {
    const [result] = await this.db
      .select({
        user: userAccounts,
        passwordHash: passwordCredentials.passwordHash,
      })
      .from(userAccounts)
      .innerJoin(
        passwordCredentials,
        eq(passwordCredentials.userId, userAccounts.id),
      )
      .where(eq(userAccounts.usernameCanonical, canonicalizeUsername(username)))
      .limit(1);

    return result
      ? { user: toAuthUser(result.user), passwordHash: result.passwordHash }
      : null;
  }

  async findCredentialBySessionTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<CredentialRecord | null> {
    const [result] = await this.db
      .select({
        user: userAccounts,
        passwordHash: passwordCredentials.passwordHash,
      })
      .from(loginSessions)
      .innerJoin(userAccounts, eq(userAccounts.id, loginSessions.userId))
      .innerJoin(
        passwordCredentials,
        eq(passwordCredentials.userId, userAccounts.id),
      )
      .where(
        and(
          eq(loginSessions.tokenHash, tokenHash),
          isNull(loginSessions.revokedAt),
          gt(loginSessions.expiresAt, now),
        ),
      )
      .limit(1);

    return result
      ? { user: toAuthUser(result.user), passwordHash: result.passwordHash }
      : null;
  }

  async createLoginSessionIfCredentialCurrent(
    session: LoginSessionRecord,
    expectedPasswordHash: string,
  ): Promise<boolean> {
    return createLoginSessionIfCredentialCurrent(this.db, {
      ...session,
      expectedPasswordHash,
    });
  }

  async findUserBySessionTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<AuthUserRecord | null> {
    const [result] = await this.db
      .select({ user: userAccounts })
      .from(loginSessions)
      .innerJoin(userAccounts, eq(userAccounts.id, loginSessions.userId))
      .where(
        and(
          eq(loginSessions.tokenHash, tokenHash),
          isNull(loginSessions.revokedAt),
          gt(loginSessions.expiresAt, now),
        ),
      )
      .limit(1);

    return result ? toAuthUser(result.user) : null;
  }

  async revokeLoginSession(tokenHash: string, revokedAt: Date): Promise<void> {
    await this.db
      .update(loginSessions)
      .set({ revokedAt, revocationReason: "logout" })
      .where(
        and(
          eq(loginSessions.tokenHash, tokenHash),
          isNull(loginSessions.revokedAt),
        ),
      );
  }

  async changeOwnPassword(input: {
    userId: string;
    currentSessionTokenHash: string;
    expectedPasswordHash: string;
    newPasswordHash: string;
    changedAt: Date;
  }): Promise<ChangeOwnPasswordResult> {
    return changeOwnPassword(this.db, input);
  }

  async createInitialAdmin(input: InitialAdminInput): Promise<AuthUserRecord> {
    const account = await initializeFirstAdmin(this.db, input);
    return toAuthUser(account);
  }

  async resetAdminPassword(
    username: string,
    passwordHash: string,
    changedAt: Date,
  ): Promise<AuthUserRecord | null> {
    const [account] = await this.db
      .select()
      .from(userAccounts)
      .where(
        and(
          eq(userAccounts.usernameCanonical, canonicalizeUsername(username)),
          eq(userAccounts.accountType, "admin"),
        ),
      )
      .limit(1);
    if (!account) return null;

    const result = await resetPasswordAndRevokeSessions(this.db, {
      targetUserId: account.id,
      passwordHash,
      actor: { type: "server_command" },
      changedAt,
    });
    return result ? toAuthUser(account) : null;
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
