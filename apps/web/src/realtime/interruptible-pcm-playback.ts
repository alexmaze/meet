export type TaggedPcmChunk = {
  generation: number;
  responseId: string;
  samples: Int16Array;
};

export type GenerationPcmSink = {
  reset(generation: number): void;
  enqueue(chunk: TaggedPcmChunk): boolean;
};

export type ResponseAdmission = {
  accepted: boolean;
  shouldCancel: boolean;
};

export type ResponseEnqueueResult = ResponseAdmission & {
  enqueued: boolean;
};

type InterruptionPhase = "open" | "speech_pending" | "manual_pending";

const RESPONSE_ID_HISTORY_LIMIT = 64;

/**
 * Owns the response/generation boundary in front of the physical audio sink.
 * A provider response first observed before the matching user-audio commit is
 * conservatively classified as old. This covers the race where speech_started
 * or manual stop arrives before that old response's response.created event.
 */
export class InterruptiblePcmPlayback {
  private generation = 0;
  private activeResponseId: string | null = null;
  private lastResponseId: string | null = null;
  private phase: InterruptionPhase = "open";
  private interruptedResponseId: string | null = null;
  private readonly responsesSeenBeforeCommit = new Set<string>();
  private readonly manualPendingResponseIds = new Set<string>();
  private readonly cancellationRequestedIds = new Set<string>();
  private readonly blockedResponseIds = new Set<string>();
  private readonly closedResponseIds = new Set<string>();
  private readonly clearedResponseIds = new Set<string>();

  constructor(private readonly sink: GenerationPcmSink) {}

  get currentGeneration(): number {
    return this.generation;
  }

  get currentResponseId(): string | null {
    return this.activeResponseId;
  }

  beginResponse(responseId: string): ResponseAdmission {
    if (this.phase === "speech_pending") {
      this.classifyPreCommitResponse(responseId);
      return { accepted: false, shouldCancel: false };
    }

    if (this.phase === "manual_pending") {
      this.remember(this.blockedResponseIds, responseId);
      this.remember(this.manualPendingResponseIds, responseId);
      const shouldCancel = !this.cancellationRequestedIds.has(responseId);
      if (shouldCancel) {
        this.remember(this.cancellationRequestedIds, responseId);
      }
      return { accepted: false, shouldCancel };
    }

    if (!this.canAccept(responseId)) {
      return { accepted: false, shouldCancel: false };
    }

    this.activeResponseId = responseId;
    this.lastResponseId = responseId;
    return { accepted: true, shouldCancel: false };
  }

  enqueue(responseId: string, samples: Int16Array): ResponseEnqueueResult {
    const admission = this.beginResponse(responseId);
    if (samples.length === 0 || !admission.accepted) {
      return { ...admission, enqueued: false };
    }

    return {
      ...admission,
      enqueued: this.sink.enqueue({
        generation: this.generation,
        responseId,
        samples,
      }),
    };
  }

  speechStarted(): void {
    const interruptedResponseId =
      this.activeResponseId ?? this.findPlayableLastResponse();
    this.phase = "speech_pending";
    this.interruptedResponseId = null;
    this.responsesSeenBeforeCommit.clear();
    this.manualPendingResponseIds.clear();
    this.cancellationRequestedIds.clear();

    if (interruptedResponseId) {
      this.interruptedResponseId = interruptedResponseId;
      this.remember(this.responsesSeenBeforeCommit, interruptedResponseId);
      this.remember(this.blockedResponseIds, interruptedResponseId);
    }
    this.activeResponseId = null;
    this.clearSink(interruptedResponseId);
  }

  /** A valid speech_stopped is not yet a response boundary. Qwen's matching
   * input_audio_buffer.committed event establishes that boundary. */
  confirmSpeechInterruption(): void {
    if (this.phase !== "speech_pending") {
      return;
    }
    this.activeResponseId = null;
  }

  commitSpeechTurn(): void {
    if (this.phase !== "speech_pending") {
      return;
    }
    this.phase = "open";
    this.interruptedResponseId = null;
    this.responsesSeenBeforeCommit.clear();
    this.activeResponseId = null;
  }

  resumeAfterInvalidTurn(): string | null {
    if (this.phase !== "speech_pending") {
      return null;
    }
    this.phase = "open";
    const responseId = this.interruptedResponseId;
    this.interruptedResponseId = null;

    // Any different response observed before turn_invalid remains blocked. Only
    // the interrupted response can resume, and only with deltas after this event.
    if (responseId && !this.closedResponseIds.has(responseId)) {
      this.blockedResponseIds.delete(responseId);
      this.activeResponseId = responseId;
      this.lastResponseId = responseId;
    }
    this.responsesSeenBeforeCommit.clear();
    return this.activeResponseId;
  }

  /**
   * `expectPendingResponse` arms a barrier for a response that is still thinking
   * and therefore has no response.created id yet. Its first id is blocked and
   * returned with shouldCancel=true from beginResponse/enqueue.
   */
  manualInterrupt(expectPendingResponse = false): string | null {
    const interruptedResponseId =
      this.activeResponseId ?? this.findPlayableLastResponse();
    const hasLiveKnownResponse =
      interruptedResponseId !== null &&
      !this.closedResponseIds.has(interruptedResponseId);

    this.phase =
      hasLiveKnownResponse || expectPendingResponse ? "manual_pending" : "open";
    this.interruptedResponseId = null;
    this.responsesSeenBeforeCommit.clear();
    this.manualPendingResponseIds.clear();
    this.cancellationRequestedIds.clear();

    if (hasLiveKnownResponse && interruptedResponseId) {
      this.remember(this.blockedResponseIds, interruptedResponseId);
      this.remember(this.manualPendingResponseIds, interruptedResponseId);
      this.remember(this.cancellationRequestedIds, interruptedResponseId);
    }
    this.activeResponseId = null;
    this.clearSink(interruptedResponseId);
    return hasLiveKnownResponse ? interruptedResponseId : null;
  }

  responseDone(
    responseId: string,
    cancelled: boolean,
    cancellationReason?: string,
  ): void {
    const wasAlreadyCleared = this.clearedResponseIds.has(responseId);
    this.remember(this.closedResponseIds, responseId);
    if (cancelled) {
      this.remember(this.blockedResponseIds, responseId);
      if (this.activeResponseId === responseId && !wasAlreadyCleared) {
        this.clearSink(responseId);
      }
    }
    if (this.activeResponseId === responseId) {
      this.activeResponseId = null;
    }

    if (this.phase === "manual_pending") {
      const belongedToManualStop =
        this.manualPendingResponseIds.delete(responseId);
      if (belongedToManualStop) {
        this.cancellationRequestedIds.delete(responseId);
      }
      // A done event is an ordered WebSocket boundary: later response ids can no
      // longer belong to the manually stopped response.
      if (belongedToManualStop && this.manualPendingResponseIds.size === 0) {
        this.phase = "open";
      }
    }

    if (
      this.phase === "speech_pending" &&
      responseId === this.interruptedResponseId &&
      cancelled &&
      cancellationReason === "turn_detected"
    ) {
      // Keep waiting for input_audio_buffer.committed. The done event confirms
      // which id was old, but responses created before commit are still blocked.
      this.interruptedResponseId = null;
    }
  }

  reset(): void {
    this.generation += 1;
    this.sink.reset(this.generation);
    this.activeResponseId = null;
    this.lastResponseId = null;
    this.phase = "open";
    this.interruptedResponseId = null;
    this.responsesSeenBeforeCommit.clear();
    this.manualPendingResponseIds.clear();
    this.cancellationRequestedIds.clear();
    this.blockedResponseIds.clear();
    this.closedResponseIds.clear();
    this.clearedResponseIds.clear();
  }

  private classifyPreCommitResponse(responseId: string): void {
    if (!this.interruptedResponseId) {
      this.interruptedResponseId = responseId;
    }
    this.remember(this.responsesSeenBeforeCommit, responseId);
    this.remember(this.blockedResponseIds, responseId);
  }

  private canAccept(responseId: string): boolean {
    return (
      !this.blockedResponseIds.has(responseId) &&
      !this.closedResponseIds.has(responseId)
    );
  }

  private findPlayableLastResponse(): string | null {
    const responseId = this.lastResponseId;
    return responseId && !this.blockedResponseIds.has(responseId)
      ? responseId
      : null;
  }

  private clearSink(responseId: string | null): void {
    this.generation += 1;
    if (responseId) {
      this.remember(this.clearedResponseIds, responseId);
    }
    this.sink.reset(this.generation);
  }

  private remember(collection: Set<string>, responseId: string): void {
    collection.add(responseId);
    if (collection.size > RESPONSE_ID_HISTORY_LIMIT) {
      const oldest = collection.values().next().value;
      if (oldest) {
        collection.delete(oldest);
      }
    }
  }
}
