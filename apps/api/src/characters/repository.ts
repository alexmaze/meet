import type {
  CharacterAggregate,
  CharacterCatalog,
  CopyCharacterResult,
  CreateCharacterResult,
  DeleteCharacterResult,
  RestoreCharacterResult,
  UpdateCharacterResult,
  EditableCharacterValues,
} from "@meet/database";

export interface CharacterRepository {
  listVisible(actorUserId: string): Promise<CharacterAggregate[]>;
  findVisible(
    actorUserId: string,
    characterId: string,
  ): Promise<CharacterAggregate | null>;
  listCatalog(): Promise<CharacterCatalog>;
  create(
    actorUserId: string,
    input: EditableCharacterValues,
    createdAt: Date,
  ): Promise<CreateCharacterResult>;
  update(
    actorUserId: string,
    characterId: string,
    expectedRevision: number,
    changes: Partial<EditableCharacterValues>,
    updatedAt: Date,
  ): Promise<UpdateCharacterResult>;
  updateVisibility(
    actorUserId: string,
    characterId: string,
    expectedRevision: number,
    visibility: "private" | "family",
    updatedAt: Date,
  ): Promise<UpdateCharacterResult>;
  copy(
    actorUserId: string,
    sourceCharacterId: string,
    createdAt: Date,
  ): Promise<CopyCharacterResult>;
  restore(
    actorUserId: string,
    characterId: string,
    restoredAt: Date,
  ): Promise<RestoreCharacterResult>;
  delete(
    actorUserId: string,
    characterId: string,
    expectedRevision: number,
    deletedAt: Date,
  ): Promise<DeleteCharacterResult>;
}
