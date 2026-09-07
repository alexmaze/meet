import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AudioContextResumeGate,
  AudioWorkletPcmPlayback,
  LowLatencyPcmQueuePolicy,
  PLAYBACK_WORKLET_SOURCE,
} from "./browser-pcm-audio.js";
import type { TaggedPcmChunk } from "./interruptible-pcm-playback.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

class FakePhysicalQueue {
  samples: number[] = [];

  clear(): void {
    this.samples = [];
  }

  apply(policy: LowLatencyPcmQueuePolicy, chunk: TaggedPcmChunk): boolean {
    const admission = policy.admit(chunk);
    if (admission.accepted) {
      this.samples.push(...admission.samples);
    }
    return admission.accepted;
  }
}

function chunk(samples: number[], generation = 1): TaggedPcmChunk {
  return {
    generation,
    responseId: "response",
    samples: Int16Array.from(samples),
  };
}

type FakeWorkletPort = {
  onmessage: ((message: { data: unknown }) => void) | null;
  posted: unknown[];
  postMessage(message: unknown): void;
};

type FakePlaybackProcessor = {
  port: FakeWorkletPort;
  process(inputs: unknown[], outputs: Float32Array[][]): boolean;
};

function createPlaybackProcessor(
  prebufferFrames: number,
  maxBufferingFrames: number,
): FakePlaybackProcessor {
  let registered:
    | (new (options: {
        processorOptions: {
          prebufferFrames: number;
          maxBufferingFrames: number;
        };
      }) => FakePlaybackProcessor)
    | null = null;

  class FakeAudioWorkletProcessor {
    readonly port: FakeWorkletPort = {
      onmessage: null,
      posted: [],
      postMessage(message: unknown) {
        this.posted.push(message);
      },
    };
  }

  const registerProcessor = (
    _name: string,
    Processor: new (options: {
      processorOptions: {
        prebufferFrames: number;
        maxBufferingFrames: number;
      };
    }) => FakePlaybackProcessor,
  ): void => {
    registered = Processor;
  };

  // Evaluate the exact blob source that the browser installs in AudioWorklet.
  const install = new Function(
    "AudioWorkletProcessor",
    "registerProcessor",
    "sampleRate",
    PLAYBACK_WORKLET_SOURCE,
  );
  install(FakeAudioWorkletProcessor, registerProcessor, 24_000);
  const Processor = registered as
    | (new (options: {
        processorOptions: {
          prebufferFrames: number;
          maxBufferingFrames: number;
        };
      }) => FakePlaybackProcessor)
    | null;
  if (!Processor) {
    throw new Error("播放 AudioWorklet 未注册处理器。");
  }
  return new Processor({
    processorOptions: { prebufferFrames, maxBufferingFrames },
  });
}

function sendToProcessor(
  processor: FakePlaybackProcessor,
  data: unknown,
): void {
  processor.port.onmessage?.({ data });
}

function renderFrames(
  processor: FakePlaybackProcessor,
  frameCount: number,
): number[] {
  const output = new Float32Array(frameCount);
  processor.process([], [[output]]);
  return [...output].map((sample) => Math.round(sample * 32_768));
}

describe("lossless PCM queue policy", () => {
  it("remains pending until every accepted sample has been consumed", () => {
    const policy = new LowLatencyPcmQueuePolicy();
    expect(policy.hasPendingAudio).toBe(false);
    policy.reset(1);
    policy.setAvailable(true);
    policy.admit(chunk([]));
    expect(policy.hasPendingAudio).toBe(false);
    policy.admit(chunk([1, 2, 3]));
    policy.admit(chunk([4]));
    expect(policy.hasPendingAudio).toBe(true);

    policy.consume(1, 3);
    expect(policy.hasPendingAudio).toBe(true);
    policy.consume(1, 1);
    expect(policy.hasPendingAudio).toBe(false);
    policy.consume(1, 10);
    expect(policy.hasPendingAudio).toBe(false);
  });

  it("clears on a fake suspended context and accepts only future samples after resume", () => {
    const policy = new LowLatencyPcmQueuePolicy();
    const physical = new FakePhysicalQueue();
    policy.reset(1);
    policy.setAvailable(true);
    expect(physical.apply(policy, chunk([1000, 1000]))).toBe(true);
    expect(policy.hasPendingAudio).toBe(true);

    // Fake context transition: running -> suspended/hidden.
    if (policy.setAvailable(false)) {
      physical.clear();
    }
    expect(physical.apply(policy, chunk([1100, 1100]))).toBe(false);
    expect(policy.hasPendingAudio).toBe(false);
    policy.setAvailable(true);
    expect(policy.hasPendingAudio).toBe(false);
    expect(physical.apply(policy, chunk([-1000, -1000]))).toBe(true);
    expect(policy.hasPendingAudio).toBe(true);

    expect(physical.samples).toEqual([-1000, -1000]);
  });

  it("preserves every accepted sample instead of skipping ahead", () => {
    const policy = new LowLatencyPcmQueuePolicy();
    const physical = new FakePhysicalQueue();
    policy.reset(1);
    policy.setAvailable(true);
    physical.apply(policy, chunk([1, 1, 1]));
    physical.apply(policy, chunk([2, 2, 2]));

    expect(physical.samples).toEqual([1, 1, 1, 2, 2, 2]);
  });

  it("still rejects old samples after an interruption generation reset", () => {
    const policy = new LowLatencyPcmQueuePolicy();
    const physical = new FakePhysicalQueue();
    policy.reset(1);
    policy.setAvailable(true);
    physical.apply(policy, chunk([1000, 1000], 1));

    policy.reset(2);
    expect(policy.hasPendingAudio).toBe(false);
    physical.clear();
    physical.apply(policy, chunk([1100, 1100], 1));
    expect(policy.hasPendingAudio).toBe(false);
    physical.apply(policy, chunk([-1000, -1000], 2));
    policy.consume(1, 10);
    expect(policy.hasPendingAudio).toBe(true);

    expect(physical.samples).toEqual([-1000, -1000]);
  });

  it("prebuffers bursty PCM and then renders every sample in order", () => {
    const processor = createPlaybackProcessor(4, 8);
    sendToProcessor(processor, { type: "reset", generation: 1 });
    sendToProcessor(processor, {
      type: "enqueue",
      generation: 1,
      responseId: "response-a",
      samples: Int16Array.from([1000, 1000]).buffer,
    });

    expect(renderFrames(processor, 2)).toEqual([0, 0]);
    sendToProcessor(processor, {
      type: "enqueue",
      generation: 1,
      responseId: "response-a",
      samples: Int16Array.from([2000, 2000]).buffer,
    });

    expect(renderFrames(processor, 4)).toEqual([1000, 1000, 2000, 2000]);

    sendToProcessor(processor, {
      type: "enqueue",
      generation: 1,
      responseId: "response-a",
      samples: Int16Array.from([3000, 3000]).buffer,
    });
    expect(renderFrames(processor, 2)).toEqual([0, 0]);
    sendToProcessor(processor, {
      type: "enqueue",
      generation: 1,
      responseId: "response-a",
      samples: Int16Array.from([4000, 4000]).buffer,
    });
    expect(renderFrames(processor, 4)).toEqual([3000, 3000, 4000, 4000]);
  });

  it("plays a short final chunk after the bounded buffering wait", () => {
    const processor = createPlaybackProcessor(8, 4);
    sendToProcessor(processor, { type: "reset", generation: 1 });
    sendToProcessor(processor, {
      type: "enqueue",
      generation: 1,
      responseId: "short-response",
      samples: Int16Array.from([1000, 1000]).buffer,
    });

    expect(renderFrames(processor, 2)).toEqual([0, 0]);
    expect(renderFrames(processor, 2)).toEqual([0, 0]);
    expect(renderFrames(processor, 2)).toEqual([0, 0]);
    expect(renderFrames(processor, 2)).toEqual([1000, 1000]);
  });

  it("clears buffered PCM immediately on generation reset", () => {
    const processor = createPlaybackProcessor(1, 1);
    sendToProcessor(processor, { type: "reset", generation: 1 });
    sendToProcessor(processor, {
      type: "enqueue",
      generation: 1,
      responseId: "response-a",
      samples: Int16Array.from([1000, 1000]).buffer,
    });
    expect(renderFrames(processor, 1)).toEqual([1000]);

    sendToProcessor(processor, { type: "reset", generation: 2 });
    sendToProcessor(processor, {
      type: "enqueue",
      generation: 1,
      responseId: "response-a",
      samples: Int16Array.from([1000]).buffer,
    });
    sendToProcessor(processor, {
      type: "enqueue",
      generation: 2,
      responseId: "response-b",
      samples: Int16Array.from([-1000]).buffer,
    });

    expect(renderFrames(processor, 1)).toEqual([-1000]);
  });

  it("a pointer retry supersedes a resume promise that never settles", async () => {
    const gate = new AudioContextResumeGate();
    let resolveFirst: () => void = () => undefined;
    let resolveSecond: () => void = () => undefined;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const resume = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const running = vi.fn();
    const rejected = vi.fn();

    gate.resume(resume, running, rejected);
    gate.resume(resume, running, rejected);
    expect(resume).toHaveBeenCalledTimes(1);

    gate.resume(resume, running, rejected, true);
    expect(resume).toHaveBeenCalledTimes(2);
    resolveSecond();
    await second;
    await Promise.resolve();
    expect(running).toHaveBeenCalledTimes(1);

    resolveFirst();
    await first;
    await Promise.resolve();
    expect(running).toHaveBeenCalledTimes(1);
    expect(rejected).not.toHaveBeenCalled();
  });
});

function createPlaybackHarness() {
  const contexts: FakePlaybackContext[] = [];
  const nodes: FakePlaybackNode[] = [];

  class FakePlaybackContext {
    state: AudioContextState = "running";
    readonly sampleRate = 24_000;
    readonly destination = {};
    readonly audioWorklet = { addModule: async () => undefined };
    onstatechange: (() => void) | null = null;

    constructor() {
      contexts.push(this);
    }

    async resume(): Promise<void> {}

    async close(): Promise<void> {
      this.state = "closed";
    }

    setState(state: AudioContextState): void {
      this.state = state;
      this.onstatechange?.();
    }
  }

  class FakePlaybackNode {
    readonly processor = createPlaybackProcessor(1, 1);
    readonly port = {
      onmessage: null as ((message: { data: unknown }) => void) | null,
      postMessage: (message: unknown) => {
        sendToProcessor(this.processor, message);
      },
      close: () => undefined,
    };

    constructor() {
      nodes.push(this);
    }

    connect(): void {}

    disconnect(): void {}

    deliverConsumed(): void {
      for (const data of this.processor.port.posted.splice(0)) {
        this.port.onmessage?.({ data });
      }
    }
  }

  vi.stubGlobal("window", { AudioContext: FakePlaybackContext });
  vi.stubGlobal("AudioWorkletNode", FakePlaybackNode);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:playback-test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

  return {
    playback: new AudioWorkletPcmPlayback(),
    get context() {
      return contexts.at(-1)!;
    },
    get node() {
      return nodes.at(-1)!;
    },
  };
}

describe("playback pending audio", () => {
  it("waits for worklet consumption, including the final short tail", async () => {
    const harness = createPlaybackHarness();
    const { playback } = harness;
    expect(playback.hasPendingAudio).toBe(false);
    await playback.start();
    playback.reset(1);
    expect(playback.enqueue(chunk(new Array(1026).fill(1000)))).toBe(true);
    expect(playback.hasPendingAudio).toBe(true);

    renderFrames(harness.node.processor, 1024);
    harness.node.deliverConsumed();
    expect(playback.hasPendingAudio).toBe(true);
    renderFrames(harness.node.processor, 2);
    expect(playback.hasPendingAudio).toBe(true);
    harness.node.deliverConsumed();
    expect(playback.hasPendingAudio).toBe(false);

    playback.enqueue(chunk([1000]));
    await playback.stop();
    expect(playback.hasPendingAudio).toBe(false);
  });

  it("ignores consumed acknowledgements queued before a suspension reset", async () => {
    const harness = createPlaybackHarness();
    const { playback } = harness;
    await playback.start();
    playback.reset(1);
    playback.enqueue(chunk([1000, 1000]));
    renderFrames(harness.node.processor, 2);
    expect(playback.hasPendingAudio).toBe(true);

    harness.context.setState("suspended");
    expect(playback.hasPendingAudio).toBe(false);
    harness.context.setState("running");
    playback.enqueue(chunk([2000, 2000]));
    harness.node.deliverConsumed();
    expect(playback.hasPendingAudio).toBe(true);
    expect(renderFrames(harness.node.processor, 2)).toEqual([2000, 2000]);
    harness.node.deliverConsumed();
    expect(playback.hasPendingAudio).toBe(false);
    await playback.stop();
  });

  it("clears pending audio on a generation reset and rejects late old audio", async () => {
    const harness = createPlaybackHarness();
    const { playback } = harness;
    await playback.start();
    playback.reset(1);
    playback.enqueue(chunk([1000, 1000]));
    renderFrames(harness.node.processor, 2);

    playback.reset(2);
    expect(playback.hasPendingAudio).toBe(false);
    expect(playback.enqueue(chunk([1000], 1))).toBe(false);
    expect(playback.hasPendingAudio).toBe(false);
    playback.enqueue(chunk([2000], 2));
    harness.node.deliverConsumed();
    expect(playback.hasPendingAudio).toBe(true);
    expect(renderFrames(harness.node.processor, 1)).toEqual([2000]);
    harness.node.deliverConsumed();
    expect(playback.hasPendingAudio).toBe(false);
    await playback.stop();
  });
});
