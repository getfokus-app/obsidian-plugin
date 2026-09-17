import { describe, expect, it } from 'vitest';

import { DEFAULT_API_URL, mirrorBelongsElsewhere, showsCustomServer } from '@/sync/state';

describe('showsCustomServer', () => {
  it('stays hidden for the ordinary case', () => {
    expect(showsCustomServer({ apiUrl: DEFAULT_API_URL })).toBe(false);
    expect(showsCustomServer({ apiUrl: DEFAULT_API_URL, customServer: false })).toBe(false);
  });

  it('shows when the user asked for it', () => {
    expect(showsCustomServer({ apiUrl: DEFAULT_API_URL, customServer: true })).toBe(true);
  });

  /**
   * The safety property. A vault pointed somewhere other than Fokus must say so
   * on screen even if the flag is off or was never written — a settings page
   * that hides where the notes are actually going is worse than no page.
   */
  it('shows a non-default server even when the flag says otherwise', () => {
    expect(showsCustomServer({ apiUrl: 'http://localhost:3000' })).toBe(true);
    expect(showsCustomServer({ apiUrl: 'http://localhost:3000', customServer: false })).toBe(true);
    expect(showsCustomServer({ apiUrl: 'https://fokus.example.com' })).toBe(true);
  });
});

describe('mirrorBelongsElsewhere', () => {
  /**
   * Every mirror entry holds a Fokus note id, and note ids belong to one
   * account. Pasting a token for a different account left the plugin pushing at
   * ids the new token cannot touch — a permanent 403 shown as "forbidden", with
   * nothing on screen to explain it.
   */
  it('is true when the vault was last synced with another account', () => {
    expect(mirrorBelongsElsewhere('ws-old', 'ws-new')).toBe(true);
  });

  it('is false on a first connect, when there is nothing to discard', () => {
    expect(mirrorBelongsElsewhere(undefined, 'ws-new')).toBe(false);
    expect(mirrorBelongsElsewhere('', 'ws-new')).toBe(false);
  });

  /** Re-connecting to the same account must keep the mirror, or everything re-adopts. */
  it('is false when reconnecting to the same workspace', () => {
    expect(mirrorBelongsElsewhere('ws-same', 'ws-same')).toBe(false);
  });
});
