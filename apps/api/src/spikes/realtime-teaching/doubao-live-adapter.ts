import {
  doubaoErrorEventSchema,
  doubaoEventSchema,
  doubaoInputAudioCommittedEventSchema,
  doubaoOutputAudioDeltaEventSchema,
  doubaoOutputAudioDoneEventSchema,
  doubaoOutputAudioStartedEventSchema,
  doubaoOutputTextDeltaEventSchema,
  doubaoOutputTextDoneEventSchema,
  doubaoResponseCanceledEventSchema,
  doubaoResponseDoneEventSchema,
  doubaoSessionClosedEventSchema,
  doubaoSessionCreatedEventSchema,
  doubaoSessionUpdatedEventSchema,
  doubaoUserTranscriptionCompletedEventSchema,
  doubaoUserTranscriptionDeltaEventSchema,
  doubaoUserTranscriptionFailedEventSchema,
  doubaoUserTranscriptionStartedEventSchema,
  type DoubaoEvent,
  type DoubaoRealtimeModel,
} from "@meet/protocol";
import { createHash, randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";

import type { AppConfig } from "../../config.js";
import {
  DOUBAO_REALTIME_WEBSOCKET_URL,
  DOUBAO_RELAY_UPSTREAM_MAX_MESSAGE_BYTES,
  buildDoubaoSessionCreateEvent,
  type DoubaoWebSocketFactory,
} from "../../doubao-websocket.js";
import {
  TEACHING_SPIKE_FIXTURES,
  TEACHING_SPIKE_FIXTURE_HASH,
  TEACHING_SPIKE_FIXTURE_REVISION,
  compileTeachingInstructions,
} from "./fixtures.js";
import {
  buildDoubaoInstructionsUpdateEvent,
  type DoubaoInstructionsUpdateEvent,
} from "./provider-events.js";

export const DOUBAO_PROTOCOL_SMOKE_PCM_CHUNK_BYTES = 640;
export const DOUBAO_PROTOCOL_SMOKE_MAX_INPUT_BYTES = 160_000;
export const DOUBAO_PROTOCOL_SMOKE_MAX_OUTPUT_BYTES = 720_000;
export const DOUBAO_PROTOCOL_SMOKE_MAX_RESPONSE_MS = 15_000;
export const DOUBAO_PROTOCOL_SMOKE_MAX_PROVIDER_EVENTS = 4_096;
export const DOUBAO_PROTOCOL_SMOKE_MAX_PROVIDER_BYTES = 4 * 1024 * 1024;
export const DOUBAO_PROTOCOL_SMOKE_MAX_EVENT_QUEUE_DEPTH = 1_024;

const MAX_INSTRUCTIONS_CHARACTERS = 12_000;
const MAX_OUTPUT_TEXT_CHARACTERS = 32_000;
const MAX_SOCKET_BUFFERED_BYTES = 1024 * 1024;
const MAX_IGNORED_EVENTS_PER_WAIT = 100;
const MAX_PROVIDER_EVENT_ID_CHARACTERS = 160;
const MAX_PROVIDER_EVENT_TYPE_CHARACTERS = 160;
const MAX_PROVIDER_ENTITY_ID_CHARACTERS = 256;
const FORCE_CLOSE_GRACE_MS = 250;

export const DOUBAO_PROTOCOL_SMOKE_SCOPE = Object.freeze({
  transport: "isolated_provider_websocket" as const,
  relayExercised: false as const,
  browserExercised: false as const,
});

export type DoubaoProtocolSmokeTransportState =
  "idle" | "connecting" | "open" | "closing" | "closed" | "failed";

export type DoubaoProtocolSmokeSessionState =
  | "not_created"
  | "creating"
  | "base_active"
  | "update_pending"
  | "directive_active"
  | "restore_required"
  | "restore_pending"
  | "outcome_unknown"
  | "failed"
  | "closing"
  | "closed";

export type DoubaoProtocolSmokeTurnState =
  | "idle"
  | "sending_input"
  | "commit_pending"
  | "awaiting_response"
  | "response_active"
  | "response_terminal"
  | "failed";

export type DoubaoProtocolSmokeSnapshot = {
  transport: DoubaoProtocolSmokeTransportState;
  session: DoubaoProtocolSmokeSessionState;
  turn: DoubaoProtocolSmokeTurnState;
};

export type DoubaoProtocolSmokeTurnResult = {
  markerCounts: {
    markerA: number;
    markerB: number;
  };
  outputAudioBytes: number;
  outputAudioDurationMs: number;
  inputCommitted: true;
  transcriptionCompleted: true;
  textCompleted: true;
  audioCompleted: true;
  responseDone: true;
};

export type DoubaoD01D02Result = {
  directiveTurn: DoubaoProtocolSmokeTurnResult;
  restoredControlTurn: DoubaoProtocolSmokeTurnResult;
};

export type DoubaoD03Result = {
  replacementTurn: DoubaoProtocolSmokeTurnResult;
};

export type DoubaoProtocolSmokeAdapterOptions = {
  config: NonNullable<AppConfig["doubao"]>;
  model: DoubaoRealtimeModel;
  voice: string;
  baseInstructions: string;
  webSocketFactory: DoubaoWebSocketFactory;
  responseTimeoutMs?: number;
  closeTimeoutMs?: number;
};

export type DoubaoProtocolSmokeMarkers = {
  markerA: string;
  markerB: string;
};

export type DoubaoTeachingPcmProtocolSmokeResult = {
  schemaVersion: 1;
  provider: "doubao";
  providerEvidence: false;
  inputMode: "pcm16le";
  fixtureRevision: string;
  fixtureHash: string;
  inputFixtureHash: string;
  scope: typeof DOUBAO_PROTOCOL_SMOKE_SCOPE;
  upstreamSessions: 2;
  responseAttempts: 3;
  cases: Array<{
    id: "D01" | "D02" | "D03";
    status: "protocol_sequence_completed";
    expectedMarkerCount: number;
    forbiddenMarkerCount: number;
  }>;
};

export type DoubaoTeachingPcmProtocolSmokeInput = {
  adapterOptions: Omit<DoubaoProtocolSmokeAdapterOptions, "baseInstructions">;
  pcm: Buffer;
};

type UpdateKind = "apply" | "replace" | "restore";

type PendingSessionUpdate = {
  sessionId: string;
  instructionsHash: string;
  sessionConfigHash: string;
};

type HashableDoubaoSessionConfig = {
  type: DoubaoInstructionsUpdateEvent["session"]["type"];
  model: DoubaoInstructionsUpdateEvent["session"]["model"];
  instructions: string;
  audio: {
    input: { format: { type: "pcm"; rate: number } };
    output: {
      format: { type: "pcm_s16le"; rate: number };
      voice: string;
      speed: number;
      loudness: number;
    };
  };
};

export class DoubaoProtocolSmokeAdapter {
  private readonly apiKey: string;
  private readonly model: DoubaoRealtimeModel;
  private readonly voice: string;
  private readonly baseInstructions: string;
  private readonly requestTimeoutMs: number;
  private readonly responseTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly webSocketFactory: DoubaoWebSocketFactory;
  private readonly events = new ProviderEventQueue();
  private readonly seenProviderEventIds = new Set<string>();
  private readonly seenResponseIds = new Set<string>();
  private providerEventCount = 0;
  private providerBytes = 0;

  private socket: WebSocket | null = null;
  private transportState: DoubaoProtocolSmokeTransportState = "idle";
  private sessionState: DoubaoProtocolSmokeSessionState = "not_created";
  private turnState: DoubaoProtocolSmokeTurnState = "idle";
  private activeOperation: string | null = null;
  private sessionId: string | null = null;
  private pendingSessionUpdate: PendingSessionUpdate | null = null;

  constructor(options: DoubaoProtocolSmokeAdapterOptions) {
    if (!options.config.enabled || !options.config.apiKey) {
      throw smokeError("NOT_CONFIGURED");
    }
    if (options.model !== "1.2.6.1") {
      throw smokeError("UNSUPPORTED_MODEL");
    }
    if (
      !Number.isSafeInteger(options.config.requestTimeoutMs) ||
      options.config.requestTimeoutMs <= 0
    ) {
      throw smokeError("INVALID_TIMEOUT");
    }

    this.apiKey = options.config.apiKey;
    this.model = options.model;
    this.voice = requireVoice(options.voice);
    this.baseInstructions = requireInstructions(options.baseInstructions);
    this.requestTimeoutMs = options.config.requestTimeoutMs;
    this.responseTimeoutMs = requireBoundedTimeout(
      options.responseTimeoutMs ?? DOUBAO_PROTOCOL_SMOKE_MAX_RESPONSE_MS,
      DOUBAO_PROTOCOL_SMOKE_MAX_RESPONSE_MS,
    );
    this.closeTimeoutMs = requireBoundedTimeout(
      options.closeTimeoutMs ?? Math.min(3_000, this.requestTimeoutMs),
      this.requestTimeoutMs,
    );
    this.webSocketFactory = options.webSocketFactory;
  }

  snapshot(): DoubaoProtocolSmokeSnapshot {
    return {
      transport: this.transportState,
      session: this.sessionState,
      turn: this.turnState,
    };
  }

  async connect(): Promise<void> {
    await this.runExclusive("connect", async () => {
      if (
        this.transportState !== "idle" ||
        this.sessionState !== "not_created"
      ) {
        throw smokeError("INVALID_STATE");
      }
      this.transportState = "connecting";
      const deadline = Date.now() + this.requestTimeoutMs;

      let socket: WebSocket;
      try {
        socket = this.webSocketFactory(DOUBAO_REALTIME_WEBSOCKET_URL, {
          headers: { "X-Api-Key": this.apiKey },
          handshakeTimeout: this.requestTimeoutMs,
          maxPayload: DOUBAO_RELAY_UPSTREAM_MAX_MESSAGE_BYTES,
          perMessageDeflate: false,
        });
      } catch {
        this.transportState = "failed";
        this.sessionState = "failed";
        throw smokeError("NETWORK_ERROR");
      }

      this.socket = socket;
      this.attachSocketListeners(socket);
      try {
        await waitForSocketOpen(
          socket,
          remainingDeadlineMs(deadline, "HANDSHAKE_FAILED"),
        );
        this.transportState = "open";
        this.sessionState = "creating";
        const createEvent = {
          ...buildDoubaoSessionCreateEvent(this.model, {
            voice: this.voice,
            instructions: this.baseInstructions,
          }),
          event_id: nextEventId(),
        };
        await this.sendEvent(createEvent, deadline);
        const created = await this.waitForSessionCreated(deadline);
        this.sessionId = created.session.id;
        this.sessionState = "base_active";
      } catch (error) {
        const primaryError = normalizeError(error);
        this.transportState = "failed";
        this.sessionState = "failed";
        await terminateSocketByDeadline(socket, deadline);
        throw primaryError;
      }
    });
  }

  async runD01D02Pair(input: {
    directiveInstructions: string;
    pcm: Buffer;
    markers: DoubaoProtocolSmokeMarkers;
  }): Promise<DoubaoD01D02Result> {
    return await this.runExclusive("D01-D02", async () => {
      const pcm = requirePcm(input.pcm);
      const directiveInstructions = requireInstructions(
        input.directiveInstructions,
      );
      const markers = requireMarkers(input.markers);
      this.requireReadyBaseSession();

      try {
        await this.updateInstructions(directiveInstructions, "apply");
        const directiveTurn = await this.runTurn(pcm, markers);
        await this.updateInstructions(this.baseInstructions, "restore");
        const restoredControlTurn = await this.runTurn(pcm, markers);
        return { directiveTurn, restoredControlTurn };
      } catch (error) {
        this.markOperationFailed(error);
        throw normalizeError(error);
      }
    });
  }

  async runD03RevisionCycle(input: {
    firstInstructions: string;
    secondInstructions: string;
    pcm: Buffer;
    markers: DoubaoProtocolSmokeMarkers;
  }): Promise<DoubaoD03Result> {
    return await this.runExclusive("D03", async () => {
      const pcm = requirePcm(input.pcm);
      const firstInstructions = requireInstructions(input.firstInstructions);
      const secondInstructions = requireInstructions(input.secondInstructions);
      const markers = requireMarkers(input.markers);
      this.requireReadyBaseSession();

      try {
        await this.updateInstructions(firstInstructions, "apply");
        await this.updateInstructions(secondInstructions, "replace");
        const replacementTurn = await this.runTurn(pcm, markers);
        await this.updateInstructions(this.baseInstructions, "restore");
        return { replacementTurn };
      } catch (error) {
        this.markOperationFailed(error);
        throw normalizeError(error);
      }
    });
  }

  async close(): Promise<void> {
    await this.runExclusive("close", async () => {
      const socket = this.socket;
      const deadline = Date.now() + this.closeTimeoutMs;
      if (!socket || socket.readyState === WebSocket.CLOSED) {
        this.markClosed();
        return;
      }
      if (socket.readyState !== WebSocket.OPEN) {
        await terminateSocketByDeadline(socket, deadline);
        this.markClosed();
        return;
      }

      this.transportState = "closing";
      this.sessionState = "closing";
      try {
        await this.sendEvent(
          {
            event_id: nextEventId(),
            type: "session.close",
          },
          deadline,
        );
        await this.waitForSessionClosed(deadline);
      } catch (error) {
        const primaryError = normalizeError(error);
        await terminateSocketByDeadline(socket, deadline);
        this.markClosed();
        throw primaryError;
      }

      try {
        await closeSocketAfterProviderAck(
          socket,
          remainingDeadlineMs(deadline, "SESSION_CLOSE_TIMEOUT"),
        );
      } catch (error) {
        if (isSocketClosed(socket)) this.markClosed();
        else {
          this.transportState = "failed";
          this.sessionState = "failed";
          this.turnState = "failed";
        }
        throw normalizeError(error);
      }
      this.markClosed();
    });
  }

  private markClosed(): void {
    this.transportState = "closed";
    this.sessionState = "closed";
    this.turnState = "idle";
    this.sessionId = null;
    this.pendingSessionUpdate = null;
  }

  private attachSocketListeners(socket: WebSocket): void {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.failProviderStream(smokeError("INVALID_PROVIDER_EVENT"));
        return;
      }
      const messageBytes = rawDataByteLength(data);
      if (
        messageBytes === null ||
        messageBytes > DOUBAO_RELAY_UPSTREAM_MAX_MESSAGE_BYTES
      ) {
        this.failProviderStream(smokeError("PROVIDER_MESSAGE_TOO_LARGE"));
        return;
      }
      if (
        this.providerEventCount >= DOUBAO_PROTOCOL_SMOKE_MAX_PROVIDER_EVENTS ||
        this.providerBytes >
          DOUBAO_PROTOCOL_SMOKE_MAX_PROVIDER_BYTES - messageBytes
      ) {
        this.failProviderStream(smokeError("PROVIDER_EVENT_BUDGET_EXCEEDED"));
        return;
      }
      this.providerEventCount += 1;
      this.providerBytes += messageBytes;
      const message = rawDataToBuffer(data);
      try {
        const decoded = JSON.parse(message.toString("utf8")) as unknown;
        const parsed = doubaoEventSchema.safeParse(decoded);
        if (!parsed.success || !hasBoundedProviderIdentifiers(parsed.data)) {
          this.failProviderStream(smokeError("INVALID_PROVIDER_EVENT"));
          return;
        }
        if (
          parsed.data.event_id !== undefined &&
          this.seenProviderEventIds.has(parsed.data.event_id)
        ) {
          this.failProviderStream(smokeError("DUPLICATE_PROVIDER_EVENT_ID"));
          return;
        }
        if (parsed.data.event_id !== undefined) {
          this.seenProviderEventIds.add(parsed.data.event_id);
        }
        if (!this.events.push(parsed.data)) {
          this.failProviderStream(smokeError("PROVIDER_EVENT_QUEUE_OVERFLOW"));
        }
      } catch {
        this.failProviderStream(smokeError("INVALID_PROVIDER_EVENT"));
      }
    });
    socket.on("error", () => {
      if (this.transportState === "closing") return;
      this.events.fail(smokeError("NETWORK_ERROR"));
    });
    socket.on("close", () => {
      if (this.transportState === "closing" || this.sessionState === "closed") {
        this.transportState = "closed";
        return;
      }
      this.transportState = "failed";
      this.sessionState = "failed";
      this.events.fail(smokeError("CONNECTION_CLOSED"));
    });
  }

  private failProviderStream(error: DoubaoProtocolSmokeError): void {
    this.transportState = "failed";
    this.sessionState = "failed";
    this.turnState = "failed";
    this.events.fail(error);
    if (this.socket) terminateSocket(this.socket);
  }

  private async waitForSessionCreated(deadline: number): Promise<{
    session: { id: string };
  }> {
    return await this.waitForExpectedEvent(
      "session.created",
      deadline,
      "SESSION_CREATE_TIMEOUT",
      (event) => doubaoSessionCreatedEventSchema.parse(event),
    );
  }

  private async updateInstructions(
    instructions: string,
    kind: UpdateKind,
  ): Promise<void> {
    if (this.turnState !== "idle") throw smokeError("INVALID_STATE");
    const allowed =
      kind === "restore"
        ? this.sessionState === "restore_required"
        : this.sessionState === "base_active" ||
          this.sessionState === "directive_active";
    if (!allowed) throw smokeError("INVALID_STATE");

    const eventId = nextEventId();
    const event = buildDoubaoInstructionsUpdateEvent({
      eventId,
      model: this.model,
      voice: this.voice,
      instructions,
    });
    if (!this.sessionId || this.pendingSessionUpdate) {
      throw smokeError("INVALID_STATE");
    }
    this.pendingSessionUpdate = {
      sessionId: this.sessionId,
      instructionsHash: hashValue(event.session.instructions),
      sessionConfigHash: hashDoubaoSessionConfig(event.session),
    };
    this.sessionState =
      kind === "restore" ? "restore_pending" : "update_pending";
    const deadline = Date.now() + this.requestTimeoutMs;

    try {
      await this.sendEvent(event, deadline);
      const updated = await this.waitForExpectedEvent(
        "session.updated",
        deadline,
        "SESSION_UPDATE_TIMEOUT",
        (providerEvent) => doubaoSessionUpdatedEventSchema.parse(providerEvent),
      );
      const pending = this.pendingSessionUpdate;
      if (!pending || updated.session.id !== pending.sessionId) {
        throw smokeError("SESSION_UPDATE_ACK_MISMATCH");
      }
      if (
        hashValue(updated.session.instructions) !== pending.instructionsHash
      ) {
        throw smokeError("INSTRUCTION_ACK_MISMATCH");
      }
      if (
        hashDoubaoSessionConfig(updated.session) !== pending.sessionConfigHash
      ) {
        throw smokeError("SESSION_CONFIGURATION_MISMATCH");
      }
      this.sessionState =
        kind === "restore" ? "base_active" : "directive_active";
    } catch (error) {
      this.sessionState = "outcome_unknown";
      throw error;
    } finally {
      this.pendingSessionUpdate = null;
    }
  }

  private async runTurn(
    pcm: Buffer,
    markers: DoubaoProtocolSmokeMarkers,
  ): Promise<DoubaoProtocolSmokeTurnResult> {
    if (
      this.turnState !== "idle" ||
      (this.sessionState !== "base_active" &&
        this.sessionState !== "directive_active")
    ) {
      throw smokeError("INVALID_STATE");
    }

    const directiveWasActive = this.sessionState === "directive_active";
    let inputCommitted = false;
    let transcriptionCompleted = false;
    let textCompleted = false;
    let audioCompleted = false;
    let responseDone = false;
    let outputTextDeltas = "";
    let outputTextDeltaReceived = false;
    let outputText: string | undefined;
    let outputAudioBytes = 0;
    let responseId: string | undefined;
    let questionId: string | undefined;
    let responseStarted = false;
    const deadline = Date.now() + this.responseTimeoutMs;

    try {
      this.turnState = "sending_input";
      for (
        let offset = 0;
        offset < pcm.byteLength;
        offset += DOUBAO_PROTOCOL_SMOKE_PCM_CHUNK_BYTES
      ) {
        const chunk = pcm.subarray(
          offset,
          offset + DOUBAO_PROTOCOL_SMOKE_PCM_CHUNK_BYTES,
        );
        await this.sendEvent(
          {
            event_id: nextEventId(),
            type: "input_audio_buffer.append",
            audio: chunk.toString("base64"),
          },
          deadline,
        );
      }
      await this.sendEvent(
        {
          event_id: nextEventId(),
          type: "input_audio_buffer.commit",
        },
        deadline,
      );
      this.turnState = "commit_pending";

      while (!responseDone) {
        const event = await this.events.next(
          remainingDeadlineMs(deadline, "RESPONSE_TIMEOUT"),
          "RESPONSE_TIMEOUT",
        );
        throwIfProviderError(event);

        switch (event.type) {
          case "input_audio_buffer.committed":
            doubaoInputAudioCommittedEventSchema.parse(event);
            inputCommitted = true;
            if (!responseStarted) this.turnState = "awaiting_response";
            break;
          case "conversation.item.input_audio_transcription.started":
            doubaoUserTranscriptionStartedEventSchema.parse(event);
            break;
          case "conversation.item.input_audio_transcription.delta":
            doubaoUserTranscriptionDeltaEventSchema.parse(event);
            break;
          case "conversation.item.input_audio_transcription.completed":
            doubaoUserTranscriptionCompletedEventSchema.parse(event);
            transcriptionCompleted = true;
            break;
          case "conversation.item.input_audio_transcription.failed":
            doubaoUserTranscriptionFailedEventSchema.parse(event);
            throw smokeError("TRANSCRIPTION_FAILED");
          case "response.output_text.delta": {
            const parsed = doubaoOutputTextDeltaEventSchema.parse(event);
            if (textCompleted) throw smokeError("OUTPUT_TEXT_MISMATCH");
            responseStarted = true;
            this.turnState = "response_active";
            responseId = this.bindResponseIdentifier(
              responseId,
              parsed.response_id,
            );
            questionId = bindIdentifier(
              questionId,
              readOptionalString(event, "question_id"),
              "QUESTION_ID_MISMATCH",
            );
            outputTextDeltaReceived = true;
            if (
              parsed.delta.length >
              MAX_OUTPUT_TEXT_CHARACTERS - outputTextDeltas.length
            ) {
              throw smokeError("OUTPUT_TEXT_TOO_LARGE");
            }
            outputTextDeltas += parsed.delta;
            break;
          }
          case "response.output_text.done": {
            const parsed = doubaoOutputTextDoneEventSchema.parse(event);
            if (textCompleted) throw smokeError("OUTPUT_TEXT_MISMATCH");
            responseStarted = true;
            this.turnState = "response_active";
            responseId = this.bindResponseIdentifier(
              responseId,
              parsed.response_id,
            );
            questionId = bindIdentifier(
              questionId,
              readOptionalString(event, "question_id"),
              "QUESTION_ID_MISMATCH",
            );
            outputText = parsed.text ?? outputTextDeltas;
            if (outputText.length > MAX_OUTPUT_TEXT_CHARACTERS) {
              throw smokeError("OUTPUT_TEXT_TOO_LARGE");
            }
            if (
              parsed.text !== undefined &&
              outputTextDeltaReceived &&
              parsed.text !== outputTextDeltas
            ) {
              throw smokeError("OUTPUT_TEXT_MISMATCH");
            }
            textCompleted = true;
            break;
          }
          case "response.output_audio.started": {
            if (audioCompleted) {
              throw smokeError("UNEXPECTED_RESPONSE_EVENT");
            }
            const parsed = doubaoOutputAudioStartedEventSchema.parse(event);
            if (audioCompleted) throw smokeError("UNEXPECTED_RESPONSE_EVENT");
            responseStarted = true;
            this.turnState = "response_active";
            responseId = this.bindResponseIdentifier(
              responseId,
              parsed.response_id,
            );
            questionId = bindIdentifier(
              questionId,
              parsed.question_id,
              "QUESTION_ID_MISMATCH",
            );
            break;
          }
          case "response.output_audio.delta": {
            if (audioCompleted) {
              throw smokeError("UNEXPECTED_RESPONSE_EVENT");
            }
            const parsed = doubaoOutputAudioDeltaEventSchema.parse(event);
            if (audioCompleted) throw smokeError("UNEXPECTED_RESPONSE_EVENT");
            responseStarted = true;
            this.turnState = "response_active";
            responseId = this.bindResponseIdentifier(
              responseId,
              parsed.response_id,
            );
            questionId = bindIdentifier(
              questionId,
              parsed.question_id,
              "QUESTION_ID_MISMATCH",
            );
            outputAudioBytes += Buffer.from(parsed.delta, "base64").byteLength;
            if (outputAudioBytes > DOUBAO_PROTOCOL_SMOKE_MAX_OUTPUT_BYTES) {
              throw smokeError("OUTPUT_AUDIO_TOO_LARGE");
            }
            break;
          }
          case "response.output_audio.done": {
            if (audioCompleted) {
              throw smokeError("UNEXPECTED_RESPONSE_EVENT");
            }
            const parsed = doubaoOutputAudioDoneEventSchema.parse(event);
            if (audioCompleted) throw smokeError("UNEXPECTED_RESPONSE_EVENT");
            responseStarted = true;
            this.turnState = "response_active";
            responseId = this.bindResponseIdentifier(
              responseId,
              parsed.response_id,
            );
            questionId = bindIdentifier(
              questionId,
              parsed.question_id,
              "QUESTION_ID_MISMATCH",
            );
            if (String(parsed.status_code) === "20000002") {
              throw smokeError("UNEXPECTED_EXIT_INTENT");
            }
            audioCompleted = true;
            break;
          }
          case "response.done": {
            const parsed = doubaoResponseDoneEventSchema.parse(event);
            responseId = this.bindResponseIdentifier(
              responseId,
              parsed.response_id,
            );
            if (parsed.status !== "completed") {
              throw smokeError("RESPONSE_NOT_COMPLETED");
            }
            responseDone = true;
            break;
          }
          case "response.canceled":
            doubaoResponseCanceledEventSchema.parse(event);
            throw smokeError("RESPONSE_CANCELED");
          case "session.updated":
            throw smokeError("UNEXPECTED_SESSION_UPDATED");
          case "session.closed":
            throw smokeError("CONNECTION_CLOSED");
          default:
            break;
        }
      }

      if (
        !inputCommitted ||
        !transcriptionCompleted ||
        !textCompleted ||
        !audioCompleted ||
        !outputText ||
        outputAudioBytes === 0
      ) {
        throw smokeError("INCOMPLETE_RESPONSE");
      }

      this.turnState = "response_terminal";
      this.sessionState = directiveWasActive
        ? "restore_required"
        : "base_active";
      this.turnState = "idle";
      return {
        markerCounts: {
          markerA: countOccurrences(outputText, markers.markerA),
          markerB: countOccurrences(outputText, markers.markerB),
        },
        outputAudioBytes,
        outputAudioDurationMs: (outputAudioBytes / (24_000 * 2)) * 1_000,
        inputCommitted: true,
        transcriptionCompleted: true,
        textCompleted: true,
        audioCompleted: true,
        responseDone: true,
      };
    } catch (error) {
      if (
        error instanceof DoubaoProtocolSmokeError &&
        error.code === "RESPONSE_TIMEOUT" &&
        responseStarted
      ) {
        await this.cancelResponseAfterTimeout();
      }
      this.turnState = "failed";
      throw error;
    }
  }

  private async cancelResponseAfterTimeout(): Promise<void> {
    const deadline = Date.now() + this.closeTimeoutMs;
    try {
      await this.sendEvent(
        {
          event_id: nextEventId(),
          type: "response.cancel",
        },
        deadline,
      );
      await this.waitForExpectedEvent(
        "response.canceled",
        deadline,
        "RESPONSE_CANCEL_TIMEOUT",
        (event) => doubaoResponseCanceledEventSchema.parse(event),
      );
    } catch {
      // The original response timeout remains the externally visible failure.
    }
  }

  private async waitForSessionClosed(deadline: number): Promise<void> {
    await this.waitForExpectedEvent(
      "session.closed",
      deadline,
      "SESSION_CLOSE_TIMEOUT",
      (event) => doubaoSessionClosedEventSchema.parse(event),
    );
  }

  private async waitForExpectedEvent<T>(
    expectedType: string,
    deadline: number,
    timeoutCode: DoubaoProtocolSmokeErrorCode,
    parse: (event: DoubaoEvent) => T,
  ): Promise<T> {
    let ignored = 0;
    while (true) {
      const event = await this.events.next(
        remainingDeadlineMs(deadline, timeoutCode),
        timeoutCode,
      );
      throwIfProviderError(event);
      if (event.type === expectedType) {
        const parsed = parse(event);
        this.events.assertHealthy();
        return parsed;
      }
      if (event.type === "session.closed") {
        throw smokeError("CONNECTION_CLOSED");
      }
      if (event.type.startsWith("response.")) {
        throw smokeError("UNEXPECTED_RESPONSE_EVENT");
      }
      ignored += 1;
      if (ignored > MAX_IGNORED_EVENTS_PER_WAIT) {
        throw smokeError("UNEXPECTED_PROVIDER_EVENT");
      }
    }
  }

  private async sendEvent(
    event: Record<string, unknown>,
    deadline: number,
  ): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw smokeError("CONNECTION_CLOSED");
    }
    const payload = Buffer.from(JSON.stringify(event));
    if (
      socket.bufferedAmount + payload.byteLength >
      MAX_SOCKET_BUFFERED_BYTES
    ) {
      throw smokeError("BACKPRESSURE");
    }
    const timeoutMs = remainingDeadlineMs(deadline, "SEND_TIMEOUT");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const fail = (error: DoubaoProtocolSmokeError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        void this.failSendAndClose(socket, error).then(reject);
      };
      const timeout = setTimeout(() => {
        fail(smokeError("SEND_TIMEOUT"));
      }, timeoutMs);
      timeout.unref();
      try {
        socket.send(
          payload,
          { binary: false, compress: false },
          (error?: Error) =>
            error ? fail(smokeError("NETWORK_ERROR")) : finish(),
        );
      } catch {
        fail(smokeError("NETWORK_ERROR"));
      }
    });
  }

  private async failSendAndClose(
    socket: WebSocket,
    error: DoubaoProtocolSmokeError,
  ): Promise<DoubaoProtocolSmokeError> {
    this.failProviderStream(error);
    return (await waitForSocketClose(socket, FORCE_CLOSE_GRACE_MS))
      ? error
      : smokeError("SESSION_CLOSE_TIMEOUT");
  }

  private requireReadyBaseSession(): void {
    if (
      this.transportState !== "open" ||
      this.sessionState !== "base_active" ||
      this.turnState !== "idle"
    ) {
      throw smokeError("INVALID_STATE");
    }
  }

  private bindResponseIdentifier(
    current: string | undefined,
    candidate: string | undefined,
  ): string | undefined {
    const bound = bindIdentifier(current, candidate, "RESPONSE_ID_MISMATCH");
    if (current === undefined && bound !== undefined) {
      if (this.seenResponseIds.has(bound)) {
        throw smokeError("DUPLICATE_RESPONSE_ID");
      }
      this.seenResponseIds.add(bound);
    }
    return bound;
  }

  private markOperationFailed(error: unknown): void {
    if (
      error instanceof DoubaoProtocolSmokeError &&
      error.code === "SESSION_UPDATE_TIMEOUT"
    ) {
      this.sessionState = "outcome_unknown";
      return;
    }
    this.sessionState = "failed";
  }

  private async runExclusive<T>(
    operation: string,
    run: () => Promise<T>,
  ): Promise<T> {
    if (this.activeOperation !== null)
      throw smokeError("OPERATION_IN_PROGRESS");
    this.activeOperation = operation;
    try {
      return await run();
    } finally {
      this.activeOperation = null;
    }
  }
}

export async function runDoubaoTeachingPcmProtocolSmoke(
  input: DoubaoTeachingPcmProtocolSmokeInput,
): Promise<DoubaoTeachingPcmProtocolSmokeResult> {
  const compiled = compileFixedTeachingFixtures();
  const pcm = requirePcm(input.pcm);
  const inputFixtureHash = createHash("sha256").update(pcm).digest("hex");
  const markers = requireMarkers({
    markerA: extractPrimaryMarker(TEACHING_SPIKE_FIXTURES.directiveA.text),
    markerB: extractPrimaryMarker(TEACHING_SPIKE_FIXTURES.directiveB.text),
  });
  const adapterOptions: DoubaoProtocolSmokeAdapterOptions = {
    ...input.adapterOptions,
    baseInstructions: compiled.base.instructions,
  };

  const pairAdapter = new DoubaoProtocolSmokeAdapter(adapterOptions);
  const pair = await runWithBoundedAdapterClose(pairAdapter, async () => {
    await pairAdapter.connect();
    return await pairAdapter.runD01D02Pair({
      directiveInstructions: compiled.directiveA.instructions,
      pcm,
      markers,
    });
  });
  assertMarkerCounts(pair.directiveTurn.markerCounts, 1, 0);
  assertMarkerCounts(pair.restoredControlTurn.markerCounts, 0, 0);

  const replacementAdapter = new DoubaoProtocolSmokeAdapter(adapterOptions);
  const replacement = await runWithBoundedAdapterClose(
    replacementAdapter,
    async () => {
      await replacementAdapter.connect();
      return await replacementAdapter.runD03RevisionCycle({
        firstInstructions: compiled.directiveA.instructions,
        secondInstructions: compiled.directiveB.instructions,
        pcm,
        markers,
      });
    },
  );
  assertMarkerCounts(replacement.replacementTurn.markerCounts, 0, 1);

  return {
    schemaVersion: 1,
    provider: "doubao",
    providerEvidence: false,
    inputMode: "pcm16le",
    fixtureRevision: TEACHING_SPIKE_FIXTURE_REVISION,
    fixtureHash: TEACHING_SPIKE_FIXTURE_HASH,
    inputFixtureHash,
    scope: DOUBAO_PROTOCOL_SMOKE_SCOPE,
    upstreamSessions: 2,
    responseAttempts: 3,
    cases: [
      {
        id: "D01",
        status: "protocol_sequence_completed",
        expectedMarkerCount: pair.directiveTurn.markerCounts.markerA,
        forbiddenMarkerCount: pair.directiveTurn.markerCounts.markerB,
      },
      {
        id: "D02",
        status: "protocol_sequence_completed",
        expectedMarkerCount: pair.restoredControlTurn.markerCounts.markerA,
        forbiddenMarkerCount: pair.restoredControlTurn.markerCounts.markerB,
      },
      {
        id: "D03",
        status: "protocol_sequence_completed",
        expectedMarkerCount: replacement.replacementTurn.markerCounts.markerB,
        forbiddenMarkerCount: replacement.replacementTurn.markerCounts.markerA,
      },
    ],
  };
}

async function runWithBoundedAdapterClose<T>(
  adapter: DoubaoProtocolSmokeAdapter,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    const result = await operation();
    await adapter.close();
    return result;
  } catch (error) {
    const primaryError = normalizeError(error);
    try {
      await adapter.close();
    } catch {
      // Preserve the protocol or connection failure that triggered cleanup.
    }
    throw primaryError;
  }
}

export type DoubaoProtocolSmokeErrorCode =
  | "NOT_CONFIGURED"
  | "UNSUPPORTED_MODEL"
  | "INVALID_TIMEOUT"
  | "INVALID_VOICE"
  | "INVALID_INSTRUCTIONS"
  | "INSTRUCTIONS_TOO_LARGE"
  | "INVALID_PCM"
  | "INVALID_MARKERS"
  | "INVALID_FIXTURE_MARKER"
  | "INPUT_TOO_LARGE"
  | "INVALID_STATE"
  | "OPERATION_IN_PROGRESS"
  | "NETWORK_ERROR"
  | "HANDSHAKE_FAILED"
  | "CONNECTION_CLOSED"
  | "SEND_TIMEOUT"
  | "BACKPRESSURE"
  | "INVALID_PROVIDER_EVENT"
  | "DUPLICATE_PROVIDER_EVENT_ID"
  | "PROVIDER_MESSAGE_TOO_LARGE"
  | "PROVIDER_EVENT_BUDGET_EXCEEDED"
  | "PROVIDER_EVENT_QUEUE_OVERFLOW"
  | "PROVIDER_ERROR"
  | "SESSION_CREATE_TIMEOUT"
  | "SESSION_UPDATE_TIMEOUT"
  | "SESSION_UPDATE_ACK_MISMATCH"
  | "INSTRUCTION_ACK_MISMATCH"
  | "SESSION_CONFIGURATION_MISMATCH"
  | "SESSION_CLOSE_TIMEOUT"
  | "RESPONSE_TIMEOUT"
  | "RESPONSE_CANCEL_TIMEOUT"
  | "TRANSCRIPTION_FAILED"
  | "RESPONSE_CANCELED"
  | "RESPONSE_NOT_COMPLETED"
  | "INCOMPLETE_RESPONSE"
  | "UNEXPECTED_EXIT_INTENT"
  | "RESPONSE_ID_MISMATCH"
  | "DUPLICATE_RESPONSE_ID"
  | "QUESTION_ID_MISMATCH"
  | "OUTPUT_TEXT_TOO_LARGE"
  | "OUTPUT_TEXT_MISMATCH"
  | "OUTPUT_AUDIO_TOO_LARGE"
  | "MARKER_ASSERTION_FAILED"
  | "UNEXPECTED_SESSION_UPDATED"
  | "UNEXPECTED_RESPONSE_EVENT"
  | "UNEXPECTED_PROVIDER_EVENT";

export class DoubaoProtocolSmokeError extends Error {
  constructor(
    readonly code: DoubaoProtocolSmokeErrorCode,
    readonly diagnostic?: {
      handshakeStatus?: number;
      providerCode?: string | number;
    },
  ) {
    super(code);
    this.name = "DoubaoProtocolSmokeError";
  }
}

class ProviderEventQueue {
  private readonly queued: DoubaoEvent[] = [];
  private pending:
    | {
        resolve: (event: DoubaoEvent) => void;
        reject: (error: Error) => void;
        timeout: NodeJS.Timeout;
      }
    | undefined;
  private failure: Error | undefined;

  push(event: DoubaoEvent): boolean {
    if (this.failure) return false;
    const pending = this.pending;
    if (!pending) {
      if (this.queued.length >= DOUBAO_PROTOCOL_SMOKE_MAX_EVENT_QUEUE_DEPTH) {
        return false;
      }
      this.queued.push(event);
      return true;
    }
    this.pending = undefined;
    clearTimeout(pending.timeout);
    pending.resolve(event);
    return true;
  }

  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.queued.length = 0;
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timeout);
    pending.reject(error);
  }

  async next(
    timeoutMs: number,
    timeoutCode: DoubaoProtocolSmokeErrorCode,
  ): Promise<DoubaoEvent> {
    if (this.failure) throw this.failure;
    const queued = this.queued.shift();
    if (queued) return queued;
    if (this.pending) throw smokeError("OPERATION_IN_PROGRESS");

    return await new Promise<DoubaoEvent>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending?.timeout !== timeout) return;
        this.pending = undefined;
        reject(smokeError(timeoutCode));
      }, timeoutMs);
      timeout.unref();
      this.pending = { resolve, reject, timeout };
    });
  }

  assertHealthy(): void {
    if (this.failure) throw this.failure;
  }
}

function requireInstructions(value: string): string {
  const instructions = value.trim();
  if (!instructions) throw smokeError("INVALID_INSTRUCTIONS");
  if (instructions.length > MAX_INSTRUCTIONS_CHARACTERS) {
    throw smokeError("INSTRUCTIONS_TOO_LARGE");
  }
  return instructions;
}

function requireVoice(value: string): string {
  const voice = value.trim();
  if (!voice || voice.length > 160) throw smokeError("INVALID_VOICE");
  return voice;
}

function requirePcm(value: Buffer): Buffer {
  if (
    !Buffer.isBuffer(value) ||
    value.byteLength === 0 ||
    value.byteLength % DOUBAO_PROTOCOL_SMOKE_PCM_CHUNK_BYTES !== 0
  ) {
    throw smokeError("INVALID_PCM");
  }
  if (value.byteLength > DOUBAO_PROTOCOL_SMOKE_MAX_INPUT_BYTES) {
    throw smokeError("INPUT_TOO_LARGE");
  }
  return Buffer.from(value);
}

function requireMarkers(
  value: DoubaoProtocolSmokeMarkers,
): DoubaoProtocolSmokeMarkers {
  const markerA = value.markerA.trim();
  const markerB = value.markerB.trim();
  if (
    !markerA ||
    !markerB ||
    markerA === markerB ||
    markerA.length > 32 ||
    markerB.length > 32
  ) {
    throw smokeError("INVALID_MARKERS");
  }
  return { markerA, markerB };
}

function compileFixedTeachingFixtures(): {
  base: { instructions: string };
  directiveA: { instructions: string };
  directiveB: { instructions: string };
} {
  const common = {
    base: TEACHING_SPIKE_FIXTURES.base.text,
    safety: TEACHING_SPIKE_FIXTURES.safety.text,
    maxCharacters: MAX_INSTRUCTIONS_CHARACTERS,
  };
  return {
    base: compileTeachingInstructions(common),
    directiveA: compileTeachingInstructions({
      ...common,
      directive: TEACHING_SPIKE_FIXTURES.directiveA.text,
    }),
    directiveB: compileTeachingInstructions({
      ...common,
      directive: TEACHING_SPIKE_FIXTURES.directiveB.text,
    }),
  };
}

function extractPrimaryMarker(directive: string): string {
  const marker = /完整说出“([^”]+)”一次/u.exec(directive)?.[1];
  if (!marker) throw smokeError("INVALID_FIXTURE_MARKER");
  return marker;
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashDoubaoSessionConfig(value: HashableDoubaoSessionConfig): string {
  return hashValue(
    JSON.stringify({
      type: value.type,
      model: value.model,
      instructions: value.instructions,
      audio: {
        input: {
          format: {
            type: value.audio.input.format.type,
            rate: value.audio.input.format.rate,
          },
        },
        output: {
          format: {
            type: value.audio.output.format.type,
            rate: value.audio.output.format.rate,
          },
          voice: value.audio.output.voice,
          speed: value.audio.output.speed,
          loudness: value.audio.output.loudness,
        },
      },
    }),
  );
}

function requireBoundedTimeout(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw smokeError("INVALID_TIMEOUT");
  }
  return value;
}

function bindIdentifier(
  current: string | undefined,
  candidate: string | undefined,
  errorCode: "RESPONSE_ID_MISMATCH" | "QUESTION_ID_MISMATCH",
): string | undefined {
  if (!candidate) return current;
  if (current !== undefined && current !== candidate) {
    throw smokeError(errorCode);
  }
  return candidate;
}

function countOccurrences(value: string, marker: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const next = value.indexOf(marker, offset);
    if (next < 0) return count;
    count += 1;
    offset = next + marker.length;
  }
}

function assertMarkerCounts(
  actual: DoubaoProtocolSmokeTurnResult["markerCounts"],
  markerA: number,
  markerB: number,
): void {
  if (actual.markerA !== markerA || actual.markerB !== markerB) {
    throw smokeError("MARKER_ASSERTION_FAILED");
  }
}

function readOptionalString(
  event: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = event[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hasBoundedProviderIdentifiers(event: DoubaoEvent): boolean {
  const record = event as Record<string, unknown>;
  if (
    !isBoundedProviderIdentifier(
      record.event_id,
      false,
      MAX_PROVIDER_EVENT_ID_CHARACTERS,
    ) ||
    typeof record.type !== "string" ||
    record.type.length === 0 ||
    record.type.length > MAX_PROVIDER_EVENT_TYPE_CHARACTERS ||
    !isBoundedProviderIdentifier(
      record.response_id,
      event.type === "response.output_audio.started",
    ) ||
    !isBoundedProviderIdentifier(record.question_id) ||
    !isBoundedProviderIdentifier(record.item_id) ||
    !isBoundedProviderIdentifier(record.session_id)
  ) {
    return false;
  }

  const session = record.session;
  return !isRecord(session) || isBoundedProviderIdentifier(session.id);
}

function isBoundedProviderIdentifier(
  value: unknown,
  allowEmpty = false,
  maximum = MAX_PROVIDER_ENTITY_ID_CHARACTERS,
): boolean {
  if (value === undefined) return true;
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.length <= maximum
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwIfProviderError(event: DoubaoEvent): void {
  if (event.type !== "error") return;
  const parsed = doubaoErrorEventSchema.parse(event);
  const providerCode =
    parsed.code ??
    parsed.status_code ??
    parsed.error?.code ??
    parsed.error?.type;
  throw new DoubaoProtocolSmokeError("PROVIDER_ERROR", {
    ...(providerCode === undefined ? {} : { providerCode }),
  });
}

function nextEventId(): string {
  return `event_${randomUUID()}`;
}

function smokeError(
  code: DoubaoProtocolSmokeErrorCode,
  diagnostic?: DoubaoProtocolSmokeError["diagnostic"],
): DoubaoProtocolSmokeError {
  return new DoubaoProtocolSmokeError(code, diagnostic);
}

function normalizeError(error: unknown): DoubaoProtocolSmokeError {
  return error instanceof DoubaoProtocolSmokeError
    ? error
    : smokeError("INVALID_PROVIDER_EVENT");
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function rawDataByteLength(data: RawData): number | null {
  if (!Array.isArray(data)) return data.byteLength;
  let total = 0;
  for (const part of data) {
    if (part.byteLength > Number.MAX_SAFE_INTEGER - total) return null;
    total += part.byteLength;
  }
  return total;
}

function remainingDeadlineMs(
  deadline: number,
  timeoutCode: DoubaoProtocolSmokeErrorCode,
): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw smokeError(timeoutCode);
  return remaining;
}

function terminateSocket(socket: WebSocket): void {
  if (socket.readyState === WebSocket.CLOSED) return;
  try {
    socket.terminate();
  } catch {
    // The bounded CLOSED-state check remains authoritative.
  }
}

function isSocketClosed(socket: WebSocket): boolean {
  return socket.readyState === WebSocket.CLOSED;
}

async function terminateSocketAndWait(
  socket: WebSocket,
  timeoutMs: number,
): Promise<void> {
  terminateSocket(socket);
  if (await waitForSocketClose(socket, timeoutMs)) return;
  throw smokeError("SESSION_CLOSE_TIMEOUT");
}

async function terminateSocketByDeadline(
  socket: WebSocket,
  deadline: number,
): Promise<void> {
  terminateSocket(socket);
  if (isSocketClosed(socket)) return;

  const remaining = deadline - Date.now();
  if (remaining > 0 && (await waitForSocketClose(socket, remaining))) return;

  await terminateSocketAndWait(socket, FORCE_CLOSE_GRACE_MS);
}

async function waitForSocketClose(
  socket: WebSocket,
  timeoutMs: number,
): Promise<boolean> {
  if (socket.readyState === WebSocket.CLOSED) return true;
  return await new Promise<boolean>((resolve) => {
    const onClose = (): void => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      socket.off("close", onClose);
      resolve(socket.readyState === WebSocket.CLOSED);
    }, timeoutMs);
    timeout.unref();
    socket.once("close", onClose);
  });
}

async function waitForSocketOpen(
  socket: WebSocket,
  timeoutMs: number,
): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(smokeError("HANDSHAKE_FAILED"));
    }, timeoutMs);
    timeout.unref();

    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.off("unexpected-response", onUnexpectedResponse);
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(smokeError("NETWORK_ERROR"));
    };
    const onClose = (): void => {
      cleanup();
      reject(smokeError("CONNECTION_CLOSED"));
    };
    const onUnexpectedResponse = (
      _request: unknown,
      response: { statusCode?: number; resume: () => void },
    ): void => {
      cleanup();
      response.resume();
      reject(
        smokeError("HANDSHAKE_FAILED", {
          ...(response.statusCode === undefined
            ? {}
            : { handshakeStatus: response.statusCode }),
        }),
      );
    };

    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.once("unexpected-response", onUnexpectedResponse);
  });
}

async function closeSocketAfterProviderAck(
  socket: WebSocket,
  timeoutMs: number,
): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closeObserved = waitForSocketClose(socket, timeoutMs);
  try {
    socket.close(1000);
  } catch {
    await terminateSocketAndWait(socket, FORCE_CLOSE_GRACE_MS);
    throw smokeError("SESSION_CLOSE_TIMEOUT");
  }
  if (await closeObserved) return;
  await terminateSocketAndWait(socket, FORCE_CLOSE_GRACE_MS);
  throw smokeError("SESSION_CLOSE_TIMEOUT");
}
