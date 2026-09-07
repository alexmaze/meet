import { describe, expect, it, vi } from "vitest";
import { ConversationApiError } from "../history/conversation-api.js";
import {
  flushTranscriptQueue,
  type ConversationPersistence,
} from "./transcript-persistence.js";

function queue(): ConversationPersistence {
  return {
    id: "conversation",
    writer: { clientId: "client", epoch: 3 },
    endOperation: null,
    nextSequence: 3,
    acknowledgedSequence: 0,
    flushing: null,
    pending: [1, 2].map((sequence) => ({
      id: `message-${sequence}`,
      sequence,
      role: "user",
      status: "completed",
      text: `第${sequence}句话`,
      providerEventId: null,
      createdAt: "2026-09-08T00:00:00.000Z",
    })),
  };
}
const wait = async () => undefined;
describe("in-memory confirmed transcript queue", () => {
  it("retains failed text and later replays the same ids and sequence", async () => {
    const persistence = queue();
    const append = vi
      .fn()
      .mockResolvedValueOnce(1)
      .mockRejectedValue(new Error("offline"));
    await expect(
      flushTranscriptQueue(persistence, append, () => undefined, wait),
    ).rejects.toThrow("offline");
    expect(persistence.pending.map((message) => message.id)).toEqual([
      "message-2",
    ]);
    expect(persistence.acknowledgedSequence).toBe(1);
    append.mockResolvedValue(2);
    await flushTranscriptQueue(persistence, append, () => undefined, wait);
    expect(persistence.pending).toEqual([]);
    expect(append.mock.calls.at(-1)?.[1]).toMatchObject({
      writer: { epoch: 3 },
      messages: [{ id: "message-2", sequence: 2 }],
    });
  });
  it("shares an in-flight flush so simultaneous finish and transcript events do not double-write", async () => {
    const persistence = queue();
    let acknowledge: (value: number) => void = () => undefined;
    const append = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            acknowledge = resolve;
          }),
      )
      .mockResolvedValue(2);
    const first = flushTranscriptQueue(
      persistence,
      append,
      () => undefined,
      wait,
    );
    const second = flushTranscriptQueue(
      persistence,
      append,
      () => undefined,
      wait,
    );
    expect(second).toBe(first);
    expect(append).toHaveBeenCalledTimes(1);
    acknowledge(1);
    await first;
    expect(append).toHaveBeenCalledTimes(2);
    expect(persistence.pending).toEqual([]);
  });
  it("keeps all text on writer conflict without retrying a stale writer", async () => {
    const persistence = queue();
    const append = vi
      .fn()
      .mockRejectedValue(
        new ConversationApiError(409, "CONVERSATION_WRITER_STALE"),
      );
    await expect(
      flushTranscriptQueue(persistence, append, () => undefined, wait),
    ).rejects.toMatchObject({ code: "CONVERSATION_WRITER_STALE" });
    expect(persistence.pending).toHaveLength(2);
    expect(append).toHaveBeenCalledTimes(1);
  });
  it("never discards a message based on an acknowledgement of an earlier sequence", async () => {
    const persistence = queue();
    const append = vi.fn().mockResolvedValue(0);
    await expect(
      flushTranscriptQueue(persistence, append, () => undefined, wait),
    ).rejects.toMatchObject({
      code: "CONVERSATION_ACKNOWLEDGEMENT_INCOMPLETE",
    });
    expect(persistence.pending).toHaveLength(2);
  });
});
