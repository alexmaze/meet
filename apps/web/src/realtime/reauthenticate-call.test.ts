import { afterEach, describe, expect, it, vi } from "vitest";
import { reauthenticateCall } from "./reauthenticate-call.js";
const user = {
  id: "4d1c2e31-ad0e-4fa9-9ae8-ae3497069117",
  username: "member",
  displayName: "成员",
  accountType: "adult",
  status: "active",
  guardianHistoryAccess: null,
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
};
afterEach(() => vi.unstubAllGlobals());
describe("same-account call reauthentication", () => {
  it("authenticates the original username and validates the account id before retrying private writes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ user }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(reauthenticateCall(user, "password")).resolves.toBeUndefined();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1].body))).toEqual({
      username: user.username,
      password: "password",
    });
  });
  it("rejects another account and signs that session out without transmitting any retained text", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          user: { ...user, id: "6172f06d-c71a-47b3-94fe-35e1204b5b55" },
        }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(reauthenticateCall(user, "password")).rejects.toThrow(
      "无法确认原账号身份",
    );
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/auth/login",
      "/api/auth/logout",
    ]);
  });
  it("keeps invalid-password failures local to the call", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ message: "wrong" }, { status: 401 }),
        ),
    );
    await expect(reauthenticateCall(user, "wrong")).rejects.toThrow(
      "密码不正确",
    );
  });
});
