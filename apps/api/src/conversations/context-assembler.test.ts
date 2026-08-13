import type { ConversationRuntimeSnapshot } from "@meet/protocol";
import { describe, expect, it } from "vitest";

import {
  assembleConversationContext,
  estimateContextTokens,
} from "./context-assembler.js";

const snapshot = {
  characterRevision: 1,
  realtimeModelProfileId: "c437c71e-f209-4f7d-8f98-1c1e239d4201",
  provider: "doubao" as const,
  model: "1.2.6.1",
  voice: "voice-1",
  instructions: "保持角色。",
  firstSpeaker: "assistant" as const,
  openingLine: null,
  contextPolicyVersion: "context-v1",
} satisfies ConversationRuntimeSnapshot;

describe("conversation context assembler", () => {
  it("keeps recent messages in chronological order", () => {
    const result = assembleConversationContext({
      runtimeSnapshot: snapshot,
      messages: Array.from({ length: 24 }, (_, index) => ({
        id: `message-${index}`,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        text: `${index}-${"中".repeat(900)}`,
      })),
      summaries: [],
      memories: [],
    });
    expect(result.messages.length).toBeLessThan(24);
    expect(result.messages.at(-1)?.id).toBe("message-23");
    expect(
      result.messages.every(
        (message, index) =>
          index === 0 ||
          Number(result.messages[index - 1]!.id.split("-")[1]) <
            Number(message.id.split("-")[1]),
      ),
    ).toBe(true);
  });

  it("preserves the newest summaries when the relationship budget is full", () => {
    const result = assembleConversationContext({
      runtimeSnapshot: snapshot,
      messages: [],
      memories: [],
      summaries: [
        { conversationId: "new", content: `最新-${"新".repeat(20_000)}` },
        { conversationId: "old", content: "更早摘要" },
      ],
    });
    expect(result.relationshipContext).toContain("最新-");
    expect(result.relationshipContext).not.toContain("更早摘要");
  });

  it("places the current-call checkpoint before relationship memory", () => {
    const result = assembleConversationContext({
      runtimeSnapshot: snapshot,
      checkpoint: { id: "checkpoint-20", content: "前二十条讨论了分数。" },
      messages: [],
      memories: [{ id: "memory-1", content: "用户周五有考试。" }],
      summaries: [],
    });
    expect(result.relationshipContext).toContain(
      "本次通话较早内容的检查点摘要",
    );
    expect(result.relationshipContext).toContain("前二十条讨论了分数。");
    expect(result.diagnostics.checkpointSelected).toBe(true);
  });

  it("uses a conservative estimate for Chinese and compact estimate for ASCII", () => {
    expect(estimateContextTokens("中文测试")).toBe(4);
    expect(estimateContextTokens("abcdefgh")).toBe(2);
  });
});
