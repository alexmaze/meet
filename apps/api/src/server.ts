import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { loadProjectEnvironment } from "./load-environment.js";

loadProjectEnvironment();

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
    `以下模型环境变量已停用，请在管理员模型设置中重新配置：${legacyModelVariables.join(", ")}`,
  );
}

const config = loadConfig();
const app = await buildApp({ config });

const close = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "Stopping Meet API");
  await app.close();
};

process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGTERM", () => void close("SIGTERM"));

try {
  await app.listen({ host: config.server.host, port: config.server.port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
