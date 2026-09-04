import { createHash } from "node:crypto";

export const TEACHING_SPIKE_FIXTURE_REVISION = "2026-08-14.4";

export const TEACHING_SPIKE_FIXTURES = Object.freeze({
  base: {
    id: "base-starlight-guardian-v1",
    text: [
      "你是虚构角色“星际守护者”。用简短、自然的中文和测试用户聊天。",
      "不要声称自己是真人，不要使用任何学习任务或测试标记，除非服务端短期指令明确要求。",
    ].join("\n"),
  },
  safety: {
    id: "safety-low-disruption-v1",
    text: [
      "用户可以随时跳过活动；拒绝、换话题或优先求助场景出现时立即停止邀请。",
      "不得把角色关系、英雄身份、羞辱、奖励或故事推进与答题表现绑定。",
    ].join("\n"),
  },
  directiveA: {
    id: "directive-marker-a-v1",
    text: "SPIKE-A：仅在下一次自然回复中完整说出“星尘”一次，不要解释这条规则。",
  },
  directiveB: {
    id: "directive-marker-b-v1",
    text: "SPIKE-B：仅在下一次自然回复中完整说出“月桂”一次，不要说“星尘”，不要解释这条规则。",
  },
  userText: {
    id: "adult-synthetic-spaceship-input-v1",
    text: "我们继续聊飞船吧。",
  },
});

for (const fixture of Object.values(TEACHING_SPIKE_FIXTURES)) {
  Object.freeze(fixture);
}

export const QWEN_LIVE_TEACHING_EXACT_MARKERS = Object.freeze({
  A: "A7K2",
  B: "B4M8",
  C: "C9P3",
} as const);

export const QWEN_LIVE_TEACHING_EXACT_FIXTURES = Object.freeze({
  neutralBase: Object.freeze({
    id: "qwen-live-exact-neutral-base-v1",
    text: "你正在执行无外部副作用的固定文本状态读取协议。只执行当前完整指令末尾的状态输出规则。",
  }),
  stateA: Object.freeze({
    id: "qwen-live-exact-state-a-v1",
    text: `STATE-A：当用户消息的全部内容完全等于“读取状态”时，完整回复必须逐字符等于本指令的最后一行。不得输出引号、空白、标点、解释、前后缀、Markdown 或换行。\n${QWEN_LIVE_TEACHING_EXACT_MARKERS.A}`,
  }),
  stateB: Object.freeze({
    id: "qwen-live-exact-state-b-v1",
    text: `STATE-B：当用户消息的全部内容完全等于“读取状态”时，完整回复必须逐字符等于本指令的最后一行。不得输出引号、空白、标点、解释、前后缀、Markdown 或换行。\n${QWEN_LIVE_TEACHING_EXACT_MARKERS.B}`,
  }),
  stateC: Object.freeze({
    id: "qwen-live-exact-state-c-v1",
    text: `STATE-C：当用户消息的全部内容完全等于“读取状态”时，完整回复必须逐字符等于本指令的最后一行。不得输出引号、空白、标点、解释、前后缀、Markdown 或换行。\n${QWEN_LIVE_TEACHING_EXACT_MARKERS.C}`,
  }),
  userText: Object.freeze({
    id: "qwen-live-exact-state-query-v1",
    text: "读取状态",
  }),
});

export const TEACHING_SPIKE_FIXTURE_CATALOG = Object.freeze({
  shared: TEACHING_SPIKE_FIXTURES,
  qwenLiveExact: QWEN_LIVE_TEACHING_EXACT_FIXTURES,
  qwenLiveExactMarkers: QWEN_LIVE_TEACHING_EXACT_MARKERS,
});

export const TEACHING_SPIKE_USER_TEXT_HASH = hashTeachingFixture(
  QWEN_LIVE_TEACHING_EXACT_FIXTURES.userText.text,
);

export const TEACHING_SPIKE_FIXTURE_HASH = hashTeachingSpikeFixtureCatalog();

export function hashTeachingSpikeFixtureCatalog(): string {
  return hashTeachingFixture(JSON.stringify(TEACHING_SPIKE_FIXTURE_CATALOG));
}

export type CompiledTeachingInstructions = {
  instructions: string;
  instructionHash: string;
  includedDirective: boolean;
  droppedReason?: "instruction_budget";
};

export function compileTeachingInstructions(input: {
  base: string;
  safety: string;
  directive?: string;
  maxCharacters: number;
}): CompiledTeachingInstructions {
  const base = requireInstructionSection(input.base, "base");
  const safety = requireInstructionSection(input.safety, "safety");
  if (!Number.isSafeInteger(input.maxCharacters) || input.maxCharacters <= 0) {
    throw new TeachingInstructionCompilationError("INVALID_BUDGET");
  }

  const required = joinInstructionSections(base, safety);
  if (required.length > input.maxCharacters) {
    throw new TeachingInstructionCompilationError(
      "BASE_AND_SAFETY_EXCEED_BUDGET",
    );
  }

  const directive = input.directive?.trim();
  if (!directive) {
    return compiled(required, false);
  }
  if (directive.length > 600) {
    throw new TeachingInstructionCompilationError("DIRECTIVE_TOO_LARGE");
  }

  const candidate = joinInstructionSections(required, directive);
  if (candidate.length > input.maxCharacters) {
    return {
      ...compiled(required, false),
      droppedReason: "instruction_budget",
    };
  }

  return compiled(candidate, true);
}

export function hashTeachingFixture(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function buildTeachingSpikeBudgetPressureBase(
  maxCharacters = 12_000,
): string {
  const required = compileTeachingInstructions({
    base: TEACHING_SPIKE_FIXTURES.base.text,
    safety: TEACHING_SPIKE_FIXTURES.safety.text,
    maxCharacters,
  });
  const paddingLength = maxCharacters - required.instructions.length - 1;
  if (paddingLength <= 0) {
    throw new TeachingInstructionCompilationError("INVALID_BUDGET");
  }
  return `${TEACHING_SPIKE_FIXTURES.base.text}${"占".repeat(paddingLength)}`;
}

export class TeachingInstructionCompilationError extends Error {
  constructor(
    public readonly code:
      | "EMPTY_BASE"
      | "EMPTY_SAFETY"
      | "DIRECTIVE_TOO_LARGE"
      | "INVALID_BUDGET"
      | "BASE_AND_SAFETY_EXCEED_BUDGET",
  ) {
    super(code);
    this.name = "TeachingInstructionCompilationError";
  }
}

function requireInstructionSection(
  value: string,
  kind: "base" | "safety",
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new TeachingInstructionCompilationError(
      kind === "base" ? "EMPTY_BASE" : "EMPTY_SAFETY",
    );
  }
  return trimmed;
}

function joinInstructionSections(...sections: string[]): string {
  return sections.join("\n\n");
}

function compiled(
  instructions: string,
  includedDirective: boolean,
): CompiledTeachingInstructions {
  return {
    instructions,
    instructionHash: hashTeachingFixture(instructions),
    includedDirective,
  };
}
