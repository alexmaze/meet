import {
  characterAvatarUploadResponseSchema,
  apiErrorSchema,
  characterCatalogResponseSchema,
  characterListResponseSchema,
  characterResponseSchema,
  characterRuntimeResponseSchema,
  createCharacterRequestSchema,
  deleteCharacterRequestSchema,
  deleteCharacterResponseSchema,
  updateCharacterRequestSchema,
  updateCharacterVisibilityRequestSchema,
  type Character,
  type CharacterAvatarUploadResponse,
  type CharacterRuntimeResponse,
  type CharacterSummary,
  type CreateCharacterRequest,
  type ProviderProfile,
  type UpdateCharacterRequest,
  type UpdateCharacterVisibilityRequest,
  type VoiceProfile,
} from "@meet/protocol";

export class CharacterApiError extends Error {
  constructor(
    readonly status: number | null,
    readonly code = "CHARACTER_REQUEST_FAILED",
  ) {
    super("角色请求失败");
    this.name = "CharacterApiError";
  }
}

export type CharacterCatalog = {
  providers: ProviderProfile[];
  voices: VoiceProfile[];
};

const jsonHeaders = {
  Accept: "application/json",
  "Content-Type": "application/json",
};

export async function listCharacters(
  signal?: AbortSignal,
): Promise<CharacterSummary[]> {
  const body = await requestJson("/api/characters", { signal });
  return parseCharacterList(body);
}

export async function getCharacterCatalog(
  signal?: AbortSignal,
): Promise<CharacterCatalog> {
  const body = await requestJson("/api/characters/catalog", { signal });
  return parseCharacterCatalog(body);
}

export async function previewVoice(
  voiceProfileId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(
      `/api/characters/voices/${encodeURIComponent(voiceProfileId)}/preview`,
      {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal,
      },
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new CharacterApiError(null, "VOICE_PREVIEW_FAILED");
  }

  if (!response.ok) {
    let code: string | undefined;
    try {
      const parsed = apiErrorSchema.safeParse(await response.json());
      if (parsed.success) code = parsed.data.code;
    } catch {
      // Fall through to the stable client-side error code.
    }
    throw new CharacterApiError(
      response.status,
      code ?? "VOICE_PREVIEW_FAILED",
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("audio/wav")) {
    throw new CharacterApiError(null, "INVALID_VOICE_PREVIEW_RESPONSE");
  }
  return await response.blob();
}

export async function uploadCharacterAvatar(
  file: File,
  signal?: AbortSignal,
): Promise<CharacterAvatarUploadResponse> {
  let response: Response;
  try {
    response = await fetch("/api/media/character-avatars", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": file.type,
      },
      credentials: "same-origin",
      cache: "no-store",
      body: file,
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new CharacterApiError(null, "CHARACTER_AVATAR_UPLOAD_FAILED");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CharacterApiError(
      response.status,
      "CHARACTER_AVATAR_UPLOAD_FAILED",
    );
  }
  if (!response.ok) {
    const parsedError = apiErrorSchema.safeParse(body);
    throw new CharacterApiError(
      response.status,
      parsedError.success
        ? parsedError.data.code
        : "CHARACTER_AVATAR_UPLOAD_FAILED",
    );
  }
  return parseWith(characterAvatarUploadResponseSchema, body);
}

export async function getCharacter(
  characterId: string,
  signal?: AbortSignal,
): Promise<Character> {
  const body = await requestJson(characterUrl(characterId), { signal });
  return parseCharacter(body);
}

export async function getCharacterRuntime(
  characterId: string,
  signal?: AbortSignal,
): Promise<CharacterRuntimeResponse> {
  const body = await requestJson(`${characterUrl(characterId)}/runtime`, {
    signal,
  });
  return parseCharacterRuntime(body);
}

export async function createCharacter(
  input: CreateCharacterRequest,
): Promise<Character> {
  const body = await requestJson("/api/characters", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(createCharacterRequestSchema.parse(input)),
  });
  return parseCharacter(body);
}

export async function updateCharacter(
  characterId: string,
  input: UpdateCharacterRequest,
): Promise<Character> {
  const body = await requestJson(characterUrl(characterId), {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify(updateCharacterRequestSchema.parse(input)),
  });
  return parseCharacter(body);
}

export async function updateCharacterVisibility(
  characterId: string,
  input: UpdateCharacterVisibilityRequest,
): Promise<Character> {
  const body = await requestJson(`${characterUrl(characterId)}/visibility`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify(updateCharacterVisibilityRequestSchema.parse(input)),
  });
  return parseCharacter(body);
}

export async function copyCharacter(characterId: string): Promise<Character> {
  const body = await requestJson(`${characterUrl(characterId)}/copy`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({}),
  });
  return parseCharacter(body);
}

export async function restoreCharacter(
  characterId: string,
): Promise<Character> {
  const body = await requestJson(`${characterUrl(characterId)}/restore`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({}),
  });
  return parseCharacter(body);
}

export async function deleteCharacter(
  characterId: string,
  revision: number,
): Promise<void> {
  const body = await requestJson(characterUrl(characterId), {
    method: "DELETE",
    headers: jsonHeaders,
    body: JSON.stringify(deleteCharacterRequestSchema.parse({ revision })),
  });
  parseWith(deleteCharacterResponseSchema, body);
}

export function parseCharacterList(input: unknown): CharacterSummary[] {
  return parseWith(characterListResponseSchema, input).characters;
}

export function parseCharacterCatalog(input: unknown): CharacterCatalog {
  return parseWith(characterCatalogResponseSchema, input);
}

export function parseCharacter(input: unknown): Character {
  return parseWith(characterResponseSchema, input).character;
}

export function parseCharacterRuntime(
  input: unknown,
): CharacterRuntimeResponse {
  return parseWith(characterRuntimeResponseSchema, input);
}

function characterUrl(characterId: string): string {
  return `/api/characters/${encodeURIComponent(characterId)}`;
}

async function requestJson(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(input, {
      credentials: "same-origin",
      cache: init.method ? undefined : "no-store",
      ...init,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new CharacterApiError(null);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CharacterApiError(response.status);
  }

  if (!response.ok) {
    const parsedError = apiErrorSchema.safeParse(body);
    throw new CharacterApiError(
      response.status,
      parsedError.success ? parsedError.data.code : undefined,
    );
  }

  return body;
}

type SafeParseSchema<T> = {
  safeParse: (
    input: unknown,
  ) => { success: true; data: T } | { success: false; error: unknown };
};

function parseWith<T>(schema: SafeParseSchema<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new CharacterApiError(null, "INVALID_CHARACTER_RESPONSE");
  }
  return parsed.data;
}
