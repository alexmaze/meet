import {
  qwenAssistantTranscriptDeltaSchema,
  qwenAssistantTranscriptDoneSchema,
  qwenInputTranscriptionCompletedSchema,
  qwenInputTranscriptionDeltaSchema,
  type QwenServerEvent,
  type RealtimeActivity,
} from "@meet/protocol";

export type PendingTranscript = {
  speaker: "user" | "assistant";
  text: string;
};

export type QwenConversationProjection = {
  activity: RealtimeActivity;
  responseActive: boolean;
  userDraft: string;
  assistantDraft: string;
};

export type ProjectionResult = {
  state: QwenConversationProjection;
  commits: PendingTranscript[];
};

export const initialQwenProjection: QwenConversationProjection = {
  activity: "idle",
  responseActive: false,
  userDraft: "",
  assistantDraft: "",
};

export function projectQwenEvent(
  previous: QwenConversationProjection,
  event: QwenServerEvent,
): ProjectionResult {
  const state = { ...previous };
  const commits: PendingTranscript[] = [];

  switch (event.type) {
    case "session.updated":
      state.activity = "listening";
      break;
    case "input_audio_buffer.speech_started":
      state.activity = "user_speaking";
      state.userDraft = "";
      break;
    case "input_audio_buffer.speech_stopped":
      state.activity =
        event.reason === "turn_invalid"
          ? state.responseActive
            ? "assistant_speaking"
            : "listening"
          : "thinking";
      break;
    case "response.created":
      state.responseActive = true;
      state.activity = "assistant_speaking";
      state.assistantDraft = "";
      break;
    case "response.done":
      if (state.assistantDraft.trim()) {
        commits.push({
          speaker: "assistant",
          text: state.assistantDraft.trim(),
        });
      }
      state.assistantDraft = "";
      state.responseActive = false;
      if (state.activity !== "user_speaking") {
        state.activity = "listening";
      }
      break;
    case "error":
      state.activity = "idle";
      break;
  }

  const userDelta = qwenInputTranscriptionDeltaSchema.safeParse(event);
  if (userDelta.success) {
    state.userDraft = `${userDelta.data.text ?? ""}${userDelta.data.stash ?? ""}`;
  }

  const userCompleted = qwenInputTranscriptionCompletedSchema.safeParse(event);
  if (userCompleted.success) {
    const text =
      userCompleted.data.transcript ??
      userCompleted.data.text ??
      state.userDraft;
    if (text.trim()) {
      commits.push({ speaker: "user", text: text.trim() });
    }
    state.userDraft = "";
  }

  const assistantDelta = qwenAssistantTranscriptDeltaSchema.safeParse(event);
  if (assistantDelta.success) {
    state.assistantDraft += assistantDelta.data.delta;
  }

  const assistantDone = qwenAssistantTranscriptDoneSchema.safeParse(event);
  if (assistantDone.success && assistantDone.data.transcript) {
    state.assistantDraft = assistantDone.data.transcript;
  }

  return { state, commits };
}
