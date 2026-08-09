/**
 * Produces the stable identity used for username lookup and uniqueness.
 *
 * The original username remains available for display. PostgreSQL cannot
 * reproduce JavaScript's Unicode NFKC normalization reliably, so every write
 * path must call this function before persisting `usernameCanonical`.
 */
export function canonicalizeUsername(username: string): string {
  return username.trim().normalize("NFKC").toLowerCase();
}
