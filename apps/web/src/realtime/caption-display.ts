import type { TranscriptSegment } from "@meet/protocol";

import type { RealtimeClientSnapshot } from "./QwenRealtimeClient.js";

export function selectVisibleAssistantCaption(
  snapshot: RealtimeClientSnapshot,
  history: TranscriptSegment[],
): string {
  const liveCaption = snapshot.assistantCaption.trim();
  if (liveCaption) return liveCaption;

  if (
    (snapshot.connection !== "active" &&
      snapshot.connection !== "reconnecting") ||
    snapshot.activity === "thinking"
  ) {
    return "";
  }

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const transcript = history[index];
    if (transcript?.speaker === "assistant") return transcript.text;
  }
  return "";
}
