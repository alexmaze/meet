import { describe, expect, it } from "vitest";

import {
  createMemberRequestSchema,
  loginRequestSchema,
  passwordSchema,
  resetMemberPasswordResponseSchema,
  updateMemberGuardianHistoryAccessRequestSchema,
  userAccountSchema,
} from "./auth.js";

describe("auth protocol", () => {
  it("trims usernames at the API boundary", () => {
    expect(
      loginRequestSchema.parse({ username: "  alex  ", password: "secret" }),
    ).toEqual({ username: "alex", password: "secret" });
  });

  it("enforces the password policy only when setting a password", () => {
    expect(passwordSchema.safeParse("short").success).toBe(false);
    expect(passwordSchema.parse("long-enough-password")).toBe(
      "long-enough-password",
    );
  });

  it("rejects private credential fields from the public account shape", () => {
    const parsed = userAccountSchema.parse({
      id: "4d1c2e31-ad0e-4fa9-9ae8-ae3497069116",
      username: "alex",
      displayName: "Alex",
      accountType: "admin",
      status: "active",
      guardianHistoryAccess: null,
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
      passwordHash: "must-not-leak",
    });

    expect(parsed).not.toHaveProperty("passwordHash");
  });

  it("defaults child guardian history access and rejects it for adults", () => {
    const child = createMemberRequestSchema.parse({
      username: "child",
      displayName: "小明",
      password: "long-enough-password",
      accountType: "child",
    });

    expect(child.guardianHistoryAccess).toBe("allowed");
    expect(
      createMemberRequestSchema.safeParse({
        username: "adult",
        displayName: "家长",
        password: "long-enough-password",
        accountType: "adult",
        guardianHistoryAccess: null,
      }).success,
    ).toBe(false);
  });

  it("keeps guardian updates on a strict field whitelist", () => {
    expect(
      updateMemberGuardianHistoryAccessRequestSchema.safeParse({
        guardianHistoryAccess: "denied",
      }).success,
    ).toBe(true);
    expect(
      updateMemberGuardianHistoryAccessRequestSchema.safeParse({
        guardianHistoryAccess: "denied",
        status: "disabled",
      }).success,
    ).toBe(false);
  });

  it("reports how many old sessions a password reset revoked", () => {
    expect(
      resetMemberPasswordResponseSchema.parse({
        ok: true,
        revokedSessionCount: 2,
      }),
    ).toEqual({ ok: true, revokedSessionCount: 2 });
    expect(
      resetMemberPasswordResponseSchema.safeParse({
        ok: true,
        revokedSessionCount: -1,
      }).success,
    ).toBe(false);
  });
});
