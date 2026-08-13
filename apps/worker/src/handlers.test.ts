import { describe, expect, it } from "vitest";

import {
  classifyMemoryCandidate,
  selectMessagesAfterCheckpoint,
} from "./handlers.js";

describe("incremental summary policy", () => {
  it("only sends messages after the latest checkpoint to final summarization", () => {
    const messages = [{ sequence: 19 }, { sequence: 20 }, { sequence: 21 }];
    expect(selectMessagesAfterCheckpoint(messages, 20)).toEqual([
      { sequence: 21 },
    ]);
    expect(selectMessagesAfterCheckpoint(messages)).toBe(messages);
  });
});

describe("memory extraction policy", () => {
  it("only auto-saves explicit, stable, high-confidence facts", () => {
    expect(
      classifyMemoryCandidate({
        content: "用户喜欢围棋",
        sourceExcerpt: "我一直很喜欢围棋",
        confidence: 0.95,
        evidence: "explicit",
        stability: "stable",
      }),
    ).toBe("active");
    expect(
      classifyMemoryCandidate({
        content: "用户可能准备搬家",
        sourceExcerpt: "也许明年会搬家",
        confidence: 0.8,
        evidence: "inferred",
        stability: "stable",
      }),
    ).toBe("suggested");
    expect(
      classifyMemoryCandidate({
        content: "用户现在饿了",
        sourceExcerpt: "我有点饿",
        confidence: 0.99,
        evidence: "explicit",
        stability: "transient",
      }),
    ).toBeNull();
  });
});
