import type {
  RealtimeRenewalClientFrame,
  RealtimeRenewalServerFrame,
} from "@meet/protocol";

export const REALTIME_RENEWAL_WARNING_MS = 28 * 60 * 1_000;
export const REALTIME_RENEWAL_MAX_SESSION_MS = 30 * 60 * 1_000;
export const REALTIME_RENEWAL_CONTEXT_USER_TURNS = 20;
export const REALTIME_RENEWAL_QUIET_MS = 750;
export const REALTIME_RENEWAL_LEASE_MS = 10_000;
const MAX_SEEN_IDS = 256;
const UNIDENTIFIED_SPEECH = "__unidentified_speech";
const UNIDENTIFIED_RESPONSE = "__unidentified_response";

type RenewalOptions = {
  provider: "qwen" | "doubao";
  sendClientFrame: (frame: RealtimeRenewalServerFrame) => void;
  /** Includes transport readiness and any in-flight teaching operation. */
  isSafeToRenew: () => boolean;
  now?: () => number;
};

/**
 * A bounded agreement to replace an idle transport, never a reason to discard
 * input or interrupt a provider response. The browser separately verifies its
 * physical playback queue and persists all completed messages before detaching.
 */
export class RealtimeRenewalController {
  private readonly now: () => number;
  private readonly deadline: number;
  private closed = false;
  private sessionReady = false;
  private dueReason: "connection_age" | "context_refresh" | null = null;
  private ageWarningSent = false;
  private userTurns = 0;
  private speechEpoch = 0;
  private committedSpeechEpoch = 0;
  private responseStartedEpoch = -1;
  private awaitingResponseEpoch: number | null = null;
  private speechEpochs = new Map<string, number>();
  private responseEpochs = new Map<string, number>();
  private responseHadAudio = new Set<string>();
  private responseAudioDone = new Set<string>();
  private responseDone = new Set<string>();
  private activeSpeech = new Set<string>();
  private pendingTranscripts = new Set<string>();
  private invalidSpeech = new Set<string>();
  private validSpeech = new Set<string>();
  private completedSpeechCandidates = new Map<string, string>();
  private activeResponses = new Set<string>();
  private seenProviderEventIds = new Set<string>();
  private seenTranscriptIds = new Set<string>();
  private settledRequests = new Set<string>();
  private pendingRequest: string | null = null;
  private ageTimer: NodeJS.Timeout | null = null;
  private quietTimer: NodeJS.Timeout | null = null;
  private leaseTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: RenewalOptions) {
    this.now = options.now ?? Date.now;
    this.deadline = this.now() + REALTIME_RENEWAL_MAX_SESSION_MS;
    this.ageTimer = setTimeout(() => {
      this.ageTimer = null;
      this.dueReason = "connection_age";
      if (this.sessionReady) this.sendDue();
    }, REALTIME_RENEWAL_WARNING_MS);
    this.ageTimer.unref();
  }

  markSessionReady(): void {
    if (this.closed || this.sessionReady) return;
    this.sessionReady = true;
    if (this.dueReason) this.sendDue();
  }

  get remainingMs(): number {
    return Math.max(0, Math.floor(this.deadline - this.now()));
  }

  handleClientFrame(frame: RealtimeRenewalClientFrame): void {
    if (this.closed) return;
    if (frame.type === "relay.renewal_cancel") {
      if (this.pendingRequest === frame.event_id) this.deferPending();
      else remember(this.settledRequests, frame.event_id);
      return;
    }
    // Replays cannot create a second lease or re-arm an expired request.
    if (this.settledRequests.has(frame.event_id)) {
      this.sendDeferred(frame.event_id);
      return;
    }
    if (this.pendingRequest === frame.event_id) return;
    this.deferPending();
    if (!this.dueReason || !this.isSafe()) {
      remember(this.settledRequests, frame.event_id);
      this.sendDeferred(frame.event_id);
      return;
    }
    this.pendingRequest = frame.event_id;
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      if (!this.isSafe()) return this.deferPending();
      if (this.pendingRequest !== frame.event_id) return;
      this.leaseTimer = setTimeout(
        () => this.deferPending(),
        REALTIME_RENEWAL_LEASE_MS,
      );
      this.leaseTimer.unref();
      this.options.sendClientFrame({
        type: "relay.renewal_ready",
        event_id: frame.event_id,
      });
    }, REALTIME_RENEWAL_QUIET_MS);
    this.quietTimer.unref();
  }

  /** Call before forwarding any ordinary browser or teaching control event. */
  observeClientEvent(event: unknown): void {
    if (this.closed) return;
    this.deferPending();
    const type = readString(event, "type");
    if (
      type === "response.create" ||
      type === "speech_text_buffer.commit" ||
      type === "input_audio_buffer.commit"
    ) {
      this.awaitingResponseEpoch = this.speechEpoch;
    }
  }

  /** Observe before teaching can consume an event; never filters provider data. */
  observeProviderEvent(event: unknown): void {
    if (this.closed) return;
    const type = readString(event, "type");
    if (!type) {
      this.deferPending();
      return;
    }
    const eventId = readString(event, "event_id");
    if (eventId && this.seenProviderEventIds.has(eventId)) return;
    if (eventId) remember(this.seenProviderEventIds, eventId);
    this.deferPending();
    const itemId = readString(event, "item_id") ?? UNIDENTIFIED_SPEECH;
    const isSpeechStart =
      type === "input_audio_buffer.speech_started" ||
      type === "conversation.item.input_audio_transcription.started";
    if (isSpeechStart) {
      this.speechEpoch += 1;
      rememberEpoch(this.speechEpochs, itemId, this.speechEpoch);
      this.activeSpeech.add(itemId);
      this.pendingTranscripts.add(itemId);
      this.invalidSpeech.delete(itemId);
      this.validSpeech.delete(itemId);
      this.completedSpeechCandidates.delete(itemId);
    }
    if (type === "input_audio_buffer.speech_stopped") {
      this.activeSpeech.delete(itemId);
      if (readString(event, "reason") === "turn_invalid") {
        this.pendingTranscripts.delete(itemId);
        remember(this.invalidSpeech, itemId);
        this.validSpeech.delete(itemId);
        this.completedSpeechCandidates.delete(itemId);
      } else {
        remember(this.validSpeech, itemId);
        const candidate = this.completedSpeechCandidates.get(itemId);
        if (candidate) {
          this.completedSpeechCandidates.delete(itemId);
          this.countUserTurn(candidate);
        }
        const epoch = this.speechEpochs.get(itemId) ?? this.speechEpoch;
        if (this.responseStartedEpoch < epoch)
          this.awaitingResponseEpoch = epoch;
      }
    }
    if (type === "input_audio_buffer.committed") {
      this.committedSpeechEpoch = Math.max(
        this.committedSpeechEpoch,
        this.speechEpochs.get(itemId) ?? this.speechEpoch,
      );
    }
    if (type === "conversation.item.input_audio_transcription.delta") {
      const deltaItemId =
        itemId === UNIDENTIFIED_SPEECH && this.pendingTranscripts.size === 1
          ? (this.pendingTranscripts.values().next().value as string)
          : itemId === UNIDENTIFIED_SPEECH && this.activeSpeech.size === 1
            ? (this.activeSpeech.values().next().value as string)
            : itemId;
      this.pendingTranscripts.add(deltaItemId);
    }
    if (
      type === "conversation.item.input_audio_transcription.completed" ||
      type === "conversation.item.input_audio_transcription.failed"
    ) {
      // Doubao may omit item_id throughout; Qwen normally identifies the item.
      // A missing final id may resolve exactly one outstanding item, never many.
      const resolvedId =
        itemId === UNIDENTIFIED_SPEECH && this.pendingTranscripts.size === 1
          ? (this.pendingTranscripts.values().next().value as string)
          : itemId;
      const invalid = this.invalidSpeech.has(resolvedId);
      this.pendingTranscripts.delete(resolvedId);
      if (this.options.provider === "doubao") {
        this.activeSpeech.delete(resolvedId);
        const epoch = this.speechEpochs.get(resolvedId) ?? this.speechEpoch;
        if (
          type.endsWith(".completed") &&
          !invalid &&
          this.responseStartedEpoch < epoch
        ) {
          this.awaitingResponseEpoch = epoch;
        }
      }
      const text = (
        readString(event, "transcript") ??
        readString(event, "text") ??
        ""
      ).trim();
      const transcriptId = readString(event, "item_id") ?? eventId;
      if (type.endsWith(".completed") && !invalid && text && transcriptId) {
        if (
          this.options.provider === "doubao" ||
          this.validSpeech.has(resolvedId)
        ) {
          this.countUserTurn(transcriptId);
        } else {
          this.completedSpeechCandidates.set(resolvedId, transcriptId);
          if (this.completedSpeechCandidates.size > MAX_SEEN_IDS) {
            const oldest = this.completedSpeechCandidates.keys().next().value;
            if (oldest !== undefined)
              this.completedSpeechCandidates.delete(oldest);
          }
        }
      }
    }
    const response = readRecord(event, "response");
    const responseId =
      readString(event, "response_id") ?? readString(response, "id");
    const responseTerminal =
      type === "response.done" ||
      type === "response.canceled" ||
      type === "response.output_audio.done";
    if (responseTerminal) {
      // Terminal events never clear the next utterance's awaiting-response
      // barrier. Only an admitted response start can satisfy that barrier.
      const terminalId =
        responseId ??
        (this.activeResponses.size === 1
          ? this.activeResponses.values().next().value
          : undefined);
      if (terminalId) {
        if (
          this.options.provider === "doubao" &&
          type !== "response.canceled"
        ) {
          remember(
            type === "response.output_audio.done"
              ? this.responseAudioDone
              : this.responseDone,
            terminalId,
          );
          if (
            this.responseDone.has(terminalId) &&
            (!this.responseHadAudio.has(terminalId) ||
              this.responseAudioDone.has(terminalId))
          ) {
            this.activeResponses.delete(terminalId);
          }
        } else {
          this.activeResponses.delete(terminalId);
        }
      }
    } else if (
      type === "response.created" ||
      type === "response.output_audio.started" ||
      type === "response.audio.delta" ||
      type === "response.output_audio.delta" ||
      type === "response.output_text.delta"
    ) {
      const currentId =
        responseId ??
        (this.activeResponses.size === 1
          ? (this.activeResponses.values().next().value as string)
          : UNIDENTIFIED_RESPONSE);
      if (responseId && this.activeResponses.delete(UNIDENTIFIED_RESPONSE)) {
        rememberEpoch(
          this.responseEpochs,
          responseId,
          this.responseEpochs.get(UNIDENTIFIED_RESPONSE) ?? this.speechEpoch,
        );
        if (this.responseHadAudio.delete(UNIDENTIFIED_RESPONSE))
          remember(this.responseHadAudio, responseId);
        if (this.responseAudioDone.delete(UNIDENTIFIED_RESPONSE))
          remember(this.responseAudioDone, responseId);
        if (this.responseDone.delete(UNIDENTIFIED_RESPONSE))
          remember(this.responseDone, responseId);
      }
      if (
        currentId === UNIDENTIFIED_RESPONSE &&
        !this.activeResponses.has(currentId)
      ) {
        this.responseEpochs.delete(currentId);
        this.responseHadAudio.delete(currentId);
        this.responseAudioDone.delete(currentId);
        this.responseDone.delete(currentId);
      }
      if (!this.responseEpochs.has(currentId)) {
        rememberEpoch(
          this.responseEpochs,
          currentId,
          this.options.provider === "qwen"
            ? this.committedSpeechEpoch
            : this.speechEpoch,
        );
      }
      const epoch = this.responseEpochs.get(currentId) ?? -1;
      this.responseStartedEpoch = Math.max(this.responseStartedEpoch, epoch);
      this.activeResponses.add(currentId);
      if (
        type === "response.output_audio.started" ||
        type === "response.output_audio.delta"
      ) {
        remember(this.responseHadAudio, currentId);
      }
      if (
        this.awaitingResponseEpoch !== null &&
        epoch >= this.awaitingResponseEpoch
      ) {
        this.awaitingResponseEpoch = null;
      }
    }
  }

  dispose(): void {
    this.closed = true;
    if (this.ageTimer) clearTimeout(this.ageTimer);
    this.ageTimer = null;
    this.clearRequest();
  }

  private isSafe(): boolean {
    return (
      !this.closed &&
      this.sessionReady &&
      this.now() < this.deadline &&
      this.activeSpeech.size === 0 &&
      this.pendingTranscripts.size === 0 &&
      this.activeResponses.size === 0 &&
      this.awaitingResponseEpoch === null &&
      this.options.isSafeToRenew()
    );
  }

  private countUserTurn(id: string): void {
    if (this.seenTranscriptIds.has(id)) return;
    remember(this.seenTranscriptIds, id);
    this.userTurns += 1;
    if (
      this.userTurns >= REALTIME_RENEWAL_CONTEXT_USER_TURNS &&
      !this.dueReason
    ) {
      this.dueReason = "context_refresh";
      if (this.sessionReady) this.sendDue();
    }
  }

  private sendDue(): void {
    if (this.closed || !this.dueReason) return;
    if (this.dueReason === "connection_age") {
      if (this.ageWarningSent) return;
      this.ageWarningSent = true;
    }
    this.options.sendClientFrame({
      type: "relay.renewal_due",
      reason: this.dueReason,
      remainingMs: this.remainingMs,
    });
  }

  private deferPending(): void {
    const request = this.pendingRequest;
    this.clearRequest();
    if (request) {
      remember(this.settledRequests, request);
      this.sendDeferred(request);
    }
  }

  private sendDeferred(event_id: string): void {
    this.options.sendClientFrame({ type: "relay.renewal_deferred", event_id });
  }

  private clearRequest(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.quietTimer = null;
    this.leaseTimer = null;
    this.pendingRequest = null;
  }
}

function remember(set: Set<string>, id: string): void {
  set.add(id);
  if (set.size > MAX_SEEN_IDS) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
}

function rememberEpoch(
  map: Map<string, number>,
  id: string,
  epoch: number,
): void {
  map.set(id, epoch);
  if (map.size > MAX_SEEN_IDS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function readRecord(value: unknown, key: string): unknown {
  return value && typeof value === "object"
    ? Reflect.get(value, key)
    : undefined;
}

function readString(value: unknown, key: string): string | null {
  const field = readRecord(value, key);
  return typeof field === "string" && field.length > 0 ? field : null;
}
