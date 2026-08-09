import { describe, expect, it } from "vitest";

import { LoginRateLimiter } from "../src/auth/login-rate-limit.js";

describe("login rate limiter", () => {
  it("blocks work before another password hash after the limit", () => {
    let now = 1_000;
    const limiter = new LoginRateLimiter(2, 60_000, () => now);

    expect(limiter.consume("ip-and-user")).toEqual({ allowed: true });
    expect(limiter.consume("ip-and-user")).toEqual({ allowed: true });
    expect(limiter.consume("ip-and-user")).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });

    now += 60_000;
    expect(limiter.consume("ip-and-user")).toEqual({ allowed: true });
  });

  it("clears the bucket after a successful login", () => {
    const limiter = new LoginRateLimiter(1, 60_000, () => 1_000);
    expect(limiter.consume("ip-and-user")).toEqual({ allowed: true });

    limiter.reset("ip-and-user");

    expect(limiter.consume("ip-and-user")).toEqual({ allowed: true });
  });
});
