import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createDatabaseClient } from "@meet/database";
import {
  CONVERSATION_FINALIZE_QUEUE,
  MEDIA_EXPIRE_QUEUE,
  MEMORY_EXTRACT_QUEUE,
  createMeetJobBoss,
} from "@meet/jobs";
import { LocalMediaStore } from "@meet/media";

import { loadWorkerConfig } from "./config.js";
import { createWorkerHandlers } from "./handlers.js";
import { DatabaseConversationAnalyzerResolver } from "./model-resolver.js";
import {
  createMediaExpirationHandler,
  PostgresMediaCleanupRepository,
} from "./media-cleanup.js";

const environmentFile = fileURLToPath(
  new URL("../../../.env", import.meta.url),
);
if (existsSync(environmentFile)) process.loadEnvFile(environmentFile);

const legacyModelVariables = Object.keys(process.env)
  .filter(
    (name) =>
      name === "DASHSCOPE_API_KEY" ||
      name.startsWith("QWEN_") ||
      name.startsWith("DOUBAO_"),
  )
  .sort();
if (legacyModelVariables.length > 0) {
  console.warn(
    `以下 Worker 模型环境变量已停用，请在管理员模型设置中重新配置：${legacyModelVariables.join(", ")}`,
  );
}

const config = loadWorkerConfig();
const database = createDatabaseClient({ connectionString: config.databaseUrl });
const boss = await createMeetJobBoss(config.databaseUrl, (error) => {
  console.error("Meet Worker 队列错误", error);
});
const handlers = createWorkerHandlers(
  database.db,
  new DatabaseConversationAnalyzerResolver(database.db),
);
const expireMedia = createMediaExpirationHandler(
  new PostgresMediaCleanupRepository(database.db),
  new LocalMediaStore(config.media.localDirectory),
);

await boss.work(CONVERSATION_FINALIZE_QUEUE, async (jobs) => {
  for (const job of jobs) await handlers.finalizeConversation(job.data);
});
await boss.work(MEMORY_EXTRACT_QUEUE, async (jobs) => {
  for (const job of jobs) await handlers.extractMemories(job.data);
});
await boss.work(MEDIA_EXPIRE_QUEUE, async (jobs) => {
  for (const job of jobs) await expireMedia(job.data);
});

console.info("Meet Worker 已启动，正在处理摘要、长期记忆与媒体清理任务。");

let closing = false;
const close = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  console.info(`Meet Worker 收到 ${signal}，正在停止。`);
  await boss.stop();
  await database.close();
};

process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGTERM", () => void close("SIGTERM"));
