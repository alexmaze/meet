import {
  passwordSchema,
  usernameSchema,
  type QwenRealtimeModel,
  type QwenRealtimeRegion,
} from "@meet/protocol";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { resolve } from "node:path";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));

const optionalTrimmedStringSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().optional(),
);

const optionalDatabaseUrlSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z
    .string()
    .trim()
    .min(1)
    .refine((value) => {
      try {
        const protocol = new URL(value).protocol;
        return protocol === "postgres:" || protocol === "postgresql:";
      } catch {
        return false;
      }
    }, "DATABASE_URL 必须是 PostgreSQL 连接地址。")
    .optional(),
);

const cookieSecureSchema = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

const optionalUuidSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.uuid().optional(),
);

const optionalPositiveIntegerSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.coerce.number().int().positive().optional(),
);

const dynamicQwenTeachingBindingSchema = z
  .object({
    modelProfileId: z.uuid(),
    modelProfileRevision: z.number().int().positive(),
    connectionId: z.uuid(),
    connectionRevision: z.number().int().positive(),
  })
  .strict();

const optionalDynamicQwenTeachingBindingsSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z
    .string()
    .trim()
    .transform((value, context): unknown => {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        context.addIssue({
          code: "custom",
          message:
            "TEACHING_QWEN_DYNAMIC_ADDITIONAL_BINDINGS 必须是合法的 JSON 数组。",
        });
        return z.NEVER;
      }
    })
    .pipe(z.array(dynamicQwenTeachingBindingSchema))
    .optional(),
);

const envSchema = z.object({
  API_HOST: z.string().trim().min(1).default("0.0.0.0"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: optionalDatabaseUrlSchema,
  AUTH_SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  AUTH_COOKIE_SECURE: cookieSecureSchema,
  AUTH_LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(10),
  AUTH_LOGIN_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(10)
    .max(3_600)
    .default(300),
  INITIAL_ADMIN_USERNAME: optionalTrimmedStringSchema,
  INITIAL_ADMIN_PASSWORD: optionalTrimmedStringSchema,
  INITIAL_ADMIN_DISPLAY_NAME: optionalTrimmedStringSchema,
  MEDIA_LOCAL_DIR: z.string().trim().min(1).default("./data/media"),
  EMBEDDING_LOCAL_CACHE_DIR: z
    .string()
    .trim()
    .min(1)
    .default("./data/embedding-models"),
  TEACHING_QWEN_DYNAMIC_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  TEACHING_QWEN_MODEL_PROFILE_ID: optionalUuidSchema,
  TEACHING_QWEN_MODEL_PROFILE_REVISION: optionalPositiveIntegerSchema,
  TEACHING_QWEN_CONNECTION_ID: optionalUuidSchema,
  TEACHING_QWEN_CONNECTION_REVISION: optionalPositiveIntegerSchema,
  // Each additional model stays bound to its reviewed profile and connection revisions.
  TEACHING_QWEN_DYNAMIC_ADDITIONAL_BINDINGS:
    optionalDynamicQwenTeachingBindingsSchema,
  DEVICE_FIRMWARE_VERSION: z.string().trim().max(32).optional(),
  DEVICE_FIRMWARE_URL: z.string().trim().max(512).optional(),
  DEVICE_FIRMWARE_SHA256: z.string().trim().max(64).optional(),
  DEVICE_FIRMWARE_SIZE: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    z.coerce.number().int().nonnegative().optional(),
  ),
  DEVICE_FIRMWARE_FORCE: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

export type DynamicQwenTeachingBinding = z.infer<
  typeof dynamicQwenTeachingBindingSchema
>;

export type AppConfig = {
  server: {
    host: string;
    port: number;
    logLevel: z.infer<typeof envSchema>["LOG_LEVEL"];
  };
  database: {
    url?: string;
  };
  auth: {
    cookieName: "meet_session";
    cookieSecure: boolean;
    sessionTtlMs: number;
    loginMaxAttempts: number;
    loginWindowMs: number;
    initialAdmin?: {
      username: string;
      displayName: string;
      password: string;
    };
  };
  qwen: {
    enabled: boolean;
    apiKey?: string;
    endpoint?: string;
    region: QwenRealtimeRegion;
    model: QwenRealtimeModel;
    voice: string;
    instructions: string;
    requestTimeoutMs: number;
  };
  doubao?: {
    enabled: boolean;
    apiKey?: string;
    model: string;
    requestTimeoutMs: number;
  };
  media?: {
    localDirectory: string;
  };
  embedding?: {
    localCacheDirectory: string;
  };
  teaching?: {
    dynamicQwen?: {
      bindings: DynamicQwenTeachingBinding[];
    };
  };
  firmware?: {
    version: string;
    url: string;
    sha256: string;
    size: number;
    force: boolean;
  };
};

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const result = envSchema.safeParse(environment);

  if (!result.success) {
    throw new Error(`环境变量无效：${z.prettifyError(result.error)}`);
  }

  const env = result.data;
  const dynamicQwen = resolveDynamicQwenCapability(env);
  const initialAdmin = resolveInitialAdmin(env);
  return {
    server: {
      host: env.API_HOST,
      port: env.API_PORT,
      logLevel: env.LOG_LEVEL,
    },
    database: {
      url: env.DATABASE_URL,
    },
    auth: {
      cookieName: "meet_session",
      cookieSecure: env.AUTH_COOKIE_SECURE,
      sessionTtlMs: env.AUTH_SESSION_TTL_DAYS * 24 * 60 * 60 * 1_000,
      loginMaxAttempts: env.AUTH_LOGIN_MAX_ATTEMPTS,
      loginWindowMs: env.AUTH_LOGIN_WINDOW_SECONDS * 1_000,
      ...(initialAdmin ? { initialAdmin } : {}),
    },
    qwen: {
      enabled: false,
      region: "cn-beijing",
      model: "qwen-audio-3.0-realtime-plus",
      voice: "longanqian",
      instructions: "模型运行配置由管理员界面管理。",
      requestTimeoutMs: 15_000,
    },
    doubao: {
      enabled: false,
      model: "1.2.6.1",
      requestTimeoutMs: 15_000,
    },
    media: {
      localDirectory: resolve(workspaceRoot, env.MEDIA_LOCAL_DIR),
    },
    embedding: {
      localCacheDirectory: resolve(
        workspaceRoot,
        env.EMBEDDING_LOCAL_CACHE_DIR,
      ),
    },
    teaching: dynamicQwen ? { dynamicQwen } : undefined,
    firmware: resolveFirmwareRelease(env),
  };
}

function resolveInitialAdmin(
  env: z.infer<typeof envSchema>,
): NonNullable<AppConfig["auth"]["initialAdmin"]> | undefined {
  const usernameRaw = env.INITIAL_ADMIN_USERNAME;
  const passwordRaw = env.INITIAL_ADMIN_PASSWORD;
  const displayNameRaw = env.INITIAL_ADMIN_DISPLAY_NAME;
  const anySet =
    usernameRaw !== undefined ||
    passwordRaw !== undefined ||
    displayNameRaw !== undefined;
  if (!anySet) {
    return undefined;
  }
  if (usernameRaw === undefined || passwordRaw === undefined) {
    throw new Error(
      "环境变量无效：设置首位管理员时必须同时提供 INITIAL_ADMIN_USERNAME 与 INITIAL_ADMIN_PASSWORD。",
    );
  }
  const usernameResult = usernameSchema.safeParse(usernameRaw);
  if (!usernameResult.success) {
    throw new Error(
      `环境变量无效：INITIAL_ADMIN_USERNAME ${z.prettifyError(usernameResult.error)}`,
    );
  }
  const passwordResult = passwordSchema.safeParse(passwordRaw);
  if (!passwordResult.success) {
    throw new Error(
      `环境变量无效：INITIAL_ADMIN_PASSWORD ${z.prettifyError(passwordResult.error)}`,
    );
  }
  const username = usernameResult.data;
  const displayNameResult = z
    .string()
    .trim()
    .min(1)
    .max(80)
    .safeParse(displayNameRaw ?? username);
  if (!displayNameResult.success) {
    throw new Error(
      `环境变量无效：INITIAL_ADMIN_DISPLAY_NAME ${z.prettifyError(displayNameResult.error)}`,
    );
  }
  return {
    username,
    displayName: displayNameResult.data,
    password: passwordResult.data,
  };
}

function resolveFirmwareRelease(
  env: z.infer<typeof envSchema>,
): AppConfig["firmware"] {
  const version = env.DEVICE_FIRMWARE_VERSION?.trim() ?? "";
  const url = env.DEVICE_FIRMWARE_URL?.trim() ?? "";
  if (!version || !url) {
    return undefined;
  }
  return {
    version,
    url,
    sha256: env.DEVICE_FIRMWARE_SHA256?.trim() ?? "",
    size: env.DEVICE_FIRMWARE_SIZE ?? 0,
    force: Boolean(env.DEVICE_FIRMWARE_FORCE),
  };
}

function resolveDynamicQwenCapability(
  env: z.infer<typeof envSchema>,
): NonNullable<NonNullable<AppConfig["teaching"]>["dynamicQwen"]> | undefined {
  const primaryBindingValues = [
    env.TEACHING_QWEN_MODEL_PROFILE_ID,
    env.TEACHING_QWEN_MODEL_PROFILE_REVISION,
    env.TEACHING_QWEN_CONNECTION_ID,
    env.TEACHING_QWEN_CONNECTION_REVISION,
  ];
  const additionalBindings =
    env.TEACHING_QWEN_DYNAMIC_ADDITIONAL_BINDINGS ?? [];
  if (!env.TEACHING_QWEN_DYNAMIC_ENABLED) {
    if (
      primaryBindingValues.some((value) => value !== undefined) ||
      additionalBindings.length > 0
    ) {
      throw new Error(
        "环境变量无效：教学能力绑定只能在 TEACHING_QWEN_DYNAMIC_ENABLED=true 时设置。",
      );
    }
    return undefined;
  }
  if (primaryBindingValues.some((value) => value === undefined)) {
    throw new Error(
      "环境变量无效：启用千问动态教学时必须同时绑定模型配置与连接的 ID 和修订号。",
    );
  }
  const bindings: DynamicQwenTeachingBinding[] = [
    {
      modelProfileId: env.TEACHING_QWEN_MODEL_PROFILE_ID!,
      modelProfileRevision: env.TEACHING_QWEN_MODEL_PROFILE_REVISION!,
      connectionId: env.TEACHING_QWEN_CONNECTION_ID!,
      connectionRevision: env.TEACHING_QWEN_CONNECTION_REVISION!,
    },
    ...additionalBindings,
  ];
  const seenModelProfiles = new Set<string>();
  for (const binding of bindings) {
    const key = `${binding.modelProfileId}:${binding.modelProfileRevision}`;
    if (seenModelProfiles.has(key)) {
      throw new Error(
        "环境变量无效：千问动态教学不能重复绑定同一模型配置修订。",
      );
    }
    seenModelProfiles.add(key);
  }
  return { bindings };
}
