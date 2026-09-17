/**
 * Where the access token lives.
 *
 * Obsidian keeps secrets in the OS keychain (Electron `safeStorage` — macOS
 * Keychain, Windows DPAPI, libsecret on Linux) and hands plugins an id rather
 * than the value. Only the id goes in `data.json`, so the token no longer sits
 * in the vault in plain text and no longer travels with it through iCloud,
 * Dropbox or git.
 *
 * Wrapped in a port so the migration below is testable: `app.secretStorage`
 * exists only inside Obsidian.
 */
export interface SecretsPort {
  get(id: string): string | null;
  set(id: string, secret: string): void;
}

/**
 * Obsidian's own store, adapted to the port.
 *
 * Kept as an adapter rather than shaping the port like `SecretStorage` so the
 * migration can be exercised without Obsidian, which is the only part of this
 * that can lose a token.
 */
export function obsidianSecrets(app: {
  secretStorage: {
    getSecret(id: string): string | null;
    setSecret(id: string, secret: string): void;
  };
}): SecretsPort {
  return {
    get: (id) => app.secretStorage.getSecret(id),
    set: (id, secret) => app.secretStorage.setSecret(id, secret),
  };
}

/**
 * The id this plugin stores its token under.
 *
 * Lowercase alphanumeric with dashes — `setSecret` throws on anything else. The
 * store is shared across plugins by design, so the name is explicit about whose
 * secret it is.
 */
export const TOKEN_SECRET_ID = 'fokus-access-token';

export interface TokenMigration {
  /** The id to record in settings. */
  secretId: string;
  /** The value to write into the keychain. */
  secret: string;
}

/**
 * What to do about a token found sitting in `data.json`.
 *
 * Returns null when there is nothing to move — either the vault never held a
 * plaintext token, or it has already been migrated and the id is recorded. The
 * caller deletes the plaintext copy either way; this only decides whether a
 * keychain write is owed first, so that a half-finished migration cannot drop
 * the only copy of the token.
 */
export function planTokenMigration(
  storedToken: string | undefined,
  storedSecretId: string | undefined,
): TokenMigration | null {
  const token = storedToken?.trim();
  if (!token) return null;
  // An id already recorded means the keychain is the source of truth; a
  // leftover plaintext copy is stale and must not overwrite it.
  if (storedSecretId) return null;
  return { secretId: TOKEN_SECRET_ID, secret: token };
}
