import {
  createDatabaseClient,
  InitialAdminAlreadyExistsError,
} from "@meet/database";
import { passwordSchema, usernameSchema } from "@meet/protocol";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { hashPassword } from "../auth/password.js";
import { PostgresAuthRepository } from "../auth/postgres-repository.js";
import { loadProjectEnvironment } from "../load-environment.js";
import { readNewPassword } from "./read-secret.js";

const displayNameSchema = z.string().trim().min(1).max(80);

async function main(): Promise<void> {
  loadProjectEnvironment();
  const [command, ...arguments_] = process.argv.slice(2);
  if (command !== "init" && command !== "reset-password") {
    throw new Error(
      "用法：admin.ts <init|reset-password> --username <用户名> [--display-name <显示名>] [--password-stdin]",
    );
  }

  const options = parseArguments(arguments_);
  const username = usernameSchema.parse(requiredOption(options, "username"));
  const databaseUrl = readDatabaseUrl();
  const password = passwordSchema.parse(
    await readNewPassword(options.has("password-stdin")),
  );
  const passwordHash = await hashPassword(password);

  const database = createDatabaseClient({
    connectionString: databaseUrl,
  });
  const repository = new PostgresAuthRepository(database.db);

  try {
    if (command === "init") {
      const displayName = displayNameSchema.parse(
        options.get("display-name") ?? username,
      );
      const account = await repository.createInitialAdmin({
        id: randomUUID(),
        username,
        displayName,
        passwordHash,
        now: new Date(),
      });
      process.stdout.write(`首位管理员 ${account.username} 已创建。\n`);
      return;
    }

    const account = await repository.resetAdminPassword(
      username,
      passwordHash,
      new Date(),
    );
    if (!account) {
      throw new Error("没有找到对应的管理员账号。");
    }
    process.stdout.write(
      `管理员 ${account.username} 的密码已重置，原登录会话已全部撤销。\n`,
    );
  } finally {
    await database.close();
  }
}

function readDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) {
    throw new Error("未配置 DATABASE_URL，无法访问账号数据库。");
  }
  const protocol = new URL(value).protocol;
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error("DATABASE_URL 必须是 PostgreSQL 连接地址。");
  }
  return value;
}

function parseArguments(arguments_: string[]): Map<string, string> {
  const options = new Map<string, string>();
  const supportedOptions = new Set([
    "username",
    "display-name",
    "password-stdin",
  ]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument?.startsWith("--")) {
      throw new Error(`无法识别的参数：${argument ?? ""}`);
    }

    const name = argument.slice(2);
    if (!supportedOptions.has(name) && name !== "password") {
      throw new Error(`无法识别的参数：--${name}`);
    }
    if (name === "password") {
      throw new Error(
        "不支持 --password；请使用遮罩输入或 --password-stdin，避免密码进入命令历史。",
      );
    }
    if (name === "password-stdin") {
      options.set(name, "true");
      continue;
    }
    if (options.has(name)) {
      throw new Error(`参数重复：--${name}`);
    }

    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`参数 --${name} 缺少值。`);
    }
    options.set(name, value);
    index += 1;
  }
  return options;
}

function requiredOption(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`缺少必填参数 --${name}。`);
  return value;
}

main().catch((error: unknown) => {
  if (error instanceof InitialAdminAlreadyExistsError) {
    process.stderr.write("数据库中已经存在账号，不能再次创建首位管理员。\n");
  } else if (error instanceof z.ZodError) {
    process.stderr.write(`输入无效：${z.prettifyError(error)}\n`);
  } else {
    process.stderr.write(`${getSafeFailureMessage(error)}\n`);
  }
  process.exitCode = 1;
});

function getSafeFailureMessage(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "管理员命令执行失败。";
  }

  const errorName = error instanceof Error && error.name ? error.name : "Error";
  const errorCode = Reflect.get(error, "code");
  const codeSuffix =
    typeof errorCode === "string" && errorCode.length <= 32
      ? `，错误代码 ${errorCode}`
      : "";
  return `管理员命令执行失败（${errorName}${codeSuffix}）。`;
}
