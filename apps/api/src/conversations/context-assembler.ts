import type {
  ConversationRuntimeSnapshot,
  RealtimeProviderKind,
} from "@meet/protocol";
import { CURRENT_CONTEXT_POLICY_VERSION } from "@meet/protocol";

export type ContextSourceMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type ContextSourceSummary = {
  conversationId: string;
  content: string;
};

export type ContextSourceMemory = {
  id: string;
  content: string;
};

export type ContextSourceCheckpoint = {
  id: string;
  content: string;
};

export type ContextDiagnostics = {
  policyVersion: string;
  provider: RealtimeProviderKind | "legacy";
  estimatedInstructionTokens: number;
  estimatedContextTokens: number;
  selected: { messages: number; summaries: number; memories: number };
  dropped: { messages: number; summaries: number; memories: number };
  checkpointSelected: boolean;
  memoryRecall: {
    mode: "disabled" | "semantic" | "fallback";
    queryMessageCount: number;
    hitCount: number;
  };
};

export type AssembledConversationContext = {
  relationshipContext?: string;
  messages: ContextSourceMessage[];
  diagnostics: ContextDiagnostics;
};

type ContextPolicy = {
  version: string;
  maximumInputTokens: number;
  maximumRenderedCharacters: number;
  fixedOverheadTokens: number;
  historyShare: number;
  maximumMessageTokens: number;
  maximumMessageCharacters: number;
};

const POLICIES: Record<
  ConversationRuntimeSnapshot["contextPolicyVersion"],
  Record<"qwen" | "doubao" | "legacy", ContextPolicy>
> = {
  "context-v1": {
    qwen: {
      version: "context-v1",
      maximumInputTokens: 14_000,
      maximumRenderedCharacters: 32_000,
      fixedOverheadTokens: 500,
      historyShare: 0.6,
      maximumMessageTokens: 1_200,
      maximumMessageCharacters: 2_000,
    },
    doubao: {
      version: "context-v1",
      maximumInputTokens: 10_000,
      maximumRenderedCharacters: 12_000,
      fixedOverheadTokens: 500,
      historyShare: 0.6,
      maximumMessageTokens: 1_000,
      maximumMessageCharacters: 2_000,
    },
    legacy: {
      version: "context-v1",
      maximumInputTokens: 10_000,
      maximumRenderedCharacters: 20_000,
      fixedOverheadTokens: 500,
      historyShare: 0.6,
      maximumMessageTokens: 1_000,
      maximumMessageCharacters: 2_000,
    },
  },
};

export function assembleConversationContext(input: {
  runtimeSnapshot: ConversationRuntimeSnapshot | null;
  messages: ContextSourceMessage[];
  summaries: ContextSourceSummary[];
  memories: ContextSourceMemory[];
  checkpoint?: ContextSourceCheckpoint | null;
}): AssembledConversationContext {
  const provider = supportedProvider(input.runtimeSnapshot?.provider);
  const policyVersion =
    input.runtimeSnapshot?.contextPolicyVersion ??
    CURRENT_CONTEXT_POLICY_VERSION;
  const policy = POLICIES[policyVersion][provider];
  const instructions = input.runtimeSnapshot?.instructions ?? "";
  const estimatedInstructionTokens = estimateContextTokens(instructions);
  const availableTokens = Math.max(
    0,
    policy.maximumInputTokens -
      policy.fixedOverheadTokens -
      estimatedInstructionTokens,
  );
  const availableCharacters = Math.max(
    0,
    policy.maximumRenderedCharacters - instructions.length - 600,
  );
  const historyTokens = Math.floor(availableTokens * policy.historyShare);
  const historyCharacters = Math.floor(
    availableCharacters * policy.historyShare,
  );
  const messages = selectRecentMessages(
    input.messages,
    historyTokens,
    historyCharacters,
    policy,
  );
  const usedMessageTokens = messages.reduce(
    (total, message) => total + estimateContextTokens(message.text),
    0,
  );
  const usedMessageCharacters = messages.reduce(
    (total, message) => total + message.text.length,
    0,
  );
  const relationship = selectRelationshipContext(
    input.checkpoint ?? null,
    input.memories,
    input.summaries,
    Math.max(0, availableTokens - usedMessageTokens),
    Math.max(0, availableCharacters - usedMessageCharacters),
  );
  const estimatedContextTokens =
    usedMessageTokens + estimateContextTokens(relationship.content ?? "");

  return {
    relationshipContext: relationship.content,
    messages,
    diagnostics: {
      policyVersion: policy.version,
      provider,
      estimatedInstructionTokens,
      estimatedContextTokens,
      selected: {
        messages: messages.length,
        summaries: relationship.summaryCount,
        memories: relationship.memoryCount,
      },
      dropped: {
        messages: Math.max(0, input.messages.length - messages.length),
        summaries: Math.max(
          0,
          input.summaries.length - relationship.summaryCount,
        ),
        memories: Math.max(0, input.memories.length - relationship.memoryCount),
      },
      checkpointSelected: relationship.checkpointSelected,
      memoryRecall: {
        mode: "disabled",
        queryMessageCount: 0,
        hitCount: 0,
      },
    },
  };
}

export function estimateContextTokens(text: string): number {
  let units = 0;
  for (const character of text) {
    units += character.codePointAt(0)! <= 0x7f ? 0.25 : 1;
  }
  return Math.ceil(units);
}

function supportedProvider(
  provider: RealtimeProviderKind | undefined,
): "qwen" | "doubao" | "legacy" {
  return provider === "qwen" || provider === "doubao" ? provider : "legacy";
}

function selectRecentMessages(
  messages: ContextSourceMessage[],
  tokenBudget: number,
  characterBudget: number,
  policy: ContextPolicy,
): ContextSourceMessage[] {
  const selected: ContextSourceMessage[] = [];
  let tokensLeft = tokenBudget;
  let charactersLeft = characterBudget;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (tokensLeft <= 0 || charactersLeft <= 0) break;
    const source = messages[index];
    if (!source) continue;
    const text = truncateToBudget(
      source.text,
      Math.min(tokensLeft, policy.maximumMessageTokens),
      Math.min(charactersLeft, policy.maximumMessageCharacters),
    );
    if (!text) continue;
    selected.push({ id: source.id, role: source.role, text });
    tokensLeft -= estimateContextTokens(text);
    charactersLeft -= text.length;
  }
  return selected.reverse();
}

function selectRelationshipContext(
  checkpoint: ContextSourceCheckpoint | null,
  memories: ContextSourceMemory[],
  summaries: ContextSourceSummary[],
  tokenBudget: number,
  characterBudget: number,
): {
  content?: string;
  memoryCount: number;
  summaryCount: number;
  checkpointSelected: boolean;
} {
  if (tokenBudget <= 0 || characterBudget <= 0) {
    return {
      memoryCount: 0,
      summaryCount: 0,
      checkpointSelected: false,
    };
  }
  const selectedCheckpoint = checkpoint
    ? truncateToBudget(checkpoint.content, tokenBudget, characterBudget)
    : "";
  const checkpointTokens = estimateContextTokens(selectedCheckpoint);
  const checkpointCharacters = selectedCheckpoint.length;
  const remainingTokens = Math.max(0, tokenBudget - checkpointTokens);
  const remainingCharacters = Math.max(
    0,
    characterBudget - checkpointCharacters,
  );
  const memoryBudget = Math.floor(remainingTokens * 0.6);
  const memoryCharacterBudget = Math.floor(remainingCharacters * 0.6);
  const selectedMemories = selectRecentText(
    memories,
    memoryBudget,
    memoryCharacterBudget,
  );
  const usedMemoryTokens = selectedMemories.reduce(
    (total, item) => total + estimateContextTokens(item.content),
    0,
  );
  const usedMemoryCharacters = selectedMemories.reduce(
    (total, item) => total + item.content.length,
    0,
  );
  const selectedSummaries = selectRecentText(
    summaries,
    Math.max(0, remainingTokens - usedMemoryTokens),
    Math.max(0, remainingCharacters - usedMemoryCharacters),
  );
  const sections: string[] = [];
  if (selectedCheckpoint) {
    sections.push(`本次通话较早内容的检查点摘要：\n- ${selectedCheckpoint}`);
  }
  if (selectedMemories.length > 0) {
    sections.push(
      `已确认长期记忆：\n${selectedMemories
        .map((memory) => `- ${memory.content}`)
        .join("\n")}`,
    );
  }
  if (selectedSummaries.length > 0) {
    sections.push(
      `此前通话摘要：\n${[...selectedSummaries]
        .reverse()
        .map((summary) => `- ${summary.content}`)
        .join("\n")}`,
    );
  }
  return {
    content: sections.length > 0 ? sections.join("\n\n") : undefined,
    memoryCount: selectedMemories.length,
    summaryCount: selectedSummaries.length,
    checkpointSelected: Boolean(selectedCheckpoint),
  };
}

function selectRecentText<T extends { content: string }>(
  items: T[],
  tokenBudget: number,
  characterBudget: number,
): T[] {
  const selected: T[] = [];
  let tokensLeft = tokenBudget;
  let charactersLeft = characterBudget;
  for (const item of items) {
    if (tokensLeft <= 0 || charactersLeft <= 0) break;
    const content = truncateToBudget(item.content, tokensLeft, charactersLeft);
    if (!content) continue;
    selected.push({ ...item, content });
    tokensLeft -= estimateContextTokens(content);
    charactersLeft -= content.length;
  }
  return selected;
}

function truncateToBudget(
  value: string,
  tokenBudget: number,
  characterBudget: number,
): string {
  const normalized = value.trim();
  if (!normalized || tokenBudget <= 0 || characterBudget <= 0) return "";
  let result = "";
  let tokens = 0;
  for (const character of normalized) {
    const nextTokens = tokens + (character.codePointAt(0)! <= 0x7f ? 0.25 : 1);
    if (
      nextTokens > tokenBudget ||
      result.length + character.length > characterBudget
    ) {
      break;
    }
    result += character;
    tokens = nextTokens;
  }
  return result.trim();
}
