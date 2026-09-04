import {
  importCharacterRelationshipTransfer,
  loadCharacterRelationshipExport,
  type Database,
  type MemoryIndexHook,
} from "@meet/database";

import type { RelationshipTransferRepository } from "./repository.js";

export class PostgresRelationshipTransferRepository implements RelationshipTransferRepository {
  constructor(
    private readonly db: Database,
    private readonly onMemoryIndex?: MemoryIndexHook,
  ) {}

  export(actorUserId: string, characterId: string) {
    return loadCharacterRelationshipExport(this.db, {
      actorUserId,
      characterId,
    });
  }

  import(input: Parameters<RelationshipTransferRepository["import"]>[0]) {
    return importCharacterRelationshipTransfer(this.db, {
      ...input,
      onMemoryIndex: this.onMemoryIndex,
    });
  }
}
