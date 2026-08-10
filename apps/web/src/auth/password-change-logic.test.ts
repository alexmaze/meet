import { describe, expect, it } from "vitest";

import {
  getPasswordChangeErrorMessage,
  validatePasswordChange,
} from "./password-change-logic.js";

describe("validatePasswordChange", () => {
  it("接受任意非空的新密码", () => {
    expect(validatePasswordChange("old", "1", "1")).toEqual({
      ok: true,
      value: { currentPassword: "old", newPassword: "1" },
    });
  });

  it("拒绝缺失字段和不一致的确认密码", () => {
    expect(validatePasswordChange("", "1", "1")).toMatchObject({
      ok: false,
      message: "请输入当前密码。",
    });
    expect(validatePasswordChange("old", "", "")).toMatchObject({
      ok: false,
      message: "请输入新密码。",
    });
    expect(validatePasswordChange("old", "1", "2")).toMatchObject({
      ok: false,
      message: "两次输入的新密码不一致。",
    });
  });
});

describe("getPasswordChangeErrorMessage", () => {
  it("保留当前密码错误并覆盖常见服务状态", () => {
    expect(getPasswordChangeErrorMessage(400, "当前密码不正确。")).toBe(
      "当前密码不正确。",
    );
    expect(getPasswordChangeErrorMessage(401)).toContain("登录状态已失效");
    expect(getPasswordChangeErrorMessage(429)).toContain("过于频繁");
    expect(getPasswordChangeErrorMessage(null)).toContain("无法连接");
  });
});
