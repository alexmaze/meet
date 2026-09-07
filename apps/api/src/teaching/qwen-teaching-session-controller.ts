import {
  qwenInputTranscriptionCompletedSchema,
  qwenResponseCreatedEventSchema,
  qwenResponseDoneEventSchema,
  qwenSpeechStartedEventSchema,
  qwenSpeechStoppedEventSchema,
  realtimeTeachingServerControlFrameSchema,
  type RealtimeTeachingClientControlFrame,
  type RealtimeTeachingServerControlFrame,
  type TeachingDifficulty,
  type TeachingSubject,
  type TeachingTriggerMode,
} from "@meet/protocol";
import { z } from "zod";

import {
  compileQwenTeachingBaseInstructions,
  compileQwenTeachingDirective,
  hashQwenTeachingInstructions,
  QwenTeachingDirectiveCompilerError,
  type CompiledQwenTeachingInstructions,
  type QwenTeachingRuntimeContent,
} from "./directive-compiler.js";

export const QWEN_TEACHING_MIN_GENTLE_ELAPSED_MS = 5 * 60 * 1_000;
export const QWEN_TEACHING_MIN_GENTLE_USER_TURNS = 6;

const DEFAULT_GATE_ACK_TIMEOUT_MS = 3_000;
const DEFAULT_UPDATE_ACK_TIMEOUT_MS = 5_000;
const DEFAULT_RESPONSE_DONE_TIMEOUT_MS = 90_000;
const MAX_SEEN_EVENT_IDS = 256;
const BASE_RESPONSE_MODALITIES = ["audio", "text"] as const;

const sessionUpdatedEventSchema = z
  .object({
    event_id: z.string().min(1).max(256),
    type: z.literal("session.updated"),
    session: z
      .object({
        id: z.string().min(1).max(256),
        object: z.literal("realtime.session"),
        model: z.string().trim().min(1).max(160),
        modalities: z.union([
          z.tuple([z.literal("audio"), z.literal("text")]),
          z.tuple([z.literal("text"), z.literal("audio")]),
        ]),
        voice: z.string().min(1).max(120),
        input_audio_format: z.literal("pcm").optional(),
        output_audio_format: z.literal("pcm").optional(),
        instructions: z.string().min(1).max(16_000).optional(),
        max_history_turns: z.number().int().min(1).max(50).optional(),
        turn_detection: z
          .object({ type: z.literal("smart_turn") })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export type QwenTeachingSessionSnapshot = Readonly<{
  id: string;
  model: string;
  modalities: readonly ["audio", "text"] | readonly ["text", "audio"];
  voice: string;
  inputAudioFormat: "pcm";
  outputAudioFormat: "pcm";
  instructions: string;
  maxHistoryTurns: number;
  turnDetection: "smart_turn";
}>;

export type QwenTeachingSessionUpdatedAcknowledgement = Readonly<{
  eventId: string;
  id: string;
  model: string;
  modalities: readonly ["audio", "text"] | readonly ["text", "audio"];
  voice: string;
  inputAudioFormat?: "pcm";
  outputAudioFormat?: "pcm";
  instructions?: string;
  maxHistoryTurns?: number;
  turnDetection: "smart_turn";
}>;

export type QwenTeachingRuntimeSnapshot = Readonly<{
  provider: "qwen" | "doubao";
  enabled: boolean;
  subject: TeachingSubject;
  difficulty: TeachingDifficulty;
  triggerMode: TeachingTriggerMode;
  startedAtMs: number;
  eligibleForGentle: boolean;
  validUserTurns: number;
  invitationCount: number;
  sessionMuted?: boolean;
}>;

export type QwenTeachingInvitationClaim =
  | Readonly<{ claimed: false }>
  | Readonly<{
      claimed: true;
      content: QwenTeachingRuntimeContent;
    }>;

export type QwenTeachingSafePersistenceReason =
  | "explicit_refusal"
  | "safety_priority"
  | "user_control"
  | "provider_failure"
  | "timeout"
  | "instruction_budget";

export type QwenTeachingPersistenceEvent = Readonly<{
  kind: "restoring" | "completed" | "session_muted" | "aborted";
  atMs: number;
  contentItemId?: string;
  reason?: QwenTeachingSafePersistenceReason;
}>;

export type QwenTeachingSessionDependencies = Readonly<{
  claimInvitation: (
    input: Readonly<{
      trigger: TeachingTriggerMode;
      subject: TeachingSubject;
      difficulty: TeachingDifficulty;
      elapsedMs: number;
      validUserTurns: number;
    }>,
  ) => Promise<QwenTeachingInvitationClaim>;
  recordValidUserTurn: (
    input: Readonly<{
      providerEventId: string;
      occurredAtMs: number;
    }>,
  ) => Promise<Readonly<{ recorded: boolean; validUserTurns: number }>>;
  persistState: (event: QwenTeachingPersistenceEvent) => Promise<void>;
}>;

export type QwenTeachingSessionTransport = Readonly<{
  sendClientFrame: (frame: RealtimeTeachingServerControlFrame) => boolean;
  sendUpstreamEvent: (event: Readonly<Record<string, unknown>>) => boolean;
  safetyClose: (
    reason: "provider_failure" | "timeout" | "protocol_mismatch",
  ) => void;
}>;

export type QwenTeachingSessionControllerOptions = Readonly<{
  runtime: QwenTeachingRuntimeSnapshot;
  dependencies: QwenTeachingSessionDependencies;
  transport: QwenTeachingSessionTransport;
  now?: () => number;
  timeouts?: Readonly<{
    gateAckMs?: number;
    updateAckMs?: number;
    responseDoneMs?: number;
  }>;
}>;

type ControllerPhase =
  | "awaiting_base"
  | "opening_gate_for_base"
  | "idle"
  | "claiming"
  | "waiting_safe_boundary"
  | "closing_gate_for_apply"
  | "applying"
  | "opening_gate_for_active"
  | "active"
  | "closing_gate_for_restore"
  | "restoring"
  | "opening_gate_for_final"
  | "closed";

type PendingGate = {
  revision: number;
  open: boolean;
  timeout: NodeJS.Timeout;
  onAcknowledged: () => void;
};

type PendingUpdate = {
  kind: "apply" | "restore";
  compiled: CompiledQwenTeachingInstructions;
  timeout: NodeJS.Timeout;
};

type ClaimedInvitation = {
  trigger: TeachingTriggerMode;
  contentItemId: string;
  compiled: CompiledQwenTeachingInstructions;
  maximumAssistantResponses: 2;
};

export type QwenTeachingProviderAvailability = "available" | "unavailable";

export function getQwenTeachingProviderAvailability(
  provider: string,
): QwenTeachingProviderAvailability {
  return provider === "qwen" ? "available" : "unavailable";
}

export class QwenTeachingSessionController {
  private readonly now: () => number;
  private readonly gateAckTimeoutMs: number;
  private readonly updateAckTimeoutMs: number;
  private readonly responseDoneTimeoutMs: number;
  private phase: ControllerPhase = "awaiting_base";
  private publicState:
    | "unavailable"
    | "available"
    | "active"
    | "restoring"
    | "muted"
    | "completed" = "unavailable";
  private wireRevision = 0;
  private baseSession: QwenTeachingSessionSnapshot | null = null;
  private baseInstructions: CompiledQwenTeachingInstructions | null = null;
  private pendingGate: PendingGate | null = null;
  private pendingUpdate: PendingUpdate | null = null;
  private claimedInvitation: ClaimedInvitation | null = null;
  private queuedTrigger: TeachingTriggerMode | null = null;
  private activeResponseId: string | null = null;
  private suppressedResponseId: string | null = null;
  private responseDoneTimeout: NodeJS.Timeout | null = null;
  private teachingResponseCreateSent = false;
  private awaitingTeachingResponseCreated = false;
  private assistantResponsesCompleted = 0;
  private finalStateAfterRestore: "muted" | "completed" = "completed";
  private validUserTurns: number;
  private invitationCount: number;
  private userSpeechActive = false;
  private awaitingResponseAfterSpeech = false;
  private muteGateClosed = false;
  private muteResponseTerminal = true;
  private muteAwaitingResponseCreated = false;
  private mutePersistenceConfirmed = false;
  private muteInProgress = false;
  private gentleCandidateReady = false;
  private claimEpoch = 0;
  private pendingClaimEpoch: number | null = null;
  private persistenceTail: Promise<void> = Promise.resolve();
  private latestStoppedSpeechItemId: string | null = null;
  private readonly stoppedSpeechTurnOutcomes = new Map<
    string,
    "valid" | "invalid"
  >();
  private readonly seenClientEventIds = new Set<string>();
  private readonly seenUserTranscriptEventIds = new Set<string>();
  private readonly seenSessionUpdatedEventIds = new Set<string>();

  constructor(private readonly options: QwenTeachingSessionControllerOptions) {
    this.now = options.now ?? Date.now;
    this.gateAckTimeoutMs = positiveTimeout(
      options.timeouts?.gateAckMs,
      DEFAULT_GATE_ACK_TIMEOUT_MS,
    );
    this.updateAckTimeoutMs = positiveTimeout(
      options.timeouts?.updateAckMs,
      DEFAULT_UPDATE_ACK_TIMEOUT_MS,
    );
    this.responseDoneTimeoutMs = positiveTimeout(
      options.timeouts?.responseDoneMs,
      DEFAULT_RESPONSE_DONE_TIMEOUT_MS,
    );
    this.validUserTurns = options.runtime.validUserTurns;
    this.invitationCount = options.runtime.invitationCount;
  }

  configureBase(
    session: QwenTeachingSessionSnapshot,
    acknowledgementEventId: string,
  ): void {
    if (this.phase !== "awaiting_base") {
      return this.safetyClose("protocol_mismatch");
    }
    if (
      !acknowledgementEventId ||
      this.seenSessionUpdatedEventIds.has(acknowledgementEventId)
    ) {
      return this.safetyClose("protocol_mismatch");
    }
    rememberBounded(this.seenSessionUpdatedEventIds, acknowledgementEventId);
    this.baseSession = session;
    try {
      this.baseInstructions = compileQwenTeachingBaseInstructions(
        session.instructions,
      );
    } catch {
      return this.safetyClose("protocol_mismatch");
    }

    let initialState: "unavailable" | "available" | "muted" | "completed";
    if (
      !this.options.runtime.enabled ||
      getQwenTeachingProviderAvailability(this.options.runtime.provider) ===
        "unavailable"
    ) {
      initialState = "unavailable";
    } else if (this.options.runtime.sessionMuted) {
      initialState = "muted";
    } else if (this.invitationCount > 0) {
      initialState = "completed";
    } else {
      initialState = "available";
    }
    this.phase = "opening_gate_for_base";
    this.sendGate(true, () => {
      this.phase = "idle";
      this.emitState(initialState);
      if (initialState === "available") this.refreshGentleEligibility();
    });
  }

  dispose(): void {
    if (this.isClosed()) return;
    this.invalidatePendingClaim();
    this.phase = "closed";
    this.clearPendingGate();
    this.clearPendingUpdate();
    this.clearResponseTimeout();
  }

  isInputGateOpen(): boolean {
    return (
      this.phase === "idle" ||
      this.phase === "claiming" ||
      this.phase === "waiting_safe_boundary" ||
      this.phase === "active"
    );
  }

  /** Renewal may not abandon a claimed invitation or an unacknowledged gate. */
  isSafeToRenew(): boolean {
    return (
      this.phase === "idle" &&
      !this.claimedInvitation &&
      !this.queuedTrigger &&
      this.pendingClaimEpoch === null &&
      !this.pendingGate &&
      !this.pendingUpdate &&
      !this.muteInProgress
    );
  }

  handleClientFrame(frame: RealtimeTeachingClientControlFrame): void {
    if (this.isClosed()) return;
    if (this.seenClientEventIds.has(frame.event_id)) return;
    rememberBounded(this.seenClientEventIds, frame.event_id);

    if (frame.type === "relay.teaching.audio_gate_ack") {
      this.acknowledgeGate(frame.revision);
      return;
    }
    if (frame.type === "relay.teaching.mute") {
      void this.mute("user_control", false);
      return;
    }
    if (frame.type === "relay.teaching.request") {
      this.requestInvitation("on_request");
    }
  }

  handleProviderEvent(input: unknown): { forward: boolean } {
    if (this.phase === "closed") return { forward: false };
    const eventType = readEventType(input);
    if (!eventType) return { forward: true };

    if (eventType === "session.updated") {
      const parsed = parseQwenTeachingSessionUpdatedEvent(input);
      if (!parsed || this.seenSessionUpdatedEventIds.has(parsed.eventId)) {
        this.safetyClose("protocol_mismatch");
        return { forward: false };
      }
      rememberBounded(this.seenSessionUpdatedEventIds, parsed.eventId);
      if (this.pendingUpdate) {
        if (!this.matchesPendingSession(parsed)) {
          this.safetyClose("protocol_mismatch");
          return { forward: false };
        }
        const kind = this.pendingUpdate.kind;
        this.clearPendingUpdate();
        void this.finishUpdate(kind, parsed);
        return { forward: false };
      }
      if (this.phase !== "awaiting_base") {
        this.safetyClose("protocol_mismatch");
        return { forward: false };
      }
    }
    if (eventType === "error" && this.hasTeachingWork()) {
      this.safetyClose("provider_failure");
      return { forward: false };
    }
    if (
      this.phase === "idle" &&
      (this.publicState === "unavailable" ||
        this.publicState === "muted" ||
        this.publicState === "completed")
    ) {
      return { forward: true };
    }

    const speechStarted = qwenSpeechStartedEventSchema.safeParse(input);
    if (speechStarted.success) {
      this.userSpeechActive = true;
      this.awaitingResponseAfterSpeech = false;
      this.latestStoppedSpeechItemId = null;
      this.stoppedSpeechTurnOutcomes.delete(speechStarted.data.item_id);
      if (!this.isInputGateOpen()) {
        this.safetyClose("protocol_mismatch");
        return { forward: false };
      }
    }
    const speechStopped = qwenSpeechStoppedEventSchema.safeParse(input);
    if (speechStopped.success) {
      this.userSpeechActive = false;
      const outcome =
        speechStopped.data.reason === "turn_invalid" ? "invalid" : "valid";
      rememberBoundedMap(
        this.stoppedSpeechTurnOutcomes,
        speechStopped.data.item_id,
        outcome,
      );
      this.latestStoppedSpeechItemId = speechStopped.data.item_id;
      this.awaitingResponseAfterSpeech = outcome === "valid";
      if (
        outcome === "valid" &&
        this.publicState === "active" &&
        this.phase === "active" &&
        this.assistantResponsesCompleted === 1 &&
        this.activeResponseId === null
      ) {
        this.ensureResponseTimeout();
      }
    }

    const userTranscript =
      qwenInputTranscriptionCompletedSchema.safeParse(input);
    if (userTranscript.success) {
      const eventId = userTranscript.data.event_id;
      const transcript = (
        userTranscript.data.transcript ??
        userTranscript.data.text ??
        ""
      ).trim();
      if (transcript) {
        const speechItemId =
          readStringField(input, "item_id") ?? this.latestStoppedSpeechItemId;
        const speechOutcome = speechItemId
          ? this.stoppedSpeechTurnOutcomes.get(speechItemId)
          : undefined;
        if (speechItemId) {
          this.stoppedSpeechTurnOutcomes.delete(speechItemId);
          if (this.latestStoppedSpeechItemId === speechItemId) {
            this.latestStoppedSpeechItemId = null;
          }
        }
        const safety = classifyTeachingSafetyTranscript(transcript);
        if (safety) {
          void this.mute(safety, true);
        } else if (eventId && speechOutcome === "valid") {
          void this.recordStableUserTurn(eventId, transcript);
        }
      }
    }

    const responseCreated = qwenResponseCreatedEventSchema.safeParse(input);
    if (responseCreated.success) {
      const responseId = responseCreated.data.response.id;
      const isFirstTeachingResponse =
        this.publicState === "active" &&
        this.assistantResponsesCompleted === 0 &&
        this.awaitingTeachingResponseCreated;
      const isFeedbackTeachingResponse =
        this.publicState === "active" &&
        this.assistantResponsesCompleted === 1 &&
        !this.awaitingTeachingResponseCreated &&
        this.awaitingResponseAfterSpeech;
      if (
        this.activeResponseId !== null ||
        !this.canAcceptResponseCreated() ||
        (this.publicState === "active" &&
          !isFirstTeachingResponse &&
          !isFeedbackTeachingResponse) ||
        (this.publicState === "active" &&
          responseCreated.data.response.modalities !== undefined &&
          !sameModalities(
            responseCreated.data.response.modalities,
            BASE_RESPONSE_MODALITIES,
          ))
      ) {
        this.safetyClose("protocol_mismatch");
        return { forward: false };
      }
      this.activeResponseId = responseId;
      this.awaitingTeachingResponseCreated = false;
      this.awaitingResponseAfterSpeech = false;
      if (isFeedbackTeachingResponse) {
        this.ensureResponseTimeout();
      }
      if (
        this.publicState === "restoring" &&
        this.muteAwaitingResponseCreated
      ) {
        this.muteAwaitingResponseCreated = false;
        this.suppressedResponseId = responseId;
        this.sendResponseCancel();
        this.muteResponseTerminal = false;
        this.startResponseTimeout();
      }
    }

    const responseDone = qwenResponseDoneEventSchema.safeParse(input);
    if (
      responseDone.success &&
      ((this.activeResponseId !== null &&
        this.activeResponseId !== responseDone.data.response.id) ||
        (this.activeResponseId === null &&
          (this.publicState === "active" ||
            (this.publicState === "restoring" &&
              this.muteAwaitingResponseCreated))))
    ) {
      this.safetyClose("protocol_mismatch");
      return { forward: false };
    }
    if (
      responseDone.success &&
      this.activeResponseId === responseDone.data.response.id
    ) {
      const responseId = this.activeResponseId;
      this.activeResponseId = null;
      this.userSpeechActive = false;
      this.awaitingResponseAfterSpeech = false;
      this.clearResponseTimeout();
      const suppressed = this.suppressedResponseId === responseId;
      if (suppressed) {
        this.suppressedResponseId = null;
        this.muteAwaitingResponseCreated = false;
        this.muteResponseTerminal = true;
        void this.maybeRestoreAfterMute();
      } else if (this.publicState === "active") {
        this.assistantResponsesCompleted += 1;
        const maximumResponses =
          this.claimedInvitation?.maximumAssistantResponses;
        if (
          maximumResponses === undefined ||
          this.assistantResponsesCompleted > maximumResponses
        ) {
          this.safetyClose("protocol_mismatch");
          return { forward: false };
        }
        if (this.assistantResponsesCompleted === maximumResponses) {
          void this.beginRestore("completed");
        }
      } else {
        this.onSafeResponseBoundary();
      }
      return { forward: !suppressed };
    }

    if (
      this.suppressedResponseId &&
      responseEventId(input) === this.suppressedResponseId
    ) {
      return { forward: false };
    }
    return { forward: true };
  }

  private requestInvitation(trigger: TeachingTriggerMode): void {
    if (
      this.publicState !== "available" ||
      this.phase !== "idle" ||
      this.claimedInvitation ||
      this.queuedTrigger ||
      this.muteInProgress ||
      this.invitationCount > 0
    ) {
      return;
    }
    if (
      this.activeResponseId ||
      this.userSpeechActive ||
      this.awaitingResponseAfterSpeech
    ) {
      this.queuedTrigger = trigger;
      this.phase = "waiting_safe_boundary";
      return;
    }
    void this.claimAndApply(trigger);
  }

  private onSafeResponseBoundary(): void {
    if (this.phase === "closed" || this.publicState !== "available") return;
    if (this.claimedInvitation) {
      this.beginApplyAtSafeBoundary();
      return;
    }
    const queued = this.queuedTrigger;
    this.queuedTrigger = null;
    this.phase = "idle";
    if (queued) {
      void this.claimAndApply(queued);
      return;
    }
    this.refreshGentleEligibility();
    if (this.gentleCandidateReady) {
      void this.claimAndApply("gentle");
    }
  }

  private async claimAndApply(trigger: TeachingTriggerMode): Promise<void> {
    if (
      this.phase !== "idle" ||
      this.publicState !== "available" ||
      this.invitationCount > 0 ||
      this.muteInProgress ||
      this.pendingClaimEpoch !== null
    ) {
      return;
    }
    if (trigger === "gentle" && !this.isGentleEligible()) return;
    const epoch = ++this.claimEpoch;
    this.pendingClaimEpoch = epoch;
    this.phase = "claiming";
    let claim: QwenTeachingInvitationClaim;
    try {
      claim = await this.options.dependencies.claimInvitation({
        trigger,
        subject: this.options.runtime.subject,
        difficulty: this.options.runtime.difficulty,
        elapsedMs: Math.max(0, this.now() - this.options.runtime.startedAtMs),
        validUserTurns: this.validUserTurns,
      });
    } catch {
      if (this.isClaimCurrent(epoch)) {
        this.pendingClaimEpoch = null;
        return this.safetyClose("provider_failure");
      }
      return;
    }
    const claimIsCurrent = this.isClaimCurrent(epoch);
    if (!claim.claimed) {
      if (!claimIsCurrent) return;
      this.pendingClaimEpoch = null;
      this.phase = "idle";
      if (trigger === "gentle") this.gentleCandidateReady = false;
      return;
    }
    if (!claimIsCurrent) {
      if (this.pendingClaimEpoch === epoch) this.pendingClaimEpoch = null;
      this.invitationCount = Math.max(1, this.invitationCount);
      await this.abortLateClaim(
        claim.content.id,
        this.muteInProgress ? "user_control" : "provider_failure",
      );
      return;
    }
    this.pendingClaimEpoch = null;
    const content = claim.content;
    if (
      !content.id.trim() ||
      content.id.length > 160 ||
      !content.directive.trim() ||
      content.directive.length > 4_000 ||
      content.maximumAssistantResponses !== 2
    ) {
      try {
        await this.persist({ kind: "aborted", reason: "provider_failure" });
      } catch {
        return this.safetyClose("provider_failure");
      }
      if (this.isClosed()) return;
      this.invitationCount = 1;
      this.phase = "idle";
      this.emitState("completed");
      return;
    }
    let compiled: CompiledQwenTeachingInstructions;
    try {
      compiled = compileQwenTeachingDirective({
        baseInstructions: this.baseSession?.instructions ?? "",
        content,
        difficulty: this.options.runtime.difficulty,
        trigger,
      });
    } catch (error) {
      if (error instanceof QwenTeachingDirectiveCompilerError) {
        try {
          await this.persist({
            kind: "aborted",
            reason: "instruction_budget",
          });
        } catch {
          return this.safetyClose("provider_failure");
        }
        if (this.isClosed()) return;
        this.invitationCount = 1;
        this.phase = "idle";
        this.emitState("completed");
        return;
      }
      return this.safetyClose("protocol_mismatch");
    }
    this.invitationCount += 1;
    this.gentleCandidateReady = false;
    this.teachingResponseCreateSent = false;
    this.awaitingTeachingResponseCreated = false;
    this.assistantResponsesCompleted = 0;
    this.claimedInvitation = {
      trigger,
      contentItemId: content.id,
      compiled,
      maximumAssistantResponses: content.maximumAssistantResponses,
    };
    if (this.isClosed()) return;
    if (
      this.activeResponseId ||
      this.userSpeechActive ||
      this.awaitingResponseAfterSpeech
    ) {
      this.phase = "waiting_safe_boundary";
      return;
    }
    this.beginApplyAtSafeBoundary();
  }

  private beginApplyAtSafeBoundary(): void {
    if (
      !this.claimedInvitation ||
      this.activeResponseId ||
      this.userSpeechActive ||
      this.awaitingResponseAfterSpeech ||
      this.pendingGate ||
      this.pendingUpdate
    ) {
      return;
    }
    this.phase = "closing_gate_for_apply";
    this.sendGate(false, () => {
      const invitation = this.claimedInvitation;
      if (!invitation) return this.safetyClose("protocol_mismatch");
      this.sendInternalUpdate("apply", invitation.compiled);
    });
  }

  private async finishUpdate(
    kind: "apply" | "restore",
    _session: QwenTeachingSessionUpdatedAcknowledgement,
  ): Promise<void> {
    if (kind === "apply") {
      this.phase = "opening_gate_for_active";
      this.sendGate(true, () => {
        this.phase = "active";
        this.emitState("active");
        this.sendTeachingResponseCreate();
      });
      return;
    }

    this.phase = "opening_gate_for_final";
    const finalState = this.finalStateAfterRestore;
    try {
      await this.persist({
        kind: "completed",
        contentItemId: this.claimedInvitation?.contentItemId,
      });
    } catch {
      return this.safetyClose("provider_failure");
    }
    this.claimedInvitation = null;
    this.teachingResponseCreateSent = false;
    this.awaitingTeachingResponseCreated = false;
    this.assistantResponsesCompleted = 0;
    this.muteInProgress = false;
    this.mutePersistenceConfirmed = false;
    this.sendGate(true, () => {
      this.phase = "idle";
      this.emitState(finalState);
    });
  }

  private async beginRestore(finalState: "muted" | "completed"): Promise<void> {
    if (
      this.phase === "closed" ||
      this.pendingGate ||
      this.pendingUpdate ||
      !this.baseInstructions
    ) {
      return;
    }
    this.finalStateAfterRestore = finalState;
    this.phase = "closing_gate_for_restore";
    this.emitState("restoring");
    try {
      await this.persist({
        kind: "restoring",
        contentItemId: this.claimedInvitation?.contentItemId,
      });
    } catch {
      return this.safetyClose("provider_failure");
    }
    this.sendGate(false, () => {
      const base = this.baseInstructions;
      if (!base) return this.safetyClose("protocol_mismatch");
      this.sendInternalUpdate("restore", base);
    });
  }

  private async mute(
    reason: "explicit_refusal" | "safety_priority" | "user_control",
    fromStableTranscript: boolean,
  ): Promise<void> {
    if (
      this.phase === "closed" ||
      this.publicState === "muted" ||
      this.publicState === "completed" ||
      this.publicState === "unavailable" ||
      this.muteInProgress
    ) {
      return;
    }
    this.invalidatePendingClaim();
    this.muteInProgress = true;
    this.mutePersistenceConfirmed = false;
    this.queuedTrigger = null;
    this.gentleCandidateReady = false;

    if (this.publicState === "available" && !this.claimedInvitation) {
      this.phase = "idle";
      try {
        await this.persist({ kind: "session_muted", reason });
        this.mutePersistenceConfirmed = true;
      } catch {
        return this.safetyClose("provider_failure");
      }
      if (this.isClosed()) return;
      this.emitState("muted");
      this.sendGate(true, () => undefined);
      return;
    }
    if (this.pendingUpdate || this.phase === "applying") {
      return this.safetyClose("protocol_mismatch");
    }
    if (this.publicState !== "active") {
      return this.safetyClose("protocol_mismatch");
    }
    this.finalStateAfterRestore = "muted";
    this.phase = "closing_gate_for_restore";
    this.emitState("restoring");
    this.muteGateClosed = false;
    this.muteAwaitingResponseCreated =
      this.activeResponseId === null &&
      (fromStableTranscript ||
        this.awaitingTeachingResponseCreated ||
        this.awaitingResponseAfterSpeech);
    this.muteResponseTerminal =
      this.activeResponseId === null && !this.muteAwaitingResponseCreated;
    if (this.activeResponseId) {
      this.suppressedResponseId = this.activeResponseId;
      this.sendResponseCancel();
      this.startResponseTimeout();
    } else if (this.muteAwaitingResponseCreated) {
      this.startResponseTimeout();
    }
    this.sendGate(false, () => {
      this.muteGateClosed = true;
      void this.maybeRestoreAfterMute();
    });
    try {
      await this.persist({ kind: "session_muted", reason });
      this.mutePersistenceConfirmed = true;
    } catch {
      return this.safetyClose("provider_failure");
    }
    void this.maybeRestoreAfterMute();
  }

  private async maybeRestoreAfterMute(): Promise<void> {
    if (
      this.phase !== "closing_gate_for_restore" ||
      !this.muteGateClosed ||
      !this.muteResponseTerminal ||
      !this.mutePersistenceConfirmed ||
      this.pendingUpdate ||
      !this.baseInstructions
    ) {
      return;
    }
    this.phase = "restoring";
    try {
      await this.persist({
        kind: "restoring",
        contentItemId: this.claimedInvitation?.contentItemId,
      });
    } catch {
      return this.safetyClose("provider_failure");
    }
    if (this.isClosed()) return;
    this.sendInternalUpdate("restore", this.baseInstructions);
  }

  private async recordStableUserTurn(
    providerEventId: string,
    transcript: string,
  ): Promise<void> {
    if (this.seenUserTranscriptEventIds.has(providerEventId)) return;
    rememberBounded(this.seenUserTranscriptEventIds, providerEventId);
    if (!looksLikeSemanticUserTurn(transcript)) return;
    let result: Readonly<{ recorded: boolean; validUserTurns: number }>;
    try {
      result = await this.options.dependencies.recordValidUserTurn({
        providerEventId,
        occurredAtMs: this.now(),
      });
    } catch {
      return;
    }
    if (!result.recorded || !Number.isSafeInteger(result.validUserTurns))
      return;
    this.validUserTurns = Math.max(this.validUserTurns, result.validUserTurns);
    this.refreshGentleEligibility();
  }

  private refreshGentleEligibility(): void {
    this.gentleCandidateReady = this.isGentleEligible();
  }

  private isGentleEligible(): boolean {
    return (
      this.publicState === "available" &&
      this.options.runtime.triggerMode === "gentle" &&
      this.options.runtime.eligibleForGentle &&
      this.invitationCount === 0 &&
      this.validUserTurns >= QWEN_TEACHING_MIN_GENTLE_USER_TURNS &&
      this.now() - this.options.runtime.startedAtMs >=
        QWEN_TEACHING_MIN_GENTLE_ELAPSED_MS
    );
  }

  private sendInternalUpdate(
    kind: "apply" | "restore",
    compiled: CompiledQwenTeachingInstructions,
  ): void {
    if (this.pendingUpdate || this.phase === "closed") {
      return this.safetyClose("protocol_mismatch");
    }
    this.phase = kind === "apply" ? "applying" : "restoring";
    const timeout = setTimeout(
      () => this.safetyClose("timeout"),
      this.updateAckTimeoutMs,
    );
    timeout.unref();
    this.pendingUpdate = { kind, compiled, timeout };
    if (
      !this.options.transport.sendUpstreamEvent({
        type: "session.update",
        session: { instructions: compiled.instructions },
      })
    ) {
      this.safetyClose("provider_failure");
    }
  }

  private sendResponseCancel(): void {
    if (
      !this.options.transport.sendUpstreamEvent({ type: "response.cancel" })
    ) {
      this.safetyClose("provider_failure");
    }
  }

  private sendTeachingResponseCreate(): void {
    if (
      this.phase !== "active" ||
      this.publicState !== "active" ||
      !this.claimedInvitation ||
      this.teachingResponseCreateSent ||
      this.awaitingTeachingResponseCreated ||
      this.activeResponseId
    ) {
      return this.safetyClose("protocol_mismatch");
    }
    this.teachingResponseCreateSent = true;
    this.awaitingTeachingResponseCreated = true;
    this.startResponseTimeout();
    if (
      !this.options.transport.sendUpstreamEvent({
        type: "response.create",
        response: { modalities: [...BASE_RESPONSE_MODALITIES] },
      })
    ) {
      this.safetyClose("provider_failure");
    }
  }

  private sendGate(open: boolean, onAcknowledged: () => void): void {
    if (this.pendingGate || this.phase === "closed") {
      return this.safetyClose("protocol_mismatch");
    }
    const revision = ++this.wireRevision;
    const timeout = setTimeout(
      () => this.safetyClose("timeout"),
      this.gateAckTimeoutMs,
    );
    timeout.unref();
    this.pendingGate = { revision, open, timeout, onAcknowledged };
    if (
      !this.sendClientFrame({
        type: "relay.teaching.audio_gate",
        revision,
        open,
      })
    ) {
      this.safetyClose("provider_failure");
    }
  }

  private acknowledgeGate(revision: number): void {
    const pending = this.pendingGate;
    if (!pending || pending.revision !== revision) {
      return this.safetyClose("protocol_mismatch");
    }
    clearTimeout(pending.timeout);
    this.pendingGate = null;
    pending.onAcknowledged();
  }

  private matchesPendingSession(
    session: QwenTeachingSessionUpdatedAcknowledgement,
  ): boolean {
    const pending = this.pendingUpdate;
    const baseline = this.baseSession;
    if (!pending || !baseline) return false;
    return (
      session.id === baseline.id &&
      session.model === baseline.model &&
      sameModalities(session.modalities, baseline.modalities) &&
      session.voice === baseline.voice &&
      optionalAcknowledgementMatches(
        session.inputAudioFormat,
        baseline.inputAudioFormat,
      ) &&
      optionalAcknowledgementMatches(
        session.outputAudioFormat,
        baseline.outputAudioFormat,
      ) &&
      optionalAcknowledgementMatches(
        session.maxHistoryTurns,
        baseline.maxHistoryTurns,
      ) &&
      session.turnDetection === baseline.turnDetection &&
      session.instructions === pending.compiled.instructions &&
      hashQwenTeachingInstructions(session.instructions) ===
        pending.compiled.instructionHash
    );
  }

  private hasTeachingWork(): boolean {
    return Boolean(
      this.claimedInvitation ||
      this.pendingGate ||
      this.pendingUpdate ||
      this.publicState === "active" ||
      this.publicState === "restoring",
    );
  }

  private isClaimCurrent(epoch: number): boolean {
    return (
      this.pendingClaimEpoch === epoch &&
      this.phase === "claiming" &&
      this.publicState === "available" &&
      !this.muteInProgress
    );
  }

  private invalidatePendingClaim(): void {
    this.claimEpoch += 1;
    this.pendingClaimEpoch = null;
  }

  private async abortLateClaim(
    contentItemId: string,
    reason: "user_control" | "provider_failure",
  ): Promise<void> {
    try {
      await this.persist({ kind: "aborted", contentItemId, reason });
    } catch {
      if (!this.isClosed()) this.safetyClose("provider_failure");
    }
  }

  private isClosed(): boolean {
    return this.phase === "closed";
  }

  private canAcceptResponseCreated(): boolean {
    if (this.publicState === "available") {
      return (
        this.phase === "idle" ||
        this.phase === "claiming" ||
        this.phase === "waiting_safe_boundary"
      );
    }
    if (this.publicState === "active") return this.phase === "active";
    return (
      this.publicState === "restoring" &&
      this.phase === "closing_gate_for_restore" &&
      this.muteAwaitingResponseCreated
    );
  }

  private emitState(
    state:
      | "unavailable"
      | "available"
      | "active"
      | "restoring"
      | "muted"
      | "completed",
  ): void {
    this.publicState = state;
    const revision = ++this.wireRevision;
    const frame = stateFrame(state, revision);
    if (!this.sendClientFrame(frame)) {
      this.safetyClose("provider_failure");
    }
  }

  private sendClientFrame(frame: RealtimeTeachingServerControlFrame): boolean {
    const parsed = realtimeTeachingServerControlFrameSchema.safeParse(frame);
    return (
      parsed.success && this.options.transport.sendClientFrame(parsed.data)
    );
  }

  private persist(
    input: Omit<QwenTeachingPersistenceEvent, "atMs">,
  ): Promise<void> {
    const event = Object.freeze({
      ...input,
      atMs: this.now(),
    });
    const operation = this.persistenceTail.then(() =>
      this.options.dependencies.persistState(event),
    );
    this.persistenceTail = operation.catch(() => undefined);
    return operation;
  }

  private startResponseTimeout(): void {
    this.clearResponseTimeout();
    const timeout = setTimeout(
      () => this.safetyClose("timeout"),
      this.responseDoneTimeoutMs,
    );
    timeout.unref();
    this.responseDoneTimeout = timeout;
  }

  private ensureResponseTimeout(): void {
    if (!this.responseDoneTimeout) this.startResponseTimeout();
  }

  private clearResponseTimeout(): void {
    if (this.responseDoneTimeout) clearTimeout(this.responseDoneTimeout);
    this.responseDoneTimeout = null;
  }

  private clearPendingGate(): void {
    if (this.pendingGate) clearTimeout(this.pendingGate.timeout);
    this.pendingGate = null;
  }

  private clearPendingUpdate(): void {
    if (this.pendingUpdate) clearTimeout(this.pendingUpdate.timeout);
    this.pendingUpdate = null;
  }

  private safetyClose(
    reason: "provider_failure" | "timeout" | "protocol_mismatch",
  ): void {
    if (this.phase === "closed") return;
    this.invalidatePendingClaim();
    this.phase = "closed";
    this.clearPendingGate();
    this.clearPendingUpdate();
    this.clearResponseTimeout();
    this.options.transport.safetyClose(reason);
  }
}

export function parseQwenTeachingSessionUpdatedEvent(
  input: unknown,
): QwenTeachingSessionUpdatedAcknowledgement | null {
  const parsed = sessionUpdatedEventSchema.safeParse(input);
  if (!parsed.success) return null;
  return Object.freeze({
    eventId: parsed.data.event_id,
    id: parsed.data.session.id,
    model: parsed.data.session.model,
    modalities: parsed.data.session.modalities,
    voice: parsed.data.session.voice,
    ...(parsed.data.session.input_audio_format === undefined
      ? {}
      : { inputAudioFormat: parsed.data.session.input_audio_format }),
    ...(parsed.data.session.output_audio_format === undefined
      ? {}
      : { outputAudioFormat: parsed.data.session.output_audio_format }),
    ...(parsed.data.session.instructions === undefined
      ? {}
      : { instructions: parsed.data.session.instructions }),
    ...(parsed.data.session.max_history_turns === undefined
      ? {}
      : { maxHistoryTurns: parsed.data.session.max_history_turns }),
    turnDetection: parsed.data.session.turn_detection.type,
  });
}

export function matchesQwenTeachingBaseSession(
  session: QwenTeachingSessionUpdatedAcknowledgement,
  expected: Readonly<{
    model: string;
    modalities: readonly string[];
    voice: string;
    inputAudioFormat: string;
    outputAudioFormat: string;
    instructions: string;
    maxHistoryTurns: number;
    turnDetection: string;
  }>,
): boolean {
  return (
    session.model === expected.model &&
    sameModalities(session.modalities, expected.modalities) &&
    session.voice === expected.voice &&
    optionalAcknowledgementMatches(
      session.inputAudioFormat,
      expected.inputAudioFormat,
    ) &&
    optionalAcknowledgementMatches(
      session.outputAudioFormat,
      expected.outputAudioFormat,
    ) &&
    (session.instructions === undefined ||
      (session.instructions === expected.instructions &&
        hashQwenTeachingInstructions(session.instructions) ===
          hashQwenTeachingInstructions(expected.instructions))) &&
    optionalAcknowledgementMatches(
      session.maxHistoryTurns,
      expected.maxHistoryTurns,
    ) &&
    session.turnDetection === expected.turnDetection
  );
}

export function completeQwenTeachingBaseSession(
  session: QwenTeachingSessionUpdatedAcknowledgement,
  expected: Readonly<{
    inputAudioFormat: "pcm";
    outputAudioFormat: "pcm";
    instructions: string;
    maxHistoryTurns: number;
  }>,
): QwenTeachingSessionSnapshot {
  return Object.freeze({
    id: session.id,
    model: session.model,
    modalities: session.modalities,
    voice: session.voice,
    inputAudioFormat: session.inputAudioFormat ?? expected.inputAudioFormat,
    outputAudioFormat: session.outputAudioFormat ?? expected.outputAudioFormat,
    instructions: session.instructions ?? expected.instructions,
    maxHistoryTurns: session.maxHistoryTurns ?? expected.maxHistoryTurns,
    turnDetection: session.turnDetection,
  });
}

export function classifyTeachingSafetyTranscript(
  transcript: string,
): "explicit_refusal" | "safety_priority" | null {
  const text = transcript.trim();
  if (!text) return null;
  if (
    ["只聊天", "不要出题", "不想学", "跳过", "先不学"].some((phrase) =>
      text.includes(phrase),
    ) ||
    /不要.{0,4}出题/u.test(text)
  ) {
    return "explicit_refusal";
  }
  if (
    [
      "难过",
      "害怕",
      "救命",
      "受伤",
      "欺负",
      "家里吵架",
      "不安全",
      "有人打我",
      "需要帮助",
    ].some((phrase) => text.includes(phrase))
  ) {
    return "safety_priority";
  }
  return null;
}

function looksLikeSemanticUserTurn(transcript: string): boolean {
  const compact = transcript.replace(/[\s，。！？,.!?~～…]+/gu, "");
  if (compact.length < 2) return false;
  if (
    [
      "嗯嗯",
      "哦哦",
      "啊啊",
      "哈哈",
      "好的",
      "好呀",
      "好吧",
      "可以",
      "行吧",
      "对的",
      "是的",
      "知道了",
      "收到",
    ].includes(compact)
  ) {
    return false;
  }
  return ![
    "只聊天",
    "不要出题",
    "不想学",
    "跳过",
    "先不学",
    "现在来一个",
    "来一个",
    "来一道题",
    "出个题",
    "开始学习",
    "继续学习",
  ].some((phrase) => compact.includes(phrase));
}

function stateFrame(
  state:
    | "unavailable"
    | "available"
    | "active"
    | "restoring"
    | "muted"
    | "completed",
  revision: number,
): RealtimeTeachingServerControlFrame {
  switch (state) {
    case "available":
      return {
        type: "relay.teaching.state",
        revision,
        state,
        canRequest: true,
        canMute: true,
      };
    case "active":
      return {
        type: "relay.teaching.state",
        revision,
        state,
        canRequest: false,
        canMute: true,
      };
    default:
      return {
        type: "relay.teaching.state",
        revision,
        state,
        canRequest: false,
        canMute: false,
      };
  }
}

function readEventType(input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const value = Reflect.get(input, "type");
  return typeof value === "string" ? value : null;
}

function readStringField(input: unknown, field: string): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const value = Reflect.get(input, field);
  return typeof value === "string" ? value : null;
}

function responseEventId(input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const direct = Reflect.get(input, "response_id");
  if (typeof direct === "string") return direct;
  const response = Reflect.get(input, "response");
  if (typeof response !== "object" || response === null) return null;
  const nested = Reflect.get(response, "id");
  return typeof nested === "string" ? nested : null;
}

function sameModalities(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === 2 &&
    right.length === 2 &&
    left.includes("audio") &&
    left.includes("text") &&
    right.includes("audio") &&
    right.includes("text")
  );
}

function optionalAcknowledgementMatches<T>(
  acknowledged: T | undefined,
  expected: T,
): boolean {
  return acknowledged === undefined || acknowledged === expected;
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? (value as number)
    : fallback;
}

function rememberBounded(set: Set<string>, value: string): void {
  set.add(value);
  if (set.size <= MAX_SEEN_EVENT_IDS) return;
  const oldest = set.values().next().value;
  if (oldest) set.delete(oldest);
}

function rememberBoundedMap<T>(
  map: Map<string, T>,
  key: string,
  value: T,
): void {
  map.set(key, value);
  if (map.size <= MAX_SEEN_EVENT_IDS) return;
  const oldest = map.keys().next().value;
  if (oldest) map.delete(oldest);
}
