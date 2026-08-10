import { z } from "zod";
import { resolve } from "node:path";

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .url()
    .refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === "postgres:" || protocol === "postgresql:";
    }, "DATABASE_URL 必须是 PostgreSQL 连接地址。"),
  DASHSCOPE_API_KEY: z.string().trim().min(1),
  QWEN_ANALYSIS_BASE_URL: z
    .string()
    .url()
    .default("https://dashscope.aliyuncs.com/compatible-mode/v1"),
  QWEN_ANALYSIS_MODEL: z.string().trim().min(1).default("qwen-plus"),
  QWEN_ANALYSIS_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(60_000),
  MEDIA_LOCAL_DIR: z.string().trim().min(1).default("./data/media"),
});

export type WorkerConfig = {
  databaseUrl: string;
  qwen: {
    apiKey: string;
    baseUrl: string;
    model: string;
    requestTimeoutMs: number;
  };
  media: {
    localDirectory: string;
  };
};

export function loadWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WorkerConfig {
  const result = envSchema.safeParse(environment);
  if (!result.success) {
    throw new Error(`Worker 环境变量无效：${z.prettifyError(result.error)}`);
  }
  return {
    databaseUrl: result.data.DATABASE_URL,
    qwen: {
      apiKey: result.data.DASHSCOPE_API_KEY,
      baseUrl: result.data.QWEN_ANALYSIS_BASE_URL,
      model: result.data.QWEN_ANALYSIS_MODEL,
      requestTimeoutMs: result.data.QWEN_ANALYSIS_REQUEST_TIMEOUT_MS,
    },
    media: {
      localDirectory: resolve(result.data.MEDIA_LOCAL_DIR),
    },
  };
}
