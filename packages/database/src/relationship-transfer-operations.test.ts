import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("relationship transfer persistence", () => {
  it("stores idempotent package receipts and conversation origin tombstones", () => {
    const path = fileURLToPath(
      new URL("../migrations/0023_living_newton_destine.sql", import.meta.url),
    );
    const migration = readFileSync(path, "utf8");
    expect(migration).toContain('CREATE TABLE "relationship_transfer_imports"');
    expect(migration).toContain(
      '"relationship_transfer_imports_user_transfer_unique"',
    );
    expect(migration).toContain(
      'CREATE TABLE "relationship_transfer_conversation_origins"',
    );
    expect(migration).toContain(
      '"relationship_transfer_origins_user_character_source_unique"',
    );
    expect(migration).toContain("ON DELETE set null");
  });
});
