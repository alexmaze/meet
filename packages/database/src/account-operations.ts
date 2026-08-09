import { and, eq, isNull, sql } from "drizzle-orm";

import type { Database } from "./client.js";
import {
  accountSecurityAuditEvents,
  loginSessions,
  passwordCredentials,
  userAccounts,
  type UserAccount,
} from "./schema.js";
import { canonicalizeUsername } from "./username.js";

export const INITIAL_ADMIN_ADVISORY_LOCK_KEYS = [
  0x4d45_4554, 0x4144_4d49,
] as const;

export class InitialAdminAlreadyExistsError extends Error {
  constructor() {
    super(
      "The initial administrator can only be created in an empty database.",
    );
    this.name = "InitialAdminAlreadyExistsError";
  }
}

export type InitializeFirstAdminInput = {
  id?: string;
  username: string;
  displayName: string;
  passwordHash: string;
  now?: Date;
};

export async function initializeFirstAdmin(
  db: Database,
  input: InitializeFirstAdminInput,
): Promise<UserAccount> {
  const now = input.now ?? new Date();
  const usernameCanonical = canonicalizeUsername(input.username);

  if (usernameCanonical.length === 0) {
    throw new TypeError("Username must not be empty.");
  }

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(
        ${INITIAL_ADMIN_ADVISORY_LOCK_KEYS[0]},
        ${INITIAL_ADMIN_ADVISORY_LOCK_KEYS[1]}
      )`,
    );

    const existingAccounts = await tx
      .select({ id: userAccounts.id })
      .from(userAccounts)
      .limit(1);

    if (existingAccounts.length !== 0) {
      throw new InitialAdminAlreadyExistsError();
    }

    const [account] = await tx
      .insert(userAccounts)
      .values({
        ...(input.id === undefined ? {} : { id: input.id }),
        username: input.username.trim(),
        usernameCanonical,
        displayName: input.displayName.trim(),
        accountType: "admin",
        status: "active",
        guardianHistoryAccess: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!account) {
      throw new Error("Failed to create the initial administrator.");
    }

    await tx.insert(passwordCredentials).values({
      userId: account.id,
      passwordHash: input.passwordHash,
      passwordChangedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(accountSecurityAuditEvents).values({
      eventType: "initial_admin_created",
      actorType: "server_command",
      actorUserId: null,
      targetUserId: account.id,
      details: {},
      createdAt: now,
    });

    return account;
  });
}

export type SecurityActor =
  { type: "user"; userId: string } | { type: "server_command" | "system" };

export type CreateLoginSessionIfCredentialCurrentInput = {
  id: string;
  userId: string;
  tokenHash: string;
  expectedPasswordHash: string;
  expiresAt: Date;
  createdAt: Date;
};

/**
 * Serializes login session creation with password resets on the account row.
 * A reset that commits before this transaction makes the expected hash stale;
 * a reset that follows this transaction will revoke the newly inserted session.
 */
export async function createLoginSessionIfCredentialCurrent(
  db: Database,
  input: CreateLoginSessionIfCredentialCurrentInput,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [account] = await tx
      .select({ status: userAccounts.status })
      .from(userAccounts)
      .where(eq(userAccounts.id, input.userId))
      .for("update")
      .limit(1);

    if (!account || account.status !== "active") return false;

    const [credential] = await tx
      .select({ passwordHash: passwordCredentials.passwordHash })
      .from(passwordCredentials)
      .where(eq(passwordCredentials.userId, input.userId))
      .limit(1);

    if (!credential || credential.passwordHash !== input.expectedPasswordHash) {
      return false;
    }

    await tx.insert(loginSessions).values({
      id: input.id,
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      lastSeenAt: input.createdAt,
      createdAt: input.createdAt,
    });
    return true;
  });
}

export type ResetPasswordAndRevokeSessionsInput = {
  targetUserId: string;
  passwordHash: string;
  actor: SecurityActor;
  changedAt?: Date;
};

export type ResetPasswordAndRevokeSessionsResult = {
  targetUserId: string;
  revokedSessionCount: number;
};

/**
 * Changes a password, revokes every active session, and records the reset as
 * one atomic operation. Callers pass an already-derived password hash so no
 * plaintext password crosses the database package boundary or appears in CLI
 * arguments owned by this package.
 */
export async function resetPasswordAndRevokeSessions(
  db: Database,
  input: ResetPasswordAndRevokeSessionsInput,
): Promise<ResetPasswordAndRevokeSessionsResult | null> {
  const changedAt = input.changedAt ?? new Date();

  return db.transaction(async (tx) => {
    const [account] = await tx
      .select({ id: userAccounts.id })
      .from(userAccounts)
      .where(eq(userAccounts.id, input.targetUserId))
      .for("update")
      .limit(1);

    if (!account) return null;

    const updatedCredentials = await tx
      .update(passwordCredentials)
      .set({
        passwordHash: input.passwordHash,
        passwordChangedAt: changedAt,
        updatedAt: changedAt,
      })
      .where(eq(passwordCredentials.userId, input.targetUserId))
      .returning({ userId: passwordCredentials.userId });

    if (updatedCredentials.length === 0) {
      return null;
    }

    const revokedSessions = await tx
      .update(loginSessions)
      .set({
        revokedAt: changedAt,
        revocationReason: "password_reset",
      })
      .where(
        and(
          eq(loginSessions.userId, input.targetUserId),
          isNull(loginSessions.revokedAt),
        ),
      )
      .returning({ id: loginSessions.id });

    await tx.insert(accountSecurityAuditEvents).values({
      eventType: "password_reset",
      actorType: input.actor.type,
      actorUserId: input.actor.type === "user" ? input.actor.userId : null,
      targetUserId: input.targetUserId,
      details: { revokedSessionCount: revokedSessions.length },
      createdAt: changedAt,
    });

    return {
      targetUserId: input.targetUserId,
      revokedSessionCount: revokedSessions.length,
    };
  });
}
