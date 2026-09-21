import type { MeetEmotionName } from "@meet/protocol";

const PROVIDER_EVENT_EMOTION: Record<string, MeetEmotionName> = {
  "input_audio_buffer.speech_started": "surprised",
  "response.created": "thinking",
  "response.audio_transcript.delta": "happy",
  "response.done": "relaxed",
};

export function meetEmotionForProviderEvent(
  type: string | null | undefined,
): MeetEmotionName | null {
  if (!type) return null;
  return PROVIDER_EVENT_EMOTION[type] ?? null;
}

export class MeetEmotionEmitter {
  private last: MeetEmotionName | null = null;

  next(type: string | null | undefined): MeetEmotionName | null {
    const name = meetEmotionForProviderEvent(type);
    if (!name || name === this.last) return null;
    this.last = name;
    return name;
  }
}
