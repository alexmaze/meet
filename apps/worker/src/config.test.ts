import { describe, expect, it } from "vitest";

import { loadWorkerConfig } from "./config.js";

describe("worker config", () => {
  it("shares the configured local media directory with the API", () => {
    const config = loadWorkerConfig({
      DATABASE_URL: "postgresql://meet:test@127.0.0.1:5432/meet",
      DASHSCOPE_API_KEY: "test-key",
      MEDIA_LOCAL_DIR: "./private-media",
    });
    expect(config.media.localDirectory).toMatch(/private-media$/);
  });
});
