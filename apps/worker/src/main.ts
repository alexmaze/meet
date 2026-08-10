import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createDatabaseClient } from "@meet/database";
import {
  CONVERSATION_FINALIZE_QUEUE,
  MEMORY_EXTRACT_QUEUE,
  createMeetJobBoss,
} from "@meet/jobs";

import { QwenConversationAnalyzer } from "./analyzer.js";
import { loadWorkerConfig } from "./config.js";
import { createWorkerHandlers } from "./handlers.js";

const environmentFile = fileURLToPath(
  new URL("../../../.env", import.meta.url),
);
if (existsSync(environmentFile)) process.loadEnvFile(environmentFile);

const config = loadWorkerConfig();
const database = createDatabaseClient({ connectionString: config.databaseUrl });
const boss = await createMeetJobBoss(config.databaseUrl, (error) => {
  console.error("Meet Worker 队列错误", error);
});
const analyzer = new QwenConversationAnalyzer(config.qwen);
const handlers = createWorkerHandlers(database.db, analyzer);

await boss.work(CONVERSATION_FINALIZE_QUEUE, async (jobs) => {
  for (const job of jobs) await handlers.finalizeConversation(job.data);
});
await boss.work(MEMORY_EXTRACT_QUEUE, async (jobs) => {
  for (const job of jobs) await handlers.extractMemories(job.data);
});

console.info("Meet Worker 已启动，正在处理摘要与长期记忆任务。");

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
