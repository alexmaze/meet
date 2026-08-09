import { describe, expect, it } from "vitest";

import { getCharacterRealtimeSessionUrl } from "./QwenRealtimeClient.js";

describe("getCharacterRealtimeSessionUrl", () => {
  it("业务握手只定位角色，不携带模型、声音或提示词", () => {
    const url = getCharacterRealtimeSessionUrl(
      "00000000-0000-4000-8000-000000000001",
    );

    expect(url).toBe(
      "/api/characters/00000000-0000-4000-8000-000000000001/realtime/sessions",
    );
    expect(url).not.toContain("?");
    expect(url).not.toContain("model");
    expect(url).not.toContain("voice");
  });
});
