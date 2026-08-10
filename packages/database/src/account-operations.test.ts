import { describe, expect, it } from "vitest";

import {
  changeOwnPassword,
  createLoginSessionIfCredentialCurrent,
  resetPasswordAndRevokeSessions,
} from "./account-operations.js";
import type { Database } from "./client.js";
import {
  accountSecurityAuditEvents,
  loginSessions,
  passwordCredentials,
  userAccounts,
} from "./schema.js";

const userId = "4d1c2e31-ad0e-4fa9-9ae8-ae3497069118";
const actorUserId = "4d1c2e31-ad0e-4fa9-9ae8-ae3497069116";
const sessionId = "83b201cc-4ef9-4d91-ad87-e3b1b75ce791";
const createdAt = new Date("2026-08-09T01:02:03.000Z");

describe("account database operations", () => {
  it("locks the account and inserts no session when the credential is stale", async () => {
    const events: string[] = [];
    let insertCalls = 0;
    const tx = loginTransaction("new-password-hash", events, () => {
      insertCalls += 1;
    });

    const created = await createLoginSessionIfCredentialCurrent(
      fakeDatabase(tx, events),
      loginInput("verified-old-password-hash"),
    );

    expect(created).toBe(false);
    expect(insertCalls).toBe(0);
    expect(events).toEqual([
      "transaction",
      "select:user_accounts",
      "lock:update",
      "select:password_credentials",
    ]);
  });

  it("inserts a session only while the verified credential is still current", async () => {
    const events: string[] = [];
    const inserts: Array<{ table: unknown; value: unknown }> = [];
    const tx = loginTransaction(
      "verified-password-hash",
      events,
      (table, value) => inserts.push({ table, value }),
    );

    const created = await createLoginSessionIfCredentialCurrent(
      fakeDatabase(tx, events),
      loginInput("verified-password-hash"),
    );

    expect(created).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      table: loginSessions,
      value: {
        id: sessionId,
        userId,
        tokenHash: "session-token-hash",
        createdAt,
        lastSeenAt: createdAt,
      },
    });
  });

  it("takes the same account lock before a server-command password reset", async () => {
    const events: string[] = [];
    const tx = {
      select() {
        return {
          from(table: unknown) {
            events.push(
              table === userAccounts ? "select:user_accounts" : "select:other",
            );
            return {
              where() {
                return {
                  for(mode: string) {
                    events.push(`lock:${mode}`);
                    return { limit: async () => [{ id: userId }] };
                  },
                };
              },
            };
          },
        };
      },
      update(table: unknown) {
        events.push(
          table === passwordCredentials
            ? "update:password_credentials"
            : "update:login_sessions",
        );
        return {
          set() {
            return {
              where() {
                return {
                  returning: async () =>
                    table === passwordCredentials
                      ? [{ userId }]
                      : [{ id: sessionId }],
                };
              },
            };
          },
        };
      },
      insert(table: unknown) {
        expect(table).toBe(accountSecurityAuditEvents);
        return { values: () => Promise.resolve() };
      },
    };

    const result = await resetPasswordAndRevokeSessions(
      fakeDatabase(tx, events),
      {
        targetUserId: userId,
        passwordHash: "new-password-hash",
        actor: { type: "user", userId: actorUserId },
        changedAt: createdAt,
      },
    );

    expect(result).toMatchObject({ revokedSessionCount: 1 });
    expect(events.slice(0, 4)).toEqual([
      "transaction",
      "select:user_accounts",
      "lock:update",
      "update:password_credentials",
    ]);
  });

  it("修改自己的密码时保留当前会话并记录安全审计", async () => {
    const events: string[] = [];
    const updates: Array<{ table: unknown; value: unknown }> = [];
    const inserts: Array<{ table: unknown; value: unknown }> = [];
    const tx = {
      select() {
        return {
          from(table: unknown) {
            if (table === userAccounts) {
              events.push("select:user_accounts");
              return {
                where() {
                  return {
                    for(mode: string) {
                      events.push(`lock:${mode}`);
                      return { limit: async () => [{ status: "active" }] };
                    },
                  };
                },
              };
            }
            if (table === loginSessions) {
              events.push("select:login_sessions");
              return {
                where() {
                  return { limit: async () => [{ id: sessionId }] };
                },
              };
            }
            events.push("select:password_credentials");
            return {
              where() {
                return {
                  limit: async () => [
                    { passwordHash: "verified-password-hash" },
                  ],
                };
              },
            };
          },
        };
      },
      update(table: unknown) {
        return {
          set(value: unknown) {
            updates.push({ table, value });
            return {
              where() {
                return {
                  returning: async () =>
                    table === passwordCredentials
                      ? [{ userId }]
                      : [{ id: "other-session-1" }, { id: "other-session-2" }],
                };
              },
            };
          },
        };
      },
      insert(table: unknown) {
        return {
          values(value: unknown) {
            inserts.push({ table, value });
            return Promise.resolve();
          },
        };
      },
    };

    const result = await changeOwnPassword(fakeDatabase(tx, events), {
      userId,
      currentSessionTokenHash: "session-token-hash",
      expectedPasswordHash: "verified-password-hash",
      newPasswordHash: "new-password-hash",
      changedAt: createdAt,
    });

    expect(result).toEqual({ kind: "changed", revokedSessionCount: 2 });
    expect(events).toEqual([
      "transaction",
      "select:user_accounts",
      "lock:update",
      "select:login_sessions",
      "select:password_credentials",
    ]);
    expect(updates).toEqual([
      {
        table: passwordCredentials,
        value: {
          passwordHash: "new-password-hash",
          passwordChangedAt: createdAt,
          updatedAt: createdAt,
        },
      },
      {
        table: loginSessions,
        value: {
          revokedAt: createdAt,
          revocationReason: "password_reset",
        },
      },
    ]);
    expect(inserts).toEqual([
      {
        table: accountSecurityAuditEvents,
        value: {
          eventType: "password_changed",
          actorType: "user",
          actorUserId: userId,
          targetUserId: userId,
          details: { revokedSessionCount: 2 },
          createdAt,
        },
      },
    ]);
  });
});

function loginInput(expectedPasswordHash: string) {
  return {
    id: sessionId,
    userId,
    tokenHash: "session-token-hash",
    expectedPasswordHash,
    expiresAt: new Date("2026-09-09T01:02:03.000Z"),
    createdAt,
  };
}

function loginTransaction(
  currentPasswordHash: string,
  events: string[],
  onInsert: (table: unknown, value: unknown) => void,
) {
  return {
    select() {
      return {
        from(table: unknown) {
          if (table === userAccounts) {
            events.push("select:user_accounts");
            return {
              where() {
                return {
                  for(mode: string) {
                    events.push(`lock:${mode}`);
                    return { limit: async () => [{ status: "active" }] };
                  },
                };
              },
            };
          }

          events.push("select:password_credentials");
          return {
            where() {
              return {
                limit: async () => [{ passwordHash: currentPasswordHash }],
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(value: unknown) {
          onInsert(table, value);
          return Promise.resolve();
        },
      };
    },
  };
}

function fakeDatabase(transaction: unknown, events: string[]) {
  return {
    async transaction<T>(operation: (tx: unknown) => Promise<T>): Promise<T> {
      events.push("transaction");
      return operation(transaction);
    },
  } as unknown as Database;
}
