import {
  qwenErrorEventSchema,
  qwenResponseAudioDeltaEventSchema,
  qwenResponseDoneEventSchema,
  type QwenRealtimeModel,
} from "@meet/protocol";
import { randomUUID } from "node:crypto";
import WebSocket, { type ClientOptions, type RawData } from "ws";

import type { AppConfig } from "./config.js";
import {
  buildQwenRealtimeWebSocketUrl,
  type QwenWebSocketFactory,
} from "./qwen-websocket.js";

const PREVIEW_INSTRUCTIONS =
  "你正在执行音色试听。只朗读用户给出的试听句子，保持自然口语，不回答、不解释，也不要增加任何其他内容。";
const PREVIEW_TEXT =
  "你好，很高兴认识你。之后的每次见面，我都会用这个声音陪你聊天。";
const OUTPUT_SAMPLE_RATE = 24_000;
const MAX_PCM_BYTES = 2 * 1024 * 1024;

export class QwenVoicePreviewError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "QwenVoicePreviewError";
  }
}

export async function generateQwenVoicePreview(input: {
  config: AppConfig["qwen"];
  model: QwenRealtimeModel;
  voice: string;
  webSocketFactory?: QwenWebSocketFactory;
}): Promise<Buffer> {
  const { config, model, voice } = input;
  if (!config.apiKey || !config.endpoint) {
    throw new QwenVoicePreviewError(
      "QWEN_NOT_CONFIGURED",
      "服务端尚未配置千问实时服务。",
      503,
    );
  }

  let socket: WebSocket;
  try {
    const factory = input.webSocketFactory ?? defaultWebSocketFactory;
    socket = factory(
      buildQwenRealtimeWebSocketUrl(config.endpoint, model).toString(),
      {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        handshakeTimeout: config.requestTimeoutMs,
        maxPayload: MAX_PCM_BYTES,
        perMessageDeflate: false,
      },
    );
  } catch {
    throw networkError();
  }

  return await new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    let configured = false;
    let pcmBytes = 0;
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      fail(
        new QwenVoicePreviewError(
          "QWEN_PREVIEW_TIMEOUT",
          "音色试听生成超时，请稍后重试。",
          504,
        ),
      );
    }, config.requestTimeoutMs);
    timeout.unref();

    const finish = (wav: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      closeSocket(socket);
      resolve(wav);
    };

    function fail(error: QwenVoicePreviewError): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      closeSocket(socket);
      reject(error);
    }

    socket.on("message", (data, isBinary) => {
      if (settled || isBinary) return;
      const event = parseEvent(data);
      if (!event) {
        fail(upstreamError());
        return;
      }

      if (event.type === "session.created") {
        if (
          !sendJson(socket, {
            event_id: `event_${randomUUID()}`,
            type: "session.update",
            session: {
              modalities: ["audio", "text"],
              voice,
              input_audio_format: "pcm",
              output_audio_format: "pcm",
              instructions: PREVIEW_INSTRUCTIONS,
              max_history_turns: 1,
              turn_detection: { type: "smart_turn" },
            },
          })
        ) {
          fail(networkError());
        }
        return;
      }

      if (event.type === "session.updated" && !configured) {
        configured = true;
        const sentItem = sendJson(socket, {
          event_id: `event_${randomUUID()}`,
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: PREVIEW_TEXT }],
          },
        });
        const sentResponse = sendJson(socket, {
          event_id: `event_${randomUUID()}`,
          type: "response.create",
        });
        if (!sentItem || !sentResponse) fail(networkError());
        return;
      }

      const audio = qwenResponseAudioDeltaEventSchema.safeParse(event);
      if (audio.success) {
        const chunk = Buffer.from(audio.data.delta, "base64");
        pcmBytes += chunk.byteLength;
        if (pcmBytes > MAX_PCM_BYTES) {
          fail(
            new QwenVoicePreviewError(
              "QWEN_PREVIEW_TOO_LARGE",
              "音色试听音频超出大小限制。",
              502,
            ),
          );
          return;
        }
        chunks.push(chunk);
        return;
      }

      const done = qwenResponseDoneEventSchema.safeParse(event);
      if (done.success) {
        if (done.data.response.status !== "completed" || pcmBytes === 0) {
          fail(upstreamError());
          return;
        }
        const pcm = Buffer.concat(chunks, pcmBytes);
        if (pcm.byteLength % 2 !== 0) {
          fail(upstreamError());
          return;
        }
        finish(pcm16ToWav(pcm, OUTPUT_SAMPLE_RATE));
        return;
      }

      if (qwenErrorEventSchema.safeParse(event).success) {
        fail(upstreamError());
      }
    });

    socket.on("error", () => fail(networkError()));
    socket.on("close", () => {
      if (!settled) fail(networkError());
    });
  });
}

export function pcm16ToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

function parseEvent(data: RawData): Record<string, unknown> | null {
  try {
    const buffer = Array.isArray(data)
      ? Buffer.concat(data)
      : data instanceof ArrayBuffer
        ? Buffer.from(data)
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const value = JSON.parse(buffer.toString("utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function sendJson(socket: WebSocket, value: Record<string, unknown>): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function defaultWebSocketFactory(
  url: string,
  options: ClientOptions,
): WebSocket {
  return new WebSocket(url, options);
}

function closeSocket(socket: WebSocket): void {
  try {
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else if (socket.readyState === WebSocket.OPEN) socket.close(1000);
  } catch {
    socket.terminate();
  }
}

function networkError(): QwenVoicePreviewError {
  return new QwenVoicePreviewError(
    "QWEN_NETWORK_ERROR",
    "无法连接千问实时服务。",
    502,
  );
}

function upstreamError(): QwenVoicePreviewError {
  return new QwenVoicePreviewError(
    "QWEN_PREVIEW_FAILED",
    "音色试听暂时无法生成，请稍后重试。",
    502,
  );
}
