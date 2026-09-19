import {
  apiErrorSchema,
  bindDeviceResponseSchema,
  companionDeviceListResponseSchema,
  revokeDeviceResponseSchema,
  type CompanionDeviceSummary,
} from "@meet/protocol";

export class DeviceApiError extends Error {
  constructor(
    readonly status: number | null,
    readonly serverMessage = "",
  ) {
    super(serverMessage || "陪伴设备请求失败");
    this.name = "DeviceApiError";
  }
}

export async function listCompanionDevices(
  signal?: AbortSignal,
): Promise<CompanionDeviceSummary[]> {
  const response = await fetch("/api/devices", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw await createError(response, body);
  }
  const parsed = companionDeviceListResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new DeviceApiError(response.status);
  }
  return parsed.data.devices;
}

export async function bindCompanionDevice(
  code: string,
): Promise<CompanionDeviceSummary> {
  const response = await fetch("/api/devices/bindings", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ code }),
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw await createError(response, body);
  }
  const parsed = bindDeviceResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new DeviceApiError(response.status);
  }
  return parsed.data.device;
}

export async function revokeCompanionDevice(deviceId: string): Promise<void> {
  const response = await fetch(`/api/devices/${deviceId}`, {
    method: "DELETE",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw await createError(response, body);
  }
  const parsed = revokeDeviceResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new DeviceApiError(response.status);
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new DeviceApiError(response.status);
  }
}

async function createError(response: Response, body: unknown) {
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(body);
    return new DeviceApiError(
      response.status,
      parsed.success ? parsed.data.message : "",
    );
  }
  return new DeviceApiError(response.status);
}
