import type { TranscriptSegment } from "@meet/protocol";
import { describe, expect, it } from "vitest";

import { initialClientSnapshot } from "./QwenRealtimeClient.js";
import { selectVisibleAssistantCaption } from "./caption-display.js";

const assistantHistory: TranscriptSegment[] = [
  {
    id: "assistant-1",
    speaker: "assistant",
    text: "这句回答仍在播放。",
    createdAt: "2026-08-13T00:00:00.000Z",
  },
];

describe("call caption display", () => {
  it("keeps the latest assistant caption when ambient speech does not form a turn", () => {
    expect(
      selectVisibleAssistantCaption(
        {
          ...initialClientSnapshot,
          connection: "active",
          activity: "user_speaking",
          userCaption: "嗯",
        },
        assistantHistory,
      ),
    ).toBe("这句回答仍在播放。");
  });

  it("prefers the current streaming assistant caption", () => {
    expect(
      selectVisibleAssistantCaption(
        {
          ...initialClientSnapshot,
          connection: "active",
          activity: "assistant_speaking",
          assistantCaption: "新的实时字幕",
        },
        assistantHistory,
      ),
    ).toBe("新的实时字幕");
  });

  it("clears the previous assistant caption for a confirmed new user turn", () => {
    expect(
      selectVisibleAssistantCaption(
        {
          ...initialClientSnapshot,
          connection: "active",
          activity: "thinking",
        },
        assistantHistory,
      ),
    ).toBe("");
  });
});
