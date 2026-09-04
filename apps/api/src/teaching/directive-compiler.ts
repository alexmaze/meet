import { createHash } from "node:crypto";

import type { TeachingDifficulty, TeachingTriggerMode } from "@meet/protocol";

export const QWEN_TEACHING_EFFECTIVE_INSTRUCTIONS_MAX_CHARACTERS = 16_000;

const CHILD_SAFETY_INSTRUCTIONS = [
  "【不可覆盖的儿童教学安全规则】",
  "陪伴主线和用户当前需要始终优先。教学互动必须简短、可拒绝，不能使用羞辱、比较、失望、关系压力、秘密、奖励或身份认同推动参与。",
  "用户拒绝、想只聊天、换话题，或表达难过、害怕、受伤、被欺负、家庭冲突、安全风险或求助时，立即停止教学并自然回应更重要的话题。",
  "不要把犹豫、不知道、口误、沉默或转写不确定解释为答错，也不要形成能力评价。",
].join("\n");

export type CompiledQwenTeachingInstructions = Readonly<{
  instructions: string;
  instructionHash: string;
}>;

export type QwenTeachingRuntimeContent = Readonly<{
  id: string;
  directive: string;
  maximumAssistantResponses: 2;
}>;

export function compileQwenTeachingDirective(input: {
  baseInstructions: string;
  content: QwenTeachingRuntimeContent;
  difficulty: TeachingDifficulty;
  trigger: TeachingTriggerMode;
}): CompiledQwenTeachingInstructions {
  const baseInstructions = requireInstructions(input.baseInstructions);
  const dynamicDirective = input.content.directive.trim();
  if (!dynamicDirective) {
    throw new QwenTeachingDirectiveCompilerError("EMPTY_CONTROLLED_CONTENT");
  }
  const instructions = [
    baseInstructions,
    CHILD_SAFETY_INSTRUCTIONS,
    "【本次短期教学支线】",
    triggerInstruction(input.trigger),
    difficultyInstruction(input.difficulty),
    dynamicDirective,
  ].join("\n\n");
  return compileWithinBudget(instructions);
}

function triggerInstruction(trigger: TeachingTriggerMode): string {
  return trigger === "on_request"
    ? "用户已经通过应用按钮明确请求现在来一次短互动。只要最新语境没有拒绝或安全优先事项，就在下一次回复执行一次；用户仍可随时跳过。"
    : "这是低打扰候选。仅当最新语境轻松、自然且没有更重要的话题时才尝试；不合适就完全跳过。";
}

function difficultyInstruction(difficulty: TeachingDifficulty): string {
  switch (difficulty) {
    case "starter":
      return "难度固定为入门：只用一个概念和一个选择，优先给示范，不要求完整解释。";
    case "growing":
      return "难度固定为成长：只问一个短问题，允许提示一次，不连续追问。";
    case "challenge":
      return "难度固定为挑战：可以邀请用户简短说明想法，但仍只进行一次互动且允许立即跳过。";
  }
}

export function compileQwenTeachingBaseInstructions(
  baseInstructions: string,
): CompiledQwenTeachingInstructions {
  return compileWithinBudget(requireInstructions(baseInstructions));
}

export function hashQwenTeachingInstructions(instructions: string): string {
  return createHash("sha256").update(instructions, "utf8").digest("hex");
}

function compileWithinBudget(
  instructions: string,
): CompiledQwenTeachingInstructions {
  if (
    instructions.length > QWEN_TEACHING_EFFECTIVE_INSTRUCTIONS_MAX_CHARACTERS
  ) {
    throw new QwenTeachingDirectiveCompilerError("INSTRUCTION_BUDGET_EXCEEDED");
  }
  return Object.freeze({
    instructions,
    instructionHash: hashQwenTeachingInstructions(instructions),
  });
}

function requireInstructions(input: string): string {
  const instructions = input.trim();
  if (!instructions) {
    throw new QwenTeachingDirectiveCompilerError("EMPTY_BASE_INSTRUCTIONS");
  }
  return instructions;
}

export type QwenTeachingDirectiveCompilerErrorCode =
  | "EMPTY_BASE_INSTRUCTIONS"
  | "EMPTY_CONTROLLED_CONTENT"
  | "INSTRUCTION_BUDGET_EXCEEDED";

export class QwenTeachingDirectiveCompilerError extends Error {
  constructor(readonly code: QwenTeachingDirectiveCompilerErrorCode) {
    super(code);
    this.name = "QwenTeachingDirectiveCompilerError";
  }
}
