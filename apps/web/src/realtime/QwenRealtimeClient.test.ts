import type { QwenServerEvent } from "@meet/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getCharacterRealtimeSessionUrl,
  QwenRealtimeClient,
} from "./QwenRealtimeClient.js";

type RealtimeClientHarness = {
  commandChannel: RTCDataChannel | null;
  acceptRemoteAudioTrack(track: MediaStreamTrack): void;
  ensureAudioDrainRunning(): void;
  handleProviderEvent(event: QwenServerEvent): void;
  prepareRemoteAudioDrain(): void;
};

type FakeAudio = HTMLAudioElement & {
  load: ReturnType<typeof vi.fn>;
  operations: string[];
  pause: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
};

type FakeTrack = MediaStreamTrack & {
  clone: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

class FakeMediaStream {
  constructor(readonly tracks: MediaStreamTrack[]) {}

  getAudioTracks(): MediaStreamTrack[] {
    return this.tracks;
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  readonly destination = {} as AudioDestinationNode;
  readonly gainNode = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    gain: { value: 1 },
  };
  readonly sourceNode = {
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  state: AudioContextState = "suspended";
  rejectResume = false;
  pendingResume = false;
  rejectSourceCreation = false;
  readonly createGain = vi.fn(() => this.gainNode);
  readonly createMediaStreamSource = vi.fn(() => {
    if (this.rejectSourceCreation) {
      throw new Error("source creation denied");
    }
    return this.sourceNode;
  });
  readonly resume = vi.fn(() => {
    if (this.pendingResume) {
      return new Promise<void>(() => undefined);
    }
    if (this.rejectResume) {
      return Promise.reject(new Error("resume denied"));
    }
    this.state = "running";
    return Promise.resolve();
  });
  readonly close = vi.fn(() => {
    this.state = "closed";
    return Promise.resolve();
  });

  constructor() {
    FakeAudioContext.instances.push(this);
  }
}

function createRemoteAudio(
  playImplementation: () => Promise<void> = () => Promise.resolve(),
): FakeAudio {
  const operations: string[] = [];
  let srcObject: MediaProvider | null = null;
  const audio = {
    muted: false,
    operations,
    pause: vi.fn(() => operations.push("pause")),
    load: vi.fn(() => operations.push("load")),
    play: vi.fn(() => {
      operations.push("play");
      return playImplementation();
    }),
  } as unknown as FakeAudio;
  Object.defineProperty(audio, "srcObject", {
    configurable: true,
    get: () => srcObject,
    set: (value: MediaProvider | null) => {
      srcObject = value;
      operations.push(value === null ? "src:null" : "src:set");
    },
  });
  return audio;
}

function createRemoteTrack() {
  const playbackClones: FakeTrack[] = [];
  const sourceTrack = {
    kind: "audio",
    clone: vi.fn(() => {
      const clone = {
        kind: "audio",
        stop: vi.fn(),
      } as unknown as FakeTrack;
      playbackClones.push(clone);
      return clone;
    }),
    stop: vi.fn(),
  } as unknown as FakeTrack;
  return { playbackClones, sourceTrack };
}

function acceptRemoteTrack(
  client: QwenRealtimeClient,
  track: MediaStreamTrack,
): void {
  (client as unknown as RealtimeClientHarness).acceptRemoteAudioTrack(track);
}

function deliverProviderEvent(
  client: QwenRealtimeClient,
  event: QwenServerEvent,
): void {
  (client as unknown as RealtimeClientHarness).handleProviderEvent(event);
}

function prepareRemoteAudioDrain(client: QwenRealtimeClient): void {
  (client as unknown as RealtimeClientHarness).prepareRemoteAudioDrain();
}

function ensureAudioDrainRunning(client: QwenRealtimeClient): void {
  (client as unknown as RealtimeClientHarness).ensureAudioDrainRunning();
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
  }
}

function responseCreated(responseId: string): QwenServerEvent {
  return {
    type: "response.created",
    response: { id: responseId, status: "in_progress" },
  };
}

function assistantDelta(responseId: string, delta = "新回复"): QwenServerEvent {
  return {
    type: "response.audio_transcript.delta",
    response_id: responseId,
    delta,
  };
}

function attachOpenCommandChannel(client: QwenRealtimeClient) {
  const send = vi.fn();
  (client as unknown as RealtimeClientHarness).commandChannel = {
    readyState: "open",
    send,
  } as unknown as RTCDataChannel;
  return send;
}

beforeEach(() => {
  FakeAudioContext.instances = [];
  vi.stubGlobal("MediaStream", FakeMediaStream);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getCharacterRealtimeSessionUrl", () => {
  it("业务握手只定位角色，不携带模型、声音或提示词", () => {
    const url = getCharacterRealtimeSessionUrl(
      "00000000-0000-4000-8000-000000000001",
    );

    expect(url).toBe(
      "/api/characters/00000000-0000-4000-8000-000000000001/realtime/sessions",
    );
    expect(url).not.toContain("?");
    expect(url).not.toContain("model");
    expect(url).not.toContain("voice");
  });
});

describe("QwenRealtimeClient interruption playback", () => {
  it("keeps the silent drain running after the page becomes visible again", async () => {
    const visibilityListeners = new Map<string, EventListener>();
    const fakeDocument = {
      visibilityState: "visible",
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        visibilityListeners.set(type, listener);
      }),
      removeEventListener: vi.fn((type: string) => {
        visibilityListeners.delete(type);
      }),
    };
    vi.stubGlobal("window", { AudioContext: FakeAudioContext });
    vi.stubGlobal("document", fakeDocument);

    const audio = createRemoteAudio();
    const client = new QwenRealtimeClient(audio);
    const { sourceTrack } = createRemoteTrack();
    prepareRemoteAudioDrain(client);
    const preparedContext = FakeAudioContext.instances[0];

    expect(preparedContext).toBeDefined();
    acceptRemoteTrack(client, sourceTrack);
    await flushMicrotasks();

    expect(preparedContext?.gainNode.gain.value).toBe(0);
    expect(preparedContext?.createMediaStreamSource).toHaveBeenCalledTimes(1);
    expect(preparedContext?.resume).toHaveBeenCalledTimes(1);

    if (preparedContext) {
      preparedContext.state = "suspended";
    }
    visibilityListeners.get("visibilitychange")?.(
      new Event("visibilitychange"),
    );
    await flushMicrotasks();

    expect(preparedContext?.resume).toHaveBeenCalledTimes(2);
    await client.close();
    expect(preparedContext?.close).toHaveBeenCalledTimes(1);
    expect(visibilityListeners.has("visibilitychange")).toBe(false);
  });

  it("reports a suspended drain that the browser refuses to resume", async () => {
    const pointerListeners = new Map<string, EventListener>();
    const fakeDocument = {
      visibilityState: "visible",
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        pointerListeners.set(type, listener);
      }),
      removeEventListener: vi.fn((type: string) => {
        pointerListeners.delete(type);
      }),
    };
    vi.stubGlobal("window", { AudioContext: FakeAudioContext });
    vi.stubGlobal("document", fakeDocument);
    const onError = vi.fn();
    const audio = createRemoteAudio();
    const client = new QwenRealtimeClient(audio, { onError });
    const { sourceTrack } = createRemoteTrack();
    prepareRemoteAudioDrain(client);
    const context = FakeAudioContext.instances[0];
    acceptRemoteTrack(client, sourceTrack);
    await flushMicrotasks();

    if (!context) {
      throw new Error("fake AudioContext was not created");
    }
    context.state = "suspended";
    context.rejectResume = true;
    ensureAudioDrainRunning(client);
    await flushMicrotasks();

    expect(onError).toHaveBeenCalledWith({
      code: "AUDIO_DRAIN_UNAVAILABLE",
      message: "浏览器无法保持音频清理通道，请点击页面恢复后再试。",
      recoverable: true,
    });
    expect(pointerListeners.has("pointerdown")).toBe(true);

    context.rejectResume = false;
    const retry = pointerListeners.get("pointerdown");
    pointerListeners.delete("pointerdown");
    retry?.(new Event("pointerdown"));
    await flushMicrotasks();

    expect(context.resume).toHaveBeenCalledTimes(3);
    expect(context.state).toBe("running");
    expect(onError).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it("reports a drain graph that cannot connect to the receiver track", async () => {
    vi.stubGlobal("window", { AudioContext: FakeAudioContext });
    const onError = vi.fn();
    const audio = createRemoteAudio();
    const client = new QwenRealtimeClient(audio, { onError });
    const { sourceTrack } = createRemoteTrack();
    prepareRemoteAudioDrain(client);
    const context = FakeAudioContext.instances[0];
    await flushMicrotasks();

    if (!context) {
      throw new Error("fake AudioContext was not created");
    }
    context.rejectSourceCreation = true;
    acceptRemoteTrack(client, sourceTrack);

    expect(onError).toHaveBeenCalledWith({
      code: "AUDIO_DRAIN_UNAVAILABLE",
      message: "浏览器无法保持音频清理通道，请点击页面恢复后再试。",
      recoverable: true,
    });
    expect(audio.srcObject).not.toBeNull();
    await client.close();
  });

  it("lets a user click supersede a resume promise that never settles", async () => {
    const pointerListeners = new Map<string, EventListener>();
    const fakeDocument = {
      visibilityState: "visible",
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        pointerListeners.set(type, listener);
      }),
      removeEventListener: vi.fn((type: string) => {
        pointerListeners.delete(type);
      }),
    };
    vi.stubGlobal("window", { AudioContext: FakeAudioContext });
    vi.stubGlobal("document", fakeDocument);

    const audio = createRemoteAudio();
    const client = new QwenRealtimeClient(audio);
    const { sourceTrack } = createRemoteTrack();
    prepareRemoteAudioDrain(client);
    const context = FakeAudioContext.instances[0];
    acceptRemoteTrack(client, sourceTrack);
    await flushMicrotasks();

    if (!context) {
      throw new Error("fake AudioContext was not created");
    }
    context.state = "suspended";
    context.pendingResume = true;
    ensureAudioDrainRunning(client);

    expect(context.resume).toHaveBeenCalledTimes(2);
    expect(pointerListeners.has("pointerdown")).toBe(true);

    context.pendingResume = false;
    const retry = pointerListeners.get("pointerdown");
    pointerListeners.delete("pointerdown");
    retry?.(new Event("pointerdown"));
    await flushMicrotasks();

    expect(context.resume).toHaveBeenCalledTimes(3);
    expect(context.state).toBe("running");
    await client.close();
  });

  it("resets the playback pipeline immediately without cancelling on speech start", () => {
    const audio = createRemoteAudio();
    const client = new QwenRealtimeClient(audio);
    const send = attachOpenCommandChannel(client);
    const { playbackClones, sourceTrack } = createRemoteTrack();
    acceptRemoteTrack(client, sourceTrack);

    const originalStream = audio.srcObject;
    deliverProviderEvent(client, responseCreated("resp_old"));
    deliverProviderEvent(client, {
      type: "input_audio_buffer.speech_started",
      item_id: "item_interrupt",
    });

    expect(originalStream).not.toBeNull();
    expect(audio.muted).toBe(true);
    expect(audio.srcObject).toBeNull();
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(audio.load).toHaveBeenCalledTimes(1);
    expect(playbackClones[0]?.stop).toHaveBeenCalledTimes(1);
    expect(audio.operations).toContain("src:null");
    expect(send).not.toHaveBeenCalled();
  });

  it("rebuilds a fresh playback stream when smart_turn rejects the candidate", () => {
    const audio = createRemoteAudio();
    const client = new QwenRealtimeClient(audio);
    const { playbackClones, sourceTrack } = createRemoteTrack();
    acceptRemoteTrack(client, sourceTrack);
    const originalStream = audio.srcObject;

    deliverProviderEvent(client, responseCreated("resp_old"));
    deliverProviderEvent(client, {
      type: "input_audio_buffer.speech_started",
      item_id: "item_rejected",
    });
    deliverProviderEvent(client, {
      type: "input_audio_buffer.speech_stopped",
      item_id: "item_rejected",
      reason: "turn_invalid",
    });

    expect(audio.muted).toBe(false);
    expect(audio.srcObject).not.toBeNull();
    expect(audio.srcObject).not.toBe(originalStream);
    expect(playbackClones).toHaveLength(2);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it("does not resume while user speech is unresolved", () => {
    const audio = createRemoteAudio();
    const client = new QwenRealtimeClient(audio);
    const { sourceTrack } = createRemoteTrack();
    acceptRemoteTrack(client, sourceTrack);

    deliverProviderEvent(client, responseCreated("resp_old"));
    deliverProviderEvent(client, {
      type: "input_audio_buffer.speech_started",
      item_id: "item_unresolved",
    });
    deliverProviderEvent(client, responseCreated("resp_new"));
    deliverProviderEvent(client, assistantDelta("resp_new"));

    expect(audio.muted).toBe(true);
    expect(audio.srcObject).toBeNull();
  });

  it("waits for the matching new response audio before rebuilding playback", () => {
    const audio = createRemoteAudio();
    const client = new QwenRealtimeClient(audio);
    const { playbackClones, sourceTrack } = createRemoteTrack();
    acceptRemoteTrack(client, sourceTrack);
    const originalStream = audio.srcObject;

    deliverProviderEvent(client, responseCreated("resp_old"));
    deliverProviderEvent(client, {
      type: "input_audio_buffer.speech_started",
      item_id: "item_valid_interrupt",
    });
    deliverProviderEvent(client, {
      type: "input_audio_buffer.speech_stopped",
      item_id: "item_valid_interrupt",
    });
    deliverProviderEvent(client, {
      type: "response.done",
      response: {
        id: "resp_old",
        status: "cancelled",
        status_details: { reason: "turn_detected" },
      },
    });
    deliverProviderEvent(client, responseCreated("resp_new"));

    expect(audio.muted).toBe(true);
    expect(audio.srcObject).toBeNull();
    expect(audio.play).toHaveBeenCalledTimes(1);

    deliverProviderEvent(client, assistantDelta("resp_old", "迟到旧字幕"));
    expect(audio.srcObject).toBeNull();

    deliverProviderEvent(client, assistantDelta("resp_new"));

    expect(audio.muted).toBe(false);
    expect(audio.srcObject).not.toBeNull();
    expect(audio.srcObject).not.toBe(originalStream);
    expect((audio.srcObject as unknown as FakeMediaStream).tracks).toEqual([
      playbackClones[1],
    ]);
    expect(playbackClones).toHaveLength(2);
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(audio.operations).toEqual([
      "src:set",
      "play",
      "pause",
      "src:null",
      "load",
      "src:set",
      "play",
    ]);

    deliverProviderEvent(client, assistantDelta("resp_new", "重复增量"));
    expect(playbackClones).toHaveLength(2);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it("ignores a late completion event from the interrupted response", () => {
    const audio = createRemoteAudio();
    const client = new QwenRealtimeClient(audio);
    const send = attachOpenCommandChannel(client);
    const { playbackClones, sourceTrack } = createRemoteTrack();
    acceptRemoteTrack(client, sourceTrack);

    deliverProviderEvent(client, responseCreated("resp_old"));
    deliverProviderEvent(client, {
      type: "input_audio_buffer.speech_started",
      item_id: "item_interrupt",
    });
    deliverProviderEvent(client, {
      type: "input_audio_buffer.speech_stopped",
      item_id: "item_interrupt",
    });
    deliverProviderEvent(client, responseCreated("resp_new"));
    deliverProviderEvent(client, {
      type: "response.done",
      response: {
        id: "resp_old",
        status: "cancelled",
        status_details: { reason: "turn_detected" },
      },
    });

    expect(audio.srcObject).toBeNull();
    deliverProviderEvent(client, assistantDelta("resp_new"));

    expect(audio.muted).toBe(false);
    expect(audio.srcObject).not.toBeNull();
    expect(playbackClones).toHaveLength(2);

    client.interrupt();
    expect(send).toHaveBeenCalledTimes(1);

    deliverProviderEvent(client, {
      type: "response.done",
      response: {
        id: "resp_old",
        status: "cancelled",
        status_details: { reason: "turn_detected" },
      },
    });
    client.interrupt();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not let a late invalid stop undo a confirmed interruption", () => {
    const audio = createRemoteAudio();
    const client = new QwenRealtimeClient(audio);
    const { sourceTrack } = createRemoteTrack();
    acceptRemoteTrack(client, sourceTrack);

    deliverProviderEvent(client, responseCreated("resp_old"));
    deliverProviderEvent(client, {
      type: "input_audio_buffer.speech_started",
      item_id: "item_provider_interrupt",
    });
    deliverProviderEvent(client, {
      type: "response.done",
      response: {
        id: "resp_old",
        status: "cancelled",
        status_details: { reason: "turn_detected" },
      },
    });
    deliverProviderEvent(client, {
      type: "input_audio_buffer.speech_stopped",
      item_id: "item_provider_interrupt",
      reason: "turn_invalid",
    });

    expect(audio.srcObject).toBeNull();

    deliverProviderEvent(client, responseCreated("resp_new"));
    expect(audio.srcObject).toBeNull();
    deliverProviderEvent(client, assistantDelta("resp_new"));

    expect(audio.muted).toBe(false);
    expect(audio.srcObject).not.toBeNull();
  });

  it("resets buffered audio after provider generation is already done", () => {
    const audio = createRemoteAudio();
    const client = new QwenRealtimeClient(audio);
    const send = attachOpenCommandChannel(client);
    const { playbackClones, sourceTrack } = createRemoteTrack();
    acceptRemoteTrack(client, sourceTrack);

    deliverProviderEvent(client, responseCreated("resp_completed"));
    deliverProviderEvent(client, {
      type: "response.done",
      response: { id: "resp_completed", status: "completed" },
    });
    client.interrupt();

    expect(audio.muted).toBe(true);
    expect(audio.srcObject).toBeNull();
    expect(playbackClones[0]?.stop).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("cancels once and waits for fresh response audio after manual stop", () => {
    const audio = createRemoteAudio();
    const client = new QwenRealtimeClient(audio);
    const send = attachOpenCommandChannel(client);
    const { playbackClones, sourceTrack } = createRemoteTrack();
    acceptRemoteTrack(client, sourceTrack);

    deliverProviderEvent(client, responseCreated("resp_old"));
    client.interrupt();
    client.interrupt();

    expect(audio.srcObject).toBeNull();
    expect(playbackClones).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]?.[0] as string)).toMatchObject({
      type: "response.cancel",
    });

    deliverProviderEvent(client, {
      type: "response.done",
      response: {
        id: "resp_old",
        status: "cancelled",
        status_details: { reason: "client_cancelled" },
      },
    });
    deliverProviderEvent(client, responseCreated("resp_new"));
    expect(audio.srcObject).toBeNull();
    deliverProviderEvent(client, assistantDelta("resp_new"));

    expect(audio.srcObject).not.toBeNull();
    expect(playbackClones).toHaveLength(2);
  });

  it("does not undo a manual stop when an invalid speech event follows", () => {
    const audio = createRemoteAudio();
    const client = new QwenRealtimeClient(audio);
    const { sourceTrack } = createRemoteTrack();
    acceptRemoteTrack(client, sourceTrack);

    client.interrupt();
    deliverProviderEvent(client, {
      type: "input_audio_buffer.speech_started",
      item_id: "item_after_manual_stop",
    });
    deliverProviderEvent(client, {
      type: "input_audio_buffer.speech_stopped",
      item_id: "item_after_manual_stop",
      reason: "turn_invalid",
    });

    expect(audio.muted).toBe(true);
    expect(audio.srcObject).toBeNull();
  });

  it("waits for every pending candidate before rebuilding playback", () => {
    const audio = createRemoteAudio();
    const client = new QwenRealtimeClient(audio);
    const { playbackClones, sourceTrack } = createRemoteTrack();
    acceptRemoteTrack(client, sourceTrack);

    deliverProviderEvent(client, responseCreated("resp_old"));
    deliverProviderEvent(client, {
      type: "input_audio_buffer.speech_started",
      item_id: "item_first",
    });
    deliverProviderEvent(client, {
      type: "input_audio_buffer.speech_started",
      item_id: "item_second",
    });
    deliverProviderEvent(client, {
      type: "input_audio_buffer.speech_stopped",
      item_id: "item_first",
      reason: "turn_invalid",
    });

    expect(audio.srcObject).toBeNull();

    deliverProviderEvent(client, {
      type: "input_audio_buffer.speech_stopped",
      item_id: "item_second",
      reason: "turn_invalid",
    });

    expect(audio.muted).toBe(false);
    expect(audio.srcObject).not.toBeNull();
    expect(playbackClones).toHaveLength(2);
  });

  it("keeps a valid candidate latched when another candidate ends invalid", () => {
    const audio = createRemoteAudio();
    const client = new QwenRealtimeClient(audio);
    const { playbackClones, sourceTrack } = createRemoteTrack();
    acceptRemoteTrack(client, sourceTrack);

    deliverProviderEvent(client, responseCreated("resp_old"));
    deliverProviderEvent(client, {
      type: "input_audio_buffer.speech_started",
      item_id: "item_valid",
    });
    deliverProviderEvent(client, {
      type: "input_audio_buffer.speech_started",
      item_id: "item_invalid",
    });
    deliverProviderEvent(client, {
      type: "input_audio_buffer.speech_stopped",
      item_id: "item_valid",
    });
    deliverProviderEvent(client, responseCreated("resp_new"));
    deliverProviderEvent(client, {
      type: "input_audio_buffer.speech_stopped",
      item_id: "item_invalid",
      reason: "turn_invalid",
    });

    expect(audio.srcObject).toBeNull();
    expect(playbackClones).toHaveLength(1);

    deliverProviderEvent(client, assistantDelta("resp_new"));
    expect(audio.srcObject).not.toBeNull();
    expect(playbackClones).toHaveLength(2);
  });

  it("ignores a stale non-abort play rejection after the pipeline is reset", async () => {
    let rejectPlay: ((reason?: unknown) => void) | undefined;
    const audio = createRemoteAudio(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPlay = reject;
        }),
    );
    const onError = vi.fn();
    const client = new QwenRealtimeClient(audio, { onError });
    const { sourceTrack } = createRemoteTrack();
    acceptRemoteTrack(client, sourceTrack);

    deliverProviderEvent(client, {
      type: "input_audio_buffer.speech_started",
      item_id: "item_interrupt",
    });
    rejectPlay?.(new DOMException("play denied", "NotAllowedError"));
    await Promise.resolve();

    expect(onError).not.toHaveBeenCalled();
    expect(audio.srcObject).toBeNull();
  });

  it("reports a current play rejection and gates the next response", async () => {
    let shouldReject = true;
    const audio = createRemoteAudio(() => {
      if (shouldReject) {
        shouldReject = false;
        return Promise.reject(
          new DOMException("play aborted", "NotAllowedError"),
        );
      }
      return Promise.resolve();
    });
    const onError = vi.fn();
    const client = new QwenRealtimeClient(audio, { onError });
    const { playbackClones, sourceTrack } = createRemoteTrack();
    acceptRemoteTrack(client, sourceTrack);
    await Promise.resolve();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(audio.srcObject).toBeNull();
    expect(playbackClones[0]?.stop).toHaveBeenCalledTimes(1);

    deliverProviderEvent(client, responseCreated("resp_retry"));
    expect(audio.srcObject).toBeNull();
    deliverProviderEvent(client, assistantDelta("resp_retry"));

    expect(audio.srcObject).not.toBeNull();
    expect(playbackClones).toHaveLength(2);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it("cleans the clone and ignores a late rejection during teardown", async () => {
    let rejectPlay: ((reason?: unknown) => void) | undefined;
    const audio = createRemoteAudio(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPlay = reject;
        }),
    );
    const onError = vi.fn();
    const client = new QwenRealtimeClient(audio, { onError });
    const { playbackClones, sourceTrack } = createRemoteTrack();
    acceptRemoteTrack(client, sourceTrack);

    await client.close();
    rejectPlay?.(new Error("late playback failure"));
    await Promise.resolve();

    expect(audio.srcObject).toBeNull();
    expect(audio.load).toHaveBeenCalledTimes(1);
    expect(playbackClones[0]?.stop).toHaveBeenCalledTimes(1);
    expect(sourceTrack.stop).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
