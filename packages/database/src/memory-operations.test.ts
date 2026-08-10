import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  fingerprintMemoryContent,
  normalizeMemoryContent,
} from "./memory-operations.js";

describe("memory persistence", () => {
  it("normalizes equivalent content to a stable fingerprint", () => {
    expect(normalizeMemoryContent("  用户   喜欢围棋\n")).toBe("用户 喜欢围棋");
    expect(fingerprintMemoryContent("用户   喜欢围棋")).toBe(
      fingerprintMemoryContent(" 用户 喜欢围棋 "),
    );
  });

  it("generates provenance, privacy, and deduplication constraints", () => {
    const path = fileURLToPath(
      new URL("../migrations/0004_last_roughhouse.sql", import.meta.url),
    );
    const migration = readFileSync(path, "utf8");
    expect(migration).toContain(
      "character_memories_user_character_fingerprint_unique",
    );
    expect(migration).toContain(
      'FOREIGN KEY ("source_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null',
    );
    expect(migration).toContain('CREATE TABLE "conversation_summaries"');
    expect(migration).toContain('"user_id" uuid NOT NULL');
  });
});
