import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { AppendConversationMessagesRequest } from "@meet/protocol";
import { describe, expect, it } from "vitest";

import { planConversationMessageAppend } from "./conversation-operations.js";
import type { ConversationMessageRecord } from "./schema.js";

const conversationId = "9172f06d-c71a-47b3-94fe-35e1204b5b55";
const userId = "4d1c2e31-ad0e-4fa9-9ae8-ae3497069117";

describe("conversation message persistence", () => {
  it("accepts a contiguous append and acknowledges its highest sequence", () => {
    const input = [message(2), message(3)];
    expect(planConversationMessageAppend(1, [], input)).toEqual({
      kind: "accepted",
      additions: input,
      acknowledgedSequence: 3,
    });
  });

  it("treats an identical retry as already acknowledged", () => {
    const input = message(1);
    expect(
      planConversationMessageAppend(1, [storedMessage(input)], [input]),
    ).toEqual({
      kind: "accepted",
      additions: [],
      acknowledgedSequence: 1,
    });
  });

  it("rejects gaps, reused sequences, and changed retry payloads", () => {
    expect(planConversationMessageAppend(1, [], [message(3)])).toEqual({
      kind: "sequence_conflict",
    });
    expect(
      planConversationMessageAppend(
        1,
        [storedMessage(message(1))],
        [{ ...message(1), text: "被修改的内容" }],
      ),
    ).toEqual({ kind: "sequence_conflict" });
    expect(
      planConversationMessageAppend(0, [], [message(1), message(1)]),
    ).toEqual({ kind: "sequence_conflict" });
  });

  it("generates privacy, ordering, and cascade constraints in the migration", () => {
    const path = fileURLToPath(
      new URL("../migrations/0003_peaceful_sersi.sql", import.meta.url),
    );
    const migration = readFileSync(path, "utf8");
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "conversation_messages_conversation_sequence_unique"',
    );
    expect(migration).toContain('"user_id" uuid NOT NULL');
    expect(migration).toContain(
      'REFERENCES "public"."conversations"("id") ON DELETE cascade',
    );
  });
});

function message(
  sequence: number,
): AppendConversationMessagesRequest["messages"][number] {
  return {
    id: `9bb6162e-e85c-4e5d-a3ff-${String(sequence).padStart(12, "0")}`,
    sequence,
    role: sequence % 2 ? "user" : "assistant",
    status: "completed",
    text: `第 ${sequence} 条消息`,
    providerEventId: `provider-${sequence}`,
    createdAt: `2026-08-10T0${sequence}:00:00.000Z`,
  };
}

function storedMessage(
  input: AppendConversationMessagesRequest["messages"][number],
): ConversationMessageRecord {
  return {
    ...input,
    conversationId,
    userId,
    createdAt: new Date(input.createdAt),
  };
}
