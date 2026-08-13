import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

import { loadWorkerConfig } from "./config.js";

describe("worker config", () => {
  it("shares the configured local media directory with the API", () => {
    const config = loadWorkerConfig({
      DATABASE_URL: "postgresql://meet:test@127.0.0.1:5432/meet",
      DASHSCOPE_API_KEY: "test-key",
      MEDIA_LOCAL_DIR: "./private-media",
    });
    expect(config.media.localDirectory).toMatch(/private-media$/);
    expect(config.media.localDirectory).toBe(
      fileURLToPath(new URL("../../../private-media", import.meta.url)),
    );
    expect(config.embedding.localCacheDirectory).toMatch(
      /data\/embedding-models$/,
    );
    expect(config.embedding.localCacheDirectory).toBe(
      fileURLToPath(new URL("../../../data/embedding-models", import.meta.url)),
    );
  });

  it("does not read retired Mem0 embedding environment variables", () => {
    const config = loadWorkerConfig({
      DATABASE_URL: "postgresql://meet:test@127.0.0.1:5432/meet",
      MEM0_ENABLED: "true",
      MEM0_EMBEDDING_API_KEY: "legacy-key",
    });
    expect(config).not.toHaveProperty("memory");
  });
});
