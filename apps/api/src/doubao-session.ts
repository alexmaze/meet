import type { DoubaoRealtimeModel } from "@meet/protocol";

export type DoubaoSessionRuntime = {
  voice: string;
  instructions: string;
  relationshipContext?: string;
  history?: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
  }>;
};

export type DoubaoSessionConfig = {
  type: "realtime";
  model: DoubaoRealtimeModel;
  instructions: string;
  audio: {
    input: { format: { type: "pcm"; rate: 16_000 } };
    output: {
      format: { type: "pcm_s16le"; rate: 24_000 };
      voice: string;
      speed: 0;
      loudness: 0;
    };
  };
};

export function buildDoubaoSessionConfig(
  model: DoubaoRealtimeModel,
  runtime: DoubaoSessionRuntime,
): DoubaoSessionConfig {
  return {
    type: "realtime",
    model,
    instructions: buildDoubaoInstructions(runtime),
    audio: {
      input: { format: { type: "pcm", rate: 16_000 } },
      output: {
        format: { type: "pcm_s16le", rate: 24_000 },
        voice: runtime.voice,
        speed: 0,
        loudness: 0,
      },
    },
  };
}

export function buildDoubaoInstructions(runtime: DoubaoSessionRuntime): string {
  const sections = [runtime.instructions.trim()];
  if (runtime.relationshipContext?.trim()) {
    sections.push(
      `【已确认的关系记忆与摘要】\n${runtime.relationshipContext.trim()}\n只用于自然延续关系，不要逐条朗读，也不要补充未记录的事实。`,
    );
  }
  const history = runtime.history ?? [];
  if (history.length > 0) {
    sections.push(
      `【最近已确认对话】\n${history
        .map(
          (message) =>
            `${message.role === "user" ? "用户" : "角色"}：${message.text}`,
        )
        .join("\n")}\n自然承接话题；不要因为重连重复上一句。`,
    );
  }
  return sections.join("\n\n").slice(0, 12_000);
}
