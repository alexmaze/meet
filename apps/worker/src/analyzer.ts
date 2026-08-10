import { z } from "zod";

export type AnalysisMessage = {
  sequence: number;
  role: "user" | "assistant";
  status: "completed" | "interrupted";
  text: string;
};

export type MemoryCandidate = {
  content: string;
  sourceExcerpt: string;
  confidence: number;
  evidence: "explicit" | "inferred";
  stability: "stable" | "transient";
};

export interface ConversationAnalyzer {
  readonly model: string;
  summarize(input: {
    characterName: string;
    messages: AnalysisMessage[];
  }): Promise<string>;
  extractMemories(input: {
    characterName: string;
    messages: AnalysisMessage[];
  }): Promise<MemoryCandidate[]>;
}

const completionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().min(1) }),
      }),
    )
    .min(1),
});

const summaryOutputSchema = z.object({
  summary: z.string().trim().min(1).max(6_000),
});

const memoriesOutputSchema = z.object({
  memories: z
    .array(
      z.object({
        content: z.string().trim().min(1).max(1_000),
        sourceExcerpt: z.string().trim().min(1).max(600),
        confidence: z.number().min(0).max(1),
        evidence: z.enum(["explicit", "inferred"]),
        stability: z.enum(["stable", "transient"]),
      }),
    )
    .max(30),
});

type QwenAnalyzerOptions = {
  apiKey: string;
  baseUrl: string;
  model: string;
  requestTimeoutMs: number;
  fetchFunction?: typeof globalThis.fetch;
};

export class QwenConversationAnalyzer implements ConversationAnalyzer {
  readonly model: string;
  private readonly endpoint: string;
  private readonly fetchFunction: typeof globalThis.fetch;

  constructor(private readonly options: QwenAnalyzerOptions) {
    this.model = options.model;
    this.endpoint = `${options.baseUrl.replace(/\/$/, "")}/chat/completions`;
    this.fetchFunction = options.fetchFunction ?? globalThis.fetch;
  }

  async summarize(input: {
    characterName: string;
    messages: AnalysisMessage[];
  }): Promise<string> {
    if (input.messages.length === 0) return "本次通话没有已确认的文字记录。";
    const output = await this.requestJson(
      '你负责压缩家庭私有角色对话。请只依据提供的转写生成 JSON，不补充未出现的事实。摘要应保留关键话题、已完成事项、未完话题、用户明确表达的偏好和角色作出的承诺；忽略寒暄与重复内容。被打断的角色句子只能按实际保存文本处理。返回 {"summary":"..."}。',
      `角色：${input.characterName}\n\n转写：\n${buildAnalysisTranscript(input.messages)}`,
    );
    return summaryOutputSchema.parse(output).summary;
  }

  async extractMemories(input: {
    characterName: string;
    messages: AnalysisMessage[];
  }): Promise<MemoryCandidate[]> {
    if (input.messages.length === 0) return [];
    const output = await this.requestJson(
      '你负责从家庭私有角色对话中提取候选长期记忆。请只依据用户明确说出的内容或有直接依据的推断生成 JSON。只保留未来多次对话可能有用的偏好、身份、稳定计划、重要共同经历或持续关系事实；一次性的情绪、饥饿、天气和当前动作标为 transient。角色自己编造或建议的内容不能当作用户事实。sourceExcerpt 必须是支持该候选的简短原文。evidence 为 explicit 或 inferred，stability 为 stable 或 transient，confidence 为 0 到 1。没有合适内容时返回空数组。返回 {"memories":[...]}。',
      `角色：${input.characterName}\n\n转写：\n${buildAnalysisTranscript(input.messages)}`,
    );
    return memoriesOutputSchema.parse(output).memories;
  }

  private async requestJson(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<unknown> {
    const response = await this.fetchFunction(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        enable_thinking: false,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(this.options.requestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `Qwen analysis request failed with status ${response.status}.`,
      );
    }
    const completion = completionResponseSchema.parse(await response.json());
    const content = completion.choices[0]?.message.content;
    if (!content) throw new Error("Qwen analysis response had no content.");
    return JSON.parse(content) as unknown;
  }
}

const MAX_TRANSCRIPT_CHARACTERS = 120_000;
const TRANSCRIPT_HEAD_CHARACTERS = 20_000;

export function buildAnalysisTranscript(messages: AnalysisMessage[]): string {
  const transcript = messages
    .map(
      (message) =>
        `[${message.sequence}] ${message.role === "user" ? "用户" : "角色"}${message.status === "interrupted" ? "（被打断）" : ""}：${message.text.trim()}`,
    )
    .join("\n");
  if (transcript.length <= MAX_TRANSCRIPT_CHARACTERS) return transcript;
  const tailCharacters = MAX_TRANSCRIPT_CHARACTERS - TRANSCRIPT_HEAD_CHARACTERS;
  return `${transcript.slice(0, TRANSCRIPT_HEAD_CHARACTERS)}\n…（中间过长内容已省略）…\n${transcript.slice(-tailCharacters)}`;
}
