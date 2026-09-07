import { once } from "node:events";

import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import {
  QWEN_CONTROLLED_TEACHING_CONTENT_IDS,
  findQwenControlledTeachingContent,
} from "../src/teaching/content-catalog.js";
import { compileQwenTeachingDirective } from "../src/teaching/directive-compiler.js";
import {
  QwenTeachingSessionController,
  classifyTeachingSafetyTranscript,
  type QwenTeachingInvitationClaim,
  type QwenTeachingPersistenceEvent,
  type QwenTeachingRuntimeSnapshot,
  type QwenTeachingSessionDependencies,
  type QwenTeachingSessionSnapshot,
} from "../src/teaching/qwen-teaching-session-controller.js";
import { relayQwenWebSocket } from "../src/qwen-websocket.js";

const BASE_INSTRUCTIONS = "你是星盾队长，陪孩子自然、安全地聊天。";
const BASE_SESSION: QwenTeachingSessionSnapshot = Object.freeze({
  id: "session-teaching-1",
  model: "qwen-audio-3.0-realtime-plus",
  modalities: ["text", "audio"],
  voice: "longanqian",
  inputAudioFormat: "pcm",
  outputAudioFormat: "pcm",
  instructions: BASE_INSTRUCTIONS,
  maxHistoryTurns: 20,
  turnDetection: "smart_turn",
});

const DEFAULT_RUNTIME: QwenTeachingRuntimeSnapshot = Object.freeze({
  provider: "qwen",
  enabled: true,
  subject: "math",
  difficulty: "starter",
  triggerMode: "on_request",
  startedAtMs: 1_000,
  eligibleForGentle: false,
  validUserTurns: 0,
  invitationCount: 0,
});

function runtimeContent(
  id: (typeof QWEN_CONTROLLED_TEACHING_CONTENT_IDS)[number],
) {
  const content = findQwenControlledTeachingContent(id);
  if (!content) throw new Error("Missing controlled teaching fixture.");
  return {
    id: content.id,
    directive: content.directive,
    maximumAssistantResponses: content.maximumAssistantResponses,
  } as const;
}

const servers: WebSocketServer[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("Qwen controlled teaching content", () => {
  it("contains one bounded branch for each selectable subject", () => {
    expect(QWEN_CONTROLLED_TEACHING_CONTENT_IDS).toEqual([
      "english-space-orbit-v1",
      "math-space-supplies-v1",
      "science-space-gravity-v1",
    ]);
    expect(
      QWEN_CONTROLLED_TEACHING_CONTENT_IDS.map(
        (id) => findQwenControlledTeachingContent(id)?.subject,
      ),
    ).toEqual(["english", "math", "science"]);
    expect(
      QWEN_CONTROLLED_TEACHING_CONTENT_IDS.map(
        (id) =>
          findQwenControlledTeachingContent(id)?.maximumAssistantResponses,
      ),
    ).toEqual([2, 2, 2]);
  });

  it("compiles distinct explicit and gentle instructions without wire fields", () => {
    const content = findQwenControlledTeachingContent(
      "science-space-gravity-v1",
    );
    if (!content) throw new Error("science fixture missing");
    const explicit = compileQwenTeachingDirective({
      baseInstructions: BASE_INSTRUCTIONS,
      content,
      difficulty: "growing",
      trigger: "on_request",
    });
    const gentle = compileQwenTeachingDirective({
      baseInstructions: BASE_INSTRUCTIONS,
      content,
      difficulty: "growing",
      trigger: "gentle",
    });

    expect(explicit.instructionHash).not.toBe(gentle.instructionHash);
    expect(explicit.instructions).toContain("已经通过应用按钮明确请求");
    expect(gentle.instructions).toContain("低打扰候选");
    expect(explicit.instructions).not.toContain("on_request");
    expect(gentle.instructions).not.toContain("triggerMode");
  });
});

describe("QwenTeachingSessionController", () => {
  it("applies a generated finite-plan directive returned by the server", async () => {
    const generatedDirective =
      "第一次只问固定题目：4 个小队，每队 3 人。固定答案 12；第二次只反馈这一题。";
    const harness = createControllerHarness({
      runtime: { ...DEFAULT_RUNTIME, subject: "math" },
      claimInvitation: vi.fn(async () => ({
        claimed: true,
        content: {
          id: "multiply-4-by-3",
          directive: generatedDirective,
          maximumAssistantResponses: 2,
        },
      })),
    });

    const effective = await driveControllerActive(harness);

    expect(effective).toContain(generatedDirective);
    expect(effective).toContain("不可覆盖的儿童教学安全规则");
    expect(harness.upstream).toContainEqual({
      type: "response.create",
      response: { modalities: ["audio", "text"] },
    });
  });

  it("runs one server-owned directive and restores the exact base", async () => {
    const harness = createControllerHarness();
    const directive = await driveControllerActive(harness);

    expect(directive).toContain("3 个补给箱");
    expect(directive).not.toContain("orbit");
    expect(harness.claimInvitation).toHaveBeenCalledWith({
      trigger: "on_request",
      subject: "math",
      difficulty: "starter",
      elapsedMs: 9_000,
      validUserTurns: 0,
    });
    expect(harness.upstream[0]).toEqual({
      type: "session.update",
      session: { instructions: directive },
    });
    expect(harness.upstream[0]).not.toHaveProperty("event_id");
    expect(harness.upstream[1]).toEqual({
      type: "response.create",
      response: { modalities: ["audio", "text"] },
    });
    expect(harness.upstream[1]).not.toHaveProperty("event_id");

    expect(
      harness.controller.handleProviderEvent(responseCreated("response-1")),
    ).toEqual({ forward: true });
    expect(
      harness.controller.handleProviderEvent(responseDone("response-1")),
    ).toEqual({ forward: true });
    expect(
      harness.clientFrames.filter(
        ({ type, open }) =>
          type === "relay.teaching.audio_gate" && open === false,
      ),
    ).toHaveLength(1);
    expect(
      harness.upstream.filter(({ type }) => type === "response.create"),
    ).toHaveLength(1);

    emitSpeechTurn(harness.controller, {
      itemId: "answer-1",
      transcript: "一共有六瓶水",
    });
    expect(
      harness.controller.handleProviderEvent(
        responseCreated("response-feedback-1"),
      ),
    ).toEqual({ forward: true });
    expect(
      harness.controller.handleProviderEvent(
        responseDone("response-feedback-1"),
      ),
    ).toEqual({ forward: true });
    const closeForRestore = await waitForGate(harness.clientFrames, false, 2);
    acknowledgeGate(harness.controller, closeForRestore, "gate-close-restore");
    await vi.waitFor(() => expect(harness.upstream).toHaveLength(3));
    expect(harness.upstream[2]).toEqual({
      type: "session.update",
      session: { instructions: BASE_INSTRUCTIONS },
    });
    expect(
      harness.controller.handleProviderEvent(
        sessionUpdated(BASE_INSTRUCTIONS, "ack-base-restore"),
      ),
    ).toEqual({ forward: false });
    const openAfterRestore = await waitForGate(harness.clientFrames, true, 3);
    acknowledgeGate(harness.controller, openAfterRestore, "gate-open-final");
    await vi.waitFor(() =>
      expect(harness.clientFrames).toContainEqual(
        expect.objectContaining({
          type: "relay.teaching.state",
          state: "completed",
        }),
      ),
    );

    expect(harness.persisted.map(({ kind }) => kind)).toEqual([
      "restoring",
      "completed",
    ]);
    expect(JSON.stringify(harness.clientFrames)).not.toContain(
      BASE_INSTRUCTIONS,
    );
    expect(JSON.stringify(harness.persisted)).not.toContain("3 个补给箱");
    expect(harness.closed).toEqual([]);
  });

  it("fails closed on an instruction ACK with the wrong echo", async () => {
    const harness = createControllerHarness();
    await configureController(harness);
    harness.controller.handleClientFrame({
      type: "relay.teaching.request",
      event_id: "request-1",
    });
    const closeGate = await waitForGate(harness.clientFrames, false, 1);
    acknowledgeGate(harness.controller, closeGate, "gate-close");
    await vi.waitFor(() => expect(harness.upstream).toHaveLength(1));

    expect(
      harness.controller.handleProviderEvent(
        sessionUpdated("attacker supplied instructions", "bad-ack"),
      ),
    ).toEqual({ forward: false });
    expect(harness.closed).toEqual(["protocol_mismatch"]);
    expect(harness.clientFrames).not.toContainEqual(
      expect.objectContaining({ state: "active" }),
    );
  });

  it("fails closed when an internal instruction ACK omits the echo", async () => {
    const harness = createControllerHarness();
    await configureController(harness);
    harness.controller.handleClientFrame({
      type: "relay.teaching.request",
      event_id: "request-1",
    });
    const closeGate = await waitForGate(harness.clientFrames, false, 1);
    acknowledgeGate(harness.controller, closeGate, "gate-close");
    await vi.waitFor(() => expect(harness.upstream).toHaveLength(1));

    expect(
      harness.controller.handleProviderEvent(
        sparseSessionUpdated("apply-ack-without-instructions"),
      ),
    ).toEqual({ forward: false });
    expect(harness.closed).toEqual(["protocol_mismatch"]);
  });

  it("fails closed when the base ACK event id is replayed for an internal update", async () => {
    const harness = createControllerHarness();
    await configureController(harness);
    harness.controller.handleClientFrame({
      type: "relay.teaching.request",
      event_id: "request-1",
    });
    const closeGate = await waitForGate(harness.clientFrames, false, 1);
    acknowledgeGate(harness.controller, closeGate, "gate-close");
    await vi.waitFor(() => expect(harness.upstream).toHaveLength(1));
    const directive = (
      harness.upstream[0]?.session as { instructions?: string } | undefined
    )?.instructions;
    if (!directive) throw new Error("directive update missing");

    expect(
      harness.controller.handleProviderEvent(
        sessionUpdated(directive, "base-ack"),
      ),
    ).toEqual({ forward: false });
    expect(harness.closed).toEqual(["protocol_mismatch"]);
  });

  it.each([
    ["session id", { id: "different-session" }],
    ["model", { model: "qwen-audio-3.0-realtime-flash" }],
    ["modalities", { modalities: ["text"] }],
    ["voice", { voice: "longanlingxin" }],
    ["turn detection", { turn_detection: { type: "server_vad" } }],
    ["input audio format", { input_audio_format: "wav" }],
    ["output audio format", { output_audio_format: "wav" }],
    ["maximum history turns", { max_history_turns: 49 }],
  ])(
    "fails closed when an internal ACK changes %s",
    async (_field, override) => {
      const harness = createControllerHarness();
      await configureController(harness);
      harness.controller.handleClientFrame({
        type: "relay.teaching.request",
        event_id: "request-1",
      });
      const closeGate = await waitForGate(harness.clientFrames, false, 1);
      acknowledgeGate(harness.controller, closeGate, "gate-close");
      await vi.waitFor(() => expect(harness.upstream).toHaveLength(1));
      const directive = (
        harness.upstream[0]?.session as { instructions?: string } | undefined
      )?.instructions;
      if (!directive) throw new Error("directive update missing");
      const acknowledgement = sessionUpdated(directive, "bad-ack");

      expect(
        harness.controller.handleProviderEvent({
          ...acknowledgement,
          session: { ...acknowledgement.session, ...override },
        }),
      ).toEqual({ forward: false });
      expect(harness.closed).toEqual(["protocol_mismatch"]);
      expect(harness.clientFrames).not.toContainEqual(
        expect.objectContaining({ state: "active" }),
      );
    },
  );

  it("closes safely when a browser gate ACK times out", async () => {
    vi.useFakeTimers();
    const harness = createControllerHarness({
      timeouts: { gateAckMs: 10, updateAckMs: 10, responseDoneMs: 10 },
    });
    harness.controller.configureBase(BASE_SESSION, "base-ack");
    await vi.advanceTimersByTimeAsync(11);
    expect(harness.closed).toEqual(["timeout"]);
  });

  it("records a gentle candidate but waits for response.done before applying", async () => {
    const now = 6 * 60 * 1_000;
    const harness = createControllerHarness({
      now: () => now,
      runtime: {
        ...DEFAULT_RUNTIME,
        triggerMode: "gentle",
        eligibleForGentle: true,
        startedAtMs: 0,
        validUserTurns: 5,
      },
      recordValidUserTurn: vi.fn(async () => ({
        recorded: true,
        validUserTurns: 6,
      })),
    });
    await configureController(harness);
    emitSpeechTurn(harness.controller, {
      itemId: "ordinary-speech-1",
      transcript: "今天聊得很开心",
    });
    await vi.waitFor(() =>
      expect(harness.recordValidUserTurn).toHaveBeenCalledTimes(1),
    );
    expect(harness.claimInvitation).not.toHaveBeenCalled();
    expect(harness.upstream).toEqual([]);
    expect(harness.clientFrames).not.toContainEqual(
      expect.objectContaining({
        type: "relay.teaching.audio_gate",
        open: false,
      }),
    );

    harness.controller.handleProviderEvent(responseCreated("ordinary-1"));
    harness.controller.handleProviderEvent(responseDone("ordinary-1"));
    await vi.waitFor(() =>
      expect(harness.claimInvitation).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: "gentle", validUserTurns: 6 }),
      ),
    );
    await waitForGate(harness.clientFrames, false, 1);
  });

  it("queues an explicit request while a stopped speech turn awaits its response", async () => {
    const harness = createControllerHarness();
    await configureController(harness);
    harness.controller.handleProviderEvent({
      event_id: "speech-started-1",
      type: "input_audio_buffer.speech_started",
      item_id: "speech-1",
    });
    harness.controller.handleProviderEvent({
      event_id: "speech-stopped-1",
      type: "input_audio_buffer.speech_stopped",
      item_id: "speech-1",
    });
    harness.controller.handleClientFrame({
      type: "relay.teaching.request",
      event_id: "request-after-speech",
    });
    expect(harness.claimInvitation).not.toHaveBeenCalled();
    expect(harness.upstream).toEqual([]);

    harness.controller.handleProviderEvent(responseCreated("ordinary-queued"));
    harness.controller.handleProviderEvent(responseDone("ordinary-queued"));
    await vi.waitFor(() =>
      expect(harness.claimInvitation).toHaveBeenCalledTimes(1),
    );
    await waitForGate(harness.clientFrames, false, 1);
  });

  it("suppresses the response admitted after a spoken refusal, then restores", async () => {
    const harness = createControllerHarness();
    await driveControllerActive(harness);

    harness.controller.handleProviderEvent({
      event_id: "transcript-refusal",
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "不要出题，我们只聊天",
    });
    const closeGate = await waitForGate(harness.clientFrames, false, 2);
    acknowledgeGate(harness.controller, closeGate, "gate-close-refusal");
    expect(harness.upstream).toHaveLength(2);

    expect(
      harness.controller.handleProviderEvent(responseCreated("response-race")),
    ).toEqual({ forward: false });
    await vi.waitFor(() =>
      expect(harness.upstream).toContainEqual({ type: "response.cancel" }),
    );
    expect(
      harness.controller.handleProviderEvent({
        event_id: "audio-race",
        type: "response.audio.delta",
        response_id: "response-race",
        item_id: "item-race",
        output_index: 0,
        content_index: 0,
        delta: "AAE=",
      }),
    ).toEqual({ forward: false });
    expect(
      harness.controller.handleProviderEvent(responseDone("response-race")),
    ).toEqual({ forward: false });
    await vi.waitFor(() =>
      expect(harness.upstream).toContainEqual({
        type: "session.update",
        session: { instructions: BASE_INSTRUCTIONS },
      }),
    );
    expect(harness.persisted).toContainEqual(
      expect.objectContaining({
        kind: "session_muted",
        reason: "explicit_refusal",
      }),
    );
    expect(JSON.stringify(harness.persisted)).not.toContain("不要出题");
    expect(harness.recordValidUserTurn).not.toHaveBeenCalled();
    expect(harness.closed).toEqual([]);
  });

  it("treats sensitive disclosure coarsely and does not classify 不知道 as refusal", async () => {
    expect(classifyTeachingSafetyTranscript("我不知道")).toBeNull();
    expect(classifyTeachingSafetyTranscript("我有点害怕，家里吵架")).toBe(
      "safety_priority",
    );
    const harness = createControllerHarness();
    await configureController(harness);
    harness.controller.handleProviderEvent({
      event_id: "sensitive-1",
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "我有点害怕，家里吵架",
    });
    await vi.waitFor(() =>
      expect(harness.persisted).toContainEqual(
        expect.objectContaining({
          kind: "session_muted",
          reason: "safety_priority",
        }),
      ),
    );
    expect(harness.recordValidUserTurn).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.persisted)).not.toContain("害怕");
    expect(JSON.stringify(harness.clientFrames)).not.toContain("家里吵架");
  });

  it("requires reliable speech termination before counting a semantic user turn", async () => {
    const harness = createControllerHarness();
    await configureController(harness);

    emitSpeechTurn(harness.controller, {
      itemId: "invalid-turn",
      transcript: "这句话不应计数",
      reason: "turn_invalid",
    });
    emitSpeechTurn(harness.controller, {
      itemId: "filler-turn",
      transcript: "嗯嗯",
    });
    emitSpeechTurn(harness.controller, {
      itemId: "control-turn",
      transcript: "现在来一个",
    });
    harness.controller.handleProviderEvent({
      event_id: "transcript-without-speech-signal",
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "missing-speech-item",
      transcript: "这段也不能计数",
    });
    await Promise.resolve();
    expect(harness.recordValidUserTurn).not.toHaveBeenCalled();

    emitSpeechTurn(harness.controller, {
      itemId: "valid-turn",
      transcript: "我不知道这个答案",
    });
    await vi.waitFor(() =>
      expect(harness.recordValidUserTurn).toHaveBeenCalledTimes(1),
    );
  });

  it("aborts a deferred claim that resolves after mute without applying or responding", async () => {
    let resolveClaim: ((claim: QwenTeachingInvitationClaim) => void) | null =
      null;
    const claimInvitation = vi.fn(
      () =>
        new Promise<QwenTeachingInvitationClaim>((resolve) => {
          resolveClaim = resolve;
        }),
    );
    const harness = createControllerHarness({ claimInvitation });
    await configureController(harness);

    harness.controller.handleClientFrame({
      type: "relay.teaching.request",
      event_id: "deferred-request-1",
    });
    await vi.waitFor(() => expect(claimInvitation).toHaveBeenCalledTimes(1));
    harness.controller.handleClientFrame({
      type: "relay.teaching.request",
      event_id: "deferred-request-duplicate",
    });
    harness.controller.handleClientFrame({
      type: "relay.teaching.mute",
      event_id: "mute-during-claim",
    });
    await vi.waitFor(() =>
      expect(harness.persisted).toContainEqual(
        expect.objectContaining({ kind: "session_muted" }),
      ),
    );
    const mutedGate = await waitForGate(harness.clientFrames, true, 2);
    acknowledgeGate(harness.controller, mutedGate, "mute-gate-ack");

    resolveClaim?.({
      claimed: true,
      content: runtimeContent("math-space-supplies-v1"),
    });
    await vi.waitFor(() =>
      expect(harness.persisted.map(({ kind }) => kind)).toEqual([
        "session_muted",
        "aborted",
      ]),
    );
    expect(harness.persisted[1]).toEqual(
      expect.objectContaining({
        kind: "aborted",
        contentItemId: "math-space-supplies-v1",
        reason: "user_control",
      }),
    );
    expect(claimInvitation).toHaveBeenCalledTimes(1);
    expect(harness.upstream).toEqual([]);
    expect(harness.closed).toEqual([]);
  });

  it("times out if the server-owned teaching response is never created", async () => {
    const harness = createControllerHarness({
      timeouts: { gateAckMs: 100, updateAckMs: 100, responseDoneMs: 10 },
    });
    await driveControllerActive(harness);
    await vi.waitFor(() => expect(harness.closed).toEqual(["timeout"]));
  });

  it("does not follow up without an answer, but times out after a valid answer has no response", async () => {
    const harness = createControllerHarness({
      timeouts: { gateAckMs: 100, updateAckMs: 100, responseDoneMs: 10 },
    });
    await driveControllerActive(harness);
    harness.controller.handleProviderEvent(responseCreated("invitation-only"));
    harness.controller.handleProviderEvent(responseDone("invitation-only"));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.closed).toEqual([]);
    expect(
      harness.upstream.filter(({ type }) => type === "response.create"),
    ).toHaveLength(1);
    expect(
      harness.clientFrames.filter(
        ({ type, open }) =>
          type === "relay.teaching.audio_gate" && open === false,
      ),
    ).toHaveLength(1);

    emitSpeechTurn(harness.controller, {
      itemId: "answer-without-provider-response",
      transcript: "答案是六瓶",
    });
    await vi.waitFor(() => expect(harness.closed).toEqual(["timeout"]));
  });

  it("fails closed when response.done arrives before the bound response.created", async () => {
    const harness = createControllerHarness();
    await driveControllerActive(harness);
    expect(
      harness.controller.handleProviderEvent(responseDone("unbound-response")),
    ).toEqual({ forward: false });
    expect(harness.closed).toEqual(["protocol_mismatch"]);
  });
});

describe("Qwen teaching WebSocket relay", () => {
  it("accepts an official minimal base ACK, requires exact internal ACKs, and rejects later browser instructions", async () => {
    const upstreamServer = createServer();
    const relayServer = createServer();
    await Promise.all([
      once(upstreamServer, "listening"),
      once(relayServer, "listening"),
    ]);
    const upstreamAddress = addressOf(upstreamServer);
    const relayAddress = addressOf(relayServer);
    const upstreamEvents: Array<Record<string, unknown>> = [];
    let upstreamSocket: WebSocket | null = null;
    upstreamServer.once("connection", (socket) => {
      upstreamSocket = socket;
      socket.on("message", (data) => {
        upstreamEvents.push(
          JSON.parse(data.toString()) as Record<string, unknown>,
        );
      });
    });
    const persistence: QwenTeachingPersistenceEvent[] = [];
    relayServer.once("connection", (client) => {
      relayQwenWebSocket({
        client,
        config: qwenConfig(),
        model: BASE_SESSION.model,
        runtime: {
          voice: BASE_SESSION.voice,
          instructions: BASE_INSTRUCTIONS,
        },
        teaching: {
          runtime: DEFAULT_RUNTIME,
          dependencies: {
            claimInvitation: async () => ({
              claimed: true,
              content: runtimeContent("math-space-supplies-v1"),
            }),
            recordValidUserTurn: async () => ({
              recorded: true,
              validUserTurns: 1,
            }),
            persistState: async (event) => {
              persistence.push(event);
            },
          },
        },
        webSocketFactory: (_url, options) =>
          new WebSocket(`ws://127.0.0.1:${upstreamAddress.port}`, options),
      });
    });

    const browser = new WebSocket(`ws://127.0.0.1:${relayAddress.port}`);
    const received: Array<Record<string, unknown>> = [];
    browser.on("message", (data) => {
      received.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    await once(browser, "open");
    await waitUntil(() => received.some(({ type }) => type === "relay.ready"));
    browser.send(JSON.stringify(baseSessionUpdate()));
    await waitUntil(() => upstreamEvents.length === 1);
    upstreamSocket?.send(JSON.stringify(sparseSessionUpdated("base-ack")));
    await waitUntil(
      () =>
        received.filter(
          ({ type, open }) =>
            type === "relay.teaching.audio_gate" && open === true,
        ).length === 1,
    );
    await waitUntil(() =>
      received.some(({ type }) => type === "session.updated"),
    );
    const initialGateIndex = received.findIndex(
      ({ type, open }) => type === "relay.teaching.audio_gate" && open === true,
    );
    const baseSessionUpdatedIndex = received.findIndex(
      ({ type }) => type === "session.updated",
    );
    expect(initialGateIndex).toBeGreaterThanOrEqual(0);
    expect(baseSessionUpdatedIndex).toBeGreaterThan(initialGateIndex);
    const initialGate = received.findLast(
      ({ type, open }) => type === "relay.teaching.audio_gate" && open === true,
    );
    browser.send(
      JSON.stringify({
        type: "relay.teaching.audio_gate_ack",
        event_id: "teaching-initial-gate-ack",
        revision: initialGate?.revision,
      }),
    );
    await waitUntil(() =>
      received.some(
        ({ type, state }) =>
          type === "relay.teaching.state" && state === "available",
      ),
    );

    browser.send(
      JSON.stringify({
        type: "relay.teaching.request",
        event_id: "teaching-request-1",
      }),
    );
    await waitUntil(() =>
      received.some(
        ({ type, open }) =>
          type === "relay.teaching.audio_gate" && open === false,
      ),
    );
    const closeGate = received.findLast(
      ({ type, open }) =>
        type === "relay.teaching.audio_gate" && open === false,
    );
    browser.send(
      JSON.stringify({
        event_id: "in-flight-audio-after-close",
        type: "input_audio_buffer.append",
        audio: "AAE=",
      }),
    );
    browser.send(
      JSON.stringify({
        type: "relay.teaching.audio_gate_ack",
        event_id: "teaching-gate-ack-1",
        revision: closeGate?.revision,
      }),
    );
    await waitUntil(() => upstreamEvents.length === 2);
    const internalUpdate = upstreamEvents[1] as {
      session?: { instructions?: string };
    };
    expect(internalUpdate).toMatchObject({
      type: "session.update",
      session: { instructions: expect.stringContaining("3 个补给箱") },
    });
    expect(internalUpdate.session?.instructions).toContain(BASE_INSTRUCTIONS);
    expect(upstreamEvents.map(({ type }) => type)).toEqual([
      "session.update",
      "session.update",
    ]);
    expect(internalUpdate).not.toHaveProperty("event_id");
    upstreamSocket?.send(
      JSON.stringify(
        sessionUpdated(
          internalUpdate.session?.instructions ?? "",
          "internal-ack",
        ),
      ),
    );
    await waitUntil(
      () =>
        received.filter(
          ({ type, open }) =>
            type === "relay.teaching.audio_gate" && open === true,
        ).length === 2,
    );
    const activeGate = received.findLast(
      ({ type, open }) => type === "relay.teaching.audio_gate" && open === true,
    );
    browser.send(
      JSON.stringify({
        type: "relay.teaching.audio_gate_ack",
        event_id: "teaching-active-gate-ack",
        revision: activeGate?.revision,
      }),
    );
    await waitUntil(() => upstreamEvents.length === 3);
    expect(
      received.filter(({ type }) => type === "session.updated"),
    ).toHaveLength(1);
    expect(JSON.stringify(received)).not.toContain("3 个补给箱");
    expect(upstreamEvents[2]).toEqual({
      type: "response.create",
      response: { modalities: ["audio", "text"] },
    });

    upstreamSocket?.send(JSON.stringify(responseCreated("invitation")));
    upstreamSocket?.send(JSON.stringify(responseDone("invitation")));
    upstreamSocket?.send(
      JSON.stringify({
        event_id: "answer-started",
        type: "input_audio_buffer.speech_started",
        item_id: "answer-1",
      }),
    );
    upstreamSocket?.send(
      JSON.stringify({
        event_id: "answer-stopped",
        type: "input_audio_buffer.speech_stopped",
        item_id: "answer-1",
      }),
    );
    upstreamSocket?.send(
      JSON.stringify({
        event_id: "answer-transcript",
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "answer-1",
        transcript: "答案是六瓶",
      }),
    );
    upstreamSocket?.send(JSON.stringify(responseCreated("feedback")));
    upstreamSocket?.send(JSON.stringify(responseDone("feedback")));

    const closeForRestore = await waitForGate(received, false, 2);
    browser.send(
      JSON.stringify({
        type: "relay.teaching.audio_gate_ack",
        event_id: "teaching-restore-gate-ack",
        revision: closeForRestore.revision,
      }),
    );
    await waitUntil(() => upstreamEvents.length === 4);
    expect(upstreamEvents[3]).toEqual({
      type: "session.update",
      session: { instructions: BASE_INSTRUCTIONS },
    });
    upstreamSocket?.send(
      JSON.stringify(sessionUpdated(BASE_INSTRUCTIONS, "restore-ack")),
    );
    await waitUntil(
      () =>
        received.filter(
          ({ type, open }) =>
            type === "relay.teaching.audio_gate" && open === true,
        ).length === 3,
    );
    const finalGate = received.findLast(
      ({ type, open }) => type === "relay.teaching.audio_gate" && open === true,
    );
    browser.send(
      JSON.stringify({
        type: "relay.teaching.audio_gate_ack",
        event_id: "teaching-final-gate-ack",
        revision: finalGate?.revision,
      }),
    );
    await waitUntil(() =>
      received.some(
        ({ type, state }) =>
          type === "relay.teaching.state" && state === "completed",
      ),
    );
    expect(
      received.filter(({ type }) => type === "session.updated"),
    ).toHaveLength(1);

    const browserClosed = once(browser, "close");
    browser.send(
      JSON.stringify({
        event_id: "browser-second-update",
        type: "session.update",
        session: {
          ...baseSessionUpdate().session,
          instructions: "浏览器伪造教学指令",
        },
      }),
    );
    const [closeCode] = await withTimeout(browserClosed);
    expect(closeCode).toBe(1008);
    expect(upstreamEvents).toHaveLength(4);
    expect(persistence.map(({ kind }) => kind)).toEqual([
      "restoring",
      "completed",
    ]);
  });
});

type ControllerHarness = ReturnType<typeof createControllerHarness>;

describe("Qwen teaching renewal safety", () => {
  it("allows renewal only after base acknowledgment and outside claiming or active teaching", async () => {
    const harness = createControllerHarness();
    expect(harness.controller.isSafeToRenew()).toBe(false);
    await configureController(harness);
    expect(harness.controller.isSafeToRenew()).toBe(true);
    harness.controller.handleClientFrame({
      type: "relay.teaching.request",
      event_id: "renewal-safety-request",
    });
    expect(harness.controller.isSafeToRenew()).toBe(false);
    await waitForGate(harness.clientFrames, false, 1);
    expect(harness.controller.isSafeToRenew()).toBe(false);
    harness.controller.dispose();
    expect(harness.controller.isSafeToRenew()).toBe(false);
  });
});

function createControllerHarness(input?: {
  runtime?: QwenTeachingRuntimeSnapshot;
  now?: () => number;
  recordValidUserTurn?: ReturnType<typeof vi.fn>;
  claimInvitation?: QwenTeachingSessionDependencies["claimInvitation"];
  persistState?: QwenTeachingSessionDependencies["persistState"];
  timeouts?: Readonly<{
    gateAckMs?: number;
    updateAckMs?: number;
    responseDoneMs?: number;
  }>;
}) {
  const clientFrames: Array<Record<string, unknown>> = [];
  const upstream: Array<Record<string, unknown>> = [];
  const persisted: QwenTeachingPersistenceEvent[] = [];
  const closed: string[] = [];
  const claimInvitation =
    input?.claimInvitation ??
    vi.fn(async () => ({
      claimed: true as const,
      content: runtimeContent("math-space-supplies-v1"),
    }));
  const recordValidUserTurn =
    input?.recordValidUserTurn ??
    vi.fn(async () => ({ recorded: true, validUserTurns: 1 }));
  const controller = new QwenTeachingSessionController({
    runtime: input?.runtime ?? DEFAULT_RUNTIME,
    now: input?.now ?? (() => 10_000),
    timeouts: input?.timeouts,
    dependencies: {
      claimInvitation,
      recordValidUserTurn,
      persistState:
        input?.persistState ??
        (async (event) => {
          persisted.push(event);
        }),
    },
    transport: {
      sendClientFrame: (frame) => {
        clientFrames.push(structuredClone(frame));
        return true;
      },
      sendUpstreamEvent: (event) => {
        upstream.push(structuredClone(event));
        return true;
      },
      safetyClose: (reason) => {
        closed.push(reason);
      },
    },
  });
  return {
    controller,
    clientFrames,
    upstream,
    persisted,
    closed,
    claimInvitation,
    recordValidUserTurn,
  };
}

async function driveControllerActive(harness: ControllerHarness) {
  await configureController(harness);
  harness.controller.handleClientFrame({
    type: "relay.teaching.request",
    event_id: "request-1",
  });
  const closeGate = await waitForGate(harness.clientFrames, false, 1);
  acknowledgeGate(harness.controller, closeGate, "gate-close-apply");
  await vi.waitFor(() => expect(harness.upstream).toHaveLength(1));
  const directive = (
    harness.upstream[0]?.session as { instructions?: string } | undefined
  )?.instructions;
  if (!directive) throw new Error("directive update missing");
  expect(
    harness.controller.handleProviderEvent(
      sessionUpdated(directive, "ack-directive"),
    ),
  ).toEqual({ forward: false });
  const openGate = await waitForGate(harness.clientFrames, true, 2);
  expect(harness.upstream).toHaveLength(1);
  acknowledgeGate(harness.controller, openGate, "gate-open-active");
  await vi.waitFor(() => expect(harness.upstream).toHaveLength(2));
  expect(harness.upstream[1]).toEqual({
    type: "response.create",
    response: { modalities: ["audio", "text"] },
  });
  await vi.waitFor(() =>
    expect(harness.clientFrames).toContainEqual(
      expect.objectContaining({
        type: "relay.teaching.state",
        state: "active",
      }),
    ),
  );
  return directive;
}

async function configureController(harness: ControllerHarness): Promise<void> {
  harness.controller.configureBase(BASE_SESSION, "base-ack");
  const initialOpen = await waitForGate(harness.clientFrames, true, 1);
  acknowledgeGate(harness.controller, initialOpen, "gate-open-base");
  await vi.waitFor(() =>
    expect(harness.clientFrames).toContainEqual(
      expect.objectContaining({
        type: "relay.teaching.state",
        state: "available",
      }),
    ),
  );
}

function acknowledgeGate(
  controller: QwenTeachingSessionController,
  gate: Record<string, unknown>,
  eventId: string,
) {
  const revision = gate.revision;
  if (typeof revision !== "number") throw new Error("gate revision missing");
  controller.handleClientFrame({
    type: "relay.teaching.audio_gate_ack",
    event_id: eventId,
    revision,
  });
}

async function waitForGate(
  frames: Array<Record<string, unknown>>,
  open: boolean,
  ordinal: number,
): Promise<Record<string, unknown>> {
  await vi.waitFor(() =>
    expect(
      frames.filter(
        (frame) =>
          frame.type === "relay.teaching.audio_gate" && frame.open === open,
      ),
    ).toHaveLength(ordinal),
  );
  return frames.filter(
    (frame) =>
      frame.type === "relay.teaching.audio_gate" && frame.open === open,
  )[ordinal - 1]!;
}

function baseSessionUpdate() {
  return {
    event_id: "browser-base-update",
    type: "session.update",
    session: {
      modalities: ["text", "audio"],
      voice: BASE_SESSION.voice,
      input_audio_format: "pcm",
      output_audio_format: "pcm",
      instructions: BASE_INSTRUCTIONS,
      max_history_turns: BASE_SESSION.maxHistoryTurns,
      turn_detection: { type: "smart_turn" },
    },
  } as const;
}

function sessionUpdated(instructions: string, eventId: string) {
  return {
    event_id: eventId,
    type: "session.updated",
    session: {
      id: BASE_SESSION.id,
      object: "realtime.session",
      model: BASE_SESSION.model,
      modalities: BASE_SESSION.modalities,
      voice: BASE_SESSION.voice,
      input_audio_format: BASE_SESSION.inputAudioFormat,
      output_audio_format: BASE_SESSION.outputAudioFormat,
      instructions,
      max_history_turns: BASE_SESSION.maxHistoryTurns,
      turn_detection: { type: BASE_SESSION.turnDetection },
    },
  } as const;
}

function sparseSessionUpdated(
  eventId: string,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    event_id: eventId,
    type: "session.updated",
    session: {
      id: BASE_SESSION.id,
      object: "realtime.session",
      model: BASE_SESSION.model,
      modalities: BASE_SESSION.modalities,
      voice: BASE_SESSION.voice,
      input_audio_transcription: { model: "fun-asr" },
      turn_detection: {
        type: BASE_SESSION.turnDetection,
        threshold: 0.5,
        silence_duration_ms: 800,
      },
      ...overrides,
    },
  } as const;
}

function responseCreated(responseId: string) {
  return {
    event_id: `created-${responseId}`,
    type: "response.created",
    response: { id: responseId, modalities: ["audio", "text"] },
  };
}

function responseDone(responseId: string) {
  return {
    event_id: `done-${responseId}`,
    type: "response.done",
    response: { id: responseId, status: "completed" },
  };
}

function emitSpeechTurn(
  controller: QwenTeachingSessionController,
  input: {
    itemId: string;
    transcript: string;
    reason?: "turn_invalid";
  },
): void {
  controller.handleProviderEvent({
    event_id: `started-${input.itemId}`,
    type: "input_audio_buffer.speech_started",
    item_id: input.itemId,
  });
  controller.handleProviderEvent({
    event_id: `stopped-${input.itemId}`,
    type: "input_audio_buffer.speech_stopped",
    item_id: input.itemId,
    ...(input.reason ? { reason: input.reason } : {}),
  });
  controller.handleProviderEvent({
    event_id: `transcript-${input.itemId}`,
    type: "conversation.item.input_audio_transcription.completed",
    item_id: input.itemId,
    transcript: input.transcript,
  });
}

function createServer(): WebSocketServer {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  return server;
}

function addressOf(server: WebSocketServer): { port: number } {
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("test WebSocket server did not bind a TCP port");
  }
  return { port: address.port };
}

function qwenConfig(): AppConfig["qwen"] {
  return {
    enabled: true,
    apiKey: "server-only-test-key",
    endpoint: "realtime.example.com",
    region: "cn-beijing",
    model: BASE_SESSION.model,
    voice: BASE_SESSION.voice,
    instructions: BASE_INSTRUCTIONS,
    requestTimeoutMs: 5_000,
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 3_000) throw new Error("test timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("test timed out")), 3_000),
    ),
  ]);
}
