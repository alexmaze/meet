import { describe, expect, it } from "vitest";

import { canonicalizeUsername } from "./username.js";

describe("canonicalizeUsername", () => {
  it("normalizes compatibility characters before case folding", () => {
    expect(canonicalizeUsername("  ＡℒＥＸ  ")).toBe("alex");
  });

  it("keeps Unicode usernames instead of restricting them to ASCII", () => {
    expect(canonicalizeUsername("  小明  ")).toBe("小明");
  });

  it("uses one canonical identity for differently cased usernames", () => {
    expect(canonicalizeUsername("Alex")).toBe(canonicalizeUsername("alex"));
  });
});
