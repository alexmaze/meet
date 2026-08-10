import { describe, expect, it } from "vitest";

import {
  memoryListQuerySchema,
  reviewMemoryRequestSchema,
} from "./memories.js";

describe("memory protocol", () => {
  it("defaults list pagination and limits visible statuses", () => {
    expect(memoryListQuerySchema.parse({})).toEqual({ limit: 100 });
    expect(memoryListQuerySchema.safeParse({ status: "deleted" }).success).toBe(
      false,
    );
  });

  it("requires edited memory content and rejects extra fields", () => {
    expect(
      reviewMemoryRequestSchema.parse({ action: "edit", content: "喜欢围棋" }),
    ).toEqual({ action: "edit", content: "喜欢围棋" });
    expect(
      reviewMemoryRequestSchema.safeParse({ action: "edit" }).success,
    ).toBe(false);
    expect(
      reviewMemoryRequestSchema.safeParse({
        action: "accept",
        content: "不能随接受操作提交",
      }).success,
    ).toBe(false);
  });
});
