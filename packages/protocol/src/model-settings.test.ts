import { describe, expect, it } from "vitest";

import {
  createModelConnectionRequestSchema,
  modelSettingsResponseSchema,
  updateModelConnectionRequestSchema,
} from "./model-settings.js";

const connection = {
  id: "00000000-0000-4000-8000-000000000101",
  adapter: "openai_chat_completions" as const,
  displayName: "摘要模型连接",
  endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  compatibilityPreset: "dashscope" as const,
  status: "enabled" as const,
  hasCredential: true,
  hasPendingChanges: false,
  revision: 2,
  verifiedAt: "2026-08-13T00:00:00.000Z",
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
};

describe("model settings protocol", () => {
  it("accepts credentials on writes but never in management responses", () => {
    expect(
      createModelConnectionRequestSchema.safeParse({
        adapter: "openai_chat_completions",
        displayName: "摘要模型连接",
        endpoint: connection.endpoint,
        apiKey: "server-only-secret",
        compatibilityPreset: "dashscope",
      }).success,
    ).toBe(true);
    expect(
      modelSettingsResponseSchema.safeParse({
        connections: [{ ...connection, apiKey: "must-not-leak" }],
        models: [],
        voices: [],
        bindings: [],
        work: { waiting: 0, failed: 0 },
      }).success,
    ).toBe(false);
  });

  it("uses an empty credential update to preserve the current secret", () => {
    expect(
      updateModelConnectionRequestSchema.parse({ revision: 2, apiKey: "" }),
    ).toEqual({ revision: 2, apiKey: "" });
  });
});
