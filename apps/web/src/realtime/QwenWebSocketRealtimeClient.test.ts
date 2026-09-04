import { describe, expect, it, vi } from "vitest";
import type { SafeRelayTeachingState } from "@meet/protocol";

import type {
  MicrophonePcmCaptureOptions,
  PcmMicrophoneCapture,
  PcmPlaybackOutput,
} from "./browser-pcm-audio.js";
import type { TaggedPcmChunk } from "./interruptible-pcm-playback.js";
import { encodePcm16Base64 } from "./pcm-codec.js";
import {
  QwenWebSocketRealtimeClient,
  type QwenWebSocketClientDependencies,
  type RealtimeClientSnapshot,
  type ScheduledTask,
} from "./QwenWebSocketRealtimeClient.js";

class FakeSocket {
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  receive(value: unknown): void {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(value) }),
    );
  }

  disconnect(code = 1006, reason = "network lost"): void {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

class FakeScheduler {
  now = 0;
  private nextId = 1;
  private tasks: Array<{
    id: number;
    at: number;
    callback: () => void;
    cancelled: boolean;
  }> = [];

  schedule = (callback: () => void, delayMs: number): ScheduledTask => {
    const task = {
      id: this.nextId++,
      at: this.now + delayMs,
      callback,
      cancelled: false,
    };
    this.tasks.push(task);
    return { cancel: () => (task.cancelled = true) };
  };

  advance(milliseconds: number): void {
    const target = this.now + milliseconds;
    while (true) {
      const next = this.tasks
        .filter((task) => !task.cancelled && task.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (!next) break;
      next.cancelled = true;
      this.now = next.at;
      next.callback();
    }
    this.now = target;
  }
}

class FakeMicrophone implements PcmMicrophoneCapture {
  readonly microphoneLabel = "测试麦克风";
  enabled = false;
  stopped = false;
  ensureAvailableCalls = 0;

  constructor(private readonly options: MicrophonePcmCaptureOptions) {}

  async start(): Promise<void> {}

  async ensureAvailable(): Promise<void> {
    this.ensureAvailableCalls += 1;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  emit(samples: Int16Array): void {
    if (this.enabled) {
      this.options.onPacket(samples);
    }
  }
}

class FakePlayback implements PcmPlaybackOutput {
  readonly outputSampleRate = 24_000;
  generation = 0;
  chunks: TaggedPcmChunk[] = [];

  async start(): Promise<void> {}

  reset(generation: number): void {
    this.generation = generation;
    this.chunks = [];
  }

  enqueue(chunk: TaggedPcmChunk): boolean {
    if (chunk.generation !== this.generation) {
      return false;
    }
    this.chunks.push({ ...chunk, samples: chunk.samples.slice() });
    return true;
  }

  ensureRunning(): void {}

  async stop(): Promise<void> {}
}

function createHarness(maxSocketBufferedBytes = 1024): {
  client: QwenWebSocketRealtimeClient;
  sockets: FakeSocket[];
  socketUrls: string[];
  microphones: FakeMicrophone[];
  playbacks: FakePlayback[];
  providerEvents: unknown[];
  errors: string[];
  snapshots: RealtimeClientSnapshot[];
  teachingStates: SafeRelayTeachingState[];
  scheduler: FakeScheduler;
  foreground: () => void;
  beforeReconnect: ReturnType<typeof vi.fn>;
} {
  const sockets: FakeSocket[] = [];
  const socketUrls: string[] = [];
  const microphones: FakeMicrophone[] = [];
  const playbacks: FakePlayback[] = [];
  const providerEvents: unknown[] = [];
  const errors: string[] = [];
  const snapshots: RealtimeClientSnapshot[] = [];
  const teachingStates: SafeRelayTeachingState[] = [];
  const scheduler = new FakeScheduler();
  const beforeReconnect = vi.fn(async () => undefined);
  let foregroundCallback: (() => void) | null = null;
  const dependencies: QwenWebSocketClientDependencies = {
    createSocket: (url) => {
      socketUrls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    createPlayback: () => {
      const playback = new FakePlayback();
      playbacks.push(playback);
      return playback;
    },
    createMicrophone: (options) => {
      const microphone = new FakeMicrophone(options);
      microphones.push(microphone);
      return microphone;
    },
    getLocationHref: () => "https://meet.example.test/call",
    maxSocketBufferedBytes,
    now: () => scheduler.now,
    scheduleTask: scheduler.schedule,
    subscribeToForeground: (callback) => {
      foregroundCallback = callback;
      return () => {
        if (foregroundCallback === callback) foregroundCallback = null;
      };
    },
  };
  const audio = {
    muted: false,
    srcObject: null,
    pause: vi.fn(),
  } as unknown as HTMLAudioElement;
  const client = new QwenWebSocketRealtimeClient(
    audio,
    {
      onProviderEvent: (_direction, event) => providerEvents.push(event),
      onError: (error) => errors.push(error.code),
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onBeforeReconnect: beforeReconnect,
      onTeachingState: (state) => teachingStates.push(state),
    },
    dependencies,
  );
  return {
    client,
    sockets,
    socketUrls,
    microphones,
    playbacks,
    providerEvents,
    errors,
    snapshots,
    teachingStates,
    scheduler,
    foreground: () => foregroundCallback?.(),
    beforeReconnect,
  };
}

async function startClient(
  client: QwenWebSocketRealtimeClient,
  assistantStarts = false,
): Promise<void> {
  await client.start({
    characterId: "character/one",
    conversationId: "9172f06d-c71a-47b3-94fe-35e1204b5b55",
    voice: "longanqian",
    instructions: "保持自然、简短。",
    inputMode: "hands_free",
    assistantStarts,
  });
}

describe("QwenWebSocketRealtimeClient", () => {
  it("binds the authenticated conversation id to the realtime socket URL", async () => {
    const harness = createHarness();
    await startClient(harness.client);

    expect(harness.socketUrls).toEqual([
      "wss://meet.example.test/api/characters/character%2Fone/realtime/websocket?conversationId=9172f06d-c71a-47b3-94fe-35e1204b5b55",
    ]);
  });

  it("reconnects with confirmed records after the first exponential backoff", async () => {
    const harness = createHarness();
    await startClient(harness.client);
    const firstSocket = harness.sockets[0];
    const microphone = harness.microphones[0];
    activateSocket(firstSocket);
    expect(microphone?.enabled).toBe(true);

    firstSocket?.disconnect();
    expect(harness.snapshots.at(-1)?.connection).toBe("reconnecting");
    expect(microphone?.enabled).toBe(false);
    harness.scheduler.advance(999);
    await settleAsyncWork();
    expect(harness.sockets).toHaveLength(1);

    harness.scheduler.advance(1);
    await settleAsyncWork();
    expect(harness.beforeReconnect).toHaveBeenCalledTimes(1);
    expect(microphone?.ensureAvailableCalls).toBe(1);
    expect(harness.sockets).toHaveLength(2);

    activateSocket(harness.sockets[1]);
    expect(harness.snapshots.at(-1)).toMatchObject({
      connection: "active",
      detail: "连接已恢复，已接回确认过的对话",
    });
    expect(microphone?.enabled).toBe(false);
    harness.sockets[1]?.receive({
      type: "relay.teaching.audio_gate",
      revision: 1,
      open: true,
    });
    expect(microphone?.enabled).toBe(true);
  });

  it("accepts a restarted teaching revision stream and keeps reconnect audio gated until reopened", async () => {
    const harness = createHarness();
    await startClient(harness.client);
    const firstSocket = harness.sockets[0];
    const playback = harness.playbacks[0];
    activateSocket(firstSocket);
    firstSocket?.receive({
      type: "relay.teaching.state",
      revision: 7,
      state: "active",
      canRequest: false,
      canMute: true,
    });
    expect(harness.teachingStates.at(-1)?.revision).toBe(7);

    firstSocket?.disconnect();
    harness.scheduler.advance(1_000);
    await settleAsyncWork();
    const replacement = harness.sockets[1];
    activateSocket(replacement);

    const audio = encodePcm16Base64(new Int16Array([700, -700]));
    replacement?.receive({
      type: "response.created",
      response: { id: "before-reopen", status: "in_progress" },
    });
    replacement?.receive({
      type: "response.audio.delta",
      response_id: "before-reopen",
      item_id: "before-reopen-item",
      output_index: 0,
      content_index: 0,
      delta: audio,
    });
    expect(playback?.chunks).toEqual([]);

    replacement?.receive({
      type: "relay.teaching.state",
      revision: 0,
      state: "available",
      canRequest: true,
      canMute: true,
    });
    expect(harness.teachingStates.at(-1)).toEqual({
      revision: 0,
      state: "available",
      canRequest: true,
      canMute: true,
    });
    replacement?.receive({
      type: "relay.teaching.audio_gate",
      revision: 1,
      open: true,
    });
    expect(JSON.parse(replacement?.sent.at(-1) ?? "{}")).toMatchObject({
      type: "relay.teaching.audio_gate_ack",
      revision: 1,
    });

    replacement?.receive({
      type: "response.created",
      response: { id: "after-reopen", status: "in_progress" },
    });
    replacement?.receive({
      type: "response.audio.delta",
      response_id: "after-reopen",
      item_id: "after-reopen-item",
      output_index: 0,
      content_index: 0,
      delta: audio,
    });
    expect(playback?.chunks.map((chunk) => chunk.responseId)).toEqual([
      "after-reopen",
    ]);
  });

  it("does not repeat the assistant opening after a replacement session", async () => {
    const harness = createHarness();
    await startClient(harness.client, true);
    const firstSocket = harness.sockets[0];
    activateSocket(firstSocket);
    expect(sentTypes(firstSocket)).toContain("response.create");

    firstSocket?.disconnect();
    harness.scheduler.advance(1_000);
    await settleAsyncWork();
    const replacement = harness.sockets[1];
    activateSocket(replacement);

    expect(sentTypes(replacement)).toEqual(["session.update"]);
  });

  it("pauses after 30 seconds and supports an explicit retry", async () => {
    const harness = createHarness();
    await startClient(harness.client);
    activateSocket(harness.sockets[0]);
    harness.sockets[0]?.disconnect();

    harness.scheduler.advance(1_000);
    await settleAsyncWork();
    harness.sockets[1]?.disconnect();
    harness.scheduler.advance(2_000);
    await settleAsyncWork();
    expect(harness.sockets).toHaveLength(3);

    harness.scheduler.advance(27_000);
    await settleAsyncWork();
    expect(harness.snapshots.at(-1)?.connection).toBe("paused");
    expect(harness.errors).toContain("REALTIME_RECONNECT_TIMEOUT");

    harness.client.retry();
    harness.scheduler.advance(0);
    await settleAsyncWork();
    expect(harness.sockets).toHaveLength(4);
    expect(harness.snapshots.at(-1)?.connection).toBe("reconnecting");
  });

  it("retries immediately when the app returns to the foreground", async () => {
    const harness = createHarness();
    await startClient(harness.client);
    activateSocket(harness.sockets[0]);
    harness.sockets[0]?.disconnect();

    harness.foreground();
    harness.scheduler.advance(0);
    await settleAsyncWork();
    expect(harness.sockets).toHaveLength(2);
  });

  it("waits for missing confirmed records to sync before replacing the session", async () => {
    const harness = createHarness();
    harness.beforeReconnect.mockRejectedValueOnce(new Error("offline"));
    await startClient(harness.client);
    activateSocket(harness.sockets[0]);
    harness.sockets[0]?.disconnect();

    harness.scheduler.advance(1_000);
    await settleAsyncWork();
    expect(harness.sockets).toHaveLength(1);
    expect(harness.beforeReconnect).toHaveBeenCalledTimes(1);

    harness.scheduler.advance(1_000);
    await settleAsyncWork();
    expect(harness.beforeReconnect).toHaveBeenCalledTimes(2);
    expect(harness.sockets).toHaveLength(2);
  });

  it("waits for relay.ready before session.update and excludes relay frames from provider events", async () => {
    const harness = createHarness();
    await startClient(harness.client);
    const socket = harness.sockets[0];
    const microphone = harness.microphones[0];
    expect(socket).toBeDefined();
    expect(microphone).toBeDefined();

    socket?.open();
    expect(socket?.sent).toEqual([]);
    socket?.receive({ type: "relay.ready" });

    expect(JSON.parse(socket?.sent[0] ?? "{}")).toMatchObject({
      type: "session.update",
      session: { input_audio_format: "pcm", output_audio_format: "pcm" },
    });
    expect(harness.providerEvents).not.toContainEqual({ type: "relay.ready" });
    expect(microphone?.enabled).toBe(false);

    socket?.receive({ type: "session.updated" });
    expect(microphone?.enabled).toBe(true);
  });

  it("uses strict teaching relay frames without exposing them as provider diagnostics", async () => {
    const harness = createHarness();
    await startClient(harness.client);
    const socket = harness.sockets[0];

    harness.client.requestTeaching();
    expect(socket?.sent).toEqual([]);
    socket?.open();
    socket?.receive({ type: "relay.ready" });

    const request = (socket?.sent ?? [])
      .map((payload) => JSON.parse(payload) as Record<string, unknown>)
      .find((event) => event.type === "relay.teaching.request");
    expect(request).toEqual({
      type: "relay.teaching.request",
      event_id: expect.stringMatching(/^event_/),
    });
    expect(request).not.toHaveProperty("contentItemId");
    expect(harness.providerEvents).not.toContainEqual(request);

    socket?.receive({
      type: "relay.teaching.state",
      revision: 1,
      state: "available",
      canRequest: true,
      canMute: true,
    });
    expect(harness.teachingStates).toEqual([
      {
        revision: 1,
        state: "available",
        canRequest: true,
        canMute: true,
      },
    ]);
    expect(harness.providerEvents).not.toContainEqual(
      expect.objectContaining({ type: "relay.teaching.state" }),
    );

    socket?.receive({
      type: "relay.teaching.state",
      revision: 2,
      state: "available",
      canRequest: false,
      canMute: true,
    });
    expect(harness.errors).toContain("INVALID_TEACHING_RELAY_FRAME");
    expect(harness.teachingStates).toHaveLength(1);

    harness.client.muteTeaching();
    const mute = JSON.parse(socket?.sent.at(-1) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(mute).toEqual({
      type: "relay.teaching.mute",
      event_id: expect.stringMatching(/^event_/),
    });
    expect(harness.providerEvents).not.toContainEqual(mute);
  });

  it("closes the local teaching gate while HTTP mute persistence is still pending", async () => {
    const harness = createHarness();
    await startClient(harness.client);
    const socket = harness.sockets[0];
    const playback = harness.playbacks[0];
    const microphone = harness.microphones[0];
    activateSocket(socket);
    const audio = encodePcm16Base64(new Int16Array([900, -900]));

    socket?.receive({
      type: "response.created",
      response: { id: "before-local-mute", status: "in_progress" },
    });
    socket?.receive({
      type: "response.audio.delta",
      response_id: "before-local-mute",
      item_id: "before-local-mute-item",
      output_index: 0,
      content_index: 0,
      delta: audio,
    });
    expect(playback?.chunks).toHaveLength(1);
    expect(microphone?.enabled).toBe(true);

    let finishPersistence: (() => void) | undefined;
    const persistence = new Promise<void>((resolve) => {
      finishPersistence = resolve;
    });
    harness.client.beginTeachingMute();
    const relayAfterPersistence = persistence.then(() =>
      harness.client.muteTeaching(),
    );

    expect(playback?.chunks).toEqual([]);
    expect(microphone?.enabled).toBe(false);
    expect(
      (socket?.sent ?? [])
        .map((payload) => JSON.parse(payload) as Record<string, unknown>)
        .filter((event) => event.type === "relay.teaching.mute"),
    ).toEqual([]);

    socket?.receive({
      type: "response.created",
      response: { id: "late-during-http", status: "in_progress" },
    });
    socket?.receive({
      type: "response.audio.delta",
      response_id: "late-during-http",
      item_id: "late-during-http-item",
      output_index: 0,
      content_index: 0,
      delta: audio,
    });
    socket?.receive({
      type: "response.audio_transcript.delta",
      response_id: "late-during-http",
      delta: "这段迟到内容不能播放或显示",
    });
    expect(playback?.chunks).toEqual([]);
    expect(harness.snapshots.at(-1)?.assistantCaption).toBe("");

    finishPersistence?.();
    await relayAfterPersistence;
    const muteFrames = (socket?.sent ?? [])
      .map((payload) => JSON.parse(payload) as Record<string, unknown>)
      .filter((event) => event.type === "relay.teaching.mute");
    expect(muteFrames).toEqual([
      {
        type: "relay.teaching.mute",
        event_id: expect.stringMatching(/^event_/),
      },
    ]);
    expect(harness.providerEvents).not.toContainEqual(muteFrames[0]);
  });

  it("applies and acknowledges monotonic teaching audio gates at a clean PCM boundary", async () => {
    const harness = createHarness();
    await startClient(harness.client);
    const socket = harness.sockets[0];
    const playback = harness.playbacks[0];
    const microphone = harness.microphones[0];
    activateSocket(socket);
    expect(microphone?.enabled).toBe(true);
    const audio = encodePcm16Base64(new Int16Array([900, -900]));

    socket?.receive({
      type: "response.created",
      response: { id: "before-gate", status: "in_progress" },
    });
    socket?.receive({
      type: "response.audio.delta",
      response_id: "before-gate",
      item_id: "before-item",
      output_index: 0,
      content_index: 0,
      delta: audio,
    });
    expect(playback?.chunks).toHaveLength(1);

    socket?.receive({
      type: "relay.teaching.audio_gate",
      revision: 1,
      open: false,
    });
    expect(playback?.chunks).toEqual([]);
    expect(microphone?.enabled).toBe(false);
    expect(JSON.parse(socket?.sent.at(-1) ?? "{}")).toEqual({
      type: "relay.teaching.audio_gate_ack",
      event_id: expect.stringMatching(/^event_/),
      revision: 1,
    });
    const sentWhileClosed = socket?.sent.length;
    microphone?.emit(new Int16Array([400, -400]));
    expect(socket?.sent).toHaveLength(sentWhileClosed ?? 0);

    socket?.receive({
      type: "response.created",
      response: { id: "while-closed", status: "in_progress" },
    });
    socket?.receive({
      type: "response.audio.delta",
      response_id: "while-closed",
      item_id: "closed-item",
      output_index: 0,
      content_index: 0,
      delta: audio,
    });
    socket?.receive({
      type: "response.audio_transcript.delta",
      response_id: "while-closed",
      delta: "这段内容不能进入字幕",
    });
    expect(playback?.chunks).toEqual([]);
    expect(harness.snapshots.at(-1)?.assistantCaption).toBe("");

    socket?.receive({
      type: "relay.teaching.audio_gate",
      revision: 1,
      open: false,
    });
    const revisionOneAcks = (socket?.sent ?? [])
      .map((payload) => JSON.parse(payload) as Record<string, unknown>)
      .filter(
        (event) =>
          event.type === "relay.teaching.audio_gate_ack" &&
          event.revision === 1,
      );
    expect(revisionOneAcks).toHaveLength(2);

    socket?.receive({
      type: "relay.teaching.audio_gate",
      revision: 1,
      open: true,
    });
    expect(harness.errors).toContain(
      "CONFLICTING_TEACHING_AUDIO_GATE_REVISION",
    );
    expect(
      (socket?.sent ?? [])
        .map((payload) => JSON.parse(payload) as Record<string, unknown>)
        .filter(
          (event) =>
            event.type === "relay.teaching.audio_gate_ack" &&
            event.revision === 1,
        ),
    ).toHaveLength(2);

    socket?.receive({
      type: "relay.teaching.audio_gate",
      revision: 2,
      open: true,
    });
    expect(microphone?.enabled).toBe(true);
    microphone?.emit(new Int16Array([400, -400]));
    expect(JSON.parse(socket?.sent.at(-1) ?? "{}")).toMatchObject({
      type: "input_audio_buffer.append",
    });
    socket?.receive({
      type: "response.audio.delta",
      response_id: "while-closed",
      item_id: "closed-item",
      output_index: 0,
      content_index: 0,
      delta: audio,
    });
    expect(playback?.chunks).toEqual([]);
    socket?.receive({
      type: "response.created",
      response: { id: "after-gate", status: "in_progress" },
    });
    socket?.receive({
      type: "response.audio.delta",
      response_id: "after-gate",
      item_id: "after-item",
      output_index: 0,
      content_index: 0,
      delta: audio,
    });
    expect(playback?.chunks.map((chunk) => chunk.responseId)).toEqual([
      "after-gate",
    ]);
    expect(harness.providerEvents).not.toContainEqual(
      expect.objectContaining({ type: "relay.teaching.audio_gate" }),
    );
    expect(harness.providerEvents).not.toContainEqual(
      expect.objectContaining({ type: "relay.teaching.audio_gate_ack" }),
    );
  });

  it("ignores messages from a socket replaced by a newer start", async () => {
    const harness = createHarness();
    await startClient(harness.client);
    const staleSocket = harness.sockets[0];
    const staleMessageHandler = staleSocket?.onmessage;

    await startClient(harness.client);
    const currentSocket = harness.sockets[1];
    currentSocket?.open();
    staleMessageHandler?.(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "relay.ready" }),
      }),
    );

    expect(staleSocket?.sent).toEqual([]);
    expect(currentSocket?.sent).toEqual([]);
    currentSocket?.receive({ type: "relay.ready" });
    expect(currentSocket?.sent).toHaveLength(1);
  });

  it("drops stale microphone packets while WebSocket bufferedAmount is over the limit", async () => {
    const harness = createHarness(128);
    await startClient(harness.client);
    const socket = harness.sockets[0];
    const microphone = harness.microphones[0];
    socket?.open();
    socket?.receive({ type: "relay.ready" });
    socket?.receive({ type: "session.updated" });
    const controlFrameCount = socket?.sent.length ?? 0;

    if (socket) {
      socket.bufferedAmount = 128;
    }
    microphone?.emit(new Int16Array(320).fill(1000));
    expect(socket?.sent).toHaveLength(controlFrameCount);
    expect(harness.errors).toContain("MICROPHONE_SOCKET_BACKPRESSURE");

    if (socket) {
      socket.bufferedAmount = 0;
    }
    microphone?.emit(new Int16Array([1000]));
    const append = JSON.parse(socket?.sent.at(-1) ?? "{}");
    expect(append).toMatchObject({ type: "input_audio_buffer.append" });
  });

  it("routes only response B PCM after a speech interruption clears response A", async () => {
    const harness = createHarness();
    await startClient(harness.client);
    const socket = harness.sockets[0];
    const playback = harness.playbacks[0];
    socket?.open();
    socket?.receive({ type: "relay.ready" });
    socket?.receive({ type: "session.updated" });

    const responseA = encodePcm16Base64(new Int16Array([1000, 1000]));
    const responseB = encodePcm16Base64(new Int16Array([-1000, -1000]));
    socket?.receive({
      type: "response.created",
      response: { id: "response-a", status: "in_progress" },
    });
    socket?.receive({
      type: "response.audio.delta",
      response_id: "response-a",
      item_id: "item-a",
      output_index: 0,
      content_index: 0,
      delta: responseA,
    });
    socket?.receive({
      type: "input_audio_buffer.speech_started",
      item_id: "speech-1",
    });
    socket?.receive({
      type: "response.audio.delta",
      response_id: "response-a",
      item_id: "item-a",
      output_index: 0,
      content_index: 0,
      delta: responseA,
    });
    // A response id first observed before the matching commit is ambiguous and
    // permanently blocked, even if it looks like a replacement.
    socket?.receive({
      type: "response.created",
      response: { id: "response-before-boundary", status: "in_progress" },
    });
    socket?.receive({
      type: "response.audio.delta",
      response_id: "response-before-boundary",
      item_id: "item-before-boundary",
      output_index: 0,
      content_index: 0,
      delta: responseB,
    });

    expect(playback?.chunks).toEqual([]);
    socket?.receive({
      type: "input_audio_buffer.speech_stopped",
      item_id: "speech-1",
    });
    expect(playback?.chunks).toEqual([]);
    socket?.receive({
      type: "input_audio_buffer.committed",
      item_id: "speech-1",
      previous_item_id: "previous-item",
    });
    socket?.receive({
      type: "response.created",
      response: { id: "response-b", status: "in_progress" },
    });
    socket?.receive({
      type: "response.audio.delta",
      response_id: "response-b",
      item_id: "item-b",
      output_index: 0,
      content_index: 0,
      delta: responseB,
    });
    socket?.receive({
      type: "response.audio.delta",
      response_id: "response-a",
      item_id: "item-a",
      output_index: 0,
      content_index: 0,
      delta: responseA,
    });

    expect(playback?.chunks).toHaveLength(1);
    expect(playback?.chunks[0]?.responseId).toBe("response-b");
    expect([...(playback?.chunks[0]?.samples ?? [])]).toEqual([-1000, -1000]);
  });

  it("requires committed and valid speech_stopped for every pending speech item", async () => {
    const harness = createHarness();
    await startClient(harness.client);
    const socket = harness.sockets[0];
    const playback = harness.playbacks[0];
    socket?.open();
    socket?.receive({ type: "relay.ready" });
    socket?.receive({ type: "session.updated" });
    const oldAudio = encodePcm16Base64(new Int16Array([1000]));
    const freshAudio = encodePcm16Base64(new Int16Array([-1000]));

    socket?.receive({
      type: "input_audio_buffer.speech_started",
      item_id: "speech-1",
    });
    socket?.receive({
      type: "input_audio_buffer.speech_started",
      item_id: "speech-2",
    });
    // committed arrives before stopped for speech-1; it must not open playback.
    socket?.receive({
      type: "input_audio_buffer.committed",
      item_id: "speech-1",
    });
    socket?.receive({
      type: "response.created",
      response: { id: "response-old", status: "in_progress" },
    });
    socket?.receive({
      type: "response.audio.delta",
      response_id: "response-old",
      item_id: "item-old",
      output_index: 0,
      content_index: 0,
      delta: oldAudio,
    });
    socket?.receive({
      type: "input_audio_buffer.speech_stopped",
      item_id: "speech-1",
    });
    socket?.receive({
      type: "input_audio_buffer.speech_stopped",
      item_id: "speech-2",
    });
    expect(playback?.chunks).toEqual([]);

    socket?.receive({
      type: "input_audio_buffer.committed",
      item_id: "speech-2",
    });
    socket?.receive({
      type: "response.created",
      response: { id: "response-fresh", status: "in_progress" },
    });
    socket?.receive({
      type: "response.audio.delta",
      response_id: "response-fresh",
      item_id: "item-fresh",
      output_index: 0,
      content_index: 0,
      delta: freshAudio,
    });
    expect(playback?.chunks.map((entry) => entry.responseId)).toEqual([
      "response-fresh",
    ]);
  });

  it("manual stop while thinking waits for the unknown response id before cancelling", async () => {
    const harness = createHarness();
    await startClient(harness.client);
    const socket = harness.sockets[0];
    const playback = harness.playbacks[0];
    socket?.open();
    socket?.receive({ type: "relay.ready" });
    socket?.receive({ type: "session.updated" });
    socket?.receive({
      type: "input_audio_buffer.speech_started",
      item_id: "speech-thinking",
    });
    socket?.receive({
      type: "input_audio_buffer.speech_stopped",
      item_id: "speech-thinking",
    });
    const cancelsBeforeStop = socket?.sent.filter(
      (payload) => JSON.parse(payload).type === "response.cancel",
    ).length;

    harness.client.interrupt();
    expect(
      socket?.sent.filter(
        (payload) => JSON.parse(payload).type === "response.cancel",
      ),
    ).toHaveLength(cancelsBeforeStop ?? 0);

    socket?.receive({
      type: "response.created",
      response: { id: "response-old", status: "in_progress" },
    });
    expect(
      socket?.sent.filter(
        (payload) => JSON.parse(payload).type === "response.cancel",
      ),
    ).toHaveLength((cancelsBeforeStop ?? 0) + 1);
    socket?.receive({
      type: "response.audio_transcript.delta",
      response_id: "response-old",
      delta: "这段旧字幕不能出现",
    });
    expect(playback?.chunks).toEqual([]);
    expect(harness.snapshots.at(-1)?.assistantCaption).toBe("");

    socket?.receive({
      type: "response.done",
      response: {
        id: "response-old",
        status: "cancelled",
        status_details: { reason: "client_cancelled" },
      },
    });
    socket?.receive({
      type: "response.created",
      response: { id: "response-fresh", status: "in_progress" },
    });
    expect(harness.snapshots.at(-1)?.activity).toBe("assistant_speaking");
  });

  it("blocks an opening interrupted after response.create but before response.created", async () => {
    const harness = createHarness();
    await startClient(harness.client, true);
    const socket = harness.sockets[0];
    const playback = harness.playbacks[0];
    socket?.open();
    socket?.receive({ type: "relay.ready" });
    socket?.receive({ type: "session.updated" });

    const sentTypes = (): string[] =>
      (socket?.sent ?? []).map(
        (payload) => (JSON.parse(payload) as { type: string }).type,
      );
    expect(
      sentTypes().filter((type) => type === "response.create"),
    ).toHaveLength(1);
    const openingItem = (socket?.sent ?? [])
      .map((payload) => JSON.parse(payload) as Record<string, unknown>)
      .find((event) => event.type === "conversation.item.create");
    expect(openingItem).toMatchObject({
      item: {
        role: "user",
        content: [
          {
            type: "input_text",
            text: expect.stringContaining("不要重复首次见面的固定欢迎语"),
          },
        ],
      },
    });
    expect(sentTypes()).not.toContain("response.cancel");

    // The request is in flight but has no response id, so this only arms the
    // manual barrier. Cancelling happens once the provider reveals that id.
    harness.client.interrupt();
    expect(sentTypes()).not.toContain("response.cancel");

    socket?.receive({
      type: "response.created",
      response: { id: "opening-response", status: "in_progress" },
    });
    socket?.receive({
      type: "response.audio.delta",
      response_id: "opening-response",
      item_id: "opening-item",
      output_index: 0,
      content_index: 0,
      delta: encodePcm16Base64(new Int16Array([1000, 1000])),
    });

    expect(
      sentTypes().filter((type) => type === "response.cancel"),
    ).toHaveLength(1);
    expect(playback?.chunks).toEqual([]);
    expect(harness.snapshots.at(-1)?.activity).not.toBe("assistant_speaking");
  });
});

function activateSocket(socket: FakeSocket | undefined): void {
  socket?.open();
  socket?.receive({ type: "relay.ready" });
  socket?.receive({ type: "session.updated" });
}

function sentTypes(socket: FakeSocket | undefined): string[] {
  return (socket?.sent ?? []).map(
    (payload) => (JSON.parse(payload) as { type: string }).type,
  );
}

async function settleAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
