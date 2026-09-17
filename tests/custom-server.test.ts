import { describe, expect, it } from 'vitest';

import { DEFAULT_API_URL, showsCustomServer } from '@/sync/state';

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
