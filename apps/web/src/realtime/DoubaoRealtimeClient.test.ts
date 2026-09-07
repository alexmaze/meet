import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  MicrophonePcmCaptureOptions,
  PcmMicrophoneCapture,
  PcmPlaybackOutput,
} from "./browser-pcm-audio.js";
import type { TaggedPcmChunk } from "./interruptible-pcm-playback.js";
import {
  DoubaoRealtimeClient,
  type DoubaoRealtimeClientDependencies,
} from "./DoubaoRealtimeClient.js";

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
    this.onclose?.({ code: 1000, reason: "closed" } as CloseEvent);
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
}

class FakeMicrophone implements PcmMicrophoneCapture {
  readonly microphoneLabel = "测试麦克风";
  enabled = false;

  constructor(private readonly options: MicrophonePcmCaptureOptions) {}

  async start(): Promise<void> {}
  async ensureAvailable(): Promise<void> {}
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
  async stop(): Promise<void> {}
  emit(samples: Int16Array): void {
    if (this.enabled) this.options.onPacket(samples);
  }
}

class FakePlayback implements PcmPlaybackOutput {
  readonly outputSampleRate = 24_000;
  generation = 0;
  chunks: TaggedPcmChunk[] = [];

  get hasPendingAudio(): boolean {
    return this.chunks.length > 0;
  }

  async start(): Promise<void> {}
  reset(generation: number): void {
    this.generation = generation;
    this.chunks = [];
  }
  enqueue(chunk: TaggedPcmChunk): boolean {
    if (chunk.generation !== this.generation) return false;
    this.chunks.push({ ...chunk, samples: chunk.samples.slice() });
    return true;
  }
  ensureRunning(): void {}
  async stop(): Promise<void> {}
}

function createHarness(
  inputMode: "hands_free" | "push_to_talk" = "hands_free",
) {
  const socket = new FakeSocket();
  const sockets: FakeSocket[] = [];
  const socketUrls: string[] = [];
  const microphones: FakeMicrophone[] = [];
  const playback = new FakePlayback();
  const transcripts: Array<{
    speaker: "user" | "assistant";
    text: string;
    status: "completed" | "interrupted";
  }> = [];
  const snapshots: Array<{
    connection: string;
    activity: string;
    detail: string;
  }> = [];
  const beforeReconnect = vi
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const errors: Array<{ code: string; message: string }> = [];
  const dependencies: DoubaoRealtimeClientDependencies = {
    createSocket: (url) => {
      const next = sockets.length === 0 ? socket : new FakeSocket();
      sockets.push(next);
      socketUrls.push(url);
      return next as unknown as WebSocket;
    },
    createPlayback: () => playback,
    createMicrophone: (options) => {
      const microphone = new FakeMicrophone(options);
      microphones.push(microphone);
      return microphone;
    },
    getLocationHref: () => "https://meet.example.test/call",
    subscribeToForeground: () => () => undefined,
  };
  const audio = {
    pause: vi.fn(),
    srcObject: null,
    removeAttribute: vi.fn(),
  } as unknown as HTMLAudioElement;
  const client = new DoubaoRealtimeClient(
    audio,
    {
      onTranscript: (transcript) => transcripts.push(transcript),
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onBeforeReconnect: beforeReconnect,
      onError: (error) => errors.push(error),
    },
    dependencies,
  );
  return {
    client,
    socket,
    sockets,
    socketUrls,
    beforeReconnect,
    errors,
    microphones,
    playback,
    transcripts,
    snapshots,
    inputMode,
  };
}

async function startHarness(
  harness: ReturnType<typeof createHarness>,
  assistantStarts = true,
): Promise<void> {
  await harness.client.start({
    characterId: "character-one",
    conversationId: "9172f06d-c71a-47b3-94fe-35e1204b5b55",
    voice: "zh_female_vv_jupiter_bigtts",
    instructions: "保持自然。",
    inputMode: harness.inputMode,
    assistantStarts,
    openingText: "你好，很高兴见到你。",
  });
  harness.socket.open();
  harness.socket.receive({ type: "relay.ready" });
  harness.socket.receive({
    event_id: "session-created",
    type: "session.created",
    session: { id: "dialog-1" },
  });
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function due(socket: FakeSocket): void {
  socket.receive({
    type: "relay.renewal_due",
    reason: "context_refresh",
    remainingMs: 120_000,
  });
}

function ready(socket: FakeSocket): void {
  const request = sentEvents(socket).findLast(
    (event) => event.type === "relay.renewal_prepare",
  );
  expect(request).toBeDefined();
  socket.receive({ type: "relay.renewal_ready", event_id: request?.event_id });
}

function finishResponse(
  socket: FakeSocket,
  responseId: string,
  audio = false,
): void {
  socket.receive({
    type: "response.output_audio.started",
    response_id: responseId,
  });
  if (audio)
    socket.receive({
      type: "response.output_audio.delta",
      response_id: responseId,
      delta: "AQD//w==",
    });
  socket.receive({
    type: "response.output_audio.done",
    response_id: responseId,
  });
  socket.receive({ type: "response.done" });
}

function activateReplacement(socket: FakeSocket): void {
  socket.open();
  socket.receive({ type: "relay.ready" });
  socket.receive({
    type: "session.created",
    session: { id: "dialog-replacement" },
  });
}

describe("DoubaoRealtimeClient", () => {
  it("activates PCM streaming and uses the saved opening line", async () => {
    const harness = createHarness();
    await startHarness(harness);

    expect(harness.microphones[0]?.enabled).toBe(true);
    expect(sentEvents(harness.socket)).toContainEqual(
      expect.objectContaining({
        type: "speech_text_buffer.commit",
        speech_id: expect.any(String),
        text: "你好，很高兴见到你。",
      }),
    );
    harness.microphones[0]?.emit(new Int16Array([1, -1]));
    expect(sentEvents(harness.socket)).toContainEqual(
      expect.objectContaining({ type: "input_audio_buffer.append" }),
    );
  });

  it("commits PTT turns and projects transcripts and PCM audio", async () => {
    const harness = createHarness("push_to_talk");
    await startHarness(harness);
    expect(harness.microphones[0]?.enabled).toBe(false);

    harness.client.setPushToTalkActive(true);
    expect(harness.microphones[0]?.enabled).toBe(true);
    harness.client.setPushToTalkActive(false);
    expect(sentEvents(harness.socket)).toContainEqual(
      expect.objectContaining({ type: "input_audio_buffer.commit" }),
    );

    harness.socket.receive({
      event_id: "user-started",
      type: "conversation.item.input_audio_transcription.started",
    });
    harness.socket.receive({
      event_id: "user-completed",
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "你好",
    });
    harness.socket.receive({
      event_id: "audio-started",
      type: "response.output_audio.started",
      response_id: "response-1",
    });
    harness.socket.receive({
      event_id: "audio-delta",
      type: "response.output_audio.delta",
      delta: "AQD//w==",
    });
    harness.socket.receive({
      event_id: "text-delta",
      type: "response.output_text.delta",
      response_id: "response-1",
      delta: "你好呀",
    });
    harness.socket.receive({
      event_id: "audio-done",
      type: "response.output_audio.done",
      response_id: "response-1",
    });

    expect(harness.transcripts).toEqual([
      expect.objectContaining({ speaker: "user", text: "你好" }),
      expect.objectContaining({ speaker: "assistant", text: "你好呀" }),
    ]);
    expect(harness.playback.chunks).toHaveLength(1);
  });

  it("renews a quiet session after durable records and graceful close, retaining the call and greeting", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    await startHarness(harness);
    finishResponse(harness.socket, "opening-response");
    due(harness.socket);
    await vi.advanceTimersByTimeAsync(750);
    expect(harness.beforeReconnect).not.toHaveBeenCalled();
    ready(harness.socket);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.beforeReconnect).toHaveBeenCalledTimes(1);
    expect(sentEvents(harness.socket).at(-1)?.type).toBe("session.close");
    expect(harness.sockets).toHaveLength(1);
    expect(harness.snapshots.at(-1)?.detail).toContain("自动续接");
    expect(harness.microphones[0]?.enabled).toBe(false);

    harness.socket.receive({
      type: "session.created",
      session: { id: "late-old-session" },
    });
    expect(harness.snapshots.at(-1)?.connection).toBe("reconnecting");
    harness.socket.receive({ type: "session.closed" });
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.sockets).toHaveLength(2);
    expect(harness.socketUrls[1]).toBe(harness.socketUrls[0]);
    const next = harness.sockets[1]!;
    activateReplacement(next);
    expect(harness.snapshots.at(-1)?.detail).toContain("自动续接");
    expect(harness.microphones[0]?.enabled).toBe(true);
    expect(
      sentEvents(next).some(
        (event) => event.type === "speech_text_buffer.commit",
      ),
    ).toBe(false);
  });

  it("waits for buffered PCM to drain after provider generation completes", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    await startHarness(harness, false);
    finishResponse(harness.socket, "response-a", true);
    due(harness.socket);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(
      sentEvents(harness.socket).some(
        (event) => event.type === "relay.renewal_prepare",
      ),
    ).toBe(false);
    harness.playback.chunks = [];
    await vi.advanceTimersByTimeAsync(250);
    expect(sentEvents(harness.socket).at(-1)?.type).toBe(
      "relay.renewal_prepare",
    );
  });

  it("cancels preparation before transmitting new speech without muting capture", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    await startHarness(harness, false);
    due(harness.socket);
    await vi.advanceTimersByTimeAsync(750);
    const request = sentEvents(harness.socket).at(-1)!;
    expect(harness.microphones[0]?.enabled).toBe(true);
    const sentBeforeSilence = harness.socket.sent.length;
    harness.microphones[0]?.emit(new Int16Array([0, 0]));
    expect(harness.socket.sent).toHaveLength(sentBeforeSilence);
    harness.microphones[0]?.emit(new Int16Array([1000, -1000]));
    expect(
      sentEvents(harness.socket)
        .slice(-2)
        .map((event) => event.type),
    ).toEqual(["relay.renewal_cancel", "input_audio_buffer.append"]);
    harness.socket.receive({
      type: "relay.renewal_ready",
      event_id: request.event_id,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.beforeReconnect).not.toHaveBeenCalled();
    expect(harness.snapshots.at(-1)?.connection).toBe("active");
  });

  it("keeps the existing session usable when transcript persistence fails", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.beforeReconnect.mockRejectedValueOnce(
      new Error("database offline"),
    );
    await startHarness(harness, false);
    due(harness.socket);
    await vi.advanceTimersByTimeAsync(750);
    ready(harness.socket);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.sockets).toHaveLength(1);
    expect(harness.socket.readyState).toBe(1);
    expect(harness.snapshots.at(-1)?.detail).toContain("同步已确认记录");
    expect(harness.microphones[0]?.enabled).toBe(true);
    expect(
      sentEvents(harness.socket).some(
        (event) => event.type === "session.close",
      ),
    ).toBe(false);
  });

  it("cancels an in-flight flush when user speech arrives and ignores its late result", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    let resolveFlush!: () => void;
    harness.beforeReconnect.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveFlush = resolve;
      }),
    );
    await startHarness(harness, false);
    due(harness.socket);
    await vi.advanceTimersByTimeAsync(750);
    ready(harness.socket);
    await vi.advanceTimersByTimeAsync(0);
    harness.socket.receive({
      type: "conversation.item.input_audio_transcription.started",
    });
    resolveFlush();
    await vi.advanceTimersByTimeAsync(0);
    expect(sentEvents(harness.socket).at(-1)?.type).toBe(
      "relay.renewal_cancel",
    );
    expect(harness.socket.readyState).toBe(1);
    expect(harness.snapshots.at(-1)?.activity).toBe("user_speaking");
  });

  it("does not prepare while user ASR, the answer, PTT, or hidden playback is pending", async () => {
    vi.useFakeTimers();
    const harness = createHarness("push_to_talk");
    await startHarness(harness, false);
    due(harness.socket);
    harness.client.setPushToTalkActive(true);
    await vi.advanceTimersByTimeAsync(1_000);
    harness.client.setPushToTalkActive(false);
    harness.socket.receive({
      type: "conversation.item.input_audio_transcription.started",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    harness.socket.receive({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "继续讲",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      sentEvents(harness.socket).some(
        (event) => event.type === "relay.renewal_prepare",
      ),
    ).toBe(false);
    finishResponse(harness.socket, "response-a");
    vi.stubGlobal("document", { visibilityState: "hidden" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      sentEvents(harness.socket).some(
        (event) => event.type === "relay.renewal_prepare",
      ),
    ).toBe(false);
    vi.stubGlobal("document", { visibilityState: "visible" });
    await vi.advanceTimersByTimeAsync(250);
    expect(sentEvents(harness.socket).at(-1)?.type).toBe(
      "relay.renewal_prepare",
    );
  });

  it("does not resurrect renewal after the user closes during the old socket wait", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    await startHarness(harness, false);
    due(harness.socket);
    await vi.advanceTimersByTimeAsync(750);
    ready(harness.socket);
    await vi.advanceTimersByTimeAsync(0);
    const closing = harness.client.close();
    await vi.advanceTimersByTimeAsync(1_500);
    await closing;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.sockets).toHaveLength(1);
    expect(harness.snapshots.at(-1)?.connection).toBe("closed");
  });

  it("does not let a late manual close tear down a newly started call", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    await startHarness(harness, false);
    const oldClosing = harness.client.close();
    await harness.client.start({
      characterId: "another-character",
      conversationId: "734f595e-12e6-4c19-a780-b85d82f8991d",
      voice: "zh_female_vv_jupiter_bigtts",
      instructions: "自然交谈。",
      inputMode: "hands_free",
      assistantStarts: false,
    });
    activateReplacement(harness.sockets[1]!);
    await vi.advanceTimersByTimeAsync(1_500);
    await oldClosing;
    expect(harness.sockets[1]?.readyState).toBe(1);
    expect(harness.snapshots.at(-1)?.connection).toBe("active");
  });

  it("includes graceful close in the 30 second budget and fences a late recovery after retry", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    let resolveOldFlush!: () => void;
    const oldFlush = new Promise<void>((resolve) => {
      resolveOldFlush = resolve;
    });
    harness.beforeReconnect
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(oldFlush);
    await startHarness(harness, false);
    due(harness.socket);
    await vi.advanceTimersByTimeAsync(750);
    ready(harness.socket);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(harness.snapshots.at(-1)?.connection).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.snapshots.at(-1)?.connection).toBe("paused");
    expect(harness.errors.at(-1)?.code).toBe("REALTIME_RECONNECT_TIMEOUT");

    harness.client.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.sockets).toHaveLength(2);
    resolveOldFlush();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.sockets).toHaveLength(2);
    activateReplacement(harness.sockets[1]!);
    expect(harness.snapshots.at(-1)?.connection).toBe("active");
  });
});

function sentEvents(socket: FakeSocket): Record<string, unknown>[] {
  return socket.sent.map(
    (payload) => JSON.parse(payload) as Record<string, unknown>,
  );
}

describe("call continuity boundaries", () => {
  it("passes the writer and suppresses the greeting on a cold recovery", async () => {
    const harness = createHarness();
    const writer = {
      clientId: "f819d072-2f86-4584-9701-04037a9c46c3",
      epoch: 4,
    };
    await harness.client.start({
      characterId: "character-one",
      conversationId: "9172f06d-c71a-47b3-94fe-35e1204b5b55",
      writer,
      voice: "zh_female_vv_jupiter_bigtts",
      instructions: "保持原设定",
      inputMode: "hands_free",
      assistantStarts: true,
      resumed: true,
      openingText: "不要重播",
    });
    expect(harness.microphones[0]?.enabled).toBe(false);
    activateReplacement(harness.socket);
    expect(new URL(harness.socketUrls[0]!).searchParams.get("epoch")).toBe("4");
    expect(
      sentEvents(harness.socket).some(
        (event) => event.type === "speech_text_buffer.commit",
      ),
    ).toBe(false);
    expect(harness.snapshots.at(-1)?.detail).toBe("已接上，可以继续说");
  });
  it("stops recording and physical playback before waiting for close acknowledgement", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    await startHarness(harness);
    const microphoneStop = vi.spyOn(harness.microphones[0]!, "stop");
    const playbackStop = vi.spyOn(harness.playback, "stop");
    const closing = harness.client.close();
    expect(harness.microphones[0]?.enabled).toBe(false);
    expect(microphoneStop).toHaveBeenCalled();
    expect(playbackStop).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    await closing;
  });
});
