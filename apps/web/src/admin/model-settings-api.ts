import {
  modelSettingsResponseSchema,
  type CreateModelConnectionRequest,
  type CreateModelProfileRequest,
  type ModelPurpose,
  type ModelSettingsResponse,
  type UpdateModelConnectionRequest,
  type UpdateModelProfileRequest,
} from "@meet/protocol";

export class ModelSettingsApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function getModelSettings(
  signal?: AbortSignal,
): Promise<ModelSettingsResponse> {
  const response = await request("/api/admin/model-settings", { signal });
  return modelSettingsResponseSchema.parse(await response.json());
}

export async function createConnection(input: CreateModelConnectionRequest) {
  await request("/api/admin/model-connections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function updateConnection(
  id: string,
  input: UpdateModelConnectionRequest,
) {
  await request(`/api/admin/model-connections/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function createModel(input: CreateModelProfileRequest) {
  await request("/api/admin/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function updateModel(
  id: string,
  input: UpdateModelProfileRequest,
) {
  await request(`/api/admin/models/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function deleteModel(id: string) {
  await request(`/api/admin/models/${id}`, { method: "DELETE" });
}

export async function testModel(id: string, voiceProfileId?: string) {
  await request(`/api/admin/models/${id}/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voiceProfileId }),
  });
}

export async function createVoice(
  modelId: string,
  input: { providerVoiceId: string; displayName: string },
) {
  await request(`/api/admin/models/${modelId}/voices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function setBinding(
  purpose: ModelPurpose,
  modelProfileId: string,
) {
  await request(`/api/admin/model-bindings/${purpose}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelProfileId }),
  });
}

async function request(input: string, init: RequestInit = {}) {
  const response = await fetch(input, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
  });
  if (response.ok) return response;
  let payload: { code?: string; message?: string } = {};
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    // 使用下方稳定错误文案。
  }
  throw new ModelSettingsApiError(
    response.status,
    payload.code ?? "MODEL_SETTINGS_FAILED",
    payload.message ?? "模型设置操作失败。",
  );
}
