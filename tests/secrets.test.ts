import { describe, expect, it } from 'vitest';

import { TOKEN_SECRET_ID, TokenStore, obsidianSecrets, shouldMigrateToken } from '@/auth/secrets';

describe('shouldMigrateToken', () => {
  /** The case every existing install hits once. */
  it('moves a plaintext token out of data.json', () => {
    expect(shouldMigrateToken('not-a-real-token', null)).toBe(true);
  });

  it('does nothing for a vault that never held one', () => {
    expect(shouldMigrateToken(undefined, null)).toBe(false);
    expect(shouldMigrateToken('', null)).toBe(false);
    expect(shouldMigrateToken('   ', null)).toBe(false);
  });

  /**
   * Once the keychain holds a value it is the source of truth. A stale
   * plaintext copy left in the file must never overwrite it — that would
   * silently restore a revoked or older token.
   */
  it('never lets a leftover plaintext copy overwrite the keychain', () => {
    expect(shouldMigrateToken('old-token', 'current-token')).toBe(false);
  });

  /** `setSecret` throws on anything but lowercase alphanumerics and dashes. */
  it('uses an id the keychain will accept', () => {
    expect(TOKEN_SECRET_ID).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('obsidianSecrets', () => {
  it('reads and writes through Obsidian’s store', () => {
    const calls: Array<[string, string]> = [];
    const store = {
      secretStorage: {
        getSecret: (id: string) => (id === 'k' ? 'v' : null),
        setSecret: (id: string, secret: string) => void calls.push([id, secret]),
      },
    };

    const secrets = obsidianSecrets(store);
    secrets.set('k', 'v');

    expect(calls).toEqual([['k', 'v']]);
    expect(secrets.get('k')).toBe('v');
    expect(secrets.get('absent')).toBeNull();
  });
});

/**
 * The credential path, driven for real.
 *
 * These replace bundle string-matching, which could not tell a wired call site
 * from a deleted one: every string still matched after the keychain write was
 * removed, and the assertions passed.
 */
describe('TokenStore', () => {
  const fakeKeychain = (seed: Record<string, string> = {}) => {
    const store = { ...seed };
    return {
      store,
      port: {
        get: (id: string) => store[id] ?? null,
        set: (id: string, secret: string) => void (store[id] = secret),
      },
    };
  };

  it('writes the token to the keychain and reads it back', () => {
    const { store, port } = fakeKeychain();
    const tokens = new TokenStore(port);

    tokens.set('  not-a-real-token  ');

    expect(store[TOKEN_SECRET_ID]).toBe('not-a-real-token');
    expect(tokens.get()).toBe('not-a-real-token');
  });

  it('reports no token when the keychain is empty', () => {
    expect(new TokenStore(fakeKeychain().port).get()).toBeUndefined();
  });

  /** Clearing the field in settings must really clear the credential. */
  it('clears the token when given a blank value', () => {
    const { port } = fakeKeychain({ [TOKEN_SECRET_ID]: 'old' });
    const tokens = new TokenStore(port);

    tokens.set('');

    expect(tokens.get()).toBeUndefined();
  });

  it('migrates a plaintext token from an older build', () => {
    const { store, port } = fakeKeychain();

    expect(new TokenStore(port).migrate('from-data-json')).toBe(true);
    expect(store[TOKEN_SECRET_ID]).toBe('from-data-json');
  });

  it('reports nothing to migrate when there never was a token', () => {
    const { port } = fakeKeychain();
    expect(new TokenStore(port).migrate(undefined)).toBe(false);
  });

  /**
   * The dangerous case: a stale plaintext copy must not resurrect a token the
   * user has already replaced or revoked.
   */
  it('refuses to overwrite a keychain token with a stale plaintext copy', () => {
    const { store, port } = fakeKeychain({ [TOKEN_SECRET_ID]: 'current' });

    expect(new TokenStore(port).migrate('stale')).toBe(false);
    expect(store[TOKEN_SECRET_ID]).toBe('current');
  });
});
