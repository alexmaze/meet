import { InitialAdminAlreadyExistsError } from "@meet/database";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config.js";
import { hashPassword } from "./password.js";
import type { AdminAccountRepository, AuthUserRecord } from "./repository.js";

export type EnsureInitialAdminLogger = {
  info: (object: Record<string, unknown>, message: string) => void;
};

export type EnsureInitialAdminResult =
  | { status: "skipped_unconfigured" }
  | { status: "created"; username: string }
  | { status: "skipped_existing" };

type PasswordHasher = (password: string) => Promise<string>;

/**
 * Creates the first admin from env config when the account table is empty.
 * If any account already exists, skips without changing credentials.
 */
export async function ensureInitialAdminFromConfig(options: {
  initialAdmin: AppConfig["auth"]["initialAdmin"];
  repository: AdminAccountRepository;
  logger: EnsureInitialAdminLogger;
  passwordHasher?: PasswordHasher;
  now?: () => Date;
}): Promise<EnsureInitialAdminResult> {
  const initialAdmin = options.initialAdmin;
  if (!initialAdmin) {
    return { status: "skipped_unconfigured" };
  }

  const passwordHasher = options.passwordHasher ?? hashPassword;
  const now = options.now ?? (() => new Date());
  const passwordHash = await passwordHasher(initialAdmin.password);

  let account: AuthUserRecord;
  try {
    account = await options.repository.createInitialAdmin({
      id: randomUUID(),
      username: initialAdmin.username,
      displayName: initialAdmin.displayName,
      passwordHash,
      now: now(),
    });
  } catch (error) {
    if (error instanceof InitialAdminAlreadyExistsError) {
      options.logger.info(
        { username: initialAdmin.username },
        "数据库已有账号，跳过环境变量首位管理员初始化",
      );
      return { status: "skipped_existing" };
    }
    throw error;
  }

  options.logger.info(
    { username: account.username },
    "已根据环境变量创建首位管理员",
  );
  return { status: "created", username: account.username };
}
