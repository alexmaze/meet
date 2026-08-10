import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { shouldClaimMediaForDeletion } from "./media-operations.js";

describe("media persistence", () => {
  it("generates private ownership, integrity, expiry, and lifecycle constraints", () => {
    const path = fileURLToPath(
      new URL("../migrations/0005_media_store.sql", import.meta.url),
    );
    const migration = readFileSync(path, "utf8");
    expect(migration).toContain('CREATE TABLE "media_objects"');
    expect(migration).toContain('"owner_user_id" uuid NOT NULL');
    expect(migration).toContain("media_objects_object_key_unique");
    expect(migration).toContain("media_objects_retention_expiry_match");
    expect(migration).toContain("media_objects_deletion_state_match");
    expect(migration).toContain("media_objects_checksum_sha256_format");
    expect(migration).toContain(
      'REFERENCES "public"."user_accounts"("id") ON DELETE restrict',
    );
  });

  it("rejects stale expiration jobs after retention or expiry changes", () => {
    const expiresAt = new Date("2026-08-11T00:00:00.000Z");
    const media = {
      status: "available" as const,
      retention: "temporary" as const,
      expiresAt,
      objectKey: "current-key",
    };
    expect(
      shouldClaimMediaForDeletion(
        media,
        {
          objectKey: "current-key",
          reason: "expired",
          expectedExpiresAt: expiresAt,
        },
        expiresAt,
      ),
    ).toBe(true);
    expect(
      shouldClaimMediaForDeletion(
        { ...media, retention: "retained", expiresAt: null },
        {
          objectKey: "current-key",
          reason: "expired",
          expectedExpiresAt: expiresAt,
        },
        expiresAt,
      ),
    ).toBe(false);
    expect(
      shouldClaimMediaForDeletion(
        media,
        {
          objectKey: "current-key",
          reason: "expired",
          expectedExpiresAt: new Date("2026-08-12T00:00:00.000Z"),
        },
        expiresAt,
      ),
    ).toBe(false);
  });
});
