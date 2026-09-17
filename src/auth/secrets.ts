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
 * The id this plugin stores its token under. Fixed, and never shown.
 *
 * Obsidian's `SecretComponent` asks the user to invent an id, because the store
 * is shared and people may want one key across several plugins. That trade does
 * not apply here: there is exactly one secret and it is ours, so naming it is
 * ceremony the user gains nothing from. The field stays an ordinary password
 * box and the value goes to this id.
 *
 * Lowercase alphanumeric with dashes — `setSecret` throws on anything else.
 */
export const TOKEN_SECRET_ID = 'fokus-access-token';

/**
 * Whether a token found sitting in `data.json` should be moved to the keychain.
 *
 * False when there is nothing to move, and false when the keychain already
 * holds a value — a leftover plaintext copy is stale by definition and must
 * never overwrite it, or a revoked token could come back. The caller deletes
 * the plaintext copy either way; this only decides whether a write is owed
 * first, so a half-finished migration cannot drop the only copy.
 */
export function shouldMigrateToken(
  storedToken: string | undefined,
  existingSecret: string | null,
): boolean {
  return !!storedToken?.trim() && !existingSecret;
}

/**
 * The plugin's whole relationship with the access token.
 *
 * Extracted from `main.ts` so it can actually be tested: that file imports
 * Obsidian, so the unit suite cannot load it, and asserting on the built bundle
 * only proves the keychain API is *mentioned* — a call site can be deleted and
 * every string still matches. Behaviour belongs somewhere a fake can drive it.
 */
export class TokenStore {
  constructor(private readonly secrets: SecretsPort) {}

  /**
   * The token, read on demand — it is never held on an object that gets saved.
   *
   * An empty entry reads as absent. Clearing the field in settings writes a
   * blank, and returning that as a string would have the plugin try to
   * authenticate with nothing instead of reporting itself unconfigured.
   */
  get(): string | undefined {
    return this.secrets.get(TOKEN_SECRET_ID) || undefined;
  }

  /** Blank clears it, so removing the token in settings really removes it. */
  set(token: string): void {
    this.secrets.set(TOKEN_SECRET_ID, token.trim());
  }

  /**
   * Move a token left in `data.json` by an older build into the keychain.
   *
   * Returns whether anything moved, so the caller can say so. The write happens
   * here and the caller deletes the plaintext copy afterwards; doing it in that
   * order means an interruption leaves two copies rather than none.
   */
  migrate(storedToken: string | undefined): boolean {
    if (!shouldMigrateToken(storedToken, this.secrets.get(TOKEN_SECRET_ID))) return false;
    this.secrets.set(TOKEN_SECRET_ID, storedToken!.trim());
    return true;
  }
}
