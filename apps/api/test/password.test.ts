import { describe, expect, it } from "vitest";

import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyPassword,
} from "../src/auth/password.js";

describe("password hashing", () => {
  it("hashes and verifies a password without storing the plaintext", async () => {
    const encoded = await hashPassword("correct horse battery staple");
    const second = await hashPassword("correct horse battery staple");

    expect(encoded).toMatch(/^\$scrypt\$/);
    expect(second).not.toBe(encoded);
    expect(encoded).not.toContain("correct horse battery staple");
    await expect(
      verifyPassword("correct horse battery staple", encoded),
    ).resolves.toBe(true);
    await expect(verifyPassword("wrong password", encoded)).resolves.toBe(
      false,
    );
  });

  it("uses a valid dummy hash for unknown-account timing work", async () => {
    await expect(
      verifyPassword("any supplied password", DUMMY_PASSWORD_HASH),
    ).resolves.toBe(false);
  });

  it("rejects malformed hashes", async () => {
    await expect(verifyPassword("password", "not-a-hash")).resolves.toBe(false);
    await expect(
      verifyPassword("password", DUMMY_PASSWORD_HASH.replace("ln=17", "ln=30")),
    ).resolves.toBe(false);
  });
});
