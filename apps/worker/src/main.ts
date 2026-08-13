import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createDatabaseClient,
  resolveMemoryEmbeddingConfiguration,
} from "@meet/database";
import {
  CONVERSATION_FINALIZE_QUEUE,
  CONVERSATION_CHECKPOINT_QUEUE,
  MEDIA_EXPIRE_QUEUE,
  MEMORY_EXTRACT_QUEUE,
  MEMORY_INDEX_SYNC_QUEUE,
  MemoryIndexJobPublisher,
  MemoryIndexJobReconciler,
  createMeetJobBoss,
} from "@meet/jobs";
import { LocalMediaStore } from "@meet/media";
import { ManagedEmbeddedMem0SemanticMemoryStoreResolver } from "@meet/memory";

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
const semanticMemoryStore = new ManagedEmbeddedMem0SemanticMemoryStoreResolver({
  databaseUrl: config.databaseUrl,
  loadConfiguration: () => resolveMemoryEmbeddingConfiguration(database.db),
  requestTimeoutMs: 15_000,
  builtinRequestTimeoutMs: 60_000,
  localEmbeddingCacheDirectory: config.embedding.localCacheDirectory,
});
const memoryIndexPublisher = new MemoryIndexJobPublisher(boss);
const handlers = createWorkerHandlers(
  database.db,
  new DatabaseConversationAnalyzerResolver(database.db),
  {
    memoryIndexHook: memoryIndexPublisher.enqueue,
    semanticMemoryStore,
  },
);
const expireMedia = createMediaExpirationHandler(
  new PostgresMediaCleanupRepository(database.db),
  new LocalMediaStore(config.media.localDirectory),
);

await boss.work(CONVERSATION_FINALIZE_QUEUE, async (jobs) => {
  for (const job of jobs) await handlers.finalizeConversation(job.data);
});
await boss.work(CONVERSATION_CHECKPOINT_QUEUE, async (jobs) => {
  for (const job of jobs) await handlers.checkpointConversation(job.data);
});
await boss.work(MEMORY_EXTRACT_QUEUE, async (jobs) => {
  for (const job of jobs) await handlers.extractMemories(job.data);
});
await boss.work(MEMORY_INDEX_SYNC_QUEUE, async (jobs) => {
  for (const job of jobs) await handlers.syncMemoryIndex(job.data);
});
try {
  const activeStore = await semanticMemoryStore.resolve();
  if (activeStore) {
    const queued = await new MemoryIndexJobReconciler(
      boss,
      database.db,
      activeStore.indexRevision,
    ).enqueueOutstanding();
    if (queued > 0) {
      console.info(`已补发 ${queued} 条 Mem0 记忆索引任务。`);
    }
  }
} catch (error) {
  console.error("Mem0 记忆索引补偿扫描失败", error);
}
await boss.work(MEDIA_EXPIRE_QUEUE, async (jobs) => {
  for (const job of jobs) await expireMedia(job.data);
});

console.info(
  "Meet Worker 已启动，正在处理增量检查点、最终摘要、长期记忆、Mem0 索引与媒体清理任务。",
);

let closing = false;
const close = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  console.info(`Meet Worker 收到 ${signal}，正在停止。`);
  await boss.stop();
  await semanticMemoryStore?.close();
  await database.close();
};

process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGTERM", () => void close("SIGTERM"));
