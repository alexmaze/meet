import {
  qwenInputAudioBufferAppendEventSchema,
  qwenResponseCancelEventSchema,
  qwenResponseCreateEventSchema,
  qwenSessionUpdateEventSchema,
  qwenUserTextItemCreateEventSchema,
  type QwenRealtimeModel,
} from "@meet/protocol";
import { isIP } from "node:net";
import WebSocket, { type ClientOptions, type RawData } from "ws";

import type { AppConfig } from "./config.js";
import { normalizeQwenRealtimeEndpoint } from "./qwen.js";

export const QWEN_RELAY_CLIENT_MAX_MESSAGE_BYTES = 256 * 1024;
export const QWEN_RELAY_UPSTREAM_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
export const QWEN_RELAY_MAX_AUDIO_BASE64_CHARACTERS = 128 * 1024;
export const QWEN_RELAY_MAX_CLIENT_BYTES_PER_SECOND = 256 * 1024;
export const QWEN_RELAY_MAX_CONTROL_EVENTS_PER_SECOND = 30;
export const QWEN_RELAY_MAX_SESSION_MS = 30 * 60 * 1000;

const MAX_PENDING_CLIENT_BYTES = 512 * 1024;
const MAX_SOCKET_BUFFERED_BYTES = 1024 * 1024;
const CLOSE_NORMAL = 1000;
const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_INTERNAL_ERROR = 1011;
const CLOSE_TRY_AGAIN_LATER = 1013;

export type QwenWebSocketFactory = (
  url: string,
  options: ClientOptions,
) => WebSocket;

export type QwenWebSocketRelayOptions = {
  client: WebSocket;
  config: AppConfig["qwen"];
  model: QwenRealtimeModel;
  runtime: {
    voice: string;
    instructions: string;
  };
  webSocketFactory?: QwenWebSocketFactory;
};

export type WebSocketOriginCheck = {
  origin: string | undefined;
  host: string | undefined;
  remoteAddress: string | undefined;
  cookieSecure: boolean;
};

/**
 * Cookie-authenticated upgrades must come from the page that hosts the app.
 * The narrow development exception handles Vite forwarding a LAN/localhost
 * page to the loopback API while `changeOrigin` rewrites the Host header.
 */
export function isAllowedWebSocketOrigin({
  origin,
  host,
  remoteAddress,
  cookieSecure,
}: WebSocketOriginCheck): boolean {
  const originUrl = parseOrigin(origin);
  const target = parseHost(host);
  if (!originUrl || !target) return false;

  if (matchesOriginHost(originUrl, target)) return true;

  return (
    !cookieSecure &&
    isLoopbackAddress(remoteAddress) &&
    isLoopbackHostname(target.hostname) &&
    isLocalDevelopmentHostname(originUrl.hostname)
  );
}

export function buildQwenRealtimeWebSocketUrl(
  endpoint: string,
  model: QwenRealtimeModel,
): URL {
  const hostname = normalizeQwenRealtimeEndpoint(endpoint);
  const url = new URL(`wss://${hostname}/api-ws/v1/realtime`);
  url.searchParams.set("model", model);
  return url;
}

/**
 * Bridges one authenticated browser socket to one Qwen socket.
 *
 * Event bodies remain opaque after the browser event envelope is checked.
 * In particular, base64 audio payloads are never decoded or logged by the API.
 */
export function relayQwenWebSocket({
  client,
  config,
  model,
  runtime,
  webSocketFactory = defaultWebSocketFactory,
}: QwenWebSocketRelayOptions): WebSocket | null {
  if (!config.apiKey || !config.endpoint) {
    sendRelayError(client, "QWEN_NOT_CONFIGURED", "千问实时服务尚未配置。");
    closeSocket(client, CLOSE_TRY_AGAIN_LATER, "Qwen not configured");
    return null;
  }

  let upstream: WebSocket;
  try {
    upstream = webSocketFactory(
      buildQwenRealtimeWebSocketUrl(config.endpoint, model).toString(),
      {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        handshakeTimeout: config.requestTimeoutMs,
        maxPayload: QWEN_RELAY_UPSTREAM_MAX_MESSAGE_BYTES,
        perMessageDeflate: false,
      },
    );
  } catch {
    sendRelayError(client, "QWEN_NETWORK_ERROR", "无法连接千问实时服务。");
    closeSocket(client, CLOSE_INTERNAL_ERROR, "Qwen connection failed");
    return null;
  }

  let stopped = false;
  let upstreamReady = false;
  let sessionConfigured = false;
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
    if (source !== "upstream") closeOrTerminateUpstream(upstream);
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
    const eventType = readAllowedQwenClientEventType(message, runtime);
    if (
      message.byteLength === 0 ||
      message.byteLength > QWEN_RELAY_CLIENT_MAX_MESSAGE_BYTES ||
      !eventType ||
      (!sessionConfigured && eventType !== "session.update") ||
      (sessionConfigured && eventType === "session.update")
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
    if (
      rateWindowAudioBytes > QWEN_RELAY_MAX_CLIENT_BYTES_PER_SECOND ||
      rateWindowControlEvents > QWEN_RELAY_MAX_CONTROL_EVENTS_PER_SECOND
    ) {
      sendRelayError(
        client,
        "REALTIME_RATE_LIMITED",
        "实时事件发送过快，请重新连接。",
      );
      stop("relay", CLOSE_POLICY_VIOLATION, "Realtime rate exceeded");
      return;
    }
    if (eventType === "session.update") sessionConfigured = true;

    if (!upstreamReady) {
      if (pendingBytes + message.byteLength > MAX_PENDING_CLIENT_BYTES) {
        sendRelayError(
          client,
          "RELAY_BACKPRESSURE",
          "实时连接繁忙，请重新连接。",
        );
        stop("relay", CLOSE_TRY_AGAIN_LATER, "Relay backpressure");
        return;
      }
      // Copy because ws may reuse an ArrayBuffer supplied by the caller.
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
    if (stopped) {
      closeOrTerminateUpstream(upstream);
      return;
    }
    upstreamReady = true;

    for (const message of pendingClientMessages) {
      if (!sendWithBackpressure(upstream, message, false)) {
        sendRelayError(
          client,
          "RELAY_BACKPRESSURE",
          "实时连接繁忙，请重新连接。",
        );
        stop("relay", CLOSE_TRY_AGAIN_LATER, "Relay backpressure");
        return;
      }
    }
    pendingClientMessages.length = 0;
    pendingBytes = 0;
    sendJson(client, { type: "relay.ready" });
  });

  upstream.on("message", (data, isBinary) => {
    if (stopped) return;
    const message = rawDataToBuffer(data);
    if (message.byteLength > QWEN_RELAY_UPSTREAM_MAX_MESSAGE_BYTES) {
      sendRelayError(
        client,
        "QWEN_MESSAGE_TOO_LARGE",
        "千问返回的实时事件过大。",
      );
      stop("relay", CLOSE_INTERNAL_ERROR, "Upstream message too large");
      return;
    }
    if (!sendWithBackpressure(client, message, isBinary)) {
      stop("relay", CLOSE_TRY_AGAIN_LATER, "Relay backpressure");
    }
  });

  upstream.on("close", (code) => {
    const clean = code === CLOSE_NORMAL;
    stop(
      "upstream",
      clean ? CLOSE_NORMAL : CLOSE_INTERNAL_ERROR,
      clean ? "Qwen closed" : "Qwen connection lost",
    );
  });
  upstream.on("error", () => {
    if (stopped) return;
    sendRelayError(client, "QWEN_NETWORK_ERROR", "千问实时连接已中断。");
    upstream.terminate();
    stop("upstream", CLOSE_INTERNAL_ERROR, "Qwen connection error");
  });

  sessionTimeout = setTimeout(() => {
    if (stopped) return;
    sendRelayError(
      client,
      "REALTIME_SESSION_EXPIRED",
      "本次实时通话已达到最长时长，请重新连接。",
    );
    stop("relay", CLOSE_NORMAL, "Realtime session expired");
  }, QWEN_RELAY_MAX_SESSION_MS);
  sessionTimeout.unref();

  return upstream;
}

function defaultWebSocketFactory(
  url: string,
  options: ClientOptions,
): WebSocket {
  return new WebSocket(url, options);
}

export function isAllowedQwenClientEvent(
  message: Buffer,
  runtime: QwenWebSocketRelayOptions["runtime"],
): boolean {
  return readAllowedQwenClientEventType(message, runtime) !== null;
}

type AllowedQwenClientEventType =
  | "session.update"
  | "input_audio_buffer.append"
  | "conversation.item.create"
  | "response.create"
  | "response.cancel";

function readAllowedQwenClientEventType(
  message: Buffer,
  runtime: QwenWebSocketRelayOptions["runtime"],
): AllowedQwenClientEventType | null {
  try {
    const event = JSON.parse(message.toString("utf8")) as unknown;
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      return null;
    }

    switch (Reflect.get(event, "type")) {
      case "session.update": {
        const parsed = qwenSessionUpdateEventSchema.safeParse(event);
        return parsed.success &&
          parsed.data.session.voice === runtime.voice &&
          parsed.data.session.instructions === runtime.instructions
          ? "session.update"
          : null;
      }
      case "input_audio_buffer.append": {
        const parsed = qwenInputAudioBufferAppendEventSchema.safeParse(event);
        return parsed.success &&
          parsed.data.audio.length <= QWEN_RELAY_MAX_AUDIO_BASE64_CHARACTERS
          ? "input_audio_buffer.append"
          : null;
      }
      case "conversation.item.create":
        return qwenUserTextItemCreateEventSchema.safeParse(event).success
          ? "conversation.item.create"
          : null;
      case "response.create":
        return qwenResponseCreateEventSchema.safeParse(event).success
          ? "response.create"
          : null;
      case "response.cancel":
        return qwenResponseCancelEventSchema.safeParse(event).success
          ? "response.cancel"
          : null;
      default:
        return null;
    }
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

function sendJson(socket: WebSocket, value: Record<string, string>): void {
  const message = Buffer.from(JSON.stringify(value));
  sendWithBackpressure(socket, message, false);
}

function sendRelayError(
  socket: WebSocket,
  code: string,
  message: string,
): void {
  sendJson(socket, { type: "relay.error", code, message });
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (
    socket.readyState !== WebSocket.OPEN &&
    socket.readyState !== WebSocket.CONNECTING
  ) {
    return;
  }
  try {
    socket.close(code, reason);
  } catch {
    socket.terminate();
  }
}

function closeOrTerminateUpstream(socket: WebSocket): void {
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.terminate();
    return;
  }
  closeSocket(socket, CLOSE_NORMAL, "Relay closed");
}

function parseOrigin(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function parseHost(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(`http://${value}`);
    return url.pathname === "/" && !url.search && !url.hash ? url : null;
  } catch {
    return null;
  }
}

function matchesOriginHost(origin: URL, target: URL): boolean {
  if (origin.host.toLowerCase() === target.host.toLowerCase()) return true;
  if (origin.hostname.toLowerCase() !== target.hostname.toLowerCase()) {
    return false;
  }
  const originDefaultPort = origin.protocol === "https:" ? "443" : "80";
  return !origin.port && target.port === originDefaultPort;
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  const address = normalizeIpHostname(value);
  if (address === "::1") return true;
  const ipv4 = parseIpv4(address);
  return ipv4?.[0] === 127;
}

function isLoopbackHostname(value: string): boolean {
  const hostname = normalizeIpHostname(value);
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    isLoopbackAddress(hostname)
  );
}

function isLocalDevelopmentHostname(value: string): boolean {
  const hostname = normalizeIpHostname(value);
  if (isLoopbackHostname(hostname)) return true;

  const version = isIP(hostname);
  if (version === 4) {
    const octets = parseIpv4(hostname);
    if (!octets) return false;
    const [first, second] = octets;
    return (
      first === 10 ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }
  if (version === 6) {
    return /^(?:fc|fd|fe[89ab])/i.test(hostname);
  }
  return false;
}

function normalizeIpHostname(value: string): string {
  const unwrapped =
    value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return unwrapped.toLowerCase().replace(/^::ffff:/, "");
}

function parseIpv4(value: string): number[] | null {
  if (isIP(value) !== 4) return null;
  return value.split(".").map(Number);
}
