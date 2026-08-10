import {
  qwenAssistantTranscriptDeltaSchema,
  qwenAssistantTranscriptDoneSchema,
  qwenInputTranscriptionCompletedSchema,
  qwenInputTranscriptionDeltaSchema,
  qwenResponseCreatedEventSchema,
  qwenResponseDoneEventSchema,
  qwenSpeechStoppedEventSchema,
  type QwenServerEvent,
  type RealtimeActivity,
} from "@meet/protocol";

export type PendingTranscript = {
  speaker: "user" | "assistant";
  text: string;
  status: "completed" | "interrupted";
  providerEventId: string | null;
};

export type QwenConversationProjection = {
  activity: RealtimeActivity;
  responseActive: boolean;
  activeResponseId: string | null;
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
  activeResponseId: null,
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
    case "input_audio_buffer.speech_stopped": {
      const speechStopped = qwenSpeechStoppedEventSchema.safeParse(event);
      state.activity =
        speechStopped.success && speechStopped.data.reason === "turn_invalid"
          ? state.responseActive
            ? "assistant_speaking"
            : "listening"
          : "thinking";
      break;
    }
    case "response.created": {
      const responseCreated = qwenResponseCreatedEventSchema.safeParse(event);
      if (responseCreated.success) {
        state.responseActive = true;
        state.activeResponseId = responseCreated.data.response.id;
        state.activity = "assistant_speaking";
        state.assistantDraft = "";
      }
      break;
    }
    case "response.done": {
      const responseDone = qwenResponseDoneEventSchema.safeParse(event);
      if (
        !responseDone.success ||
        !state.activeResponseId ||
        responseDone.data.response.id !== state.activeResponseId
      ) {
        break;
      }
      if (state.assistantDraft.trim()) {
        commits.push({
          speaker: "assistant",
          text: state.assistantDraft.trim(),
          status:
            responseDone.success &&
            responseDone.data.response.status === "completed"
              ? "completed"
              : "interrupted",
          providerEventId: state.activeResponseId,
        });
      }
      state.assistantDraft = "";
      state.responseActive = false;
      state.activeResponseId = null;
      if (state.activity !== "user_speaking") {
        state.activity = "listening";
      }
      break;
    }
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
      commits.push({
        speaker: "user",
        text: text.trim(),
        status: "completed",
        providerEventId: userCompleted.data.event_id ?? null,
      });
    }
    state.userDraft = "";
  }

  const assistantDelta = qwenAssistantTranscriptDeltaSchema.safeParse(event);
  if (
    assistantDelta.success &&
    state.responseActive &&
    state.activeResponseId === assistantDelta.data.response_id
  ) {
    state.assistantDraft += assistantDelta.data.delta;
  }

  const assistantDone = qwenAssistantTranscriptDoneSchema.safeParse(event);
  if (
    assistantDone.success &&
    state.responseActive &&
    state.activeResponseId === assistantDone.data.response_id &&
    assistantDone.data.transcript
  ) {
    state.assistantDraft = assistantDone.data.transcript;
  }

  return { state, commits };
}
