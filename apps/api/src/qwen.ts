import type { QwenRealtimeModel } from "@meet/protocol";

import type { AppConfig } from "./config.js";

const MAX_SDP_BYTES = 512 * 1024;
const HOSTNAME_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export class QwenGatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "QwenGatewayError";
  }
}

export function normalizeQwenRealtimeEndpoint(endpoint: string): string {
  const value = endpoint.trim();
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(value);

  if (!hasScheme) {
    if (!isValidHostname(value)) {
      throw invalidEndpointError();
    }
    return value.toLowerCase();
  }

  if (!/^https:\/\/[^/?#]+\/?$/i.test(value)) {
    throw invalidEndpointError();
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidEndpointError();
  }

  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    !isValidHostname(url.hostname)
  ) {
    throw invalidEndpointError();
  }

  return url.hostname;
}

export function validateOfferSdp(
  offerSdp: unknown,
): asserts offerSdp is string {
  if (typeof offerSdp !== "string" || offerSdp.length === 0) {
    throw new QwenGatewayError("INVALID_SDP", "请求体必须是 SDP offer。", 400);
  }

  if (Buffer.byteLength(offerSdp, "utf8") > MAX_SDP_BYTES) {
    throw new QwenGatewayError(
      "SDP_TOO_LARGE",
      "SDP offer 超出大小限制。",
      413,
    );
  }

  if (
    !/^v=0(?:\r?\n)/.test(offerSdp) ||
    !/(?:^|\r?\n)m=audio\s/m.test(offerSdp)
  ) {
    throw new QwenGatewayError(
      "INVALID_SDP",
      "SDP offer 缺少有效的版本行或音频媒体段。",
      400,
    );
  }
}

export function buildQwenRealtimeUrl(
  endpoint: string,
  model: QwenRealtimeModel,
): URL {
  const hostname = normalizeQwenRealtimeEndpoint(endpoint);
  const url = new URL(`https://${hostname}/api/v1/webrtc/realtime`);
  url.searchParams.set("model", model);
  return url;
}

type FetchFunction = typeof globalThis.fetch;

export async function exchangeQwenOffer(
  config: AppConfig["qwen"],
  model: QwenRealtimeModel,
  offerSdp: string,
  fetchFunction: FetchFunction = globalThis.fetch,
): Promise<string> {
  validateOfferSdp(offerSdp);

  if (!config.apiKey || !config.endpoint) {
    throw new QwenGatewayError(
      "QWEN_NOT_CONFIGURED",
      "服务端尚未配置千问 API Key 和 WebRTC Endpoint。",
      503,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const response = await fetchFunction(
      buildQwenRealtimeUrl(config.endpoint, model),
      {
        method: "POST",
        headers: {
          Accept: "application/sdp, application/json",
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/sdp",
        },
        body: offerSdp,
        signal: controller.signal,
      },
    );

    const responseText = await response.text();
    const requestId =
      response.headers.get("x-request-id") ??
      response.headers.get("x-dashscope-request-id") ??
      undefined;

    if (!response.ok) {
      const upstream = readUpstreamError(responseText);
      throw new QwenGatewayError(
        upstream.code ?? "QWEN_UPSTREAM_ERROR",
        upstream.message ?? `千问握手失败（HTTP ${response.status}）。`,
        response.status === 429 ? 429 : 502,
        upstream.requestId ?? requestId,
      );
    }

    if (!/^v=0(?:\r?\n)/.test(responseText)) {
      throw new QwenGatewayError(
        "INVALID_UPSTREAM_SDP",
        "千问返回了无效的 SDP answer。",
        502,
        requestId,
      );
    }

    return responseText;
  } catch (error) {
    if (error instanceof QwenGatewayError) {
      throw error;
    }

    if (error instanceof Error && error.name === "AbortError") {
      throw new QwenGatewayError(
        "QWEN_HANDSHAKE_TIMEOUT",
        "千问握手超时，请稍后重试。",
        504,
      );
    }

    throw new QwenGatewayError(
      "QWEN_NETWORK_ERROR",
      "无法连接千问实时服务。",
      502,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function isValidHostname(hostname: string): boolean {
  return (
    hostname.length > 0 &&
    hostname.length <= 253 &&
    hostname.split(".").every((label) => HOSTNAME_LABEL_PATTERN.test(label))
  );
}

function invalidEndpointError(): QwenGatewayError {
  return new QwenGatewayError(
    "INVALID_ENDPOINT",
    "QWEN_REALTIME_ENDPOINT 必须是 HTTPS Origin 或合法主机名。",
    500,
  );
}

function readUpstreamError(input: string): {
  code?: string;
  message?: string;
  requestId?: string;
} {
  try {
    const value = JSON.parse(input) as Record<string, unknown>;
    return {
      code: stringValue(value.code),
      message: truncate(stringValue(value.message), 500),
      requestId: stringValue(value.request_id) ?? stringValue(value.requestId),
    };
  } catch {
    return { message: truncate(input.trim(), 500) };
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function truncate(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  return value ? value.slice(0, maxLength) : undefined;
}
