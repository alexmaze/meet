import {
  CHARACTER_RELATIONSHIP_TRANSFER_MAX_BYTES,
  apiErrorSchema,
  characterRelationshipTransferPackageSchema,
  relationshipTransferImportResponseSchema,
  type CharacterRelationshipTransferPackage,
  type RelationshipTransferImportResult,
} from "@meet/protocol";

export class RelationshipTransferApiError extends Error {
  constructor(
    readonly status: number | null,
    readonly code: string,
    message = "角色数据迁移请求失败。",
  ) {
    super(message);
    this.name = "RelationshipTransferApiError";
  }
}

export async function exportCharacterRelationship(
  characterId: string,
): Promise<{
  transferPackage: CharacterRelationshipTransferPackage;
  fileName: string;
}> {
  const response = await request(
    `/api/characters/${encodeURIComponent(characterId)}/relationship-export`,
  );
  const body = await readJson(response);
  const parsed = characterRelationshipTransferPackageSchema.safeParse(body);
  if (!response.ok) throw apiError(response, body);
  if (!parsed.success) {
    throw new RelationshipTransferApiError(
      response.status,
      "RELATIONSHIP_TRANSFER_INVALID_RESPONSE",
    );
  }
  return {
    transferPackage: parsed.data,
    fileName: relationshipTransferFileName(parsed.data),
  };
}

export async function parseRelationshipTransferFile(
  file: File,
): Promise<CharacterRelationshipTransferPackage> {
  if (
    file.size === 0 ||
    file.size > CHARACTER_RELATIONSHIP_TRANSFER_MAX_BYTES
  ) {
    throw new RelationshipTransferApiError(
      null,
      "RELATIONSHIP_TRANSFER_TOO_LARGE",
      "请选择不超过 25 MB 的 Meet 角色关系迁移文件。",
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(await file.text());
  } catch {
    throw invalidFile();
  }
  const parsed = characterRelationshipTransferPackageSchema.safeParse(body);
  if (!parsed.success) throw invalidFile();
  return parsed.data;
}

export async function importCharacterRelationship(
  characterId: string,
  transferPackage: CharacterRelationshipTransferPackage,
  confirmCharacterMismatch: boolean,
): Promise<RelationshipTransferImportResult> {
  const query = confirmCharacterMismatch
    ? "?confirmCharacterMismatch=true"
    : "";
  const response = await request(
    `/api/characters/${encodeURIComponent(characterId)}/relationship-import${query}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(transferPackage),
    },
  );
  const body = await readJson(response);
  if (!response.ok) throw apiError(response, body);
  const parsed = relationshipTransferImportResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new RelationshipTransferApiError(
      response.status,
      "RELATIONSHIP_TRANSFER_INVALID_RESPONSE",
    );
  }
  return parsed.data.result;
}

export function downloadRelationshipTransfer(
  transferPackage: CharacterRelationshipTransferPackage,
  fileName: string,
): void {
  const blob = new Blob([JSON.stringify(transferPackage)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function relationshipTransferFileName(
  transferPackage: CharacterRelationshipTransferPackage,
): string {
  const name = Array.from(transferPackage.payload.character.name)
    .map((character) =>
      character.charCodeAt(0) < 32 || /[\\/:*?"<>|]/.test(character)
        ? "-"
        : character,
    )
    .join("")
    .slice(0, 60);
  return `Meet-${name || "角色"}-关系数据-${transferPackage.payload.exportedAt.slice(0, 10)}.json`;
}

async function request(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  try {
    return await fetch(input, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new RelationshipTransferApiError(
      null,
      "RELATIONSHIP_TRANSFER_REQUEST_FAILED",
    );
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new RelationshipTransferApiError(
      response.status,
      "RELATIONSHIP_TRANSFER_INVALID_RESPONSE",
    );
  }
}

function apiError(response: Response, body: unknown) {
  const parsed = apiErrorSchema.safeParse(body);
  return new RelationshipTransferApiError(
    response.status,
    parsed.success ? parsed.data.code : "RELATIONSHIP_TRANSFER_REQUEST_FAILED",
    parsed.success ? parsed.data.message : undefined,
  );
}

function invalidFile(): RelationshipTransferApiError {
  return new RelationshipTransferApiError(
    null,
    "RELATIONSHIP_TRANSFER_INVALID_PACKAGE",
    "请选择有效的 Meet 角色关系迁移文件。",
  );
}
