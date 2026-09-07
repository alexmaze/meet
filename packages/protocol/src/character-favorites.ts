import { z } from "zod";

export const characterFavoritesResponseSchema = z.object({
  characterIds: z.array(z.uuid()),
});

export const setCharacterFavoriteRequestSchema = z
  .object({ favorite: z.boolean() })
  .strict();

export const characterFavoriteResponseSchema = z.object({
  characterId: z.uuid(),
  favorite: z.boolean(),
});
