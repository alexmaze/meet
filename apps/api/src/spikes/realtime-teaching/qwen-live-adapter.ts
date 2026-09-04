import {
  QWEN_REALTIME_MAX_EVENT_TYPE_CHARACTERS,
  QWEN_REALTIME_MAX_IDENTIFIER_CHARACTERS,
  qwenLiveConversationItemCreatedEventSchema,
  qwenLiveResponseContentPartAddedEventSchema,
  qwenLiveResponseContentPartDoneEventSchema,
  qwenLiveResponseCreateEventSchema,
  qwenLiveResponseDoneEventSchema,
  qwenLiveResponseOutputItemAddedEventSchema,
  qwenLiveResponseOutputItemDoneEventSchema,
  qwenLiveSessionCreatedEventSchema,
  qwenLiveSessionUpdatePatchSchema,
  qwenLiveSessionUpdatedEventSchema,
  qwenLiveUserTextItemCreateEventSchema,
  qwenResponseCreatedEventSchema,
  qwenResponseDoneEventSchema,
  qwenResponseTextDeltaEventSchema,
  qwenResponseTextDoneEventSchema,
  qwenServerEventSchema,
  type QwenLiveSessionUpdatePatch,
  type QwenLiveResponseUsage,
  type QwenRealtimeModel,
} from "@meet/protocol";
import { randomUUID } from "node:crypto";
import WebSocket, { type ClientOptions, type RawData } from "ws";

import { buildQwenRealtimeWebSocketUrl } from "../../qwen-websocket.js";
import {
  QWEN_LIVE_TEACHING_EXACT_FIXTURES,
  QWEN_LIVE_TEACHING_EXACT_MARKERS,
  TEACHING_SPIKE_FIXTURES,
  TEACHING_SPIKE_FIXTURE_HASH,
  TEACHING_SPIKE_FIXTURE_REVISION,
  TEACHING_SPIKE_USER_TEXT_HASH,
  compileTeachingInstructions,
  hashTeachingFixture,
} from "./fixtures.js";

const MAX_UPSTREAM_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_INSTRUCTIONS_CHARACTERS = 12_000;
const FORCE_CLOSE_GRACE_MS = 250;
export const QWEN_TEACHING_LIVE_MAX_TRANSCRIPT_CHARACTERS = 32_000;
export const QWEN_TEACHING_LIVE_MAX_RESPONSE_MS = 15_000;
export const QWEN_TEACHING_LIVE_MAX_SESSION_INBOUND_BYTES = 4 * 1024 * 1024;
export const QWEN_TEACHING_LIVE_MAX_SESSION_INBOUND_EVENTS = 2_048;
export const QWEN_TEACHING_LIVE_MAX_INBOX_DEPTH = 64;
export const QWEN_TEACHING_LIVE_MAX_INPUT_TEXT_TOKENS_PER_RESPONSE = 16_384;
export const QWEN_TEACHING_LIVE_MAX_OUTPUT_TEXT_TOKENS_PER_RESPONSE = 8_192;

export const QWEN_TEACHING_LIVE_CASE_IDS = ["D01T", "D02T", "D03T"] as const;

export type QwenTeachingLiveCaseId =
  (typeof QWEN_TEACHING_LIVE_CASE_IDS)[number];

export const QWEN_TEACHING_LIVE_CHECKPOINTS = Object.freeze([
  "adapter_setup",
  "session_1_connect",
  "session_1_session_created",
  "session_1_voice_update_ack",
  "session_1_input_audio_format_update_ack",
  "session_1_output_audio_format_update_ack",
  "session_1_smart_turn_update_ack",
  "session_1_max_history_turns_update_ack",
  "session_1_modalities_update_ack",
  "session_1_base_instructions_update_ack",
  "session_1_base_update_ack",
  "d01t_directive_update_ack",
  "d01t_case",
  "d02t_restore_update_ack",
  "d02t_case",
  "session_1_close",
  "session_2_connect",
  "session_2_session_created",
  "session_2_voice_update_ack",
  "session_2_input_audio_format_update_ack",
  "session_2_output_audio_format_update_ack",
  "session_2_smart_turn_update_ack",
  "session_2_max_history_turns_update_ack",
  "session_2_modalities_update_ack",
  "session_2_base_instructions_update_ack",
  "session_2_base_update_ack",
  "d03t_directive_a_update_ack",
  "d03t_directive_b_update_ack",
  "d03t_case",
  "d03t_restore_update_ack",
  "session_2_close",
] as const);

export type QwenTeachingLiveCheckpoint =
  (typeof QWEN_TEACHING_LIVE_CHECKPOINTS)[number];

export const QWEN_TEACHING_LIVE_PROVIDER_ERROR_TYPE_CATEGORIES = Object.freeze([
  "invalid_request",
  "server",
  "missing",
  "unrecognized",
] as const);

export const QWEN_TEACHING_LIVE_PROVIDER_ERROR_CODE_CATEGORIES = Object.freeze([
  "invalid_value",
  "missing",
  "unrecognized",
] as const);

export const QWEN_TEACHING_LIVE_PROVIDER_ERROR_PARAM_CATEGORIES = Object.freeze(
  [
    "session_update",
    "session_configuration",
    "conversation_item_create",
    "response_create",
    "missing",
    "unrecognized",
  ] as const,
);

export type QwenTeachingLiveSafeProviderError = Readonly<{
  typeCategory: (typeof QWEN_TEACHING_LIVE_PROVIDER_ERROR_TYPE_CATEGORIES)[number];
  codeCategory: (typeof QWEN_TEACHING_LIVE_PROVIDER_ERROR_CODE_CATEGORIES)[number];
  paramCategory: (typeof QWEN_TEACHING_LIVE_PROVIDER_ERROR_PARAM_CATEGORIES)[number];
}>;

export type QwenTeachingLiveWebSocketFactory = (
  url: string,
  options: ClientOptions,
) => WebSocket;

export type QwenTeachingLiveTimeouts = {
  socketOpenMs: number;
  socketCloseMs: number;
  sessionCreatedMs: number;
  updateAckMs: number;
  itemCreatedMs: number;
  responseCreatedMs: number;
  responseDoneMs: number;
};

export type QwenTeachingLiveSmokeResult = {
  schemaVersion: 3;
  provider: "qwen";
  inputMode: "text";
  fixtureRevision: string;
  fixtureHash: string;
  inputFixtureHash: string;
  scope: {
    transport: "isolated_provider_websocket";
    relayExercised: false;
    browserExercised: false;
  };
  providerEvidence: false;
  upstreamSessions: 2;
  responseAttempts: 3;
  instructionAcks: QwenTeachingLiveInstructionAcks;
  usage: QwenTeachingLiveUsage;
  cases: Array<{
    id: QwenTeachingLiveCaseId;
    status: "protocol_sequence_completed";
    expectedMarkerCount: number;
    forbiddenMarkerCount: number;
  }>;
};

export type QwenTeachingLiveInstructionAcks = Readonly<{
  total: 5;
  echoedMatch: number;
  omitted: number;
}>;

export const QWEN_TEACHING_LIVE_INSTRUCTION_ACK_DISPOSITIONS = Object.freeze([
  "echoed_match",
  "omitted",
] as const);

export type QwenTeachingLiveInstructionAckDisposition =
  (typeof QWEN_TEACHING_LIVE_INSTRUCTION_ACK_DISPOSITIONS)[number];

export const QWEN_TEACHING_LIVE_MARKER_MULTIPLICITIES = Object.freeze([
  "zero",
  "one",
  "multiple",
] as const);

export type QwenTeachingLiveMarkerMultiplicity =
  (typeof QWEN_TEACHING_LIVE_MARKER_MULTIPLICITIES)[number];

export type QwenTeachingLiveMarkerFailureObservation = Readonly<{
  caseId: QwenTeachingLiveCaseId;
  expectedState: "A" | "B" | "C";
  activeInstructionAck: QwenTeachingLiveInstructionAckDisposition;
  observedInstructionAcks: Readonly<{
    total: number;
    echoedMatch: number;
    omitted: number;
  }>;
  markerMultiplicity: Readonly<{
    a: QwenTeachingLiveMarkerMultiplicity;
    b: QwenTeachingLiveMarkerMultiplicity;
    c: QwenTeachingLiveMarkerMultiplicity;
  }>;
  hasUnexpectedText: boolean;
  progress: Readonly<{
    session: 1 | 2;
    attempt: 1 | 2 | 3;
    completed: 0 | 1 | 2;
    failed: 1;
  }>;
  usage: Readonly<QwenTeachingLiveUsage>;
}>;

export type QwenTeachingLiveUsage = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  inputTextTokens: number;
  inputAudioTokens: number;
  outputTextTokens: number;
  outputAudioTokens: number;
};

export type QwenTeachingLiveAdapterInput = {
  endpoint: string;
  apiKey: string;
  model: QwenRealtimeModel;
  voice: string;
  webSocketFactory: QwenTeachingLiveWebSocketFactory;
  timeouts?: Partial<QwenTeachingLiveTimeouts>;
};

const DEFAULT_TIMEOUTS: QwenTeachingLiveTimeouts = {
  socketOpenMs: 10_000,
  socketCloseMs: 2_000,
  sessionCreatedMs: 10_000,
  updateAckMs: 5_000,
  itemCreatedMs: 5_000,
  responseCreatedMs: 5_000,
  responseDoneMs: QWEN_TEACHING_LIVE_MAX_RESPONSE_MS,
};

type SafeSessionSnapshot = {
  id: string;
  model: string;
  modalities: Array<"text" | "audio">;
  instructionsHash?: string;
};

type InstructionAckAccumulator = {
  echoedMatch: number;
  omitted: number;
};

type SanitizedServerEvent =
  | { kind: "session.created"; session: SafeSessionSnapshot }
  | { kind: "session.updated"; session: SafeSessionSnapshot }
  | {
      kind: "conversation.item.created";
      itemId: string;
      role: "system" | "user" | "assistant";
      status: "in_progress" | "completed";
    }
  | {
      kind: "response.created";
      responseId: string;
      modalities?: Array<"text" | "audio">;
    }
  | {
      kind: "response.transcript.delta";
      responseId: string;
      itemId: string;
      outputIndex: number;
      contentIndex: number;
      text: string;
    }
  | {
      kind: "response.transcript.done";
      responseId: string;
      itemId: string;
      outputIndex: number;
      contentIndex: number;
      text: string;
    }
  | {
      kind: "response.output_item.added";
      responseId: string;
      itemId: string;
      outputIndex: number;
    }
  | {
      kind: "response.content_part.added";
      responseId: string;
      itemId: string;
      outputIndex: number;
      contentIndex: number;
    }
  | {
      kind: "response.content_part.done";
      responseId: string;
      itemId: string;
      outputIndex: number;
      contentIndex: number;
      text: string;
    }
  | {
      kind: "response.output_item.done";
      responseId: string;
      itemId: string;
      outputIndex: number;
      text: string;
    }
  | {
      kind: "response.done";
      responseId: string;
      status: "completed" | "cancelled" | "failed";
      terminalTranscript?: string;
      terminalItemId?: string;
      usage?: QwenTeachingLiveUsage;
    }
  | {
      kind: "provider.error";
      providerError: QwenTeachingLiveSafeProviderError;
    }
  | { kind: "other"; providerType: string; responseId?: string };

type MarkerCounts = Record<string, number>;

/**
 * Runs the narrow Qwen D01T-D03T text-input protocol smoke.
 *
 * The caller must inject the transport explicitly. This module does not read
 * configuration, credentials, databases, CLI arguments, or production relay
 * state, and it never returns or persists Provider response text.
 */
export async function runQwenTeachingTextProtocolSmoke(
  input: QwenTeachingLiveAdapterInput,
): Promise<QwenTeachingLiveSmokeResult> {
  const setup = await runAtCheckpoint("adapter_setup", () => {
    const config = requireInput(input);
    const compiled = compileFixtures();
    const markers = requireExactFixtureMarkers();
    return { config, compiled, markers };
  });
  const { config, compiled, markers } = setup;
  const cases: QwenTeachingLiveSmokeResult["cases"] = [];
  const usage = emptyUsage();
  const instructionAcks: InstructionAckAccumulator = {
    echoedMatch: 0,
    omitted: 0,
  };

  const pairedSession = await QwenTeachingLiveSession.connect(config, {
    connect: "session_1_connect",
    sessionCreated: "session_1_session_created",
  });
  await runWithBoundedSessionClose(
    pairedSession,
    "session_1_close",
    async () => {
      await runAtCheckpoint("session_1_modalities_update_ack", () =>
        pairedSession.configureTextOnly(),
      );
      const d01InstructionAck = await runAtCheckpoint(
        "d01t_directive_update_ack",
        async () => {
          const disposition = await pairedSession.updateInstructions(
            compiled.stateA.instructions,
            compiled.stateA.instructionHash,
          );
          recordInstructionAck(instructionAcks, disposition);
          return disposition;
        },
      );
      await runAtCheckpoint("d01t_case", async () => {
        const d01 = await pairedSession.runFixedTextResponse(
          Object.values(markers),
          markers.A,
        );
        addUsage(usage, d01.usage);
        assertExactMarkerState({
          caseId: "D01T",
          expectedState: "A",
          activeInstructionAck: d01InstructionAck,
          observedInstructionAcks:
            snapshotObservedInstructionAcks(instructionAcks),
          markerCounts: d01.markerCounts,
          markers,
          hasUnexpectedText: d01.hasUnexpectedText,
          progress: { session: 1, attempt: 1, completed: 0, failed: 1 },
          usage,
        });
        cases.push({
          id: "D01T",
          status: "protocol_sequence_completed",
          expectedMarkerCount: d01.markerCounts[markers.A] ?? 0,
          forbiddenMarkerCount: sumMarkerCounts(d01.markerCounts, [
            markers.B,
            markers.C,
          ]),
        });
      });

      const d02InstructionAck = await runAtCheckpoint(
        "d02t_restore_update_ack",
        async () => {
          const disposition = await pairedSession.updateInstructions(
            compiled.stateC.instructions,
            compiled.stateC.instructionHash,
          );
          recordInstructionAck(instructionAcks, disposition);
          return disposition;
        },
      );
      await runAtCheckpoint("d02t_case", async () => {
        const d02 = await pairedSession.runFixedTextResponse(
          Object.values(markers),
          markers.C,
        );
        addUsage(usage, d02.usage);
        assertExactMarkerState({
          caseId: "D02T",
          expectedState: "C",
          activeInstructionAck: d02InstructionAck,
          observedInstructionAcks:
            snapshotObservedInstructionAcks(instructionAcks),
          markerCounts: d02.markerCounts,
          markers,
          hasUnexpectedText: d02.hasUnexpectedText,
          progress: { session: 1, attempt: 2, completed: 1, failed: 1 },
          usage,
        });
        cases.push({
          id: "D02T",
          status: "protocol_sequence_completed",
          expectedMarkerCount: d02.markerCounts[markers.C] ?? 0,
          forbiddenMarkerCount: sumMarkerCounts(d02.markerCounts, [
            markers.A,
            markers.B,
          ]),
        });
      });
    },
  );

  const orderingSession = await QwenTeachingLiveSession.connect(config, {
    connect: "session_2_connect",
    sessionCreated: "session_2_session_created",
  });
  await runWithBoundedSessionClose(
    orderingSession,
    "session_2_close",
    async () => {
      await runAtCheckpoint("session_2_modalities_update_ack", () =>
        orderingSession.configureTextOnly(),
      );
      await runAtCheckpoint("d03t_directive_a_update_ack", async () => {
        const disposition = await orderingSession.updateInstructions(
          compiled.stateA.instructions,
          compiled.stateA.instructionHash,
        );
        recordInstructionAck(instructionAcks, disposition);
      });
      const d03InstructionAck = await runAtCheckpoint(
        "d03t_directive_b_update_ack",
        async () => {
          const disposition = await orderingSession.updateInstructions(
            compiled.stateB.instructions,
            compiled.stateB.instructionHash,
          );
          recordInstructionAck(instructionAcks, disposition);
          return disposition;
        },
      );
      await runAtCheckpoint("d03t_case", async () => {
        const d03 = await orderingSession.runFixedTextResponse(
          Object.values(markers),
          markers.B,
        );
        addUsage(usage, d03.usage);
        assertExactMarkerState({
          caseId: "D03T",
          expectedState: "B",
          activeInstructionAck: d03InstructionAck,
          observedInstructionAcks:
            snapshotObservedInstructionAcks(instructionAcks),
          markerCounts: d03.markerCounts,
          markers,
          hasUnexpectedText: d03.hasUnexpectedText,
          progress: { session: 2, attempt: 3, completed: 2, failed: 1 },
          usage,
        });
        cases.push({
          id: "D03T",
          status: "protocol_sequence_completed",
          expectedMarkerCount: d03.markerCounts[markers.B] ?? 0,
          forbiddenMarkerCount: sumMarkerCounts(d03.markerCounts, [
            markers.A,
            markers.C,
          ]),
        });
      });
      await runAtCheckpoint("d03t_restore_update_ack", async () =>
        recordInstructionAck(
          instructionAcks,
          await orderingSession.updateInstructions(
            compiled.stateC.instructions,
            compiled.stateC.instructionHash,
          ),
        ),
      );
    },
  );

  return {
    schemaVersion: 3,
    provider: "qwen",
    inputMode: "text",
    fixtureRevision: TEACHING_SPIKE_FIXTURE_REVISION,
    fixtureHash: TEACHING_SPIKE_FIXTURE_HASH,
    inputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
    scope: {
      transport: "isolated_provider_websocket",
      relayExercised: false,
      browserExercised: false,
    },
    providerEvidence: false,
    upstreamSessions: 2,
    responseAttempts: 3,
    instructionAcks: finalizeInstructionAcks(instructionAcks),
    usage,
    cases,
  };
}

type ResolvedInput = Omit<QwenTeachingLiveAdapterInput, "timeouts"> & {
  timeouts: QwenTeachingLiveTimeouts;
};

class QwenTeachingLiveSession {
  private readonly inbox = new LiveEventInbox();
  private readonly seenServerEventIds = new Set<string>();
  private readonly seenResponseIds = new Set<string>();
  private inboundBytes = 0;
  private inboundEvents = 0;
  private sessionId: string | null = null;
  private textOnlySessionConfirmed = false;
  private sessionUpdatePending = false;
  private activeResponseId: string | null = null;
  private failed = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;

  private constructor(
    private readonly socket: WebSocket,
    private readonly config: ResolvedInput,
  ) {
    socket.on("message", (data, isBinary) => {
      if (this.closing || this.failed) return;
      try {
        this.recordInboundMessage(data);
        this.inbox.push(
          sanitizeServerEvent(data, isBinary, this.seenServerEventIds),
        );
      } catch (error) {
        this.failSession(normalizeAdapterError(error));
      }
    });
    socket.on("error", () => {
      if (!this.closing) this.failSession(adapterError("NETWORK_ERROR"));
    });
    socket.on("close", () => {
      if (!this.closing) this.failSession(adapterError("CONNECTION_CLOSED"));
    });
  }

  static async connect(
    config: ResolvedInput,
    checkpoints: Readonly<{
      connect: QwenTeachingLiveCheckpoint;
      sessionCreated: QwenTeachingLiveCheckpoint;
    }>,
  ): Promise<QwenTeachingLiveSession> {
    let socket: WebSocket;
    try {
      socket = config.webSocketFactory(
        buildQwenRealtimeWebSocketUrl(config.endpoint, config.model).toString(),
        {
          headers: { Authorization: `Bearer ${config.apiKey}` },
          handshakeTimeout: config.timeouts.socketOpenMs,
          maxPayload: MAX_UPSTREAM_MESSAGE_BYTES,
          perMessageDeflate: false,
        },
      );
    } catch {
      throw checkpointAdapterError(
        adapterError("NETWORK_ERROR"),
        checkpoints.connect,
      );
    }

    const session = new QwenTeachingLiveSession(socket, config);
    try {
      await runAtCheckpoint(checkpoints.connect, () =>
        waitForSocketOpen(socket, config.timeouts.socketOpenMs),
      );
      await runAtCheckpoint(checkpoints.sessionCreated, async () => {
        const created = await session.expectEvent(
          "session.created",
          config.timeouts.sessionCreatedMs,
          "SESSION_CREATED_TIMEOUT",
        );
        if (created.session.model !== config.model) {
          throw adapterError("SESSION_MODEL_MISMATCH");
        }
        session.sessionId = created.session.id;
      });
      return session;
    } catch (error) {
      const primaryError = normalizeAdapterError(error);
      try {
        await session.close();
      } catch {
        // Preserve the protocol/opening failure after attempting bounded close.
      }
      throw primaryError;
    }
  }

  async configureTextOnly(): Promise<void> {
    const updated = await this.exchangeSessionUpdate({
      modalities: ["text"],
    });
    this.assertSessionIdentityAndTextOnly(updated.session);
    this.textOnlySessionConfirmed = true;
  }

  async updateInstructions(
    instructions: string,
    instructionHash: string,
  ): Promise<QwenTeachingLiveInstructionAckDisposition> {
    if (!/^[a-f0-9]{64}$/u.test(instructionHash)) {
      throw adapterError("INVALID_INSTRUCTION_HASH");
    }
    if (!this.textOnlySessionConfirmed) {
      throw adapterError("SESSION_CONFIGURATION_MISMATCH");
    }
    const updated = await this.exchangeSessionUpdate({ instructions });
    this.assertSessionIdentityAndTextOnly(updated.session);
    if (updated.session.instructionsHash === undefined) return "omitted";
    if (updated.session.instructionsHash !== instructionHash) {
      throw adapterError("INSTRUCTION_ACK_MISMATCH");
    }
    return "echoed_match";
  }

  async runFixedTextResponse(
    markers: string[],
    expectedToken: string,
  ): Promise<{
    markerCounts: MarkerCounts;
    hasUnexpectedText: boolean;
    usage: QwenTeachingLiveUsage;
  }> {
    if (this.sessionUpdatePending || this.activeResponseId) {
      throw adapterError("TURN_NOT_IDLE");
    }

    const userItemId = createClientItemId();
    this.send(
      qwenLiveUserTextItemCreateEventSchema.parse({
        type: "conversation.item.create",
        item: {
          id: userItemId,
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: QWEN_LIVE_TEACHING_EXACT_FIXTURES.userText.text,
            },
          ],
        },
      }),
    );
    const itemCreated = await this.expectEvent(
      "conversation.item.created",
      this.config.timeouts.itemCreatedMs,
      "ITEM_CREATED_TIMEOUT",
    );
    if (
      itemCreated.itemId !== userItemId ||
      itemCreated.role !== "user" ||
      itemCreated.status !== "completed"
    ) {
      throw adapterError("USER_ITEM_ACK_MISMATCH");
    }

    const requestedResponseModalities = ["text"] as const;
    this.send(
      qwenLiveResponseCreateEventSchema.parse({
        type: "response.create",
        response: { modalities: requestedResponseModalities },
      }),
    );
    const responseCreated = await this.expectEvent(
      "response.created",
      this.config.timeouts.responseCreatedMs,
      "RESPONSE_CREATED_TIMEOUT",
    );
    if (this.seenResponseIds.has(responseCreated.responseId)) {
      throw adapterError("DUPLICATE_RESPONSE_ID");
    }
    if (
      responseCreated.modalities === undefined
        ? !this.textOnlySessionConfirmed
        : !sameModalities(
            responseCreated.modalities,
            requestedResponseModalities,
          )
    ) {
      throw adapterError("RESPONSE_MODALITY_MISMATCH");
    }
    this.seenResponseIds.add(responseCreated.responseId);
    this.activeResponseId = responseCreated.responseId;

    let transcriptDeltas = "";
    let transcriptDeltaReceived = false;
    let finalTranscript: string | undefined;
    let transcriptDoneReceived = false;
    let assistantItemId: string | null = null;
    let outputItemAdded = false;
    let contentPartAdded = false;
    let contentPartDone = false;
    let outputItemDone = false;
    const bindAssistantItem = (itemId: string): void => {
      if (assistantItemId !== null && assistantItemId !== itemId) {
        throw adapterError("RESPONSE_OUTPUT_BINDING_MISMATCH");
      }
      assistantItemId = itemId;
    };
    const deadline = Date.now() + this.config.timeouts.responseDoneMs;
    try {
      while (true) {
        const event = await this.inbox.next(
          remainingMs(deadline, "RESPONSE_DONE_TIMEOUT"),
          "RESPONSE_DONE_TIMEOUT",
        );
        if (event.kind === "provider.error") {
          throw adapterError("PROVIDER_ERROR", event.providerError);
        }
        if (event.kind === "response.created") {
          throw adapterError("DUPLICATE_RESPONSE_CREATED");
        }
        if (event.kind === "response.transcript.delta") {
          this.requireResponseId(event.responseId);
          if (transcriptDoneReceived || contentPartDone || outputItemDone) {
            throw adapterError("UNEXPECTED_SERVER_EVENT");
          }
          requirePrimaryTextPosition(event.outputIndex, event.contentIndex);
          bindAssistantItem(event.itemId);
          if (outputItemAdded && !contentPartAdded) {
            throw adapterError("UNEXPECTED_SERVER_EVENT");
          }
          transcriptDeltaReceived = true;
          if (
            event.text.length >
            QWEN_TEACHING_LIVE_MAX_TRANSCRIPT_CHARACTERS -
              transcriptDeltas.length
          ) {
            throw adapterError("RESPONSE_TRANSCRIPT_TOO_LARGE");
          }
          transcriptDeltas += event.text;
          continue;
        }
        if (event.kind === "response.transcript.done") {
          this.requireResponseId(event.responseId);
          requirePrimaryTextPosition(event.outputIndex, event.contentIndex);
          bindAssistantItem(event.itemId);
          if (outputItemAdded && !contentPartAdded) {
            throw adapterError("UNEXPECTED_SERVER_EVENT");
          }
          if (transcriptDoneReceived) {
            throw adapterError("DUPLICATE_TRANSCRIPT_DONE");
          }
          transcriptDoneReceived = true;
          requireBoundedTranscript(event.text);
          if (transcriptDeltaReceived) {
            requireMatchingTranscript(transcriptDeltas, event.text);
          }
          finalTranscript = event.text;
          continue;
        }
        if (event.kind === "response.output_item.added") {
          this.requireResponseId(event.responseId);
          requirePrimaryTextPosition(event.outputIndex);
          bindAssistantItem(event.itemId);
          if (
            outputItemAdded ||
            transcriptDeltaReceived ||
            transcriptDoneReceived
          ) {
            throw adapterError("UNEXPECTED_SERVER_EVENT");
          }
          outputItemAdded = true;
          continue;
        }
        if (event.kind === "response.content_part.added") {
          this.requireResponseId(event.responseId);
          requirePrimaryTextPosition(event.outputIndex, event.contentIndex);
          bindAssistantItem(event.itemId);
          if (
            !outputItemAdded ||
            contentPartAdded ||
            transcriptDeltaReceived ||
            transcriptDoneReceived
          ) {
            throw adapterError("UNEXPECTED_SERVER_EVENT");
          }
          contentPartAdded = true;
          continue;
        }
        if (event.kind === "response.content_part.done") {
          this.requireResponseId(event.responseId);
          requirePrimaryTextPosition(event.outputIndex, event.contentIndex);
          bindAssistantItem(event.itemId);
          requireBoundedTranscript(event.text);
          if (
            !contentPartAdded ||
            !transcriptDoneReceived ||
            finalTranscript === undefined ||
            contentPartDone
          ) {
            throw adapterError("UNEXPECTED_SERVER_EVENT");
          }
          requireMatchingTranscript(finalTranscript, event.text);
          contentPartDone = true;
          continue;
        }
        if (event.kind === "response.output_item.done") {
          this.requireResponseId(event.responseId);
          requirePrimaryTextPosition(event.outputIndex);
          bindAssistantItem(event.itemId);
          requireBoundedTranscript(event.text);
          if (
            !outputItemAdded ||
            !contentPartDone ||
            !transcriptDoneReceived ||
            finalTranscript === undefined ||
            outputItemDone
          ) {
            throw adapterError("UNEXPECTED_SERVER_EVENT");
          }
          requireMatchingTranscript(finalTranscript, event.text);
          outputItemDone = true;
          continue;
        }
        if (event.kind === "conversation.item.created") {
          if (event.role !== "assistant") {
            throw adapterError("UNEXPECTED_SERVER_EVENT");
          }
          bindAssistantItem(event.itemId);
          continue;
        }
        if (event.kind === "response.done") {
          this.requireResponseId(event.responseId);
          if (event.status !== "completed") {
            throw adapterError("RESPONSE_NOT_COMPLETED");
          }
          if (!event.usage) throw adapterError("RESPONSE_USAGE_MISSING");
          assertUsageWithinReservation(event.usage);
          if (!transcriptDoneReceived || finalTranscript === undefined) {
            throw adapterError("RESPONSE_TEXT_DONE_MISSING");
          }
          if (
            outputItemAdded !== contentPartAdded ||
            outputItemAdded !== contentPartDone ||
            outputItemAdded !== outputItemDone
          ) {
            throw adapterError("UNEXPECTED_SERVER_EVENT");
          }
          if (event.terminalItemId !== undefined) {
            bindAssistantItem(event.terminalItemId);
          }
          if (event.terminalTranscript !== undefined) {
            requireBoundedTranscript(event.terminalTranscript);
            requireMatchingTranscript(
              finalTranscript,
              event.terminalTranscript,
            );
          }
          const transcript = finalTranscript;
          if (!transcript) throw adapterError("RESPONSE_TRANSCRIPT_MISSING");
          requireBoundedTranscript(transcript);
          const counts = countMarkers(transcript, markers);
          return {
            markerCounts: counts,
            hasUnexpectedText: transcript.trim() !== expectedToken,
            usage: event.usage,
          };
        }
        throw adapterError("UNEXPECTED_SERVER_EVENT");
      }
    } finally {
      this.activeResponseId = null;
    }
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeBounded();
    await this.closePromise;
  }

  private async closeBounded(): Promise<void> {
    this.closing = true;
    this.inbox.fail(adapterError("CONNECTION_CLOSED"));
    if (this.socket.readyState === WebSocket.CLOSED) return;

    try {
      if (this.socket.readyState === WebSocket.CONNECTING) {
        this.socket.terminate();
      } else if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.close(1000, "Teaching smoke complete");
      }
    } catch {
      tryTerminate(this.socket);
    }

    if (
      await waitForSocketClose(this.socket, this.config.timeouts.socketCloseMs)
    ) {
      return;
    }

    tryTerminate(this.socket);
    if (await waitForSocketClose(this.socket, FORCE_CLOSE_GRACE_MS)) return;
    throw adapterError("SOCKET_CLOSE_TIMEOUT");
  }

  private recordInboundMessage(data: RawData): void {
    this.inboundEvents += 1;
    if (this.inboundEvents > QWEN_TEACHING_LIVE_MAX_SESSION_INBOUND_EVENTS) {
      throw adapterError("UPSTREAM_SESSION_EVENTS_EXCEEDED");
    }

    const messageBytes = rawDataByteLength(data);
    if (messageBytes === 0 || messageBytes > MAX_UPSTREAM_MESSAGE_BYTES) {
      throw adapterError("INVALID_SERVER_EVENT");
    }
    this.inboundBytes += messageBytes;
    if (this.inboundBytes > QWEN_TEACHING_LIVE_MAX_SESSION_INBOUND_BYTES) {
      throw adapterError("UPSTREAM_SESSION_BYTES_EXCEEDED");
    }
  }

  private failSession(error: QwenTeachingLiveAdapterError): void {
    if (this.failed || this.closing) return;
    this.failed = true;
    this.inbox.fail(error);
    void this.close().catch(() => undefined);
  }

  private async exchangeSessionUpdate(
    session: QwenLiveSessionUpdatePatch["session"],
  ): Promise<Extract<SanitizedServerEvent, { kind: "session.updated" }>> {
    if (this.sessionUpdatePending) {
      throw adapterError("UPDATE_ALREADY_PENDING");
    }
    if (this.activeResponseId) throw adapterError("TURN_NOT_IDLE");

    const event = qwenLiveSessionUpdatePatchSchema.parse({
      type: "session.update",
      session,
    });
    this.sessionUpdatePending = true;
    try {
      this.send(event);
      const updated = await this.expectEvent(
        "session.updated",
        this.config.timeouts.updateAckMs,
        "UPDATE_ACK_TIMEOUT",
      );
      return updated;
    } finally {
      this.sessionUpdatePending = false;
    }
  }

  private assertSessionIdentityAndTextOnly(session: SafeSessionSnapshot): void {
    if (
      session.model !== this.config.model ||
      session.id !== this.sessionId ||
      !isTextOnlyModalities(session.modalities)
    ) {
      throw adapterError("SESSION_CONFIGURATION_MISMATCH");
    }
  }

  private requireResponseId(responseId: string): void {
    if (!this.activeResponseId || responseId !== this.activeResponseId) {
      throw adapterError("RESPONSE_ID_MISMATCH");
    }
  }

  private send(value: object): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw adapterError("CONNECTION_CLOSED");
    }
    try {
      this.socket.send(JSON.stringify(value), (error) => {
        if (error && !this.closing) {
          this.inbox.fail(adapterError("NETWORK_ERROR"));
        }
      });
    } catch {
      throw adapterError("NETWORK_ERROR");
    }
  }

  private async expectEvent<K extends SanitizedServerEvent["kind"]>(
    kind: K,
    timeoutMs: number,
    timeoutCode: QwenTeachingLiveAdapterErrorCode,
  ): Promise<Extract<SanitizedServerEvent, { kind: K }>> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const event = await this.inbox.next(
        remainingMs(deadline, timeoutCode),
        timeoutCode,
      );
      if (event.kind === "provider.error") {
        throw adapterError("PROVIDER_ERROR", event.providerError);
      }
      if (event.kind !== kind) {
        throw adapterError("UNEXPECTED_SERVER_EVENT");
      }
      return event as Extract<SanitizedServerEvent, { kind: K }>;
    }
  }
}

async function runWithBoundedSessionClose(
  session: QwenTeachingLiveSession,
  closeCheckpoint: QwenTeachingLiveCheckpoint,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    try {
      await session.close();
    } catch {
      // The original protocol failure remains the actionable safe error.
    }
    throw error;
  }
  await runAtCheckpoint(closeCheckpoint, () => session.close());
}

class LiveEventInbox {
  private readonly events: SanitizedServerEvent[] = [];
  private readonly waiters: Array<{
    resolve: (event: SanitizedServerEvent) => void;
    reject: (error: QwenTeachingLiveAdapterError) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private failure: QwenTeachingLiveAdapterError | null = null;

  push(event: SanitizedServerEvent): void {
    if (this.failure) return;
    const waiter = this.waiters.shift();
    if (!waiter) {
      if (this.events.length >= QWEN_TEACHING_LIVE_MAX_INBOX_DEPTH) {
        throw adapterError("UPSTREAM_INBOX_OVERFLOW");
      }
      this.events.push(event);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(event);
  }

  fail(error: QwenTeachingLiveAdapterError): void {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.events.length = 0;
  }

  async next(
    timeoutMs: number,
    timeoutCode: QwenTeachingLiveAdapterErrorCode,
  ): Promise<SanitizedServerEvent> {
    if (this.failure) throw this.failure;
    const event = this.events.shift();
    if (event) return event;
    if (timeoutMs <= 0) throw adapterError(timeoutCode);

    return await new Promise<SanitizedServerEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex(
          (candidate) => candidate.timer === timer,
        );
        if (index >= 0) this.waiters.splice(index, 1);
        reject(adapterError(timeoutCode));
      }, timeoutMs);
      timer.unref();
      this.waiters.push({ resolve, reject, timer });
    });
  }
}

function sanitizeServerEvent(
  data: RawData,
  isBinary: boolean,
  seenEventIds: Set<string>,
): SanitizedServerEvent {
  if (isBinary) throw adapterError("INVALID_SERVER_EVENT");
  const buffer = rawDataToBuffer(data);
  if (
    buffer.byteLength === 0 ||
    buffer.byteLength > MAX_UPSTREAM_MESSAGE_BYTES
  ) {
    throw adapterError("INVALID_SERVER_EVENT");
  }

  let value: unknown;
  try {
    value = JSON.parse(buffer.toString("utf8")) as unknown;
  } catch {
    throw adapterError("INVALID_SERVER_EVENT");
  }
  const envelope = qwenServerEventSchema.safeParse(value);
  if (
    !envelope.success ||
    !envelope.data.event_id ||
    envelope.data.event_id.length > QWEN_REALTIME_MAX_IDENTIFIER_CHARACTERS ||
    envelope.data.type.length > QWEN_REALTIME_MAX_EVENT_TYPE_CHARACTERS
  ) {
    throw adapterError("INVALID_SERVER_EVENT");
  }
  if (seenEventIds.has(envelope.data.event_id)) {
    throw adapterError("DUPLICATE_SERVER_EVENT_ID");
  }
  seenEventIds.add(envelope.data.event_id);

  switch (envelope.data.type) {
    case "session.created": {
      const event = parseLiveEvent(
        qwenLiveSessionCreatedEventSchema,
        value,
        "INVALID_SESSION_CREATED_EVENT",
      );
      return { kind: "session.created", session: safeSession(event.session) };
    }
    case "session.updated": {
      const event = parseLiveEvent(
        qwenLiveSessionUpdatedEventSchema,
        value,
        "INVALID_SESSION_UPDATED_EVENT",
      );
      return { kind: "session.updated", session: safeSession(event.session) };
    }
    case "conversation.item.created": {
      const event = parseLiveEvent(
        qwenLiveConversationItemCreatedEventSchema,
        value,
        "INVALID_CONVERSATION_ITEM_CREATED_EVENT",
      );
      return {
        kind: "conversation.item.created",
        itemId: event.item.id,
        role: event.item.role,
        status: event.item.status,
      };
    }
    case "response.created": {
      const event = parseLiveEvent(
        qwenResponseCreatedEventSchema,
        value,
        "INVALID_RESPONSE_CREATED_EVENT",
      );
      return {
        kind: "response.created",
        responseId: event.response.id,
        ...(event.response.modalities === undefined
          ? {}
          : { modalities: [...event.response.modalities] }),
      };
    }
    case "response.text.delta": {
      const event = parseLiveEvent(
        qwenResponseTextDeltaEventSchema,
        value,
        "INVALID_RESPONSE_TEXT_DELTA_EVENT",
      );
      return {
        kind: "response.transcript.delta",
        responseId: event.response_id,
        itemId: event.item_id,
        outputIndex: event.output_index,
        contentIndex: event.content_index,
        text: event.delta,
      };
    }
    case "response.text.done": {
      const event = parseLiveEvent(
        qwenResponseTextDoneEventSchema,
        value,
        "INVALID_RESPONSE_TEXT_DONE_EVENT",
      );
      return {
        kind: "response.transcript.done",
        responseId: event.response_id,
        itemId: event.item_id,
        outputIndex: event.output_index,
        contentIndex: event.content_index,
        text: event.text,
      };
    }
    case "response.output_item.added": {
      if (responseOutputItemHasAudio(value)) {
        throw adapterError("UNEXPECTED_AUDIO_OUTPUT");
      }
      const event = parseLiveEvent(
        qwenLiveResponseOutputItemAddedEventSchema,
        value,
        "INVALID_RESPONSE_OUTPUT_ITEM_ADDED_EVENT",
      );
      return {
        kind: "response.output_item.added",
        responseId: event.response_id,
        itemId: event.item.id,
        outputIndex: event.output_index,
      };
    }
    case "response.content_part.added": {
      if (responsePartIsAudio(value)) {
        throw adapterError("UNEXPECTED_AUDIO_OUTPUT");
      }
      const event = parseLiveEvent(
        qwenLiveResponseContentPartAddedEventSchema,
        value,
        "INVALID_RESPONSE_CONTENT_PART_ADDED_EVENT",
      );
      return {
        kind: "response.content_part.added",
        responseId: event.response_id,
        itemId: event.item_id,
        outputIndex: event.output_index,
        contentIndex: event.content_index,
      };
    }
    case "response.content_part.done": {
      if (responsePartIsAudio(value)) {
        throw adapterError("UNEXPECTED_AUDIO_OUTPUT");
      }
      const event = parseLiveEvent(
        qwenLiveResponseContentPartDoneEventSchema,
        value,
        "INVALID_RESPONSE_CONTENT_PART_DONE_EVENT",
      );
      return {
        kind: "response.content_part.done",
        responseId: event.response_id,
        itemId: event.item_id,
        outputIndex: event.output_index,
        contentIndex: event.content_index,
        text: event.part.text,
      };
    }
    case "response.output_item.done": {
      if (responseOutputItemHasAudio(value)) {
        throw adapterError("UNEXPECTED_AUDIO_OUTPUT");
      }
      const event = parseLiveEvent(
        qwenLiveResponseOutputItemDoneEventSchema,
        value,
        "INVALID_RESPONSE_OUTPUT_ITEM_DONE_EVENT",
      );
      return {
        kind: "response.output_item.done",
        responseId: event.response_id,
        itemId: event.item.id,
        outputIndex: event.output_index,
        text: event.item.content[0].text,
      };
    }
    case "response.audio.delta":
    case "response.audio.done":
    case "response.audio_transcript.delta":
    case "response.audio_transcript.done":
      throw adapterError("UNEXPECTED_AUDIO_OUTPUT");
    case "response.done": {
      const event = parseLiveEvent(
        qwenResponseDoneEventSchema,
        value,
        "INVALID_RESPONSE_DONE_EVENT",
      );
      const terminalText = extractStrictTerminalText(value);
      const completed =
        event.response.status === "completed"
          ? parseLiveEvent(
              qwenLiveResponseDoneEventSchema,
              value,
              "INVALID_RESPONSE_DONE_EVENT",
            )
          : null;
      return {
        kind: "response.done",
        responseId: event.response.id,
        status: event.response.status,
        ...(terminalText === undefined
          ? {}
          : {
              terminalTranscript: terminalText.text,
              terminalItemId: terminalText.itemId,
            }),
        ...(completed ? { usage: safeUsage(completed.response.usage) } : {}),
      };
    }
    case "error": {
      const error = readObjectProperty(value, "error");
      if (!error) throw adapterError("INVALID_PROVIDER_ERROR_EVENT");
      return {
        kind: "provider.error",
        providerError: sanitizeProviderError(error),
      };
    }
    default: {
      const responseId = readBoundedIdentifierProperty(value, "response_id");
      return {
        kind: "other",
        providerType: envelope.data.type,
        ...(responseId ? { responseId } : {}),
      };
    }
  }
}

function parseLiveEvent<T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  value: unknown,
  errorCode: QwenTeachingLiveAdapterErrorCode,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw adapterError(errorCode);
  return parsed.data;
}

function safeSession(value: {
  id: string;
  model: string;
  modalities: Array<"text" | "audio">;
  instructions?: string;
}): SafeSessionSnapshot {
  return {
    id: value.id,
    model: value.model,
    modalities: [...value.modalities],
    ...(value.instructions === undefined
      ? {}
      : { instructionsHash: hashTeachingFixture(value.instructions) }),
  };
}

function isTextOnlyModalities(
  modalities: ReadonlyArray<"text" | "audio">,
): boolean {
  return modalities.length === 1 && modalities[0] === "text";
}

function sameModalities(
  actual: ReadonlyArray<"text" | "audio">,
  expected: ReadonlyArray<"text" | "audio">,
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function responsePartIsAudio(value: unknown): boolean {
  const part = readObjectProperty(value, "part");
  return part !== null && isExplicitAudioPart(part);
}

function responseOutputItemHasAudio(value: unknown): boolean {
  const item = readObjectProperty(value, "item");
  return item !== null && itemHasExplicitAudioPart(item);
}

function itemHasExplicitAudioPart(item: Record<string, unknown>): boolean {
  const content = Reflect.get(item, "content");
  return (
    Array.isArray(content) &&
    content.some((part) => isRecord(part) && isExplicitAudioPart(part))
  );
}

function isExplicitAudioPart(part: Record<string, unknown>): boolean {
  return (
    Reflect.get(part, "type") === "audio" ||
    typeof Reflect.get(part, "transcript") === "string"
  );
}

function extractStrictTerminalText(
  value: unknown,
): Readonly<{ itemId: string; text: string }> | undefined {
  const response = readObjectProperty(value, "response");
  const output = response ? Reflect.get(response, "output") : undefined;
  if (output === undefined || (Array.isArray(output) && output.length === 0)) {
    return undefined;
  }
  if (!Array.isArray(output)) {
    throw adapterError("INVALID_RESPONSE_DONE_EVENT");
  }
  for (const candidate of output) {
    if (isRecord(candidate) && itemHasExplicitAudioPart(candidate)) {
      throw adapterError("UNEXPECTED_AUDIO_OUTPUT");
    }
  }
  if (output.length !== 1 || !isRecord(output[0])) {
    throw adapterError("INVALID_RESPONSE_DONE_EVENT");
  }
  const item = output[0];
  const itemId = Reflect.get(item, "id");
  const content = Reflect.get(item, "content");
  if (
    typeof itemId !== "string" ||
    itemId.length === 0 ||
    itemId.length > QWEN_REALTIME_MAX_IDENTIFIER_CHARACTERS ||
    Reflect.get(item, "object") !== "realtime.item" ||
    Reflect.get(item, "type") !== "message" ||
    Reflect.get(item, "status") !== "completed" ||
    Reflect.get(item, "role") !== "assistant" ||
    !Array.isArray(content) ||
    content.length !== 1 ||
    !isRecord(content[0]) ||
    Reflect.get(content[0], "type") !== "text" ||
    typeof Reflect.get(content[0], "text") !== "string"
  ) {
    throw adapterError("INVALID_RESPONSE_DONE_EVENT");
  }
  const text = Reflect.get(content[0], "text") as string;
  requireBoundedTranscript(text);
  return Object.freeze({ itemId, text });
}

function readObjectProperty(
  value: unknown,
  property: string,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const nested = Reflect.get(value, property);
  return isRecord(nested) ? nested : null;
}

function sanitizeProviderError(
  value: Record<string, unknown>,
): QwenTeachingLiveSafeProviderError {
  const type = readOwnProviderErrorField(value, "type");
  const code = readOwnProviderErrorField(value, "code");
  const param = readOwnProviderErrorField(value, "param");
  return Object.freeze({
    typeCategory: mapProviderErrorType(type),
    codeCategory: mapProviderErrorCode(code),
    paramCategory: mapProviderErrorParam(param),
  });
}

type ProviderErrorField =
  Readonly<{ present: false }> | Readonly<{ present: true; value: unknown }>;

function readOwnProviderErrorField(
  value: Record<string, unknown>,
  field: "type" | "code" | "param",
): ProviderErrorField {
  return Object.prototype.hasOwnProperty.call(value, field)
    ? { present: true, value: Reflect.get(value, field) }
    : { present: false };
}

function mapProviderErrorType(
  field: ProviderErrorField,
): QwenTeachingLiveSafeProviderError["typeCategory"] {
  if (!field.present) return "missing";
  switch (field.value) {
    case "invalid_request_error":
      return "invalid_request";
    case "server_error":
      return "server";
    default:
      return "unrecognized";
  }
}

function mapProviderErrorCode(
  field: ProviderErrorField,
): QwenTeachingLiveSafeProviderError["codeCategory"] {
  if (!field.present) return "missing";
  return field.value === "invalid_value" ? "invalid_value" : "unrecognized";
}

function mapProviderErrorParam(
  field: ProviderErrorField,
): QwenTeachingLiveSafeProviderError["paramCategory"] {
  if (!field.present) return "missing";
  switch (field.value) {
    case "session.update":
      return "session_update";
    case "session":
    case "session.voice":
    case "session.input_audio_format":
    case "session.output_audio_format":
    case "session.turn_detection":
    case "session.turn_detection.type":
    case "session.max_history_turns":
    case "session.modalities":
    case "session.instructions":
      return "session_configuration";
    case "conversation.item.create":
      return "conversation_item_create";
    case "response.create":
      return "response_create";
    default:
      return "unrecognized";
  }
}

function readBoundedIdentifierProperty(
  value: unknown,
  property: string,
): string | null {
  if (!isRecord(value)) return null;
  const nested = Reflect.get(value, property);
  if (nested === undefined) return null;
  if (
    typeof nested !== "string" ||
    nested.length === 0 ||
    nested.length > QWEN_REALTIME_MAX_IDENTIFIER_CHARACTERS
  ) {
    throw adapterError("INVALID_SERVER_EVENT");
  }
  return nested;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function rawDataByteLength(data: RawData): number {
  if (!Array.isArray(data)) return data.byteLength;
  let total = 0;
  for (const chunk of data) {
    total += chunk.byteLength;
    if (!Number.isSafeInteger(total)) return Number.POSITIVE_INFINITY;
  }
  return total;
}

function compileFixtures() {
  const common = {
    base: QWEN_LIVE_TEACHING_EXACT_FIXTURES.neutralBase.text,
    safety: TEACHING_SPIKE_FIXTURES.safety.text,
    maxCharacters: MAX_INSTRUCTIONS_CHARACTERS,
  };
  return {
    stateA: compileTeachingInstructions({
      ...common,
      directive: QWEN_LIVE_TEACHING_EXACT_FIXTURES.stateA.text,
    }),
    stateB: compileTeachingInstructions({
      ...common,
      directive: QWEN_LIVE_TEACHING_EXACT_FIXTURES.stateB.text,
    }),
    stateC: compileTeachingInstructions({
      ...common,
      directive: QWEN_LIVE_TEACHING_EXACT_FIXTURES.stateC.text,
    }),
  };
}

function requireExactFixtureMarkers(): typeof QWEN_LIVE_TEACHING_EXACT_MARKERS {
  const markers = Object.values(QWEN_LIVE_TEACHING_EXACT_MARKERS);
  if (
    markers.some((marker) => !marker || marker.trim() !== marker) ||
    new Set(markers).size !== markers.length ||
    markers.some((marker, index) =>
      markers.some(
        (candidate, candidateIndex) =>
          index !== candidateIndex && candidate.includes(marker),
      ),
    )
  ) {
    throw adapterError("INVALID_FIXTURE_MARKER");
  }
  const markerSets = [
    QWEN_LIVE_TEACHING_EXACT_FIXTURES.neutralBase.text,
    TEACHING_SPIKE_FIXTURES.safety.text,
    QWEN_LIVE_TEACHING_EXACT_FIXTURES.userText.text,
  ];
  if (
    markerSets.some((text) => markers.some((marker) => text.includes(marker)))
  ) {
    throw adapterError("INVALID_FIXTURE_MARKER");
  }
  for (const [state, fixture] of [
    ["A", QWEN_LIVE_TEACHING_EXACT_FIXTURES.stateA.text],
    ["B", QWEN_LIVE_TEACHING_EXACT_FIXTURES.stateB.text],
    ["C", QWEN_LIVE_TEACHING_EXACT_FIXTURES.stateC.text],
  ] as const) {
    const counts = countMarkers(fixture, markers);
    if (
      markers.some(
        (marker) =>
          (counts[marker] ?? 0) !==
          (marker === QWEN_LIVE_TEACHING_EXACT_MARKERS[state] ? 1 : 0),
      )
    ) {
      throw adapterError("INVALID_FIXTURE_MARKER");
    }
  }
  return QWEN_LIVE_TEACHING_EXACT_MARKERS;
}

function recordInstructionAck(
  aggregate: InstructionAckAccumulator,
  disposition: QwenTeachingLiveInstructionAckDisposition,
): void {
  if (disposition === "echoed_match") aggregate.echoedMatch += 1;
  else aggregate.omitted += 1;
  if (
    !Number.isSafeInteger(aggregate.echoedMatch) ||
    !Number.isSafeInteger(aggregate.omitted) ||
    aggregate.echoedMatch + aggregate.omitted > 5
  ) {
    throw adapterError("INSTRUCTION_ACK_MISMATCH");
  }
}

function snapshotObservedInstructionAcks(
  aggregate: InstructionAckAccumulator,
): QwenTeachingLiveMarkerFailureObservation["observedInstructionAcks"] {
  const total = aggregate.echoedMatch + aggregate.omitted;
  if (
    aggregate.echoedMatch < 0 ||
    aggregate.omitted < 0 ||
    !Number.isSafeInteger(aggregate.echoedMatch) ||
    !Number.isSafeInteger(aggregate.omitted) ||
    !Number.isSafeInteger(total) ||
    total > 5
  ) {
    throw adapterError("INSTRUCTION_ACK_MISMATCH");
  }
  return Object.freeze({
    total,
    echoedMatch: aggregate.echoedMatch,
    omitted: aggregate.omitted,
  });
}

function finalizeInstructionAcks(
  aggregate: InstructionAckAccumulator,
): QwenTeachingLiveInstructionAcks {
  if (
    aggregate.echoedMatch < 0 ||
    aggregate.omitted < 0 ||
    !Number.isSafeInteger(aggregate.echoedMatch) ||
    !Number.isSafeInteger(aggregate.omitted) ||
    aggregate.echoedMatch + aggregate.omitted !== 5
  ) {
    throw adapterError("INSTRUCTION_ACK_MISMATCH");
  }
  return Object.freeze({
    total: 5,
    echoedMatch: aggregate.echoedMatch,
    omitted: aggregate.omitted,
  });
}

function requireBoundedTranscript(transcript: string): void {
  if (transcript.length > QWEN_TEACHING_LIVE_MAX_TRANSCRIPT_CHARACTERS) {
    throw adapterError("RESPONSE_TRANSCRIPT_TOO_LARGE");
  }
}

function requirePrimaryTextPosition(
  outputIndex: number,
  contentIndex?: number,
): void {
  if (outputIndex !== 0 || (contentIndex !== undefined && contentIndex !== 0)) {
    throw adapterError("RESPONSE_OUTPUT_BINDING_MISMATCH");
  }
}

function requireMatchingTranscript(earlier: string, later: string): void {
  if (earlier !== later) {
    throw adapterError("RESPONSE_TRANSCRIPT_MISMATCH");
  }
}

function safeUsage(value: QwenLiveResponseUsage): QwenTeachingLiveUsage {
  return {
    totalTokens: value.total_tokens,
    inputTokens: value.input_tokens,
    outputTokens: value.output_tokens,
    inputTextTokens: value.input_tokens_details.text_tokens,
    inputAudioTokens: value.input_tokens_details.audio_tokens ?? 0,
    outputTextTokens: value.output_tokens_details.text_tokens,
    outputAudioTokens: value.output_tokens_details.audio_tokens ?? 0,
  };
}

function assertUsageWithinReservation(usage: QwenTeachingLiveUsage): void {
  if (
    usage.inputAudioTokens !== 0 ||
    usage.outputAudioTokens !== 0 ||
    usage.inputTextTokens >
      QWEN_TEACHING_LIVE_MAX_INPUT_TEXT_TOKENS_PER_RESPONSE ||
    usage.outputTextTokens >
      QWEN_TEACHING_LIVE_MAX_OUTPUT_TEXT_TOKENS_PER_RESPONSE
  ) {
    throw adapterError("RESPONSE_USAGE_EXCEEDS_RESERVATION");
  }
}

function emptyUsage(): QwenTeachingLiveUsage {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    inputTextTokens: 0,
    inputAudioTokens: 0,
    outputTextTokens: 0,
    outputAudioTokens: 0,
  };
}

function addUsage(
  aggregate: QwenTeachingLiveUsage,
  response: QwenTeachingLiveUsage,
): void {
  for (const key of Object.keys(aggregate) as Array<
    keyof QwenTeachingLiveUsage
  >) {
    const next = aggregate[key] + response[key];
    if (!Number.isSafeInteger(next)) {
      throw adapterError("RESPONSE_USAGE_OVERFLOW");
    }
    aggregate[key] = next;
  }
}

function countMarkers(text: string, markers: string[]): MarkerCounts {
  const counts: MarkerCounts = {};
  for (const marker of new Set(markers)) {
    let count = 0;
    let offset = 0;
    while (true) {
      const index = text.indexOf(marker, offset);
      if (index < 0) break;
      count += 1;
      offset = index + marker.length;
    }
    counts[marker] = count;
  }
  return counts;
}

function assertExactMarkerState(input: {
  caseId: QwenTeachingLiveCaseId;
  expectedState: "A" | "B" | "C";
  activeInstructionAck: QwenTeachingLiveInstructionAckDisposition;
  observedInstructionAcks: QwenTeachingLiveMarkerFailureObservation["observedInstructionAcks"];
  markerCounts: MarkerCounts;
  markers: typeof QWEN_LIVE_TEACHING_EXACT_MARKERS;
  hasUnexpectedText: boolean;
  progress: QwenTeachingLiveMarkerFailureObservation["progress"];
  usage: QwenTeachingLiveUsage;
}): void {
  const expectedCounts = {
    A: input.expectedState === "A" ? 1 : 0,
    B: input.expectedState === "B" ? 1 : 0,
    C: input.expectedState === "C" ? 1 : 0,
  } as const;
  const markerCountsMatch = (
    Object.keys(input.markers) as Array<"A" | "B" | "C">
  ).every(
    (state) =>
      (input.markerCounts[input.markers[state]] ?? 0) === expectedCounts[state],
  );
  if (markerCountsMatch && !input.hasUnexpectedText) return;

  throw markerAssertionError({
    caseId: input.caseId,
    expectedState: input.expectedState,
    activeInstructionAck: input.activeInstructionAck,
    observedInstructionAcks: input.observedInstructionAcks,
    markerMultiplicity: {
      a: markerMultiplicity(input.markerCounts[input.markers.A] ?? 0),
      b: markerMultiplicity(input.markerCounts[input.markers.B] ?? 0),
      c: markerMultiplicity(input.markerCounts[input.markers.C] ?? 0),
    },
    hasUnexpectedText: input.hasUnexpectedText,
    progress: input.progress,
    usage: input.usage,
  });
}

function markerMultiplicity(count: number): QwenTeachingLiveMarkerMultiplicity {
  if (count === 0) return "zero";
  if (count === 1) return "one";
  return "multiple";
}

function sumMarkerCounts(counts: MarkerCounts, markers: string[]): number {
  return markers.reduce((sum, marker) => sum + (counts[marker] ?? 0), 0);
}

function requireInput(input: QwenTeachingLiveAdapterInput): ResolvedInput {
  const endpoint = input.endpoint.trim();
  const apiKey = input.apiKey.trim();
  const model = input.model.trim();
  const voice = input.voice.trim();
  if (!endpoint || !apiKey || !model || !voice) {
    throw adapterError("INVALID_CONFIGURATION");
  }
  const timeouts = { ...DEFAULT_TIMEOUTS, ...input.timeouts };
  for (const key of Object.keys(DEFAULT_TIMEOUTS) as Array<
    keyof QwenTeachingLiveTimeouts
  >) {
    const value = timeouts[key];
    if (
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > DEFAULT_TIMEOUTS[key]
    ) {
      throw adapterError("INVALID_CONFIGURATION");
    }
  }
  return {
    endpoint,
    apiKey,
    model,
    voice,
    webSocketFactory: input.webSocketFactory,
    timeouts,
  };
}

async function waitForSocketOpen(
  socket: WebSocket,
  timeoutMs: number,
): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  if (socket.readyState !== WebSocket.CONNECTING) {
    throw adapterError("NETWORK_ERROR");
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("open", handleOpen);
      socket.off("error", handleError);
      socket.off("close", handleClose);
    };
    const handleOpen = (): void => {
      cleanup();
      resolve();
    };
    const handleError = (): void => {
      cleanup();
      reject(adapterError("NETWORK_ERROR"));
    };
    const handleClose = (): void => {
      cleanup();
      reject(adapterError("CONNECTION_CLOSED"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(adapterError("SOCKET_OPEN_TIMEOUT"));
    }, timeoutMs);
    timer.unref();
    socket.once("open", handleOpen);
    socket.once("error", handleError);
    socket.once("close", handleClose);
  });
}

async function waitForSocketClose(
  socket: WebSocket,
  timeoutMs: number,
): Promise<boolean> {
  if (socket.readyState === WebSocket.CLOSED) return true;
  return await new Promise<boolean>((resolve) => {
    const handleClose = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      socket.off("close", handleClose);
      resolve(socket.readyState === WebSocket.CLOSED);
    }, timeoutMs);
    timer.unref();
    socket.once("close", handleClose);
  });
}

function tryTerminate(socket: WebSocket): void {
  try {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  } catch {
    // The bounded close check below determines whether termination completed.
  }
}

function remainingMs(
  deadline: number,
  timeoutCode: QwenTeachingLiveAdapterErrorCode,
): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw adapterError(timeoutCode);
  return remaining;
}

function createClientItemId(): string {
  return `item_${randomUUID()}`;
}

export const QWEN_TEACHING_LIVE_ADAPTER_ERROR_CODES = Object.freeze([
  "INVALID_CONFIGURATION",
  "INVALID_FIXTURE_MARKER",
  "INVALID_INSTRUCTION_HASH",
  "NETWORK_ERROR",
  "SOCKET_OPEN_TIMEOUT",
  "SOCKET_CLOSE_TIMEOUT",
  "SESSION_CREATED_TIMEOUT",
  "UPDATE_ACK_TIMEOUT",
  "ITEM_CREATED_TIMEOUT",
  "RESPONSE_CREATED_TIMEOUT",
  "RESPONSE_DONE_TIMEOUT",
  "CONNECTION_CLOSED",
  "INVALID_SERVER_EVENT",
  "INVALID_SESSION_CREATED_EVENT",
  "INVALID_SESSION_UPDATED_EVENT",
  "INVALID_CONVERSATION_ITEM_CREATED_EVENT",
  "INVALID_RESPONSE_CREATED_EVENT",
  "INVALID_RESPONSE_TEXT_DELTA_EVENT",
  "INVALID_RESPONSE_TEXT_DONE_EVENT",
  "INVALID_RESPONSE_OUTPUT_ITEM_ADDED_EVENT",
  "INVALID_RESPONSE_CONTENT_PART_ADDED_EVENT",
  "INVALID_RESPONSE_CONTENT_PART_DONE_EVENT",
  "INVALID_RESPONSE_OUTPUT_ITEM_DONE_EVENT",
  "INVALID_RESPONSE_DONE_EVENT",
  "INVALID_PROVIDER_ERROR_EVENT",
  "DUPLICATE_SERVER_EVENT_ID",
  "UPSTREAM_SESSION_BYTES_EXCEEDED",
  "UPSTREAM_SESSION_EVENTS_EXCEEDED",
  "UPSTREAM_INBOX_OVERFLOW",
  "UNEXPECTED_SERVER_EVENT",
  "PROVIDER_ERROR",
  "SESSION_MODEL_MISMATCH",
  "SESSION_CONFIGURATION_MISMATCH",
  "UPDATE_ALREADY_PENDING",
  "INSTRUCTION_ACK_MISMATCH",
  "TURN_NOT_IDLE",
  "USER_ITEM_ACK_MISMATCH",
  "DUPLICATE_RESPONSE_CREATED",
  "DUPLICATE_RESPONSE_ID",
  "DUPLICATE_TRANSCRIPT_DONE",
  "RESPONSE_ID_MISMATCH",
  "RESPONSE_OUTPUT_BINDING_MISMATCH",
  "RESPONSE_MODALITY_MISMATCH",
  "UNEXPECTED_AUDIO_OUTPUT",
  "RESPONSE_NOT_COMPLETED",
  "RESPONSE_USAGE_MISSING",
  "RESPONSE_USAGE_EXCEEDS_RESERVATION",
  "RESPONSE_USAGE_OVERFLOW",
  "RESPONSE_TRANSCRIPT_MISSING",
  "RESPONSE_TEXT_DONE_MISSING",
  "RESPONSE_TRANSCRIPT_MISMATCH",
  "RESPONSE_TRANSCRIPT_TOO_LARGE",
  "MARKER_ASSERTION_FAILED",
] as const);

export type QwenTeachingLiveAdapterErrorCode =
  (typeof QWEN_TEACHING_LIVE_ADAPTER_ERROR_CODES)[number];

const markerFailureObservations = new WeakMap<
  QwenTeachingLiveAdapterError,
  QwenTeachingLiveMarkerFailureObservation
>();

export class QwenTeachingLiveAdapterError extends Error {
  public readonly providerError?: QwenTeachingLiveSafeProviderError;

  constructor(
    public readonly code: QwenTeachingLiveAdapterErrorCode,
    public readonly caseId?: QwenTeachingLiveCaseId,
    public readonly checkpoint?: QwenTeachingLiveCheckpoint,
    providerError?: QwenTeachingLiveSafeProviderError,
  ) {
    super(code);
    this.name = "QwenTeachingLiveAdapterError";
    this.providerError =
      code === "PROVIDER_ERROR"
        ? copySafeProviderError(providerError)
        : undefined;
  }
}

export function getQwenTeachingLiveMarkerFailureObservation(
  error: unknown,
): QwenTeachingLiveMarkerFailureObservation | undefined {
  if (!(error instanceof QwenTeachingLiveAdapterError)) return undefined;
  return markerFailureObservations.get(error);
}

function markerAssertionError(
  observation: QwenTeachingLiveMarkerFailureObservation,
): QwenTeachingLiveAdapterError {
  const safeObservation = copySafeMarkerFailureObservation(observation);
  if (!safeObservation) return adapterError("INVALID_SERVER_EVENT");
  const error = new QwenTeachingLiveAdapterError(
    "MARKER_ASSERTION_FAILED",
    safeObservation.caseId,
  );
  markerFailureObservations.set(error, safeObservation);
  return error;
}

function adapterError(
  code: QwenTeachingLiveAdapterErrorCode,
  providerError?: QwenTeachingLiveSafeProviderError,
): QwenTeachingLiveAdapterError {
  return new QwenTeachingLiveAdapterError(
    code,
    undefined,
    undefined,
    providerError,
  );
}

function normalizeAdapterError(error: unknown): QwenTeachingLiveAdapterError {
  return error instanceof QwenTeachingLiveAdapterError
    ? error
    : adapterError("INVALID_SERVER_EVENT");
}

async function runAtCheckpoint<Result>(
  checkpoint: QwenTeachingLiveCheckpoint,
  operation: () => Result | Promise<Result>,
): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    throw checkpointAdapterError(error, checkpoint);
  }
}

function checkpointAdapterError(
  error: unknown,
  checkpoint: QwenTeachingLiveCheckpoint,
): QwenTeachingLiveAdapterError {
  const normalized = normalizeAdapterError(error);
  if (
    normalized.checkpoint !== undefined &&
    QWEN_TEACHING_LIVE_CHECKPOINTS.includes(normalized.checkpoint)
  ) {
    return normalized;
  }
  const checkpointed = new QwenTeachingLiveAdapterError(
    normalized.code,
    normalized.caseId,
    checkpoint,
    normalized.providerError,
  );
  const markerFailure = markerFailureObservations.get(normalized);
  if (markerFailure) {
    markerFailureObservations.set(checkpointed, markerFailure);
  }
  return checkpointed;
}

function copySafeProviderError(
  value: QwenTeachingLiveSafeProviderError | undefined,
): QwenTeachingLiveSafeProviderError | undefined {
  if (
    value === undefined ||
    !QWEN_TEACHING_LIVE_PROVIDER_ERROR_TYPE_CATEGORIES.includes(
      value.typeCategory,
    ) ||
    !QWEN_TEACHING_LIVE_PROVIDER_ERROR_CODE_CATEGORIES.includes(
      value.codeCategory,
    ) ||
    !QWEN_TEACHING_LIVE_PROVIDER_ERROR_PARAM_CATEGORIES.includes(
      value.paramCategory,
    )
  ) {
    return undefined;
  }
  return Object.freeze({
    typeCategory: value.typeCategory,
    codeCategory: value.codeCategory,
    paramCategory: value.paramCategory,
  });
}

function copySafeMarkerFailureObservation(
  value: QwenTeachingLiveMarkerFailureObservation,
): QwenTeachingLiveMarkerFailureObservation | undefined {
  const expected = markerFailureExpectation(value.caseId);
  if (
    !expected ||
    value.expectedState !== expected.expectedState ||
    value.progress.session !== expected.session ||
    value.progress.attempt !== expected.attempt ||
    value.progress.completed !== expected.completed ||
    value.progress.failed !== 1 ||
    value.observedInstructionAcks.total !== expected.observedAckTotal ||
    !QWEN_TEACHING_LIVE_INSTRUCTION_ACK_DISPOSITIONS.includes(
      value.activeInstructionAck,
    ) ||
    !isSafeObservedInstructionAcks(value.observedInstructionAcks) ||
    !isActiveAckObserved(
      value.activeInstructionAck,
      value.observedInstructionAcks,
    ) ||
    !QWEN_TEACHING_LIVE_MARKER_MULTIPLICITIES.includes(
      value.markerMultiplicity.a,
    ) ||
    !QWEN_TEACHING_LIVE_MARKER_MULTIPLICITIES.includes(
      value.markerMultiplicity.b,
    ) ||
    !QWEN_TEACHING_LIVE_MARKER_MULTIPLICITIES.includes(
      value.markerMultiplicity.c,
    ) ||
    typeof value.hasUnexpectedText !== "boolean"
  ) {
    return undefined;
  }
  const usage = copySafeCumulativeUsage(value.usage);
  if (!usage) return undefined;

  return Object.freeze({
    caseId: value.caseId,
    expectedState: value.expectedState,
    activeInstructionAck: value.activeInstructionAck,
    observedInstructionAcks: Object.freeze({
      total: value.observedInstructionAcks.total,
      echoedMatch: value.observedInstructionAcks.echoedMatch,
      omitted: value.observedInstructionAcks.omitted,
    }),
    markerMultiplicity: Object.freeze({
      a: value.markerMultiplicity.a,
      b: value.markerMultiplicity.b,
      c: value.markerMultiplicity.c,
    }),
    hasUnexpectedText: value.hasUnexpectedText,
    progress: Object.freeze({
      session: value.progress.session,
      attempt: value.progress.attempt,
      completed: value.progress.completed,
      failed: 1,
    }),
    usage,
  });
}

function markerFailureExpectation(caseId: QwenTeachingLiveCaseId):
  | Readonly<{
      expectedState: "A" | "B" | "C";
      session: 1 | 2;
      attempt: 1 | 2 | 3;
      completed: 0 | 1 | 2;
      observedAckTotal: 1 | 2 | 4;
    }>
  | undefined {
  switch (caseId) {
    case "D01T":
      return {
        expectedState: "A",
        session: 1,
        attempt: 1,
        completed: 0,
        observedAckTotal: 1,
      };
    case "D02T":
      return {
        expectedState: "C",
        session: 1,
        attempt: 2,
        completed: 1,
        observedAckTotal: 2,
      };
    case "D03T":
      return {
        expectedState: "B",
        session: 2,
        attempt: 3,
        completed: 2,
        observedAckTotal: 4,
      };
  }
}

function isSafeObservedInstructionAcks(
  value: QwenTeachingLiveMarkerFailureObservation["observedInstructionAcks"],
): boolean {
  return (
    Number.isSafeInteger(value.total) &&
    Number.isSafeInteger(value.echoedMatch) &&
    Number.isSafeInteger(value.omitted) &&
    value.total >= 0 &&
    value.echoedMatch >= 0 &&
    value.omitted >= 0 &&
    value.total === value.echoedMatch + value.omitted
  );
}

function isActiveAckObserved(
  disposition: QwenTeachingLiveInstructionAckDisposition,
  aggregate: QwenTeachingLiveMarkerFailureObservation["observedInstructionAcks"],
): boolean {
  return disposition === "echoed_match"
    ? aggregate.echoedMatch >= 1
    : aggregate.omitted >= 1;
}

function copySafeCumulativeUsage(
  value: Readonly<QwenTeachingLiveUsage>,
): Readonly<QwenTeachingLiveUsage> | undefined {
  const keys = [
    "totalTokens",
    "inputTokens",
    "outputTokens",
    "inputTextTokens",
    "inputAudioTokens",
    "outputTextTokens",
    "outputAudioTokens",
  ] as const;
  if (
    keys.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0) ||
    value.inputAudioTokens !== 0 ||
    value.outputAudioTokens !== 0 ||
    value.totalTokens !== value.inputTokens + value.outputTokens ||
    value.inputTokens !== value.inputTextTokens + value.inputAudioTokens ||
    value.outputTokens !== value.outputTextTokens + value.outputAudioTokens
  ) {
    return undefined;
  }
  return Object.freeze({
    totalTokens: value.totalTokens,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    inputTextTokens: value.inputTextTokens,
    inputAudioTokens: value.inputAudioTokens,
    outputTextTokens: value.outputTextTokens,
    outputAudioTokens: value.outputAudioTokens,
  });
}
