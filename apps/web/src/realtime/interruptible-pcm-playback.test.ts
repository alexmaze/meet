import { describe, expect, it } from "vitest";

import {
  InterruptiblePcmPlayback,
  type GenerationPcmSink,
  type TaggedPcmChunk,
} from "./interruptible-pcm-playback.js";

class RecordingGenerationSink implements GenerationPcmSink {
  generation = 0;
  chunks: TaggedPcmChunk[] = [];

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

  readAll(): Int16Array {
    const length = this.chunks.reduce(
      (total, chunk) => total + chunk.samples.length,
      0,
    );
    const result = new Int16Array(length);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk.samples, offset);
      offset += chunk.samples.length;
    }
    return result;
  }
}

describe("InterruptiblePcmPlayback", () => {
  it("never emits response A again after clear and response B starts", () => {
    const sink = new RecordingGenerationSink();
    const playback = new InterruptiblePcmPlayback(sink);
    const responseA = new Int16Array([1000, 1000, 1000, 1000]);
    const responseB = new Int16Array([-1000, -1000, -1000, -1000]);

    expect(playback.beginResponse("response-a").accepted).toBe(true);
    expect(playback.enqueue("response-a", responseA).enqueued).toBe(true);
    playback.speechStarted();

    // Provider packets already in flight for A arrive after the interruption.
    expect(playback.enqueue("response-a", responseA).enqueued).toBe(false);
    expect([...sink.readAll()]).toEqual([]);
    playback.confirmSpeechInterruption();
    playback.commitSpeechTurn();
    expect(playback.enqueue("response-b", responseB).enqueued).toBe(true);

    // A remains permanently blocked even after B has become active.
    expect(playback.enqueue("response-a", responseA).enqueued).toBe(false);

    expect([...sink.readAll()]).toEqual([-1000, -1000, -1000, -1000]);
    expect(sink.readAll()).not.toContain(1000);
  });

  it("restores only future deltas after smart_turn reports turn_invalid", () => {
    const sink = new RecordingGenerationSink();
    const playback = new InterruptiblePcmPlayback(sink);

    playback.enqueue("response-a", new Int16Array([1000, 1000]));
    playback.speechStarted();
    expect(
      playback.enqueue("response-a", new Int16Array([1100, 1100])).enqueued,
    ).toBe(false);

    expect(playback.resumeAfterInvalidTurn()).toBe("response-a");
    expect(
      playback.enqueue("response-a", new Int16Array([1200, 1200])).enqueued,
    ).toBe(true);

    expect([...sink.readAll()]).toEqual([1200, 1200]);
  });

  it("does not let a late cancelled done for A clear response B", () => {
    const sink = new RecordingGenerationSink();
    const playback = new InterruptiblePcmPlayback(sink);

    playback.enqueue("response-a", new Int16Array([1000]));
    playback.speechStarted();
    playback.confirmSpeechInterruption();
    playback.commitSpeechTurn();
    playback.beginResponse("response-b");
    playback.enqueue("response-b", new Int16Array([-1000, -1000]));
    playback.responseDone("response-a", true);

    expect([...sink.readAll()]).toEqual([-1000, -1000]);
    expect(playback.currentResponseId).toBe("response-b");
  });

  it("clears already queued tail even after a completed response", () => {
    const sink = new RecordingGenerationSink();
    const playback = new InterruptiblePcmPlayback(sink);

    playback.enqueue("response-a", new Int16Array([1000, 1000]));
    playback.responseDone("response-a", false);
    playback.manualInterrupt();

    expect([...sink.readAll()]).toEqual([]);
    expect(
      playback.enqueue("response-a", new Int16Array([1000, 1000])).enqueued,
    ).toBe(false);
  });

  it("treats the first response created before speech commit as old", () => {
    const sink = new RecordingGenerationSink();
    const playback = new InterruptiblePcmPlayback(sink);

    // speech_started wins the race against old response.created.
    playback.speechStarted();
    expect(playback.beginResponse("response-old").accepted).toBe(false);
    expect(
      playback.enqueue("response-old", new Int16Array([1000])).enqueued,
    ).toBe(false);
    playback.confirmSpeechInterruption();
    playback.commitSpeechTurn();

    expect(playback.beginResponse("response-old").accepted).toBe(false);
    expect(
      playback.enqueue("response-fresh", new Int16Array([-1000])).enqueued,
    ).toBe(true);
    expect([...sink.readAll()]).toEqual([-1000]);
  });

  it("restores a response first seen after speech_started when turn is invalid", () => {
    const sink = new RecordingGenerationSink();
    const playback = new InterruptiblePcmPlayback(sink);

    playback.speechStarted();
    expect(playback.beginResponse("response-old").accepted).toBe(false);
    expect(playback.resumeAfterInvalidTurn()).toBe("response-old");
    expect(
      playback.enqueue("response-old", new Int16Array([1200])).enqueued,
    ).toBe(true);
    expect([...sink.readAll()]).toEqual([1200]);
  });

  it("cancels a response created after manual stop while projection was thinking", () => {
    const sink = new RecordingGenerationSink();
    const playback = new InterruptiblePcmPlayback(sink);

    expect(playback.manualInterrupt(true)).toBeNull();
    expect(playback.beginResponse("response-old")).toEqual({
      accepted: false,
      shouldCancel: true,
    });
    expect(playback.beginResponse("response-old")).toEqual({
      accepted: false,
      shouldCancel: false,
    });
    playback.responseDone("response-old", true, "client_cancelled");

    expect(playback.beginResponse("response-fresh").accepted).toBe(true);
  });

  it("does not let an unrelated stale done release an unknown manual response barrier", () => {
    const sink = new RecordingGenerationSink();
    const playback = new InterruptiblePcmPlayback(sink);

    playback.manualInterrupt(true);
    playback.responseDone("unrelated-stale-response", false);
    expect(playback.beginResponse("response-old")).toEqual({
      accepted: false,
      shouldCancel: true,
    });
    playback.responseDone("response-old", true, "client_cancelled");
    expect(playback.beginResponse("response-fresh").accepted).toBe(true);
  });

  it("rejects a stale generation at the physical sink", () => {
    const sink = new RecordingGenerationSink();
    sink.reset(2);

    expect(
      sink.enqueue({
        generation: 1,
        responseId: "response-a",
        samples: new Int16Array([1000]),
      }),
    ).toBe(false);
    expect([...sink.readAll()]).toEqual([]);
  });
});
