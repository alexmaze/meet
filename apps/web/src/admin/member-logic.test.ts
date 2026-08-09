import { describe, expect, it } from "vitest";

import {
  getMemberErrorMessage,
  sortMembers,
  validateCreateMember,
  validatePasswordReset,
} from "./member-logic.js";

describe("validateCreateMember", () => {
  it("整理成人账号字段，但不改变密码内容", () => {
    const result = validateCreateMember({
      username: "  family-adult  ",
      displayName: "  家庭成员  ",
      password: " 1234567890123 ",
      passwordConfirmation: " 1234567890123 ",
      accountType: "adult",
      guardianHistoryAccess: "allowed",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        username: "family-adult",
        displayName: "家庭成员",
        password: " 1234567890123 ",
        accountType: "adult",
      },
    });
  });

  it("儿童账号默认权限可随提交值写入", () => {
    const result = validateCreateMember({
      username: "child",
      displayName: "小朋友",
      password: "123456789012345",
      passwordConfirmation: "123456789012345",
      accountType: "child",
      guardianHistoryAccess: "denied",
    });

    expect(result.ok && result.value.guardianHistoryAccess).toBe("denied");
  });

  it("拒绝过短或两次不一致的密码", () => {
    expect(
      validateCreateMember({
        username: "child",
        displayName: "小朋友",
        password: "too-short",
        passwordConfirmation: "too-short",
        accountType: "child",
        guardianHistoryAccess: "allowed",
      }),
    ).toMatchObject({ ok: false });

    expect(validatePasswordReset("123456789012345", "123456789012346")).toEqual(
      { ok: false, message: "两次输入的新密码不一致。" },
    );
  });
});

describe("getMemberErrorMessage", () => {
  it("覆盖权限、冲突、服务不可用和登录失效", () => {
    expect(getMemberErrorMessage(401, "list")).toContain("登录状态已失效");
    expect(getMemberErrorMessage(403, "update")).toContain("没有管理");
    expect(getMemberErrorMessage(409, "create")).toContain("用户名已被使用");
    expect(getMemberErrorMessage(503, "reset")).toContain("暂不可用");
  });

  it("网络错误不暴露服务端细节", () => {
    expect(getMemberErrorMessage(null, "create")).toBe(
      "无法连接家庭成员服务，请检查网络后重试。",
    );
  });
});

describe("sortMembers", () => {
  it("按管理员、成人、儿童顺序排列", () => {
    const base = {
      status: "active" as const,
      guardianHistoryAccess: null,
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    };

    const sorted = sortMembers([
      {
        ...base,
        id: "00000000-0000-4000-8000-000000000003",
        username: "child",
        displayName: "儿童",
        accountType: "child",
        guardianHistoryAccess: "allowed",
      },
      {
        ...base,
        id: "00000000-0000-4000-8000-000000000001",
        username: "admin",
        displayName: "管理员",
        accountType: "admin",
      },
      {
        ...base,
        id: "00000000-0000-4000-8000-000000000002",
        username: "adult",
        displayName: "成人",
        accountType: "adult",
      },
    ]);

    expect(sorted.map((member) => member.accountType)).toEqual([
      "admin",
      "adult",
      "child",
    ]);
  });
});
