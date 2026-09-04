import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildTeachingSpikePlan,
  runTeachingSpike,
  type TeachingSpikeMode,
  type TeachingSpikeProvider,
} from "../spikes/realtime-teaching/runner.js";
import { serializeTeachingSpikeReport } from "../spikes/realtime-teaching/report.js";

type CliOptions = {
  provider: TeachingSpikeProvider;
  mode: TeachingSpikeMode;
  pretty: boolean;
};

type TextWriter = { write(value: string): unknown };

const USAGE = `用法：
  pnpm spike:teaching -- --provider <qwen|doubao> [--mode <dry-run|mock>] [--pretty]

默认 mode 为 dry-run。dry-run 与 mock 都不会联网、读取 Provider 凭据或访问数据库。
真实 Provider 模式尚未实现；本命令不能证明任何 Provider 已通过动态指令能力验证。`;

export function parseTeachingSpikeCliArguments(args: string[]): CliOptions {
  let provider: TeachingSpikeProvider | undefined;
  let mode: TeachingSpikeMode = "dry-run";
  let pretty = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--provider") {
      const value = args[index + 1];
      if (value !== "qwen" && value !== "doubao") {
        throw new TeachingSpikeCliError("INVALID_PROVIDER");
      }
      provider = value;
      index += 1;
      continue;
    }
    if (argument === "--mode") {
      const value = args[index + 1];
      if (value !== "dry-run" && value !== "mock") {
        throw new TeachingSpikeCliError("INVALID_MODE");
      }
      mode = value;
      index += 1;
      continue;
    }
    if (argument === "--suite") {
      if (args[index + 1] !== "protocol-smoke") {
        throw new TeachingSpikeCliError("INVALID_SUITE");
      }
      index += 1;
      continue;
    }
    if (argument === "--pretty") {
      pretty = true;
      continue;
    }
    if (
      argument === "--live" ||
      argument === "--execute" ||
      argument === "--ack-billable"
    ) {
      throw new TeachingSpikeCliError("LIVE_MODE_NOT_IMPLEMENTED");
    }
    if (
      argument === "--api-key" ||
      argument === "--endpoint" ||
      argument === "--instructions" ||
      argument === "--audio"
    ) {
      throw new TeachingSpikeCliError("UNSAFE_ARGUMENT");
    }
    throw new TeachingSpikeCliError("UNKNOWN_ARGUMENT");
  }

  if (!provider) throw new TeachingSpikeCliError("PROVIDER_REQUIRED");
  return { provider, mode, pretty };
}

export function runTeachingSpikeCli(
  args: string[],
  output: TextWriter = process.stdout,
  errorOutput: TextWriter = process.stderr,
): number {
  if (args.includes("--help") || args.includes("-h")) {
    output.write(`${USAGE}\n`);
    return 0;
  }

  try {
    const options = parseTeachingSpikeCliArguments(args);
    const plan = buildTeachingSpikePlan({
      provider: options.provider,
      mode: options.mode,
    });
    const report = runTeachingSpike(plan);
    output.write(`${serializeTeachingSpikeReport(report, options.pretty)}\n`);
    return report.summary.fixtureFailed === 0 ? 0 : 1;
  } catch (error) {
    const code =
      error instanceof TeachingSpikeCliError
        ? error.code
        : "UNEXPECTED_SPIKE_ERROR";
    errorOutput.write(`教学指令 Spike 未运行：${code}\n${USAGE}\n`);
    return 2;
  }
}

export class TeachingSpikeCliError extends Error {
  constructor(
    public readonly code:
      | "INVALID_PROVIDER"
      | "INVALID_MODE"
      | "INVALID_SUITE"
      | "LIVE_MODE_NOT_IMPLEMENTED"
      | "UNSAFE_ARGUMENT"
      | "UNKNOWN_ARGUMENT"
      | "PROVIDER_REQUIRED",
  ) {
    super(code);
    this.name = "TeachingSpikeCliError";
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = runTeachingSpikeCli(process.argv.slice(2));
}
