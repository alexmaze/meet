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
  MEDIA_LOCAL_DIR: z.string().trim().min(1).default("./data/media"),
});

export type WorkerConfig = {
  databaseUrl: string;
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
    media: {
      localDirectory: resolve(result.data.MEDIA_LOCAL_DIR),
    },
  };
}
