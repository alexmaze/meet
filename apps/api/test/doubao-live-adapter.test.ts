import { EventEmitter, once } from "node:events";
import { createHash } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DOUBAO_REALTIME_WEBSOCKET_URL,
  DOUBAO_RELAY_UPSTREAM_MAX_MESSAGE_BYTES,
  type DoubaoWebSocketFactory,
} from "../src/doubao-websocket.js";
import {
  DOUBAO_PROTOCOL_SMOKE_PCM_CHUNK_BYTES,
  DOUBAO_PROTOCOL_SMOKE_MAX_EVENT_QUEUE_DEPTH,
  DOUBAO_PROTOCOL_SMOKE_MAX_PROVIDER_BYTES,
  DOUBAO_PROTOCOL_SMOKE_MAX_PROVIDER_EVENTS,
  DoubaoProtocolSmokeAdapter,
  runDoubaoTeachingPcmProtocolSmoke,
} from "../src/spikes/realtime-teaching/doubao-live-adapter.js";
import {
  TEACHING_SPIKE_FIXTURES,
  compileTeachingInstructions,
} from "../src/spikes/realtime-teaching/fixtures.js";

const servers: WebSocketServer[] = [];
const pcm = Buffer.alloc(DOUBAO_PROTOCOL_SMOKE_PCM_CHUNK_BYTES * 2, 7);
const base = compileTeachingInstructions({
  base: TEACHING_SPIKE_FIXTURES.base.text,
  safety: TEACHING_SPIKE_FIXTURES.safety.text,
  maxCharacters: 12_000,
});
const directiveA = compileTeachingInstructions({
  base: TEACHING_SPIKE_FIXTURES.base.text,
  safety: TEACHING_SPIKE_FIXTURES.safety.text,
  directive: TEACHING_SPIKE_FIXTURES.directiveA.text,
  maxCharacters: 12_000,
});
const directiveB = compileTeachingInstructions({
  base: TEACHING_SPIKE_FIXTURES.base.text,
  safety: TEACHING_SPIKE_FIXTURES.safety.text,
  directive: TEACHING_SPIKE_FIXTURES.directiveB.text,
  maxCharacters: 12_000,
});

afterEach(async () => {
  vi.restoreAllMocks();
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

describe("Doubao isolated protocol-smoke adapter", () => {
  it("runs the D01/D02 pair without crossing update, response.done, or restore ACK gates", async () => {
    const upstream = createServer();
    upstream.on("headers", (headers) => {
      headers.push("X-Tt-Logid: mock-log-d01-d02");
    });
    await once(upstream, "listening");

    const firstUpdate = deferred<{
      event: Record<string, unknown>;
      socket: WebSocket;
    }>();
    const firstOutputDone = deferred<WebSocket>();
    const restoreUpdate = deferred<{
      event: Record<string, unknown>;
      socket: WebSocket;
    }>();
    const peerClosed = deferred<void>();
    const received: Record<string, unknown>[] = [];
    let createSession: Record<string, unknown> | undefined;
    let closeAckSent = false;
    let peerClosedAfterAck = false;
    let updateCount = 0;
    let commitCount = 0;

    upstream.once("connection", (socket, request) => {
      expect(request.headers["x-api-key"]).toBe("mock-only-key");
      socket.on("close", () => {
        peerClosedAfterAck = closeAckSent;
        peerClosed.resolve();
      });
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        received.push(event);
        switch (event.type) {
          case "session.create":
            createSession = event.session as Record<string, unknown>;
            socket.send(
              JSON.stringify({
                event_id: "provider-created",
                type: "session.created",
                session: { id: "dialog-d01-d02" },
              }),
            );
            break;
          case "session.update":
            updateCount += 1;
            if (updateCount === 1) {
              firstUpdate.resolve({ event, socket });
            } else if (updateCount === 2) {
              restoreUpdate.resolve({ event, socket });
            } else {
              throw new Error(`unexpected update ${updateCount}`);
            }
            break;
          case "input_audio_buffer.commit":
            commitCount += 1;
            if (commitCount === 1) {
              sendTurnBeforeResponseDone(socket, {
                index: 1,
                textDeltas: ["我们带着星", "尘继续飞。"],
                finalText: "我们带着星尘继续飞。",
              });
              firstOutputDone.resolve(socket);
            } else if (commitCount === 2) {
              sendCompleteTurn(socket, {
                index: 2,
                textDeltas: ["我们继续飞船故事。"],
                finalText: "我们继续飞船故事。",
              });
            } else {
              throw new Error(`unexpected commit ${commitCount}`);
            }
            break;
          case "session.close":
            closeAckSent = true;
            socket.send(JSON.stringify({ type: "session.closed" }));
            break;
          default:
            break;
        }
      });
    });

    const adapter = createAdapter(upstream);
    await adapter.connect();
    expect(adapter.snapshot()).toMatchObject({
      transport: "open",
      session: "base_active",
    });

    const run = adapter.runD01D02Pair({
      directiveInstructions: directiveA.instructions,
      pcm,
      markers: { markerA: "星尘", markerB: "月桂" },
    });
    const applied = await withTimeout(firstUpdate.promise);
    await shortDelay();
    expect(eventCount(received, "input_audio_buffer.append")).toBe(0);
    sendSessionUpdated(applied.socket, applied.event, "dialog-d01-d02");

    const outputDoneSocket = await withTimeout(firstOutputDone.promise);
    await shortDelay();
    expect(updateCount).toBe(1);
    sendResponseDone(outputDoneSocket, 1);

    const restored = await withTimeout(restoreUpdate.promise);
    expect(commitCount).toBe(1);
    expect(eventCount(received, "input_audio_buffer.append")).toBe(2);
    await shortDelay();
    expect(commitCount).toBe(1);
    sendSessionUpdated(restored.socket, restored.event, "dialog-d01-d02");

    const result = await withTimeout(run);
    expect(result.directiveTurn).toMatchObject({
      markerCounts: { markerA: 1, markerB: 0 },
      responseDone: true,
      inputCommitted: true,
      transcriptionCompleted: true,
      textCompleted: true,
      audioCompleted: true,
    });
    expect(result.restoredControlTurn.markerCounts).toEqual({
      markerA: 0,
      markerB: 0,
    });
    expect(eventCount(received, "input_audio_buffer.append")).toBe(4);
    for (const event of received.filter(
      ({ type }) => type === "input_audio_buffer.append",
    )) {
      expect(Buffer.from(String(event.audio), "base64")).toHaveLength(
        DOUBAO_PROTOCOL_SMOKE_PCM_CHUNK_BYTES,
      );
    }

    const updates = received.filter(({ type }) => type === "session.update");
    expect(updates).toHaveLength(2);
    expect(updates[0]?.session).toEqual({
      ...createSession,
      instructions: directiveA.instructions,
    });
    expect(updates[1]?.session).toEqual(createSession);
    expect(adapter.snapshot()).toMatchObject({
      session: "base_active",
      turn: "idle",
    });

    await adapter.close();
    await withTimeout(peerClosed.promise);
    expect(peerClosedAfterAck).toBe(true);
    expect(adapter.snapshot()).toMatchObject({
      transport: "closed",
      session: "closed",
    });
  });

  it("runs D03 as A ACK then B ACK, sends no PCM before B, and restores only after response.done", async () => {
    const upstream = createServer();
    await once(upstream, "listening");

    const secondUpdate = deferred<{
      event: Record<string, unknown>;
      socket: WebSocket;
    }>();
    const responseOutputDone = deferred<WebSocket>();
    const restoreSeen = deferred<void>();
    const received: Record<string, unknown>[] = [];
    let updateCount = 0;

    upstream.once("connection", (socket) => {
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        received.push(event);
        switch (event.type) {
          case "session.create":
            socket.send(
              JSON.stringify({
                type: "session.created",
                session: { id: "dialog-d03" },
              }),
            );
            break;
          case "session.update":
            updateCount += 1;
            if (updateCount === 1) {
              sendSessionUpdated(socket, event, "dialog-d03");
            } else if (updateCount === 2) {
              secondUpdate.resolve({ event, socket });
            } else if (updateCount === 3) {
              restoreSeen.resolve();
              sendSessionUpdated(socket, event, "dialog-d03");
            }
            break;
          case "input_audio_buffer.commit":
            sendTurnBeforeResponseDone(socket, {
              index: 3,
              textDeltas: ["月", "桂号飞船准备好了。"],
              finalText: "月桂号飞船准备好了。",
            });
            responseOutputDone.resolve(socket);
            break;
          case "session.close":
            socket.send(JSON.stringify({ type: "session.closed" }));
            break;
          default:
            break;
        }
      });
    });

    const adapter = createAdapter(upstream);
    await adapter.connect();
    const run = adapter.runD03RevisionCycle({
      firstInstructions: directiveA.instructions,
      secondInstructions: directiveB.instructions,
      pcm,
      markers: { markerA: "星尘", markerB: "月桂" },
    });

    const secondUpdateAck = await withTimeout(secondUpdate.promise);
    expect(eventCount(received, "session.update")).toBe(2);
    expect(eventCount(received, "input_audio_buffer.append")).toBe(0);
    await shortDelay();
    expect(eventCount(received, "input_audio_buffer.append")).toBe(0);
    sendSessionUpdated(
      secondUpdateAck.socket,
      secondUpdateAck.event,
      "dialog-d03",
    );

    const outputDoneSocket = await withTimeout(responseOutputDone.promise);
    await shortDelay();
    expect(updateCount).toBe(2);
    sendResponseDone(outputDoneSocket, 3);
    await withTimeout(restoreSeen.promise);

    const result = await withTimeout(run);
    expect(result.replacementTurn.markerCounts).toEqual({
      markerA: 0,
      markerB: 1,
    });
    expect(result.replacementTurn.responseDone).toBe(true);
    expect(
      received
        .map(({ type }) => type)
        .filter((type) =>
          [
            "session.create",
            "session.update",
            "input_audio_buffer.append",
            "input_audio_buffer.commit",
          ].includes(String(type)),
        ),
    ).toEqual([
      "session.create",
      "session.update",
      "session.update",
      "input_audio_buffer.append",
      "input_audio_buffer.append",
      "input_audio_buffer.commit",
      "session.update",
    ]);

    await adapter.close();
  });

  it.each([
    ["bare", "INVALID_PROVIDER_EVENT"],
    ["wrong-session", "SESSION_UPDATE_ACK_MISMATCH"],
    ["wrong-instructions", "INSTRUCTION_ACK_MISMATCH"],
    ["wrong-full-config", "SESSION_CONFIGURATION_MISMATCH"],
  ] as const)(
    "fails closed on a %s session.updated ACK before sending PCM",
    async (mode, expectedCode) => {
      const upstream = createServer();
      await once(upstream, "listening");
      const received: Record<string, unknown>[] = [];
      upstream.once("connection", (socket) => {
        socket.on("message", (data) => {
          const event = JSON.parse(data.toString()) as Record<string, unknown>;
          received.push(event);
          if (event.type === "session.create") {
            socket.send(
              JSON.stringify({
                event_id: "provider-created-strict-ack",
                type: "session.created",
                session: { id: "dialog-strict-ack" },
              }),
            );
          } else if (event.type === "session.update") {
            if (mode === "bare") {
              socket.send(
                JSON.stringify({
                  event_id: "provider-bare-update-ack",
                  type: "session.updated",
                }),
              );
            } else {
              sendSessionUpdated(socket, event, "dialog-strict-ack", {
                ...(mode === "wrong-session" ? { id: "dialog-stale" } : {}),
                ...(mode === "wrong-instructions"
                  ? { instructions: "stale instructions" }
                  : {}),
                ...(mode === "wrong-full-config"
                  ? { model: "different-model" }
                  : {}),
              });
            }
          } else if (event.type === "session.close") {
            socket.send(JSON.stringify({ type: "session.closed" }));
          }
        });
      });

      const adapter = createAdapter(upstream);
      await adapter.connect();
      await expect(
        adapter.runD01D02Pair({
          directiveInstructions: directiveA.instructions,
          pcm,
          markers: { markerA: "星尘", markerB: "月桂" },
        }),
      ).rejects.toMatchObject({ code: expectedCode });
      expect(eventCount(received, "input_audio_buffer.append")).toBe(0);
      await adapter.close();
    },
  );

  it.each([
    ["bare", "INVALID_PROVIDER_EVENT"],
    ["wrong-id", "RESPONSE_ID_MISMATCH"],
    ["failed", "RESPONSE_NOT_COMPLETED"],
  ] as const)(
    "rejects a %s response.done terminal before restoring instructions",
    async (mode, expectedCode) => {
      const upstream = createServer();
      await once(upstream, "listening");
      const received: Record<string, unknown>[] = [];
      upstream.once("connection", (socket) => {
        socket.on("message", (data) => {
          const event = JSON.parse(data.toString()) as Record<string, unknown>;
          received.push(event);
          if (event.type === "session.create") {
            socket.send(
              JSON.stringify({
                event_id: "provider-created-strict-response",
                type: "session.created",
                session: { id: "dialog-strict-response" },
              }),
            );
          } else if (event.type === "session.update") {
            sendSessionUpdated(socket, event, "dialog-strict-response");
          } else if (event.type === "input_audio_buffer.commit") {
            sendTurnBeforeResponseDone(socket, {
              index: 90,
              textDeltas: ["星尘"],
              finalText: "星尘",
            });
            if (mode === "bare") {
              socket.send(
                JSON.stringify({
                  type: "response.done",
                  usage: { total_tokens: 90 },
                }),
              );
            } else {
              sendResponseDone(socket, 90, {
                ...(mode === "wrong-id"
                  ? { responseId: "response-stale" }
                  : {}),
                ...(mode === "failed" ? { status: "failed" } : {}),
              });
            }
          } else if (event.type === "session.close") {
            socket.send(JSON.stringify({ type: "session.closed" }));
          }
        });
      });

      const adapter = createAdapter(upstream);
      await adapter.connect();
      await expect(
        adapter.runD01D02Pair({
          directiveInstructions: directiveA.instructions,
          pcm,
          markers: { markerA: "星尘", markerB: "月桂" },
        }),
      ).rejects.toMatchObject({ code: expectedCode });
      expect(eventCount(received, "session.update")).toBe(1);
      await adapter.close();
    },
  );

  it("rejects inconsistent output_text delta and done representations", async () => {
    const upstream = createServer();
    await once(upstream, "listening");
    upstream.once("connection", (socket) => {
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        if (event.type === "session.create") {
          socket.send(
            JSON.stringify({
              type: "session.created",
              session: { id: "dialog-text-mismatch" },
            }),
          );
        } else if (event.type === "session.update") {
          sendSessionUpdated(socket, event, "dialog-text-mismatch");
        } else if (event.type === "input_audio_buffer.commit") {
          socket.send(JSON.stringify({ type: "input_audio_buffer.committed" }));
          socket.send(
            JSON.stringify({
              type: "conversation.item.input_audio_transcription.completed",
              transcript: "固定成年合成输入。",
            }),
          );
          socket.send(
            JSON.stringify({
              type: "response.output_text.delta",
              response_id: "response-text-mismatch",
              question_id: "question-text-mismatch",
              delta: "星尘",
            }),
          );
          socket.send(
            JSON.stringify({
              type: "response.output_text.done",
              response_id: "response-text-mismatch",
              question_id: "question-text-mismatch",
              text: "月桂",
            }),
          );
        } else if (event.type === "session.close") {
          socket.send(JSON.stringify({ type: "session.closed" }));
        }
      });
    });

    const adapter = createAdapter(upstream);
    await adapter.connect();
    await expect(
      adapter.runD01D02Pair({
        directiveInstructions: directiveA.instructions,
        pcm,
        markers: { markerA: "星尘", markerB: "月桂" },
      }),
    ).rejects.toMatchObject({ code: "OUTPUT_TEXT_MISMATCH" });
    await adapter.close();
  });

  it("rejects text deltas that arrive after output_text.done", async () => {
    const upstream = createServer();
    await once(upstream, "listening");
    upstream.once("connection", (socket) => {
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        if (event.type === "session.create") {
          socket.send(
            JSON.stringify({
              type: "session.created",
              session: { id: "dialog-text-after-done" },
            }),
          );
        } else if (event.type === "session.update") {
          sendSessionUpdated(socket, event, "dialog-text-after-done");
        } else if (event.type === "input_audio_buffer.commit") {
          socket.send(JSON.stringify({ type: "input_audio_buffer.committed" }));
          socket.send(
            JSON.stringify({
              type: "conversation.item.input_audio_transcription.completed",
              transcript: "固定成年合成输入。",
            }),
          );
          socket.send(
            JSON.stringify({
              type: "response.output_text.delta",
              response_id: "response-text-after-done",
              question_id: "question-text-after-done",
              delta: "星尘",
            }),
          );
          socket.send(
            JSON.stringify({
              type: "response.output_text.done",
              response_id: "response-text-after-done",
              question_id: "question-text-after-done",
              text: "星尘",
            }),
          );
          socket.send(
            JSON.stringify({
              type: "response.output_text.delta",
              response_id: "response-text-after-done",
              question_id: "question-text-after-done",
              delta: "月桂",
            }),
          );
        } else if (event.type === "session.close") {
          socket.send(JSON.stringify({ type: "session.closed" }));
        }
      });
    });

    const adapter = createAdapter(upstream);
    await adapter.connect();
    await expect(
      adapter.runD01D02Pair({
        directiveInstructions: directiveA.instructions,
        pcm,
        markers: { markerA: "星尘", markerB: "月桂" },
      }),
    ).rejects.toMatchObject({ code: "OUTPUT_TEXT_MISMATCH" });
    await adapter.close();
  });

  it("rejects a second audio segment after output_audio.done", async () => {
    const upstream = createServer();
    await once(upstream, "listening");
    upstream.once("connection", (socket) => {
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        if (event.type === "session.create") {
          socket.send(
            JSON.stringify({
              type: "session.created",
              session: { id: "dialog-audio-after-done" },
            }),
          );
        } else if (event.type === "session.update") {
          sendSessionUpdated(socket, event, "dialog-audio-after-done");
        } else if (event.type === "input_audio_buffer.commit") {
          sendTurnBeforeResponseDone(socket, {
            index: 98,
            textDeltas: ["星尘"],
            finalText: "星尘",
          });
          socket.send(
            JSON.stringify({
              type: "response.output_audio.started",
              question_id: "question-98",
              response_id: "response-98",
            }),
          );
        } else if (event.type === "session.close") {
          socket.send(JSON.stringify({ type: "session.closed" }));
        }
      });
    });

    const adapter = createAdapter(upstream);
    await adapter.connect();
    await expect(
      adapter.runD01D02Pair({
        directiveInstructions: directiveA.instructions,
        pcm,
        markers: { markerA: "星尘", markerB: "月桂" },
      }),
    ).rejects.toMatchObject({ code: "UNEXPECTED_RESPONSE_EVENT" });
    await adapter.close();
  });

  it("rejects response.output_audio.started after output_audio.done", async () => {
    const upstream = createServer();
    await once(upstream, "listening");
    upstream.once("connection", (socket) => {
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        if (event.type === "session.create") {
          socket.send(
            JSON.stringify({
              type: "session.created",
              session: { id: "dialog-audio-after-done" },
            }),
          );
        } else if (event.type === "session.update") {
          sendSessionUpdated(socket, event, "dialog-audio-after-done");
        } else if (event.type === "input_audio_buffer.commit") {
          sendTurnBeforeResponseDone(socket, {
            index: 97,
            textDeltas: ["星尘"],
            finalText: "星尘",
          });
          socket.send(
            JSON.stringify({
              event_id: "provider-audio-started-after-done",
              type: "response.output_audio.started",
              question_id: "question-97",
              response_id: "response-97",
              tts_type: "default",
            }),
          );
        } else if (event.type === "session.close") {
          socket.send(JSON.stringify({ type: "session.closed" }));
        }
      });
    });

    const adapter = createAdapter(upstream);
    await adapter.connect();
    await expect(
      adapter.runD01D02Pair({
        directiveInstructions: directiveA.instructions,
        pcm,
        markers: { markerA: "星尘", markerB: "月桂" },
      }),
    ).rejects.toMatchObject({ code: "UNEXPECTED_RESPONSE_EVENT" });
    await adapter.close();
  });

  it.each(["delta", "done"] as const)(
    "bounds output_text.%s independently",
    async (representation) => {
      const upstream = createServer();
      await once(upstream, "listening");
      upstream.once("connection", (socket) => {
        socket.on("message", (data) => {
          const event = JSON.parse(data.toString()) as Record<string, unknown>;
          if (event.type === "session.create") {
            socket.send(
              JSON.stringify({
                type: "session.created",
                session: { id: `dialog-text-${representation}-limit` },
              }),
            );
          } else if (event.type === "session.update") {
            sendSessionUpdated(
              socket,
              event,
              `dialog-text-${representation}-limit`,
            );
          } else if (event.type === "input_audio_buffer.commit") {
            socket.send(
              JSON.stringify({ type: "input_audio_buffer.committed" }),
            );
            socket.send(
              JSON.stringify({
                type: "conversation.item.input_audio_transcription.completed",
                transcript: "固定成年合成输入。",
              }),
            );
            socket.send(
              JSON.stringify({
                type: `response.output_text.${representation}`,
                response_id: `response-text-${representation}-limit`,
                question_id: `question-text-${representation}-limit`,
                ...(representation === "delta"
                  ? { delta: "x".repeat(32_001) }
                  : { text: "x".repeat(32_001) }),
              }),
            );
          } else if (event.type === "session.close") {
            socket.send(JSON.stringify({ type: "session.closed" }));
          }
        });
      });

      const adapter = createAdapter(upstream);
      await adapter.connect();
      await expect(
        adapter.runD01D02Pair({
          directiveInstructions: directiveA.instructions,
          pcm,
          markers: { markerA: "星尘", markerB: "月桂" },
        }),
      ).rejects.toMatchObject({ code: "OUTPUT_TEXT_TOO_LARGE" });
      await adapter.close();
    },
  );

  it("rejects a response_id reused by a later turn on the connection", async () => {
    const upstream = createServer();
    await once(upstream, "listening");
    let commitCount = 0;
    upstream.once("connection", (socket) => {
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        if (event.type === "session.create") {
          socket.send(
            JSON.stringify({
              type: "session.created",
              session: { id: "dialog-response-id-reuse" },
            }),
          );
        } else if (event.type === "session.update") {
          sendSessionUpdated(socket, event, "dialog-response-id-reuse");
        } else if (event.type === "input_audio_buffer.commit") {
          commitCount += 1;
          if (commitCount === 1) {
            sendCompleteTurn(socket, {
              index: 95,
              responseId: "response-reused",
              textDeltas: ["星尘"],
              finalText: "星尘",
            });
          } else {
            socket.send(
              JSON.stringify({ type: "input_audio_buffer.committed" }),
            );
            socket.send(
              JSON.stringify({
                type: "conversation.item.input_audio_transcription.completed",
                transcript: "固定成年合成输入。",
              }),
            );
            socket.send(
              JSON.stringify({
                type: "response.output_text.delta",
                response_id: "response-reused",
                question_id: "question-response-id-reuse-2",
                delta: "继续",
              }),
            );
          }
        } else if (event.type === "session.close") {
          socket.send(JSON.stringify({ type: "session.closed" }));
        }
      });
    });

    const adapter = createAdapter(upstream);
    await adapter.connect();
    await expect(
      adapter.runD01D02Pair({
        directiveInstructions: directiveA.instructions,
        pcm,
        markers: { markerA: "星尘", markerB: "月桂" },
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_RESPONSE_ID" });
    expect(commitCount).toBe(2);
    await adapter.close();
  });

  it.each(["audio-delta", "response-done"] as const)(
    "fails closed on a late %s after response.done before restore can succeed",
    async (lateEvent) => {
      const upstream = createServer();
      await once(upstream, "listening");
      let updateCount = 0;
      let commitCount = 0;
      upstream.once("connection", (socket) => {
        socket.on("message", (data) => {
          const event = JSON.parse(data.toString()) as Record<string, unknown>;
          if (event.type === "session.create") {
            socket.send(
              JSON.stringify({
                type: "session.created",
                session: { id: `dialog-late-${lateEvent}` },
              }),
            );
          } else if (event.type === "session.update") {
            updateCount += 1;
            if (updateCount === 1) {
              sendSessionUpdated(socket, event, `dialog-late-${lateEvent}`);
            }
          } else if (event.type === "input_audio_buffer.commit") {
            commitCount += 1;
            sendCompleteTurn(socket, {
              index: 96,
              textDeltas: ["星尘"],
              finalText: "星尘",
            });
            socket.send(
              JSON.stringify(
                lateEvent === "audio-delta"
                  ? {
                      event_id: "provider-late-audio-delta",
                      type: "response.output_audio.delta",
                      response_id: "response-96",
                      question_id: "question-96",
                      delta: "AQIDBA==",
                    }
                  : {
                      event_id: "provider-late-response-done",
                      type: "response.done",
                      response_id: "response-96",
                      status: "completed",
                    },
              ),
            );
          } else if (event.type === "session.close") {
            socket.send(JSON.stringify({ type: "session.closed" }));
          }
        });
      });

      const adapter = createAdapter(upstream);
      await adapter.connect();
      await expect(
        adapter.runD01D02Pair({
          directiveInstructions: directiveA.instructions,
          pcm,
          markers: { markerA: "星尘", markerB: "月桂" },
        }),
      ).rejects.toMatchObject({ code: "UNEXPECTED_RESPONSE_EVENT" });
      expect(commitCount).toBe(1);
      expect(adapter.snapshot()).toMatchObject({
        session: "failed",
        turn: "idle",
      });
      await shortDelay();
      expect(updateCount).toBe(2);
      await adapter.close();
    },
  );

  it("preserves a failed high-level connect error and returns with no open socket", async () => {
    let activeSockets = 0;
    let fakeSocket: SynchronousFakeSocket | undefined;
    const factory: DoubaoWebSocketFactory = () => {
      activeSockets += 1;
      fakeSocket = new SynchronousFakeSocket((event, socket) => {
        if (event.type === "session.create") {
          socket.providerSend({
            type: "session.created",
            session: {},
          });
        }
      });
      fakeSocket.once("close", () => {
        activeSockets -= 1;
      });
      return fakeSocket as unknown as WebSocket;
    };

    await expect(
      runDoubaoTeachingPcmProtocolSmoke({
        adapterOptions: {
          config: {
            enabled: true,
            apiKey: "mock-only-key",
            model: "1.2.6.1",
            requestTimeoutMs: 100,
          },
          model: "1.2.6.1",
          voice: "zh_female_vv_jupiter_bigtts",
          webSocketFactory: factory,
          responseTimeoutMs: 100,
          closeTimeoutMs: 100,
        },
        pcm,
      }),
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_EVENT" });
    expect(activeSockets).toBe(0);
    expect(fakeSocket?.readyState).toBe(WebSocket.CLOSED);
  });

  it("bounds a stalled send callback and returns with no open socket", async () => {
    let activeSockets = 0;
    let fakeSocket: SynchronousFakeSocket | undefined;
    const factory = createSynchronousFakeFactory(
      () => undefined,
      () => false,
      (socket) => {
        fakeSocket = socket;
        activeSockets += 1;
        socket.once("close", () => {
          activeSockets -= 1;
        });
      },
    );
    const adapter = createAdapterWithFactory(factory, 30);

    await expect(withTimeout(adapter.connect())).rejects.toMatchObject({
      code: "SEND_TIMEOUT",
    });
    expect(activeSockets).toBe(0);
    expect(fakeSocket?.readyState).toBe(WebSocket.CLOSED);
  });

  it("terminates a CLOSING socket and confirms CLOSED before close returns", async () => {
    let fakeSocket: StubbornClosingFakeSocket | undefined;
    const factory: DoubaoWebSocketFactory = () => {
      fakeSocket = new StubbornClosingFakeSocket((event, socket) => {
        if (event.type === "session.create") {
          socket.providerSend({
            event_id: "provider-created-stubborn-close",
            type: "session.created",
            session: { id: "dialog-stubborn-close" },
          });
        } else if (event.type === "session.close") {
          socket.providerSend({
            event_id: "provider-closed-stubborn-close",
            type: "session.closed",
          });
        }
      });
      return fakeSocket as unknown as WebSocket;
    };
    const adapter = new DoubaoProtocolSmokeAdapter({
      config: {
        enabled: true,
        apiKey: "mock-only-key",
        model: "1.2.6.1",
        requestTimeoutMs: 1_000,
      },
      model: "1.2.6.1",
      voice: "zh_female_vv_jupiter_bigtts",
      baseInstructions: base.instructions,
      webSocketFactory: factory,
      responseTimeoutMs: 1_000,
      closeTimeoutMs: 20,
    });

    await adapter.connect();
    await expect(adapter.close()).rejects.toMatchObject({
      code: "SESSION_CLOSE_TIMEOUT",
    });
    expect(fakeSocket?.terminateCalls).toBe(1);
    expect(fakeSocket?.readyState).toBe(WebSocket.CLOSED);
    expect(adapter.snapshot()).toMatchObject({
      transport: "closed",
      session: "closed",
    });
  });

  it("uses two clean upstream sessions and returns only neutral marker-count evidence", async () => {
    const upstream = createServer();
    await once(upstream, "listening");
    let connectionCount = 0;
    let activeConnections = 0;
    let maxActiveConnections = 0;
    const appendedAudio: Buffer[] = [];

    upstream.on("connection", (socket) => {
      connectionCount += 1;
      const connectionIndex = connectionCount;
      let commitCount = 0;
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        if (event.type === "session.create") {
          socket.send(
            JSON.stringify({
              type: "session.created",
              session: { id: `dialog-${connectionIndex}` },
            }),
          );
          return;
        }
        if (event.type === "session.update") {
          sendSessionUpdated(socket, event, `dialog-${connectionIndex}`);
          return;
        }
        if (event.type === "input_audio_buffer.append") {
          appendedAudio.push(Buffer.from(String(event.audio), "base64"));
          return;
        }
        if (event.type === "input_audio_buffer.commit") {
          commitCount += 1;
          const isD01 = connectionIndex === 1 && commitCount === 1;
          const isD03 = connectionIndex === 2;
          sendCompleteTurn(socket, {
            index: connectionIndex * 10 + commitCount,
            textDeltas: isD01
              ? ["星", "尘"]
              : isD03
                ? ["月", "桂"]
                : ["继续飞。"],
            finalText: isD01 ? "星尘" : isD03 ? "月桂" : "继续飞。",
          });
          return;
        }
        if (event.type === "session.close") {
          socket.send(JSON.stringify({ type: "session.closed" }));
        }
      });
    });

    const address = addressOf(upstream);
    const factory: DoubaoWebSocketFactory = vi.fn((_url, options) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}`, options);
      activeConnections += 1;
      maxActiveConnections = Math.max(maxActiveConnections, activeConnections);
      socket.once("close", () => {
        activeConnections -= 1;
      });
      return socket;
    });
    const mutablePcm = Buffer.from(pcm);
    const expectedPcm = Buffer.from(mutablePcm);
    const run = runDoubaoTeachingPcmProtocolSmoke({
      adapterOptions: {
        config: {
          enabled: true,
          apiKey: "mock-only-key",
          model: "1.2.6.1",
          requestTimeoutMs: 1_000,
        },
        model: "1.2.6.1",
        voice: "zh_female_vv_jupiter_bigtts",
        webSocketFactory: factory,
        responseTimeoutMs: 1_000,
        closeTimeoutMs: 1_000,
      },
      pcm: mutablePcm,
    });
    mutablePcm.fill(9);
    const result = await run;

    expect(connectionCount).toBe(2);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(maxActiveConnections).toBe(1);
    expect(activeConnections).toBe(0);
    expect(appendedAudio).toHaveLength(6);
    expect(Buffer.concat(appendedAudio)).toEqual(
      Buffer.concat([expectedPcm, expectedPcm, expectedPcm]),
    );
    expect(result).toEqual({
      schemaVersion: 1,
      provider: "doubao",
      providerEvidence: false,
      inputMode: "pcm16le",
      fixtureRevision: expect.any(String),
      fixtureHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      inputFixtureHash: createHash("sha256").update(expectedPcm).digest("hex"),
      scope: {
        transport: "isolated_provider_websocket",
        relayExercised: false,
        browserExercised: false,
      },
      upstreamSessions: 2,
      responseAttempts: 3,
      cases: [
        {
          id: "D01",
          status: "protocol_sequence_completed",
          expectedMarkerCount: 1,
          forbiddenMarkerCount: 0,
        },
        {
          id: "D02",
          status: "protocol_sequence_completed",
          expectedMarkerCount: 0,
          forbiddenMarkerCount: 0,
        },
        {
          id: "D03",
          status: "protocol_sequence_completed",
          expectedMarkerCount: 1,
          forbiddenMarkerCount: 0,
        },
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("星尘");
    expect(serialized).not.toContain("月桂");
    expect(serialized).not.toContain("dialog-");
    expect(serialized).not.toContain("total_tokens");
    expect(serialized).not.toContain(expectedPcm.toString("base64"));
    expect(serialized).not.toContain(mutablePcm.toString("base64"));
    expect(serialized).not.toContain("AQIDBA==");
  });

  it("rejects neutral sequence completion when a marker assertion fails", async () => {
    const upstream = createServer();
    await once(upstream, "listening");
    let commitCount = 0;
    let connectionCount = 0;
    upstream.on("connection", (socket) => {
      connectionCount += 1;
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        if (event.type === "session.create") {
          socket.send(
            JSON.stringify({
              type: "session.created",
              session: { id: "dialog-marker-negative" },
            }),
          );
        } else if (event.type === "session.update") {
          sendSessionUpdated(socket, event, "dialog-marker-negative");
        } else if (event.type === "input_audio_buffer.commit") {
          commitCount += 1;
          sendCompleteTurn(socket, {
            index: 30 + commitCount,
            textDeltas: ["星尘"],
            finalText: "星尘",
          });
        } else if (event.type === "session.close") {
          socket.send(JSON.stringify({ type: "session.closed" }));
        }
      });
    });

    const address = addressOf(upstream);
    const factory: DoubaoWebSocketFactory = (_url, options) =>
      new WebSocket(`ws://127.0.0.1:${address.port}`, options);
    await expect(
      runDoubaoTeachingPcmProtocolSmoke({
        adapterOptions: {
          config: {
            enabled: true,
            apiKey: "mock-only-key",
            model: "1.2.6.1",
            requestTimeoutMs: 1_000,
          },
          model: "1.2.6.1",
          voice: "zh_female_vv_jupiter_bigtts",
          webSocketFactory: factory,
          responseTimeoutMs: 1_000,
          closeTimeoutMs: 1_000,
        },
        pcm,
      }),
    ).rejects.toMatchObject({ code: "MARKER_ASSERTION_FAILED" });
    expect(connectionCount).toBe(1);
  });

  it("fails the connection when an upstream event_id is reused", async () => {
    const upstream = createServer();
    await once(upstream, "listening");
    upstream.once("connection", (socket) => {
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        if (event.type === "session.create") {
          socket.send(
            JSON.stringify({
              type: "session.created",
              session: { id: "dialog-duplicate" },
            }),
          );
        } else if (event.type === "session.update") {
          sendSessionUpdated(socket, event, "dialog-duplicate");
        } else if (event.type === "input_audio_buffer.commit") {
          socket.send(
            JSON.stringify({
              type: "input_audio_buffer.committed",
              event_id: "provider-commit-unique",
            }),
          );
          socket.send(
            JSON.stringify({
              type: "conversation.item.input_audio_transcription.completed",
              transcript: "我们继续聊飞船吧。",
            }),
          );
          socket.send(
            JSON.stringify({
              type: "response.output_text.delta",
              event_id: "provider-duplicate",
              response_id: "response-duplicate",
              delta: "星",
            }),
          );
          socket.send(
            JSON.stringify({
              type: "response.output_text.delta",
              event_id: "provider-duplicate",
              response_id: "response-duplicate",
              delta: "尘",
            }),
          );
        }
      });
    });

    const adapter = createAdapter(upstream);
    await adapter.connect();
    await expect(
      adapter.runD01D02Pair({
        directiveInstructions: directiveA.instructions,
        pcm,
        markers: { markerA: "星尘", markerB: "月桂" },
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_PROVIDER_EVENT_ID" });
    expect(adapter.snapshot()).toMatchObject({
      transport: "failed",
      session: "failed",
      turn: "failed",
    });
    await adapter.close();
  });

  it.each([
    ["event_id", { event_id: "e".repeat(161), type: "future.event" }],
    ["type", { type: "t".repeat(161) }],
    ["response_id", { type: "future.event", response_id: "r".repeat(257) }],
    ["question_id", { type: "future.event", question_id: "q".repeat(257) }],
    ["session.id", { type: "future.event", session: { id: "s".repeat(257) } }],
  ])("rejects an oversized inbound %s", async (_field, inbound) => {
    const factory = createSynchronousFakeFactory((_event, socket) => {
      socket.providerSend(inbound);
    });
    const adapter = createAdapterWithFactory(factory);

    await expect(adapter.connect()).rejects.toMatchObject({
      code: "INVALID_PROVIDER_EVENT",
    });
    expect(adapter.snapshot()).toMatchObject({
      transport: "failed",
      session: "failed",
    });
  });

  it("fails closed when a synchronous provider burst exceeds queue depth", async () => {
    const factory = createSynchronousFakeFactory((_event, socket) => {
      for (
        let index = 0;
        index <= DOUBAO_PROTOCOL_SMOKE_MAX_EVENT_QUEUE_DEPTH;
        index += 1
      ) {
        socket.providerSend({
          event_id: `provider-queued-${index}`,
          type: "future.event",
        });
      }
    });
    const adapter = createAdapterWithFactory(factory);

    await expect(adapter.connect()).rejects.toMatchObject({
      code: "PROVIDER_EVENT_QUEUE_OVERFLOW",
    });
    expect(adapter.snapshot()).toMatchObject({
      transport: "failed",
      session: "failed",
      turn: "failed",
    });
  });

  it("fails closed when cumulative provider bytes exceed the connection budget", async () => {
    const padding = "x".repeat(
      Math.floor(DOUBAO_PROTOCOL_SMOKE_MAX_PROVIDER_BYTES / 3) + 1,
    );
    const factory = createSynchronousFakeFactory((_event, socket) => {
      for (let index = 0; index < 3; index += 1) {
        socket.providerSend({
          event_id: `provider-large-${index}`,
          type: "future.large",
          padding,
        });
      }
    });
    const adapter = createAdapterWithFactory(factory);

    await expect(adapter.connect()).rejects.toMatchObject({
      code: "PROVIDER_EVENT_BUDGET_EXCEEDED",
    });
    expect(adapter.snapshot()).toMatchObject({
      transport: "failed",
      session: "failed",
      turn: "failed",
    });
  });

  it("rejects oversized fragmented RawData before concatenating it", async () => {
    const concat = vi.spyOn(Buffer, "concat");
    const partLength =
      Math.floor(DOUBAO_RELAY_UPSTREAM_MAX_MESSAGE_BYTES / 2) + 1;
    const factory = createSynchronousFakeFactory((_event, socket) => {
      socket.providerSendRaw([
        Buffer.alloc(partLength),
        Buffer.alloc(partLength),
      ]);
    });
    const adapter = createAdapterWithFactory(factory);

    await expect(adapter.connect()).rejects.toMatchObject({
      code: "PROVIDER_MESSAGE_TOO_LARGE",
    });
    expect(concat).not.toHaveBeenCalled();
  });

  it("fails closed when cumulative provider events exceed the connection budget", async () => {
    const upstream = createServer();
    await once(upstream, "listening");
    upstream.once("connection", (socket) => {
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        if (event.type === "session.create") {
          socket.send(
            JSON.stringify({
              type: "session.created",
              session: { id: "dialog-event-budget" },
            }),
          );
        } else if (event.type === "session.update") {
          sendSessionUpdated(socket, event, "dialog-event-budget");
        } else if (event.type === "input_audio_buffer.commit") {
          socket.send(JSON.stringify({ type: "input_audio_buffer.committed" }));
          socket.send(
            JSON.stringify({
              type: "conversation.item.input_audio_transcription.completed",
              transcript: "固定成年合成输入。",
            }),
          );
          let sent = 0;
          const sendNext = (): void => {
            if (
              socket.readyState !== WebSocket.OPEN ||
              sent > DOUBAO_PROTOCOL_SMOKE_MAX_PROVIDER_EVENTS
            ) {
              return;
            }
            socket.send(
              JSON.stringify({
                event_id: `provider-event-budget-${sent}`,
                type: "conversation.item.input_audio_transcription.delta",
                delta: "x",
              }),
            );
            sent += 1;
            setImmediate(sendNext);
          };
          sendNext();
        }
      });
    });

    const address = addressOf(upstream);
    const factory: DoubaoWebSocketFactory = (_url, options) =>
      new WebSocket(`ws://127.0.0.1:${address.port}`, options);
    const adapter = createAdapterWithFactory(factory, 5_000);
    await adapter.connect();

    await expect(
      adapter.runD01D02Pair({
        directiveInstructions: directiveA.instructions,
        pcm,
        markers: { markerA: "星尘", markerB: "月桂" },
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_EVENT_BUDGET_EXCEEDED" });
    expect(adapter.snapshot()).toMatchObject({
      transport: "failed",
      session: "failed",
      turn: "failed",
    });
  }, 10_000);
});

function createAdapter(upstream: WebSocketServer): DoubaoProtocolSmokeAdapter {
  const address = addressOf(upstream);
  const factory: DoubaoWebSocketFactory = vi.fn((url, options) => {
    expect(url).toBe(DOUBAO_REALTIME_WEBSOCKET_URL);
    return new WebSocket(`ws://127.0.0.1:${address.port}`, options);
  });
  return createAdapterWithFactory(factory);
}

function createAdapterWithFactory(
  webSocketFactory: DoubaoWebSocketFactory,
  timeoutMs = 1_000,
): DoubaoProtocolSmokeAdapter {
  return new DoubaoProtocolSmokeAdapter({
    config: {
      enabled: true,
      apiKey: "mock-only-key",
      model: "1.2.6.1",
      requestTimeoutMs: timeoutMs,
    },
    model: "1.2.6.1",
    voice: "zh_female_vv_jupiter_bigtts",
    baseInstructions: base.instructions,
    webSocketFactory,
    responseTimeoutMs: timeoutMs,
    closeTimeoutMs: timeoutMs,
  });
}

function createSynchronousFakeFactory(
  onClientEvent: (
    event: Record<string, unknown>,
    socket: SynchronousFakeSocket,
  ) => void,
  shouldCompleteSend: (event: Record<string, unknown>) => boolean = () => true,
  onCreate: (socket: SynchronousFakeSocket) => void = () => undefined,
): DoubaoWebSocketFactory {
  return () => {
    const socket = new SynchronousFakeSocket(onClientEvent, shouldCompleteSend);
    onCreate(socket);
    return socket as unknown as WebSocket;
  };
}

class SynchronousFakeSocket extends EventEmitter {
  readyState = WebSocket.CONNECTING;
  bufferedAmount = 0;

  constructor(
    private readonly onClientEvent: (
      event: Record<string, unknown>,
      socket: SynchronousFakeSocket,
    ) => void,
    private readonly shouldCompleteSend: (
      event: Record<string, unknown>,
    ) => boolean = () => true,
  ) {
    super();
    queueMicrotask(() => {
      if (this.readyState !== WebSocket.CONNECTING) return;
      this.readyState = WebSocket.OPEN;
      this.emit("open");
    });
  }

  send(
    data: Buffer,
    _options: unknown,
    callback: (error?: Error) => void,
  ): void {
    const event = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
    this.onClientEvent(event, this);
    if (this.shouldCompleteSend(event)) callback();
  }

  providerSend(event: Record<string, unknown>): void {
    if (this.readyState !== WebSocket.OPEN) return;
    this.emit("message", Buffer.from(JSON.stringify(event)), false);
  }

  providerSendRaw(data: Buffer[]): void {
    if (this.readyState !== WebSocket.OPEN) return;
    this.emit("message", data, false);
  }

  terminate(): void {
    this.finishClose();
  }

  close(): void {
    this.finishClose();
  }

  private finishClose(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    queueMicrotask(() => this.emit("close"));
  }
}

class StubbornClosingFakeSocket extends SynchronousFakeSocket {
  terminateCalls = 0;

  override close(): void {
    if (this.readyState !== WebSocket.CLOSED) {
      this.readyState = WebSocket.CLOSING;
    }
  }

  override terminate(): void {
    this.terminateCalls += 1;
    super.terminate();
  }
}

function sendCompleteTurn(
  socket: WebSocket,
  input: {
    index: number;
    textDeltas: string[];
    finalText: string;
    responseId?: string;
  },
): void {
  sendTurnBeforeResponseDone(socket, input);
  sendResponseDone(socket, input.index, {
    ...(input.responseId === undefined ? {} : { responseId: input.responseId }),
  });
}

function sendResponseDone(
  socket: WebSocket,
  index: number,
  overrides: { responseId?: string; status?: string } = {},
): void {
  socket.send(
    JSON.stringify({
      event_id: `provider-response-done-${index}`,
      type: "response.done",
      response_id: overrides.responseId ?? `response-${index}`,
      status: overrides.status ?? "completed",
      usage: { total_tokens: index },
    }),
  );
}

function sendSessionUpdated(
  socket: WebSocket,
  clientEvent: Record<string, unknown>,
  sessionId: string,
  overrides: Record<string, unknown> = {},
): void {
  const session = readRecord(clientEvent.session);
  socket.send(
    JSON.stringify({
      event_id: `provider-ack-${String(clientEvent.event_id)}`,
      type: "session.updated",
      session: { id: sessionId, ...session, ...overrides },
    }),
  );
}

function sendTurnBeforeResponseDone(
  socket: WebSocket,
  input: {
    index: number;
    textDeltas: string[];
    finalText: string;
    responseId?: string;
  },
): void {
  const questionId = `question-${input.index}`;
  const responseId = input.responseId ?? `response-${input.index}`;
  socket.send(
    JSON.stringify({
      event_id: `provider-commit-${input.index}`,
      type: "input_audio_buffer.committed",
    }),
  );
  socket.send(
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.started",
      item_id: `item-${input.index}`,
    }),
  );
  socket.send(
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: `item-${input.index}`,
      transcript: "我们继续聊飞船吧。",
    }),
  );
  for (const delta of input.textDeltas) {
    socket.send(
      JSON.stringify({
        type: "response.output_text.delta",
        question_id: questionId,
        response_id: responseId,
        delta,
      }),
    );
  }
  socket.send(
    JSON.stringify({
      type: "response.output_text.done",
      question_id: questionId,
      response_id: responseId,
      text: input.finalText,
    }),
  );
  socket.send(
    JSON.stringify({
      type: "response.output_audio.started",
      question_id: questionId,
      response_id: "",
      tts_type: "default",
    }),
  );
  socket.send(
    JSON.stringify({
      type: "response.output_audio.delta",
      question_id: questionId,
      response_id: responseId,
      delta: "AQIDBA==",
    }),
  );
  socket.send(
    JSON.stringify({
      type: "response.output_audio.done",
      question_id: questionId,
      response_id: responseId,
    }),
  );
}

function eventCount(events: Record<string, unknown>[], type: string): number {
  return events.filter((event) => event.type === type).length;
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object in the scripted Doubao upstream.");
  }
  return value as Record<string, unknown>;
}

function createServer(): WebSocketServer {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  return server;
}

function addressOf(server: WebSocketServer): { port: number } {
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("测试 WebSocket 服务未监听 TCP 端口。");
  }
  return { port: address.port };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("测试等待超时。")), 3_000),
    ),
  ]);
}

async function shortDelay(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
