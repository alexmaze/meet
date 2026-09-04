import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DOUBAO_REALTIME_WEBSOCKET_URL,
  buildDoubaoInstructions,
  buildDoubaoSessionCreateEvent,
  isAllowedDoubaoClientEvent,
  relayDoubaoWebSocket,
} from "../src/doubao-websocket.js";
import { generateDoubaoVoicePreview } from "../src/doubao-voice-preview.js";
import { buildDoubaoInstructionsUpdateEvent } from "../src/spikes/realtime-teaching/provider-events.js";

const servers: WebSocketServer[] = [];

afterEach(async () => {
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

describe("Doubao WebSocket relay", () => {
  it("keeps server instruction updates out of the browser allowlist", () => {
    expect(
      isAllowedDoubaoClientEvent(
        Buffer.from(
          JSON.stringify({
            event_id: "browser-update",
            type: "session.update",
            session: { instructions: "伪造规则" },
          }),
        ),
      ),
    ).toBe(false);
    expect(
      isAllowedDoubaoClientEvent(
        Buffer.from(
          JSON.stringify({
            event_id: "browser-control",
            type: "relay.control",
          }),
        ),
      ),
    ).toBe(false);
  });

  it("builds a fixed PCM session and bounded continuity instructions", () => {
    const runtime = {
      voice: "zh_female_vv_jupiter_bigtts",
      instructions: "你是知夏。",
      relationshipContext: "用户喜欢散步。",
      history: [
        { id: "message-1", role: "user" as const, text: "我们上次聊到公园。" },
        { id: "message-2", role: "assistant" as const, text: "记得。" },
      ],
    };
    expect(buildDoubaoInstructions(runtime)).toContain("最近已确认对话");
    expect(buildDoubaoSessionCreateEvent("1.2.6.1", runtime)).toMatchObject({
      type: "session.create",
      session: {
        model: "1.2.6.1",
        audio: {
          input: { format: { type: "pcm", rate: 16_000 } },
          output: {
            format: { type: "pcm_s16le", rate: 24_000 },
            voice: "zh_female_vv_jupiter_bigtts",
          },
        },
      },
    });
    const fixedRuntime = {
      voice: runtime.voice,
      instructions: runtime.instructions,
    };
    const created = buildDoubaoSessionCreateEvent("1.2.6.1", fixedRuntime) as {
      session: unknown;
    };
    const updated = buildDoubaoInstructionsUpdateEvent({
      eventId: "event-update",
      model: "1.2.6.1",
      voice: fixedRuntime.voice,
      instructions: fixedRuntime.instructions,
    });
    expect(updated.session).toEqual(created.session);
  });

  it("rejects a browser session.update with 1008 before it reaches upstream", async () => {
    const upstreamServer = createServer();
    const relayServer = createServer();
    await Promise.all([
      once(upstreamServer, "listening"),
      once(relayServer, "listening"),
    ]);
    const upstreamAddress = addressOf(upstreamServer);
    const relayAddress = addressOf(relayServer);
    const upstreamTypes: string[] = [];
    let resolveUpstreamClosed!: () => void;
    const upstreamClosed = new Promise<void>((resolve) => {
      resolveUpstreamClosed = resolve;
    });
    upstreamServer.once("connection", (socket) => {
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        upstreamTypes.push(String(event.type));
        if (event.type === "session.create") {
          socket.send(
            JSON.stringify({
              type: "session.created",
              session: { id: "test" },
            }),
          );
        }
      });
      socket.once("close", resolveUpstreamClosed);
    });
    relayServer.once("connection", (client) => {
      relayDoubaoWebSocket({
        client,
        config: {
          enabled: true,
          apiKey: "server-only-key",
          model: "1.2.6.1",
          requestTimeoutMs: 5_000,
        },
        model: "1.2.6.1",
        runtime: {
          voice: "zh_female_vv_jupiter_bigtts",
          instructions: "保持自然。",
        },
        webSocketFactory: (_url, options) =>
          new WebSocket(`ws://127.0.0.1:${upstreamAddress.port}`, options),
      });
    });

    const browser = new WebSocket(`ws://127.0.0.1:${relayAddress.port}`);
    await once(browser, "open");
    const received: Record<string, unknown>[] = [];
    browser.on("message", (data) => {
      received.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    await waitUntil(() => received.some(({ type }) => type === "relay.ready"));

    const browserClosed = once(browser, "close");
    browser.send(
      JSON.stringify({
        event_id: "browser-update",
        type: "session.update",
        session: { instructions: "伪造规则" },
      }),
    );
    await waitUntil(() => received.some(({ type }) => type === "relay.error"));
    const [closeCode] = await withTimeout(browserClosed);
    await withTimeout(upstreamClosed);

    expect(closeCode).toBe(1008);
    expect(received).toContainEqual(
      expect.objectContaining({
        type: "relay.error",
        code: "INVALID_CLIENT_EVENT",
      }),
    );
    expect(upstreamTypes).toEqual(["session.create"]);
  });

  it("keeps the API key server-side and relays allowed JSON events", async () => {
    const upstreamServer = createServer();
    const relayServer = createServer();
    await Promise.all([
      once(upstreamServer, "listening"),
      once(relayServer, "listening"),
    ]);
    const upstreamAddress = addressOf(upstreamServer);
    const relayAddress = addressOf(relayServer);

    let apiKeyHeader: string | undefined;
    let resolveSessionCreate!: (event: Record<string, unknown>) => void;
    const sessionCreate = new Promise<Record<string, unknown>>((resolve) => {
      resolveSessionCreate = resolve;
    });
    let resolveAppend!: (event: Record<string, unknown>) => void;
    const append = new Promise<Record<string, unknown>>((resolve) => {
      resolveAppend = resolve;
    });
    upstreamServer.once("connection", (socket, request) => {
      apiKeyHeader = request.headers["x-api-key"] as string | undefined;
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        if (event.type === "session.create") {
          resolveSessionCreate(event);
          socket.send(
            JSON.stringify({
              event_id: "provider-session-created",
              type: "session.created",
              session: { id: "dialog-1" },
            }),
          );
        }
        if (event.type === "input_audio_buffer.append") resolveAppend(event);
        if (event.type === "session.close") {
          socket.send(JSON.stringify({ type: "session.closed" }));
        }
      });
    });

    const factory = vi.fn((url: string, options) => {
      expect(url).toBe(DOUBAO_REALTIME_WEBSOCKET_URL);
      return new WebSocket(`ws://127.0.0.1:${upstreamAddress.port}`, options);
    });
    relayServer.once("connection", (client) => {
      relayDoubaoWebSocket({
        client,
        config: {
          enabled: true,
          apiKey: "server-only-key",
          model: "1.2.6.1",
          requestTimeoutMs: 5_000,
        },
        model: "1.2.6.1",
        runtime: {
          voice: "zh_female_vv_jupiter_bigtts",
          instructions: "保持自然。",
        },
        webSocketFactory: factory,
      });
    });

    const browser = new WebSocket(`ws://127.0.0.1:${relayAddress.port}`);
    await once(browser, "open");
    const received: Record<string, unknown>[] = [];
    browser.on("message", (data) => {
      received.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });

    const created = await withTimeout(sessionCreate);
    expect(created).not.toHaveProperty("apiKey");
    expect(apiKeyHeader).toBe("server-only-key");
    await waitUntil(() => received.some(({ type }) => type === "relay.ready"));

    browser.send(
      JSON.stringify({
        event_id: "client-audio",
        type: "input_audio_buffer.append",
        audio: "AAE=",
      }),
    );
    expect(await withTimeout(append)).toMatchObject({
      event_id: "client-audio",
      type: "input_audio_buffer.append",
    });
    browser.send(
      JSON.stringify({ event_id: "client-close", type: "session.close" }),
    );
    await once(browser, "close");
  });

  it("generates a short WAV preview through the same full-duplex endpoint", async () => {
    const upstreamServer = createServer();
    await once(upstreamServer, "listening");
    const address = addressOf(upstreamServer);
    upstreamServer.once("connection", (socket, request) => {
      expect(request.headers["x-api-key"]).toBe("preview-key");
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        if (event.type === "session.create") {
          socket.send(
            JSON.stringify({
              type: "session.created",
              session: { id: "preview" },
            }),
          );
        }
        if (event.type === "speech_text_buffer.commit") {
          expect(event.speech_id).toEqual(expect.any(String));
          socket.send(
            JSON.stringify({
              type: "response.output_audio.delta",
              response_id: "preview-response",
              delta: "AQIDBA==",
            }),
          );
          socket.send(
            JSON.stringify({
              type: "response.output_audio.done",
              response_id: "preview-response",
            }),
          );
        }
      });
    });

    const wav = await generateDoubaoVoicePreview({
      config: {
        enabled: true,
        apiKey: "preview-key",
        model: "1.2.6.1",
        requestTimeoutMs: 3_000,
      },
      model: "1.2.6.1",
      voice: "zh_female_vv_jupiter_bigtts",
      webSocketFactory: (_url, options) =>
        new WebSocket(`ws://127.0.0.1:${address.port}`, options),
    });

    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4]);
  });
});

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

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("测试等待超时。")), 3_000),
    ),
  ]);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 3_000) throw new Error("测试等待超时。");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
