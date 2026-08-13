import {
  doubaoInputAudioAppendEventSchema,
  doubaoInputAudioCommitEventSchema,
  doubaoResponseCancelEventSchema,
  doubaoSessionCloseEventSchema,
  doubaoSpeechTextCommitEventSchema,
  type DoubaoRealtimeModel,
} from "@meet/protocol";
import WebSocket, { type ClientOptions, type RawData } from "ws";

import type { AppConfig } from "./config.js";
import type { QwenContinuityMessage } from "./qwen-websocket.js";

export const DOUBAO_REALTIME_WEBSOCKET_URL =
  "wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue";
export const DOUBAO_RELAY_CLIENT_MAX_MESSAGE_BYTES = 256 * 1024;
export const DOUBAO_RELAY_UPSTREAM_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
export const DOUBAO_RELAY_MAX_AUDIO_BASE64_CHARACTERS = 128 * 1024;
export const DOUBAO_RELAY_MAX_SESSION_MS = 30 * 60 * 1000;

const MAX_PENDING_CLIENT_BYTES = 512 * 1024;
const MAX_SOCKET_BUFFERED_BYTES = 1024 * 1024;
const CLOSE_NORMAL = 1000;
const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_INTERNAL_ERROR = 1011;
const CLOSE_TRY_AGAIN_LATER = 1013;

export type DoubaoWebSocketFactory = (
  url: string,
  options: ClientOptions,
) => WebSocket;

export type DoubaoWebSocketRelayOptions = {
  client: WebSocket;
  config: NonNullable<AppConfig["doubao"]>;
  model: DoubaoRealtimeModel;
  runtime: {
    voice: string;
    instructions: string;
    relationshipContext?: string;
    history?: QwenContinuityMessage[];
  };
  webSocketFactory?: DoubaoWebSocketFactory;
};

export function relayDoubaoWebSocket({
  client,
  config,
  model,
  runtime,
  webSocketFactory = defaultWebSocketFactory,
}: DoubaoWebSocketRelayOptions): WebSocket | null {
  if (!config.enabled || !config.apiKey) {
    sendRelayError(
      client,
      "DOUBAO_NOT_CONFIGURED",
      "豆包实时语音服务尚未配置。",
    );
    closeSocket(client, CLOSE_TRY_AGAIN_LATER, "Doubao not configured");
    return null;
  }

  let upstream: WebSocket;
  try {
    upstream = webSocketFactory(DOUBAO_REALTIME_WEBSOCKET_URL, {
      headers: { "X-Api-Key": config.apiKey },
      handshakeTimeout: config.requestTimeoutMs,
      maxPayload: DOUBAO_RELAY_UPSTREAM_MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
  } catch {
    sendRelayError(
      client,
      "DOUBAO_NETWORK_ERROR",
      "无法连接豆包实时语音服务。",
    );
    closeSocket(client, CLOSE_INTERNAL_ERROR, "Doubao connection failed");
    return null;
  }

  let stopped = false;
  let upstreamReady = false;
  let sessionCreated = false;
  let gracefulCloseRequested = false;
  let pendingBytes = 0;
  let rateWindowStartedAt = Date.now();
  let rateWindowAudioBytes = 0;
  let rateWindowControlEvents = 0;
  let sessionTimeout: NodeJS.Timeout | null = null;
  const pendingClientMessages: Buffer[] = [];

  const stop = (
    source: "client" | "upstream" | "relay",
    code: number,
    reason: string,
  ): void => {
    if (stopped) return;
    stopped = true;
    if (sessionTimeout) clearTimeout(sessionTimeout);
    sessionTimeout = null;
    pendingClientMessages.length = 0;
    pendingBytes = 0;
    if (source !== "client") closeSocket(client, code, reason);
    if (source !== "upstream") closeOrTerminate(upstream);
  };

  client.on("message", (data, isBinary) => {
    if (stopped) return;
    if (isBinary) {
      sendRelayError(
        client,
        "INVALID_CLIENT_EVENT",
        "实时事件必须使用 JSON 文本。",
      );
      stop("relay", CLOSE_POLICY_VIOLATION, "Invalid client event");
      return;
    }
    const message = rawDataToBuffer(data);
    const eventType = readAllowedDoubaoClientEventType(message);
    if (
      message.byteLength === 0 ||
      message.byteLength > DOUBAO_RELAY_CLIENT_MAX_MESSAGE_BYTES ||
      !eventType ||
      gracefulCloseRequested
    ) {
      sendRelayError(
        client,
        "INVALID_CLIENT_EVENT",
        "实时事件格式或大小无效。",
      );
      stop("relay", CLOSE_POLICY_VIOLATION, "Invalid client event");
      return;
    }

    const now = Date.now();
    if (now - rateWindowStartedAt >= 1_000) {
      rateWindowStartedAt = now;
      rateWindowAudioBytes = 0;
      rateWindowControlEvents = 0;
    }
    if (eventType === "input_audio_buffer.append") {
      rateWindowAudioBytes += message.byteLength;
    } else {
      rateWindowControlEvents += 1;
    }
    if (rateWindowAudioBytes > 256 * 1024 || rateWindowControlEvents > 30) {
      sendRelayError(
        client,
        "REALTIME_RATE_LIMITED",
        "实时事件发送过快，请重新连接。",
      );
      stop("relay", CLOSE_POLICY_VIOLATION, "Realtime rate exceeded");
      return;
    }
    if (eventType === "session.close") gracefulCloseRequested = true;

    if (!upstreamReady || !sessionCreated) {
      if (pendingBytes + message.byteLength > MAX_PENDING_CLIENT_BYTES) {
        sendRelayError(
          client,
          "RELAY_BACKPRESSURE",
          "实时连接繁忙，请重新连接。",
        );
        stop("relay", CLOSE_TRY_AGAIN_LATER, "Relay backpressure");
        return;
      }
      pendingClientMessages.push(Buffer.from(message));
      pendingBytes += message.byteLength;
      return;
    }
    if (!sendWithBackpressure(upstream, message, false)) {
      sendRelayError(
        client,
        "RELAY_BACKPRESSURE",
        "实时连接繁忙，请重新连接。",
      );
      stop("relay", CLOSE_TRY_AGAIN_LATER, "Relay backpressure");
    }
  });

  client.on("close", () => stop("client", CLOSE_NORMAL, "Client closed"));
  client.on("error", () =>
    stop("client", CLOSE_INTERNAL_ERROR, "Client socket error"),
  );

  upstream.on("open", () => {
    if (stopped) return closeOrTerminate(upstream);
    upstreamReady = true;
    if (
      !sendWithBackpressure(
        upstream,
        Buffer.from(
          JSON.stringify(buildDoubaoSessionCreateEvent(model, runtime)),
        ),
        false,
      )
    ) {
      sendRelayError(
        client,
        "RELAY_BACKPRESSURE",
        "豆包会话创建失败，请重试。",
      );
      stop("relay", CLOSE_TRY_AGAIN_LATER, "Session create failed");
    }
  });

  upstream.on("message", (data, isBinary) => {
    if (stopped) return;
    if (isBinary) {
      sendRelayError(
        client,
        "INVALID_PROVIDER_EVENT",
        "豆包返回了非文本事件。",
      );
      stop("relay", CLOSE_INTERNAL_ERROR, "Invalid provider event");
      return;
    }
    const message = rawDataToBuffer(data);
    if (message.byteLength > DOUBAO_RELAY_UPSTREAM_MAX_MESSAGE_BYTES) {
      sendRelayError(
        client,
        "DOUBAO_MESSAGE_TOO_LARGE",
        "豆包返回的实时事件过大。",
      );
      stop("relay", CLOSE_INTERNAL_ERROR, "Provider event too large");
      return;
    }
    const type = readJsonEventType(message);
    if (type === "session.created" && !sessionCreated) {
      sessionCreated = true;
      sendJson(client, { type: "relay.ready" });
      for (const pending of pendingClientMessages) {
        if (!sendWithBackpressure(upstream, pending, false)) {
          sendRelayError(
            client,
            "RELAY_BACKPRESSURE",
            "待发送实时事件转发失败。",
          );
          stop("relay", CLOSE_TRY_AGAIN_LATER, "Relay backpressure");
          return;
        }
      }
      pendingClientMessages.length = 0;
      pendingBytes = 0;
    }
    if (!sendWithBackpressure(client, message, false)) {
      stop("relay", CLOSE_TRY_AGAIN_LATER, "Client backpressure");
      return;
    }
    if (type === "session.closed") {
      stop("upstream", CLOSE_NORMAL, "Doubao session closed");
    }
  });

  upstream.on("unexpected-response", (_request, response) => {
    if (stopped) return;
    sendRelayError(
      client,
      response.statusCode === 401 || response.statusCode === 403
        ? "DOUBAO_AUTHORIZATION_FAILED"
        : "DOUBAO_HANDSHAKE_FAILED",
      "豆包实时语音握手失败。",
      response.statusCode,
    );
    stop("relay", CLOSE_INTERNAL_ERROR, "Doubao handshake failed");
  });
  upstream.on("close", (code) => {
    if (stopped) return;
    stop(
      "upstream",
      code === CLOSE_NORMAL ? CLOSE_NORMAL : CLOSE_INTERNAL_ERROR,
      code === CLOSE_NORMAL ? "Doubao closed" : "Doubao connection lost",
    );
  });
  upstream.on("error", () => {
    if (stopped) return;
    sendRelayError(client, "DOUBAO_NETWORK_ERROR", "豆包实时语音连接已中断。");
    stop("upstream", CLOSE_INTERNAL_ERROR, "Doubao connection error");
  });

  sessionTimeout = setTimeout(() => {
    if (stopped) return;
    sendRelayError(
      client,
      "REALTIME_SESSION_EXPIRED",
      "本次实时通话已达到最长时长，请重新连接。",
    );
    stop("relay", CLOSE_NORMAL, "Realtime session expired");
  }, DOUBAO_RELAY_MAX_SESSION_MS);
  sessionTimeout.unref();
  return upstream;
}

export function buildDoubaoSessionCreateEvent(
  model: DoubaoRealtimeModel,
  runtime: DoubaoWebSocketRelayOptions["runtime"],
): Record<string, unknown> {
  return {
    event_id: "event_meet_session_create",
    type: "session.create",
    session: {
      type: "realtime",
      model,
      instructions: buildDoubaoInstructions(runtime),
      audio: {
        input: { format: { type: "pcm", rate: 16_000 } },
        output: {
          format: { type: "pcm_s16le", rate: 24_000 },
          voice: runtime.voice,
          speed: 0,
          loudness: 0,
        },
      },
    },
  };
}

export function buildDoubaoInstructions(
  runtime: DoubaoWebSocketRelayOptions["runtime"],
): string {
  const sections = [runtime.instructions.trim()];
  if (runtime.relationshipContext?.trim()) {
    sections.push(
      `【已确认的关系记忆与摘要】\n${runtime.relationshipContext.trim()}\n只用于自然延续关系，不要逐条朗读，也不要补充未记录的事实。`,
    );
  }
  const history = runtime.history ?? [];
  if (history.length > 0) {
    sections.push(
      `【最近已确认对话】\n${history
        .map(
          (message) =>
            `${message.role === "user" ? "用户" : "角色"}：${message.text}`,
        )
        .join("\n")}\n自然承接话题；不要因为重连重复上一句。`,
    );
  }
  return sections.join("\n\n").slice(0, 12_000);
}

type AllowedDoubaoClientEventType =
  | "input_audio_buffer.append"
  | "input_audio_buffer.commit"
  | "response.cancel"
  | "speech_text_buffer.commit"
  | "session.close";

function readAllowedDoubaoClientEventType(
  message: Buffer,
): AllowedDoubaoClientEventType | null {
  try {
    const event = JSON.parse(message.toString("utf8")) as unknown;
    const type =
      typeof event === "object" && event !== null
        ? Reflect.get(event, "type")
        : null;
    switch (type) {
      case "input_audio_buffer.append": {
        const parsed = doubaoInputAudioAppendEventSchema.safeParse(event);
        return parsed.success &&
          parsed.data.audio.length <= DOUBAO_RELAY_MAX_AUDIO_BASE64_CHARACTERS
          ? type
          : null;
      }
      case "input_audio_buffer.commit":
        return doubaoInputAudioCommitEventSchema.safeParse(event).success
          ? type
          : null;
      case "response.cancel":
        return doubaoResponseCancelEventSchema.safeParse(event).success
          ? type
          : null;
      case "speech_text_buffer.commit":
        return doubaoSpeechTextCommitEventSchema.safeParse(event).success
          ? type
          : null;
      case "session.close":
        return doubaoSessionCloseEventSchema.safeParse(event).success
          ? type
          : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function readJsonEventType(message: Buffer): string | null {
  try {
    const input = JSON.parse(message.toString("utf8")) as unknown;
    return typeof input === "object" &&
      input !== null &&
      typeof Reflect.get(input, "type") === "string"
      ? (Reflect.get(input, "type") as string)
      : null;
  } catch {
    return null;
  }
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function sendWithBackpressure(
  socket: WebSocket,
  data: Buffer,
  binary: boolean,
): boolean {
  if (
    socket.readyState !== WebSocket.OPEN ||
    socket.bufferedAmount + data.byteLength > MAX_SOCKET_BUFFERED_BYTES
  ) {
    return false;
  }
  try {
    socket.send(data, { binary, compress: false }, () => undefined);
    return true;
  } catch {
    return false;
  }
}

function sendJson(
  socket: WebSocket,
  value: Record<string, string | number>,
): void {
  sendWithBackpressure(socket, Buffer.from(JSON.stringify(value)), false);
}

function sendRelayError(
  socket: WebSocket,
  code: string,
  message: string,
  status?: number,
): void {
  sendJson(socket, {
    type: "relay.error",
    code,
    message,
    ...(status === undefined ? {} : { status }),
  });
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
}

function closeOrTerminate(socket: WebSocket): void {
  if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
  else if (socket.readyState === WebSocket.OPEN) socket.close(CLOSE_NORMAL);
}

function defaultWebSocketFactory(
  url: string,
  options: ClientOptions,
): WebSocket {
  return new WebSocket(url, options);
}
