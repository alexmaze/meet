import { InitialAdminAlreadyExistsError } from "@meet/database";
import { describe, expect, it, vi } from "vitest";

import { ensureInitialAdminFromConfig } from "../src/auth/ensure-initial-admin.js";
import type {
  AdminAccountRepository,
  AuthUserRecord,
  InitialAdminInput,
} from "../src/auth/repository.js";

describe("ensureInitialAdminFromConfig", () => {
  it("skips when initial admin env is not configured", async () => {
    const createInitialAdmin = vi.fn();
    const logger = { info: vi.fn() };

    const result = await ensureInitialAdminFromConfig({
      initialAdmin: undefined,
      repository: { createInitialAdmin } as unknown as AdminAccountRepository,
      logger,
    });

    expect(result).toEqual({ status: "skipped_unconfigured" });
    expect(createInitialAdmin).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("creates the first admin in an empty database", async () => {
    const created: AuthUserRecord = {
      id: "11111111-1111-4111-8111-111111111111",
      username: "admin",
      displayName: "家庭管理员",
      accountType: "admin",
      status: "active",
      guardianHistoryAccess: null,
      createdAt: new Date("2026-09-21T00:00:00.000Z"),
      updatedAt: new Date("2026-09-21T00:00:00.000Z"),
    };
    let captured: InitialAdminInput | undefined;
    const createInitialAdmin = vi.fn(async (input: InitialAdminInput) => {
      captured = input;
      return created;
    });
    const logger = { info: vi.fn() };

    const result = await ensureInitialAdminFromConfig({
      initialAdmin: {
        username: "admin",
        displayName: "家庭管理员",
        password: "secret",
      },
      repository: { createInitialAdmin } as unknown as AdminAccountRepository,
      logger,
      passwordHasher: async (password) => `hash:${password}`,
      now: () => new Date("2026-09-21T00:00:00.000Z"),
    });

    expect(result).toEqual({ status: "created", username: "admin" });
    expect(captured).toMatchObject({
      username: "admin",
      displayName: "家庭管理员",
      passwordHash: "hash:secret",
      now: new Date("2026-09-21T00:00:00.000Z"),
    });
    expect(logger.info).toHaveBeenCalledWith(
      { username: "admin" },
      "已根据环境变量创建首位管理员",
    );
  });

  it("skips without changing credentials when accounts already exist", async () => {
    const createInitialAdmin = vi.fn(async () => {
      throw new InitialAdminAlreadyExistsError();
    });
    const logger = { info: vi.fn() };

    const result = await ensureInitialAdminFromConfig({
      initialAdmin: {
        username: "admin",
        displayName: "家庭管理员",
        password: "new-secret",
      },
      repository: { createInitialAdmin } as unknown as AdminAccountRepository,
      logger,
      passwordHasher: async () => "hash:new-secret",
    });

    expect(result).toEqual({ status: "skipped_existing" });
    expect(createInitialAdmin).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      { username: "admin" },
      "数据库已有账号，跳过环境变量首位管理员初始化",
    );
  });

  it("rethrows unexpected repository errors", async () => {
    const createInitialAdmin = vi.fn(async () => {
      throw new Error("database unavailable");
    });

    await expect(
      ensureInitialAdminFromConfig({
        initialAdmin: {
          username: "admin",
          displayName: "admin",
          password: "secret",
        },
        repository: { createInitialAdmin } as unknown as AdminAccountRepository,
        logger: { info: vi.fn() },
        passwordHasher: async () => "hash",
      }),
    ).rejects.toThrow(/database unavailable/);
  });
});
