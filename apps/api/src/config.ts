import type { QwenRealtimeModel, QwenRealtimeRegion } from "@meet/protocol";
import { z } from "zod";
import { resolve } from "node:path";

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
  MEDIA_LOCAL_DIR: z.string().trim().min(1).default("./data/media"),
});

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
};

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const result = envSchema.safeParse(environment);

  if (!result.success) {
    throw new Error(`环境变量无效：${z.prettifyError(result.error)}`);
  }

  const env = result.data;
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
      localDirectory: resolve(env.MEDIA_LOCAL_DIR),
    },
  };
}
