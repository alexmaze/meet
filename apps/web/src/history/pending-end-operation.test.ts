import { describe, expect, it } from "vitest";
import {
  clearPendingEndOperation,
  getPendingEndOperation,
  listPendingEndOperations,
  savePendingEndOperation,
} from "./pending-end-operation.js";

const operation = {
  conversationId: "9172f06d-c71a-47b3-94fe-35e1204b5b55",
  requestId: "f819d072-2f86-4584-9701-04037a9c46c3",
  lastSequence: 7,
};
function storage() {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

describe("pending end operation metadata", () => {
  it("persists only the fixed operation fields, never private content", () => {
    const target = storage();
    savePendingEndOperation(
      "member-a",
      {
        ...operation,
        text: "私人对话",
        password: "secret",
        voice: "private voice",
      } as typeof operation,
      target,
    );
    expect([...target.data.values()].map((value) => JSON.parse(value))).toEqual(
      [operation],
    );
  });
  it("isolates accounts and preserves independent unfinished conversations", () => {
    const target = storage();
    savePendingEndOperation("member-a", operation, target);
    savePendingEndOperation(
      "member-a",
      { ...operation, conversationId: "4172f06d-c71a-47b3-94fe-35e1204b5b55" },
      target,
    );
    expect(
      getPendingEndOperation(operation.conversationId, "member-b", target),
    ).toBeNull();
    expect(listPendingEndOperations("member-a", target)).toHaveLength(2);
    clearPendingEndOperation(operation.conversationId, "member-a", target);
    expect(listPendingEndOperations("member-a", target)).toHaveLength(1);
  });
  it("rejects corrupt metadata and tolerates unavailable browser storage", () => {
    const target = storage();
    expect(
      savePendingEndOperation("a", { ...operation, lastSequence: -1 }, target),
    ).toBe(false);
    const broken = {
      ...target,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(savePendingEndOperation("a", operation, broken)).toBe(false);
    expect(
      getPendingEndOperation(operation.conversationId, "a", null),
    ).toBeNull();
  });
});
