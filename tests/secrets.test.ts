import { describe, expect, it } from 'vitest';

import { TOKEN_SECRET_ID, obsidianSecrets, planTokenMigration } from '@/auth/secrets';

describe('planTokenMigration', () => {
  /** The case every existing install hits once. */
  it('moves a plaintext token out of data.json', () => {
    expect(planTokenMigration('eyJhbGciOi.abc.def', undefined)).toEqual({
      secretId: TOKEN_SECRET_ID,
      secret: 'eyJhbGciOi.abc.def',
    });
  });

  it('does nothing for a vault that never held one', () => {
    expect(planTokenMigration(undefined, undefined)).toBeNull();
    expect(planTokenMigration('', undefined)).toBeNull();
    expect(planTokenMigration('   ', undefined)).toBeNull();
  });

  /**
   * Once an id is recorded the keychain is the source of truth. A stale
   * plaintext copy left in the file must never be written back over it —
   * that would silently restore a revoked or older token.
   */
  it('never lets a leftover plaintext copy overwrite the keychain', () => {
    expect(planTokenMigration('old-token', TOKEN_SECRET_ID)).toBeNull();
    expect(planTokenMigration('old-token', 'some-other-id')).toBeNull();
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
