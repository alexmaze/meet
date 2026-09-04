import {
  realtimeTeachingClientControlFrameSchema,
  realtimeTeachingServerControlFrameSchema,
  safeRelayTeachingStateSchema,
  type ChildTeachingAvailability,
  type RealtimeTeachingServerControlFrame,
  type SafeRelayTeachingState,
} from "@meet/protocol";

export type TeachingCapability =
  "unavailable" | "dynamic_instructions_next_safe_turn";

export const teachingCallStateNames = [
  "unavailable",
  "available",
  "active",
  "restoring",
  "muted",
  "completed",
] as const;

export type TeachingCallStateName = (typeof teachingCallStateNames)[number];

export type TeachingCallState = Readonly<SafeRelayTeachingState>;

export type TeachingAvailability = Readonly<ChildTeachingAvailability>;

export type TeachingChoice = "enabled" | "chat_only";

export function resolveCallTeachingChoice(
  accountType: "admin" | "adult" | "child",
  conversationMode: "normal" | "temporary",
  requested: TeachingChoice | undefined,
): TeachingChoice | undefined {
  if (accountType !== "child") return undefined;
  if (conversationMode === "temporary") return "chat_only";
  return requested;
}

export type TeachingStateRelayFrame = Extract<
  RealtimeTeachingServerControlFrame,
  { type: "relay.teaching.state" }
>;

export type TeachingAudioGateRelayFrame = Extract<
  RealtimeTeachingServerControlFrame,
  { type: "relay.teaching.audio_gate" }
>;

export type TeachingRelayFrame =
  TeachingStateRelayFrame | TeachingAudioGateRelayFrame;

export type TeachingRelayFrameParseResult =
  | { kind: "not_teaching" }
  | { kind: "invalid" }
  | { kind: "state"; frame: TeachingStateRelayFrame }
  | { kind: "audio_gate"; frame: TeachingAudioGateRelayFrame };

export type TeachingCallPresentation = Readonly<{
  label: string;
  detail: string;
  tone: "neutral" | "active" | "muted" | "unavailable";
  showRequest: boolean;
  showMute: boolean;
}>;

export function unavailableTeachingAvailability(): TeachingAvailability {
  return Object.freeze({ enabled: false, reason: "provider_unsupported" });
}

export function parseTeachingRelayFrame(
  input: unknown,
): TeachingRelayFrameParseResult {
  if (!isRecord(input) || typeof input.type !== "string") {
    return { kind: "not_teaching" };
  }
  if (!input.type.startsWith("relay.teaching.")) {
    return { kind: "not_teaching" };
  }
  const parsed = realtimeTeachingServerControlFrameSchema.safeParse(input);
  if (!parsed.success) return { kind: "invalid" };
  if (parsed.data.type === "relay.teaching.state") {
    return {
      kind: "state",
      frame: Object.freeze(parsed.data),
    };
  }
  return { kind: "audio_gate", frame: Object.freeze(parsed.data) };
}

export function teachingRequestFrame(eventId: string) {
  return teachingControlFrame("relay.teaching.request", eventId);
}

export function teachingMuteFrame(eventId: string) {
  return teachingControlFrame("relay.teaching.mute", eventId);
}

export function teachingAudioGateAckFrame(eventId: string, revision: number) {
  if (!isPositiveSafeInteger(revision)) {
    throw new Error("INVALID_TEACHING_AUDIO_GATE_REVISION");
  }
  return Object.freeze(
    realtimeTeachingClientControlFrameSchema.parse({
      event_id: requireEventId(eventId),
      type: "relay.teaching.audio_gate_ack",
      revision,
    }),
  );
}

export function teachingStateFromRelayFrame(
  frame: TeachingStateRelayFrame,
): TeachingCallState {
  const { type: _type, ...state } = frame;
  return safeRelayTeachingStateSchema.parse(state);
}

export function reduceTeachingCallState(
  current: TeachingCallState,
  incoming: TeachingCallState,
): TeachingCallState {
  if (incoming.revision <= current.revision) return current;
  return Object.freeze({ ...incoming });
}

export function initialTeachingCallState(
  availability: TeachingAvailability,
  choice: TeachingChoice,
): TeachingCallState {
  if (choice === "chat_only") {
    return Object.freeze({
      revision: 0,
      state: "muted",
      canRequest: false,
      canMute: false,
    });
  }
  if (!availability.enabled) {
    return Object.freeze({
      revision: 0,
      state: "unavailable",
      canRequest: false,
      canMute: false,
    });
  }
  return Object.freeze({
    revision: 0,
    state: "available",
    canRequest: true,
    canMute: true,
  });
}

export function teachingCallPresentation(
  state: TeachingCallState,
): TeachingCallPresentation {
  switch (state.state) {
    case "available":
      return {
        label: "学习小支线已开启",
        detail: "今天最多一个小挑战，你也可以继续只聊天。",
        tone: "neutral",
        showRequest: state.canRequest,
        showMute: state.canMute,
      };
    case "active":
      return {
        label: "小挑战进行中",
        detail: "不想继续时，可以马上跳过并回到聊天。",
        tone: "active",
        showRequest: false,
        showMute: state.canMute,
      };
    case "restoring":
      return {
        label: "正在回到聊天",
        detail: "这次通话不会再主动邀请小挑战。",
        tone: "muted",
        showRequest: false,
        showMute: false,
      };
    case "muted":
      return {
        label: "这次只聊天",
        detail: "这次通话不会主动出题或邀请小挑战。",
        tone: "muted",
        showRequest: false,
        showMute: false,
      };
    case "completed":
      return {
        label: "小挑战已结束",
        detail: "已经回到原来的聊天。",
        tone: "neutral",
        showRequest: false,
        showMute: false,
      };
    case "unavailable":
      return {
        label: "学习小支线本次不可用",
        detail: "普通聊天不受影响。",
        tone: "unavailable",
        showRequest: false,
        showMute: false,
      };
  }
}

function teachingControlFrame(
  type: "relay.teaching.request" | "relay.teaching.mute",
  eventId: string,
) {
  return Object.freeze(
    realtimeTeachingClientControlFrameSchema.parse({
      event_id: requireEventId(eventId),
      type,
    }),
  );
}

function requireEventId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new Error("INVALID_TEACHING_EVENT_ID");
  }
  return normalized;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
