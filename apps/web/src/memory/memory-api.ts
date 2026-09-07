import {
  mem0DiagnosticsResponseSchema,
  mem0SearchResponseSchema,
  memoryListResponseSchema,
  memoryResponseSchema,
  type CharacterMemory,
  type Mem0DiagnosticsResponse,
  type Mem0SearchResponse,
  type ReviewMemoryRequest,
} from "@meet/protocol";

export class MemoryApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MemoryApiError";
  }
}

export async function listMemories(
  signal?: AbortSignal,
  filter: { characterId?: string; sourceConversationId?: string } = {},
): Promise<CharacterMemory[]> {
  const query = new URLSearchParams();
  if (filter.characterId) query.set("characterId", filter.characterId);
  if (filter.sourceConversationId)
    query.set("sourceConversationId", filter.sourceConversationId);
  const response = await fetch(
    `/api/memories${query.size ? `?${query}` : ""}`,
    {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal,
    },
  );
  const body = await readBody(response);
  if (!response.ok) throw apiError(response, body);
  return memoryListResponseSchema.parse(body).memories;
}

export async function reviewMemory(
  memoryId: string,
  input: ReviewMemoryRequest,
): Promise<CharacterMemory> {
  const response = await fetch(
    `/api/memories/${encodeURIComponent(memoryId)}`,
    {
      method: "PATCH",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
  const body = await readBody(response);
  if (!response.ok) throw apiError(response, body);
  return memoryResponseSchema.parse(body).memory;
}

export async function getMem0Diagnostics(
  signal?: AbortSignal,
): Promise<Mem0DiagnosticsResponse> {
  const response = await fetch("/api/memories/mem0?limit=200", {
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  const body = await readBody(response);
  if (!response.ok) throw apiError(response, body);
  return mem0DiagnosticsResponseSchema.parse(body);
}

export async function searchMem0(input: {
  characterId: string;
  query: string;
  limit?: number;
  threshold?: number;
}): Promise<Mem0SearchResponse> {
  const response = await fetch("/api/memories/mem0/search", {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ limit: 8, threshold: 0, ...input }),
  });
  const body = await readBody(response);
  if (!response.ok) throw apiError(response, body);
  return mem0SearchResponseSchema.parse(body);
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function apiError(response: Response, body: unknown): MemoryApiError {
  const value =
    typeof body === "object" && body !== null
      ? (body as { code?: unknown; message?: unknown })
      : {};
  return new MemoryApiError(
    response.status,
    typeof value.code === "string" ? value.code : "MEMORY_REQUEST_FAILED",
    typeof value.message === "string" ? value.message : "记忆请求失败。",
  );
}
