import { describe, expect, it } from "vitest";

import { getAuthErrorPresentation } from "./auth-errors.js";

describe("getAuthErrorPresentation", () => {
  it("把未登录的会话检查视为正常登出状态", () => {
    expect(
      getAuthErrorPresentation({ operation: "session", status: 401 }),
    ).toEqual({ message: "", serviceUnavailable: false });
  });

  it("不展示登录接口可能返回的敏感认证细节", () => {
    expect(
      getAuthErrorPresentation({
        operation: "login",
        status: 401,
        serverMessage: "内部认证细节",
      }),
    ).toEqual({
      message: "用户名或密码不正确。",
      serviceUnavailable: false,
    });
  });

  it("在数据库未配置时给出可执行提示", () => {
    const result = getAuthErrorPresentation({
      operation: "session",
      status: 503,
    });

    expect(result.serviceUnavailable).toBe(true);
    expect(result.message).toContain("DATABASE_URL");
    expect(result.message).toContain("管理员初始化");
  });

  it("区分网络错误与服务端错误", () => {
    expect(
      getAuthErrorPresentation({ operation: "login", status: null }),
    ).toEqual({
      message: "无法连接账号服务，请检查网络和 API 服务后重试。",
      serviceUnavailable: false,
    });

    expect(
      getAuthErrorPresentation({
        operation: "login",
        status: 403,
        serverMessage: "该账号已停用。",
      }),
    ).toEqual({
      message: "该账号已停用。",
      serviceUnavailable: false,
    });
  });
});
