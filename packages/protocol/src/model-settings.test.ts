import { describe, expect, it } from "vitest";

import {
  BUILTIN_EMBEDDING_MODELS,
  createModelConnectionRequestSchema,
  createModelProfileRequestSchema,
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

  it("requires a bounded vector dimension for embedding models", () => {
    const base = {
      connectionId: connection.id,
      kind: "embedding",
      model: "text-embedding-3-small",
      displayName: "长期记忆向量模型",
    };
    expect(createModelProfileRequestSchema.safeParse(base).success).toBe(false);
    expect(
      createModelProfileRequestSchema.safeParse({
        ...base,
        embeddingDimensions: 1_536,
      }).success,
    ).toBe(true);
  });

  it("allows a credential-free built-in embedding connection", () => {
    expect(
      createModelConnectionRequestSchema.parse({
        adapter: "builtin_fastembed",
        displayName: "内置中文 Embedding",
      }),
    ).toEqual({
      adapter: "builtin_fastembed",
      displayName: "内置中文 Embedding",
    });
    expect(
      createModelConnectionRequestSchema.safeParse({
        adapter: "openai_embeddings",
        displayName: "外部 Embedding",
      }).success,
    ).toBe(false);
  });

  it("exposes every dense model supported by the pinned FastEmbed runtime", () => {
    expect(
      BUILTIN_EMBEDDING_MODELS.map(({ id, dimensions }) => [id, dimensions]),
    ).toEqual([
      ["fast-bge-small-zh-v1.5", 512],
      ["fast-multilingual-e5-large", 1_024],
      ["fast-bge-small-en-v1.5", 384],
      ["fast-bge-base-en-v1.5", 768],
      ["fast-bge-small-en", 384],
      ["fast-bge-base-en", 768],
      ["fast-all-MiniLM-L6-v2", 384],
    ]);
    expect(
      BUILTIN_EMBEDDING_MODELS.filter(({ recommended }) => recommended),
    ).toHaveLength(1);
  });
});
