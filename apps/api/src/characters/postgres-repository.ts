import {
  copyCharacter,
  createCharacter,
  deleteCharacter,
  findVisibleCharacter,
  listCharacterCatalog,
  listVisibleCharacters,
  restoreBuiltinCharacter,
  updateCharacter,
  updateCharacterVisibility,
  type Database,
} from "@meet/database";

import type { CharacterRepository } from "./repository.js";

export class PostgresCharacterRepository implements CharacterRepository {
  constructor(private readonly db: Database) {}

  listVisible(actorUserId: string) {
    return listVisibleCharacters(this.db, actorUserId);
  }

  findVisible(actorUserId: string, characterId: string) {
    return findVisibleCharacter(this.db, actorUserId, characterId);
  }

  listCatalog() {
    return listCharacterCatalog(this.db);
  }

  create(
    actorUserId: string,
    input: Parameters<CharacterRepository["create"]>[1],
    createdAt: Date,
  ) {
    return createCharacter(this.db, { ...input, actorUserId, createdAt });
  }

  update(
    actorUserId: string,
    characterId: string,
    expectedRevision: number,
    changes: Parameters<CharacterRepository["update"]>[3],
    updatedAt: Date,
  ) {
    return updateCharacter(this.db, {
      actorUserId,
      characterId,
      expectedRevision,
      changes,
      updatedAt,
    });
  }

  updateVisibility(
    actorUserId: string,
    characterId: string,
    expectedRevision: number,
    visibility: "private" | "family",
    updatedAt: Date,
  ) {
    return updateCharacterVisibility(this.db, {
      actorUserId,
      characterId,
      expectedRevision,
      visibility,
      updatedAt,
    });
  }

  copy(actorUserId: string, sourceCharacterId: string, createdAt: Date) {
    return copyCharacter(this.db, {
      actorUserId,
      sourceCharacterId,
      createdAt,
    });
  }

  restore(actorUserId: string, characterId: string, restoredAt: Date) {
    return restoreBuiltinCharacter(this.db, {
      actorUserId,
      characterId,
      restoredAt,
    });
  }

  delete(
    actorUserId: string,
    characterId: string,
    expectedRevision: number,
    deletedAt: Date,
  ) {
    return deleteCharacter(this.db, {
      actorUserId,
      characterId,
      expectedRevision,
      deletedAt,
    });
  }
}
