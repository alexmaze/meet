import {
  doubaoErrorEventSchema,
  doubaoOutputAudioDeltaEventSchema,
  doubaoOutputAudioDoneEventSchema,
  type DoubaoRealtimeModel,
} from "@meet/protocol";
import { randomUUID } from "node:crypto";
import WebSocket, { type ClientOptions, type RawData } from "ws";

import type { AppConfig } from "./config.js";
import {
  DOUBAO_REALTIME_WEBSOCKET_URL,
  buildDoubaoSessionCreateEvent,
  type DoubaoWebSocketFactory,
} from "./doubao-websocket.js";
import { pcm16ToWav } from "./qwen-voice-preview.js";

const PREVIEW_TEXT =
  "你好，很高兴认识你。之后的每次见面，我都会用这个声音陪你聊天。";
const OUTPUT_SAMPLE_RATE = 24_000;
const MAX_PCM_BYTES = 2 * 1024 * 1024;

export class DoubaoVoicePreviewError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    readonly diagnostic?: {
      providerCode?: string | number;
      providerMessage?: string;
      logId?: string;
      handshakeStatus?: number;
    },
  ) {
    super(message);
    this.name = "DoubaoVoicePreviewError";
  }
}

export async function generateDoubaoVoicePreview(input: {
  config: NonNullable<AppConfig["doubao"]>;
  model: DoubaoRealtimeModel;
  voice: string;
  webSocketFactory?: DoubaoWebSocketFactory;
}): Promise<Buffer> {
  if (!input.config.enabled || !input.config.apiKey) {
    throw new DoubaoVoicePreviewError(
      "DOUBAO_NOT_CONFIGURED",
      "服务端尚未配置豆包实时语音服务。",
      503,
    );
  }

  let socket: WebSocket;
  try {
    const factory = input.webSocketFactory ?? defaultWebSocketFactory;
    socket = factory(DOUBAO_REALTIME_WEBSOCKET_URL, {
      headers: { "X-Api-Key": input.config.apiKey },
      handshakeTimeout: input.config.requestTimeoutMs,
      maxPayload: MAX_PCM_BYTES,
      perMessageDeflate: false,
    });
  } catch {
    throw networkError();
  }

  return await new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    let logId: string | undefined;
    let pcmBytes = 0;
    const chunks: Buffer[] = [];
    const timeout = setTimeout(
      () =>
        fail(
          new DoubaoVoicePreviewError(
            "DOUBAO_PREVIEW_TIMEOUT",
            "音色试听生成超时，请稍后重试。",
            504,
          ),
        ),
      input.config.requestTimeoutMs,
    );
    timeout.unref();

    const finish = (wav: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      sendJson(socket, {
        event_id: `event_${randomUUID()}`,
        type: "session.close",
      });
      closeSocket(socket);
      resolve(wav);
    };
    function fail(error: DoubaoVoicePreviewError): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      closeSocket(socket);
      reject(error);
    }

    socket.on("open", () => {
      const event = buildDoubaoSessionCreateEvent(input.model, {
        voice: input.voice,
        instructions:
          "你正在执行音色试听。只朗读给出的试听句子，不回答、不解释。",
      });
      if (!sendJson(socket, event)) fail(networkError());
    });
    socket.on("upgrade", (response) => {
      logId = readHeader(response.headers["x-tt-logid"]);
    });
    socket.on("unexpected-response", (_request, response) => {
      fail(
        new DoubaoVoicePreviewError(
          response.statusCode === 401 || response.statusCode === 403
            ? "DOUBAO_AUTHORIZATION_FAILED"
            : "DOUBAO_HANDSHAKE_FAILED",
          "豆包实时语音握手失败。",
          response.statusCode === 401 || response.statusCode === 403
            ? 502
            : 503,
          {
            handshakeStatus: response.statusCode,
            logId: readHeader(response.headers["x-tt-logid"]),
          },
        ),
      );
    });
    socket.on("message", (data, isBinary) => {
      if (settled || isBinary) return;
      const event = parseEvent(data);
      if (!event) return fail(upstreamError());
      if (event.type === "session.created") {
        if (
          !sendJson(socket, {
            event_id: `event_${randomUUID()}`,
            type: "speech_text_buffer.commit",
            speech_id: `speech_${randomUUID()}`,
            text: PREVIEW_TEXT,
          })
        ) {
          fail(networkError());
        }
        return;
      }
      const audio = doubaoOutputAudioDeltaEventSchema.safeParse(event);
      if (audio.success) {
        const chunk = Buffer.from(audio.data.delta, "base64");
        pcmBytes += chunk.byteLength;
        if (pcmBytes > MAX_PCM_BYTES) {
          return fail(
            new DoubaoVoicePreviewError(
              "DOUBAO_PREVIEW_TOO_LARGE",
              "音色试听音频超出大小限制。",
              502,
            ),
          );
        }
        chunks.push(chunk);
        return;
      }
      if (doubaoOutputAudioDoneEventSchema.safeParse(event).success) {
        const pcm = Buffer.concat(chunks, pcmBytes);
        if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
          return fail(upstreamError());
        }
        finish(pcm16ToWav(pcm, OUTPUT_SAMPLE_RATE));
        return;
      }
      const providerError = doubaoErrorEventSchema.safeParse(event);
      if (providerError.success) {
        fail(
          upstreamError({
            providerCode:
              providerError.data.code ?? providerError.data.status_code,
            providerMessage: providerError.data.message,
            logId,
          }),
        );
      }
    });
    socket.on("error", () => fail(networkError()));
    socket.on("close", () => {
      if (!settled) fail(networkError());
    });
  });
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

function closeSocket(socket: WebSocket): void {
  try {
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else if (socket.readyState === WebSocket.OPEN) socket.close(1000);
  } catch {
    socket.terminate();
  }
}

function defaultWebSocketFactory(
  url: string,
  options: ClientOptions,
): WebSocket {
  return new WebSocket(url, options);
}

function networkError(): DoubaoVoicePreviewError {
  return new DoubaoVoicePreviewError(
    "DOUBAO_NETWORK_ERROR",
    "无法连接豆包实时语音服务。",
    502,
  );
}

function upstreamError(
  diagnostic?: DoubaoVoicePreviewError["diagnostic"],
): DoubaoVoicePreviewError {
  return new DoubaoVoicePreviewError(
    "DOUBAO_PREVIEW_FAILED",
    "音色试听暂时无法生成，请稍后重试。",
    502,
    diagnostic,
  );
}

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
