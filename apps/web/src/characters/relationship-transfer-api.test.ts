import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RelationshipTransferApiError,
  exportCharacterRelationship,
  importCharacterRelationship,
  parseRelationshipTransferFile,
} from "./relationship-transfer-api.js";

const characterId = "c437c71e-f209-4f7d-8f98-1c1e239d4201";

describe("relationship transfer web API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("downloads and strictly parses the current account package", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(transferPackage()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const exported = await exportCharacterRelationship(characterId);

    expect(exported.fileName).toContain("奥特曼");
    expect(exported.transferPackage.payload.character.name).toBe("奥特曼");
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/characters/${characterId}/relationship-export`,
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
      }),
    );
  });

  it("rejects malformed local files before an upload", async () => {
    const file = new File(["{not-json"], "broken.json", {
      type: "application/json",
    });
    await expect(parseRelationshipTransferFile(file)).rejects.toBeInstanceOf(
      RelationshipTransferApiError,
    );
  });

  it("uploads the selected package with explicit mismatch confirmation", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            result: {
              transferId: "4c89af5d-f410-4da8-82cc-02f48dff2ff9",
              targetCharacterId: characterId,
              importedConversations: 2,
              skippedConversations: 1,
              importedMemories: 3,
              skippedMemories: 0,
              wasAlreadyImported: false,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await importCharacterRelationship(
      characterId,
      transferPackage(),
      true,
    );

    expect(result.importedMemories).toBe(3);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/characters/${characterId}/relationship-import?confirmCharacterMismatch=true`,
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      }),
    );
  });
});

function transferPackage() {
  return {
    kind: "meet-character-relationship-transfer" as const,
    schemaVersion: "meet-character-relationship-v1" as const,
    payload: {
      transferId: "4c89af5d-f410-4da8-82cc-02f48dff2ff9",
      exportedAt: "2026-09-05T03:00:00.000Z",
      character: { name: "奥特曼", systemKey: null },
      conversations: [],
      memories: [],
    },
    integritySha256: "0".repeat(64),
  };
}
