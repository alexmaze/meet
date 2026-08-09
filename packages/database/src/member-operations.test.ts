import { describe, expect, it } from "vitest";

import type { Database } from "./client.js";
import {
  createMemberAccount,
  MemberUsernameAlreadyExistsError,
  resetMemberPassword,
  updateChildGuardianHistoryAccess,
} from "./member-operations.js";
import {
  accountSecurityAuditEvents,
  loginSessions,
  passwordCredentials,
  userAccounts,
  type UserAccount,
} from "./schema.js";

const now = new Date("2026-08-09T01:02:03.000Z");
const actorUserId = "4d1c2e31-ad0e-4fa9-9ae8-ae3497069116";
const memberId = "4d1c2e31-ad0e-4fa9-9ae8-ae3497069118";

describe("member database operations", () => {
  it("creates the account, credential, and audit inside one transaction", async () => {
    const inserts: Array<{ table: unknown; value: unknown }> = [];
    const account = childAccount();
    let transactions = 0;
    const tx = {
      insert(table: unknown) {
        return {
          values(value: unknown) {
            inserts.push({ table, value });
            if (table === userAccounts) {
              return {
                onConflictDoNothing() {
                  return { returning: async () => [account] };
                },
              };
            }
            return Promise.resolve();
          },
        };
      },
    };
    const db = fakeDatabase(tx, () => {
      transactions += 1;
    });

    const result = await createMemberAccount(db, {
      id: memberId,
      username: "  Child  ",
      displayName: " 小明 ",
      passwordHash: "password-hash",
      accountType: "child",
      guardianHistoryAccess: "allowed",
      actorUserId,
      createdAt: now,
    });

    expect(result).toBe(account);
    expect(transactions).toBe(1);
    expect(inserts.map((insert) => insert.table)).toEqual([
      userAccounts,
      passwordCredentials,
      accountSecurityAuditEvents,
    ]);
    expect(inserts[0]?.value).toMatchObject({
      username: "Child",
      usernameCanonical: "child",
      displayName: "小明",
      accountType: "child",
    });
    expect(inserts[2]?.value).toMatchObject({
      eventType: "member_account_created",
      actorUserId,
      targetUserId: memberId,
    });
  });

  it("turns a concurrent canonical username conflict into a stable error", async () => {
    const inserts: unknown[] = [];
    const tx = {
      insert(table: unknown) {
        inserts.push(table);
        return {
          values() {
            return {
              onConflictDoNothing() {
                return { returning: async () => [] };
              },
            };
          },
        };
      },
    };

    await expect(
      createMemberAccount(fakeDatabase(tx), {
        username: "CHILD",
        displayName: "重复成员",
        passwordHash: "password-hash",
        accountType: "adult",
        actorUserId,
        createdAt: now,
      }),
    ).rejects.toBeInstanceOf(MemberUsernameAlreadyExistsError);
    expect(inserts).toEqual([userAccounts]);
  });

  it("keeps same-value guardian updates idempotent and audit-free", async () => {
    const account = childAccount();
    let updateCalls = 0;
    let insertCalls = 0;
    const tx = {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  for() {
                    return { limit: async () => [account] };
                  },
                };
              },
            };
          },
        };
      },
      update() {
        updateCalls += 1;
      },
      insert() {
        insertCalls += 1;
      },
    };

    const result = await updateChildGuardianHistoryAccess(fakeDatabase(tx), {
      targetUserId: memberId,
      guardianHistoryAccess: "allowed",
      actorUserId,
      changedAt: now,
    });

    expect(result).toEqual({ kind: "unchanged", account });
    expect(updateCalls).toBe(0);
    expect(insertCalls).toBe(0);
  });

  it("resets a member credential, revokes sessions, and audits atomically", async () => {
    const account = childAccount();
    const updates: Array<{ table: unknown; value: unknown }> = [];
    const inserts: Array<{ table: unknown; value: unknown }> = [];
    const tx = {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  for() {
                    return { limit: async () => [account] };
                  },
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
                      ? [{ userId: memberId }]
                      : [{ id: "83b201cc-4ef9-4d91-ad87-e3b1b75ce791" }],
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

    const result = await resetMemberPassword(fakeDatabase(tx), {
      targetUserId: memberId,
      passwordHash: "new-password-hash",
      actorUserId,
      changedAt: now,
    });

    expect(result).toMatchObject({ kind: "reset", revokedSessionCount: 1 });
    expect(updates.map((update) => update.table)).toEqual([
      passwordCredentials,
      loginSessions,
    ]);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      table: accountSecurityAuditEvents,
      value: {
        eventType: "password_reset",
        actorUserId,
        targetUserId: memberId,
        details: { revokedSessionCount: 1 },
      },
    });
  });

  it("hard-protects an administrator target before touching credentials", async () => {
    let updateCalls = 0;
    const tx = {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  for() {
                    return {
                      limit: async () => [
                        { ...childAccount(), accountType: "admin" as const },
                      ],
                    };
                  },
                };
              },
            };
          },
        };
      },
      update() {
        updateCalls += 1;
      },
    };

    const result = await resetMemberPassword(fakeDatabase(tx), {
      targetUserId: memberId,
      passwordHash: "new-password-hash",
      actorUserId,
      changedAt: now,
    });

    expect(result).toEqual({ kind: "admin_protected" });
    expect(updateCalls).toBe(0);
  });
});

function childAccount(): UserAccount {
  return {
    id: memberId,
    username: "Child",
    usernameCanonical: "child",
    displayName: "小明",
    accountType: "child",
    status: "active",
    guardianHistoryAccess: "allowed",
    createdAt: now,
    updatedAt: now,
  };
}

function fakeDatabase(transaction: unknown, onTransaction?: () => void) {
  return {
    async transaction<T>(operation: (tx: unknown) => Promise<T>): Promise<T> {
      onTransaction?.();
      return operation(transaction);
    },
  } as unknown as Database;
}
