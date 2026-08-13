import { describe, expect, it, vi } from "vitest";

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
  const microphones: FakeMicrophone[] = [];
  const playback = new FakePlayback();
  const transcripts: Array<{
    speaker: "user" | "assistant";
    text: string;
    status: "completed" | "interrupted";
  }> = [];
  const snapshots: Array<{ connection: string; activity: string }> = [];
  const dependencies: DoubaoRealtimeClientDependencies = {
    createSocket: () => socket as unknown as WebSocket,
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
    },
    dependencies,
  );
  return {
    client,
    socket,
    microphones,
    playback,
    transcripts,
    snapshots,
    inputMode,
  };
}

async function startHarness(
  harness: ReturnType<typeof createHarness>,
): Promise<void> {
  await harness.client.start({
    characterId: "character-one",
    conversationId: "9172f06d-c71a-47b3-94fe-35e1204b5b55",
    voice: "zh_female_vv_jupiter_bigtts",
    instructions: "保持自然。",
    inputMode: harness.inputMode,
    assistantStarts: true,
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
});

function sentEvents(socket: FakeSocket): Record<string, unknown>[] {
  return socket.sent.map(
    (payload) => JSON.parse(payload) as Record<string, unknown>,
  );
}
