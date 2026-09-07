import { and, desc, eq } from "drizzle-orm";

import { visibleCharacterWhere } from "./character-operations.js";
import type { Database } from "./client.js";
import { characterFavorites, characters } from "./schema.js";

export async function listFavoriteCharacterIds(
  db: Database,
  actorUserId: string,
): Promise<string[]> {
  const rows = await db
    .select({ characterId: characterFavorites.characterId })
    .from(characterFavorites)
    .innerJoin(characters, eq(characterFavorites.characterId, characters.id))
    .where(
      and(
        eq(characterFavorites.userId, actorUserId),
        visibleCharacterWhere(actorUserId),
      ),
    )
    .orderBy(
      desc(characterFavorites.createdAt),
      characterFavorites.characterId,
    );
  return rows.map((row) => row.characterId);
}

export async function setCharacterFavorite(
  db: Database,
  input: {
    actorUserId: string;
    characterId: string;
    favorite: boolean;
    createdAt: Date;
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Sharing changes and deletion lock the same role row. Visibility must still
    // hold at the moment the private bookmark is written.
    const [character] = await tx
      .select({ id: characters.id })
      .from(characters)
      .where(
        and(
          eq(characters.id, input.characterId),
          visibleCharacterWhere(input.actorUserId),
        ),
      )
      .for("update");
    if (!character) return false;
    if (input.favorite) {
      await tx
        .insert(characterFavorites)
        .values({
          userId: input.actorUserId,
          characterId: input.characterId,
          createdAt: input.createdAt,
        })
        .onConflictDoNothing();
    } else {
      await tx
        .delete(characterFavorites)
        .where(
          and(
            eq(characterFavorites.userId, input.actorUserId),
            eq(characterFavorites.characterId, input.characterId),
          ),
        );
    }
    return true;
  });
}
