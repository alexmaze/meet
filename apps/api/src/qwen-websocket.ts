import {
  qwenInputAudioBufferAppendEventSchema,
  qwenResponseCancelEventSchema,
  qwenResponseCreateEventSchema,
  qwenSessionUpdateEventSchema,
  qwenUserTextItemCreateEventSchema,
  realtimeTeachingClientControlFrameSchema,
  realtimeRenewalClientFrameSchema,
  type QwenSessionUpdateEvent,
  type QwenRealtimeModel,
} from "@meet/protocol";
import { isIP } from "node:net";
import WebSocket, { type ClientOptions, type RawData } from "ws";

import type { AppConfig } from "./config.js";
import { MeetEmotionEmitter } from "./realtime-emotion.js";
import { normalizeQwenRealtimeEndpoint } from "./qwen.js";
import {
  RealtimeRenewalController,
  REALTIME_RENEWAL_MAX_SESSION_MS,
} from "./realtime-renewal.js";
import {
  completeQwenTeachingBaseSession,
  matchesQwenTeachingBaseSession,
  parseQwenTeachingSessionUpdatedEvent,
  QwenTeachingSessionController,
  type QwenTeachingRuntimeSnapshot,
  type QwenTeachingSessionDependencies,
} from "./teaching/qwen-teaching-session-controller.js";

export const QWEN_RELAY_CLIENT_MAX_MESSAGE_BYTES = 256 * 1024;
export const QWEN_RELAY_UPSTREAM_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
export const QWEN_RELAY_MAX_AUDIO_BASE64_CHARACTERS = 128 * 1024;
export const QWEN_RELAY_MAX_CLIENT_BYTES_PER_SECOND = 256 * 1024;
export const QWEN_RELAY_MAX_CONTROL_EVENTS_PER_SECOND = 30;
export const QWEN_RELAY_MAX_SESSION_MS = REALTIME_RENEWAL_MAX_SESSION_MS;

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
    relationshipContext?: string;
    history?: QwenContinuityMessage[];
  };
  teaching?: QwenWebSocketTeachingOptions;
  webSocketFactory?: QwenWebSocketFactory;
};

export type QwenWebSocketTeachingOptions = Readonly<{
  runtime: QwenTeachingRuntimeSnapshot;
  dependencies: QwenTeachingSessionDependencies;
  now?: () => number;
  timeouts?: Readonly<{
    gateAckMs?: number;
    updateAckMs?: number;
    responseDoneMs?: number;
  }>;
}>;

export type QwenContinuityMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
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
  teaching,
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
  let historyInjected = false;
  let pendingBytes = 0;
  let rateWindowStartedAt = Date.now();
  let rateWindowAudioBytes = 0;
  let rateWindowControlEvents = 0;
  let sessionTimeout: NodeJS.Timeout | null = null;
  let expectedTeachingBaseSession: QwenSessionUpdateEvent["session"] | null =
    null;
  let teachingBaseAcknowledged = false;
  let teachingController: QwenTeachingSessionController | null = null;
  const renewal = new RealtimeRenewalController({
    provider: "qwen",
    sendClientFrame: (frame) => sendJson(client, frame),
    isSafeToRenew: () =>
      !stopped &&
      upstreamReady &&
      historyInjected &&
      (teachingController?.isSafeToRenew() ?? true),
  });
  const pendingClientMessages: Buffer[] = [];
  const emotion = new MeetEmotionEmitter();

  const emitMeetEmotion = (type: string | null | undefined): void => {
    const name = emotion.next(type);
    if (name) sendJson(client, { type: "meet.emotion", name });
  };

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
    teachingController?.dispose();
    renewal.dispose();

    if (source !== "client") closeSocket(client, code, reason);
    if (source !== "upstream") closeOrTerminateUpstream(upstream);
  };

  if (teaching) {
    teachingController = new QwenTeachingSessionController({
      runtime: teaching.runtime,
      dependencies: teaching.dependencies,
      now: teaching.now,
      timeouts: teaching.timeouts,
      transport: {
        sendClientFrame: (frame) => sendJson(client, frame),
        sendUpstreamEvent: (event) =>
          sendWithBackpressure(
            upstream,
            Buffer.from(JSON.stringify(event)),
            false,
          ),
        safetyClose: () => {
          sendRelayError(
            client,
            "TEACHING_SAFETY_RESET",
            "教学状态未能安全确认，请重新连接继续普通聊天。",
          );
          stop("relay", CLOSE_INTERNAL_ERROR, "Teaching safety reset");
        },
      },
    });
  }

  const injectContinuity = (): boolean => {
    if (historyInjected) return true;
    historyInjected = true;
    for (const event of buildQwenContinuityEvents(
      runtime.history ?? [],
      runtime.relationshipContext,
    )) {
      const payload = Buffer.from(JSON.stringify(event));
      if (!sendWithBackpressure(upstream, payload, false)) {
        sendRelayError(
          client,
          "RELAY_BACKPRESSURE",
          "续聊上下文注入失败，请重新连接。",
        );
        stop("relay", CLOSE_TRY_AGAIN_LATER, "History injection failed");
        return false;
      }
    }
    return true;
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
    if (
      message.byteLength === 0 ||
      message.byteLength > QWEN_RELAY_CLIENT_MAX_MESSAGE_BYTES
    ) {
      sendRelayError(
        client,
        "INVALID_CLIENT_EVENT",
        "实时事件格式或大小无效。",
      );
      stop("relay", CLOSE_POLICY_VIOLATION, "Invalid client event");
      return;
    }
    const parsedJson = parseJsonMessage(message);
    const teachingFrame =
      realtimeTeachingClientControlFrameSchema.safeParse(parsedJson);
    const renewalFrame = realtimeRenewalClientFrameSchema.safeParse(parsedJson);
    const eventType = renewalFrame.success
      ? renewalFrame.data.type
      : teachingFrame.success
        ? teachingFrame.data.type
        : readAllowedQwenClientEventType(message, runtime);
    if (
      !eventType ||
      (!teachingFrame.success &&
        !renewalFrame.success &&
        ((!sessionConfigured && eventType !== "session.update") ||
          (sessionConfigured && eventType === "session.update")))
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
    if (renewalFrame.success) {
      renewal.handleClientFrame(renewalFrame.data);
      return;
    }
    // Ordinary audio and controls always abort renewal before proceeding.
    renewal.observeClientEvent(parsedJson);
    if (teachingFrame.success) {
      if (teachingController) {
        teachingController.handleClientFrame(teachingFrame.data);
      } else {
        sendJson(client, {
          type: "relay.teaching.state",
          revision: 0,
          state: "unavailable",
          canRequest: false,
          canMute: false,
        });
      }
      return;
    }
    if (eventType === "session.update") {
      sessionConfigured = true;
      if (teachingController) {
        const parsed = qwenSessionUpdateEventSchema.safeParse(parsedJson);
        if (!parsed.success) {
          sendRelayError(
            client,
            "INVALID_CLIENT_EVENT",
            "实时事件格式或大小无效。",
          );
          stop("relay", CLOSE_POLICY_VIOLATION, "Invalid client event");
          return;
        }
        expectedTeachingBaseSession = parsed.data.session;
      }
    } else if (teachingController && !teachingController.isInputGateOpen()) {
      // The browser has already been asked to close its local RTP/control
      // gate. Consume any in-flight provider control without forwarding it.
      return;
    }

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
    sendJson(client, {
      type: "relay.ready",
      teaching: Boolean(teachingController),
    });
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
    const renewalProviderEvent = isBinary ? null : parseJsonMessage(message);
    renewal.observeProviderEvent(renewalProviderEvent);
    if (teachingController) {
      if (isBinary) {
        sendRelayError(
          client,
          "TEACHING_SAFETY_RESET",
          "教学状态未能安全确认，请重新连接继续普通聊天。",
        );
        stop("relay", CLOSE_INTERNAL_ERROR, "Teaching safety reset");
        return;
      }
      const providerEvent = parseJsonMessage(message);
      const providerType = readUnknownEventType(providerEvent);
      if (!providerType) {
        sendRelayError(
          client,
          "TEACHING_SAFETY_RESET",
          "教学状态未能安全确认，请重新连接继续普通聊天。",
        );
        stop("relay", CLOSE_INTERNAL_ERROR, "Teaching safety reset");
        return;
      }
      if (providerType === "session.updated" && !teachingBaseAcknowledged) {
        const session = parseQwenTeachingSessionUpdatedEvent(providerEvent);
        const expected = expectedTeachingBaseSession;
        if (
          !session ||
          !expected ||
          !matchesQwenTeachingBaseSession(session, {
            model,
            modalities: expected.modalities,
            voice: expected.voice,
            inputAudioFormat: expected.input_audio_format,
            outputAudioFormat: expected.output_audio_format,
            instructions: expected.instructions,
            maxHistoryTurns: expected.max_history_turns,
            turnDetection: expected.turn_detection.type,
          })
        ) {
          sendRelayError(
            client,
            "TEACHING_SAFETY_RESET",
            "教学状态未能安全确认，请重新连接继续普通聊天。",
          );
          stop("relay", CLOSE_INTERNAL_ERROR, "Teaching safety reset");
          return;
        }
        teachingBaseAcknowledged = true;
        if (!injectContinuity()) return;
        // Open the browser-side teaching gate before exposing session.updated.
        // The client keeps its microphone disabled until session.updated, while
        // the relay keeps dropping input until the gate ACK arrives. This
        // ordering avoids a brief un-gated microphone window at startup.
        teachingController.configureBase(
          completeQwenTeachingBaseSession(session, {
            inputAudioFormat: expected.input_audio_format,
            outputAudioFormat: expected.output_audio_format,
            instructions: expected.instructions,
            maxHistoryTurns: expected.max_history_turns,
          }),
          session.eventId,
        );
        renewal.markSessionReady();
        if (!sendWithBackpressure(client, message, false)) {
          stop("relay", CLOSE_TRY_AGAIN_LATER, "Relay backpressure");
          return;
        }
        emitMeetEmotion(providerType);
        return;
      }
      if (teachingBaseAcknowledged) {
        const disposition =
          teachingController.handleProviderEvent(providerEvent);
        if (!disposition.forward) return;
      }
    } else if (
      !historyInjected &&
      !isBinary &&
      readJsonEventType(message) === "session.updated"
    ) {
      if (!injectContinuity()) return;
      renewal.markSessionReady();
    }
    if (!sendWithBackpressure(client, message, isBinary)) {
      stop("relay", CLOSE_TRY_AGAIN_LATER, "Relay backpressure");
      return;
    }
    if (!isBinary) {
      emitMeetEmotion(readJsonEventType(message));
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
  }, renewal.remainingMs);
  sessionTimeout.unref();

  return upstream;
}

export function buildQwenContinuityEvents(
  history: QwenContinuityMessage[],
  relationshipContext?: string,
): Array<Record<string, unknown>> {
  if (history.length === 0 && !relationshipContext) return [];
  const events: Array<Record<string, unknown>> = [];
  if (relationshipContext) {
    events.push(
      qwenContextItem(
        "meet_relationship_context",
        "system",
        "input_text",
        `以下是当前账号与这个角色之间由应用保存的已确认长期记忆和过往摘要。只把它们用于自然延续关系，不要逐条朗读，也不要扩展成未记录的事实。\n\n${relationshipContext}`,
      ),
    );
  }
  if (history.length > 0) {
    events.push(
      qwenContextItem(
        "meet_history_context",
        "system",
        "input_text",
        "以下消息是当前用户与这个角色此前真实发生、已经确认保存的对话。请把它们作为关系延续上下文使用；只依据记录回忆，不要编造未出现的往事。",
      ),
    );
  }
  for (const message of history) {
    events.push(
      qwenContextItem(
        `meet_history_${message.id.replaceAll("-", "")}`,
        message.role,
        message.role === "assistant" ? "output_text" : "input_text",
        message.text,
      ),
    );
  }
  events.push(
    qwenContextItem(
      "meet_history_resume",
      "system",
      "input_text",
      "现在开始或恢复实时连接。自然承接上面的关系与话题；只有收到新的用户输入或明确的开场请求时才回应，不要因为连接恢复而重复上一句或首次见面的固定欢迎语。",
    ),
  );
  return events;
}

function qwenContextItem(
  id: string,
  role: "system" | "user" | "assistant",
  contentType: "input_text" | "output_text",
  text: string,
): Record<string, unknown> {
  return {
    event_id: `event_${id}`,
    type: "conversation.item.create",
    item: {
      id,
      type: "message",
      role,
      content: [{ type: contentType, text }],
    },
  };
}

function readJsonEventType(message: Buffer): string | null {
  return readUnknownEventType(parseJsonMessage(message));
}

function parseJsonMessage(message: Buffer): unknown {
  try {
    return JSON.parse(message.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function readUnknownEventType(input: unknown): string | null {
  return typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    typeof Reflect.get(input, "type") === "string"
    ? (Reflect.get(input, "type") as string)
    : null;
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

function sendJson(
  socket: WebSocket,
  value: Readonly<Record<string, unknown>>,
): boolean {
  const message = Buffer.from(JSON.stringify(value));
  return sendWithBackpressure(socket, message, false);
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
