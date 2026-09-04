import type { CharacterRelationshipTransferPayload } from "@meet/protocol";
import type {
  CharacterRelationshipExportData,
  ImportCharacterRelationshipTransferResult,
} from "@meet/database";

export interface RelationshipTransferRepository {
  export(
    actorUserId: string,
    characterId: string,
  ): Promise<CharacterRelationshipExportData | null>;
  import(input: {
    actorUserId: string;
    targetCharacterId: string;
    packageChecksum: string;
    payload: CharacterRelationshipTransferPayload;
    confirmCharacterMismatch: boolean;
    importedAt: Date;
  }): Promise<ImportCharacterRelationshipTransferResult>;
}
