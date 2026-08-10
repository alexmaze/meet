import { describe, expect, it, vi } from "vitest";

import {
  AudioContextResumeGate,
  LowLatencyPcmQueuePolicy,
  PLAYBACK_WORKLET_SOURCE,
} from "./browser-pcm-audio.js";
import type { TaggedPcmChunk } from "./interruptible-pcm-playback.js";

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
  it("clears on a fake suspended context and accepts only future samples after resume", () => {
    const policy = new LowLatencyPcmQueuePolicy();
    const physical = new FakePhysicalQueue();
    policy.reset(1);
    policy.setAvailable(true);
    expect(physical.apply(policy, chunk([1000, 1000]))).toBe(true);

    // Fake context transition: running -> suspended/hidden.
    if (policy.setAvailable(false)) {
      physical.clear();
    }
    expect(physical.apply(policy, chunk([1100, 1100]))).toBe(false);
    policy.setAvailable(true);
    expect(physical.apply(policy, chunk([-1000, -1000]))).toBe(true);

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
    physical.clear();
    physical.apply(policy, chunk([1100, 1100], 1));
    physical.apply(policy, chunk([-1000, -1000], 2));

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
