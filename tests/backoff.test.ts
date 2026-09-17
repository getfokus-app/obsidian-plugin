import { describe, expect, it } from 'vitest';

import { FokusApiError } from '@/api/errors';
import { isBackoff } from '@/sync/backoff';

/**
 * What stops a queue run part-way instead of pushing every remaining file into
 * the same refusal.
 */
describe('isBackoff', () => {
  it('stops for the connection-level refusals', () => {
    expect(isBackoff(new FokusApiError('rate-limited', 429, 'Too many'))).toBe(true);
    expect(isBackoff(new FokusApiError('offline', 0, 'Could not reach Fokus'))).toBe(true);
  });

  /**
   * A paywall never resolves by waiting. Left out of this list, a first full
   * sync of a few hundred notes showed one "Pro required" popup per note.
   */
  it('stops for a paywall, which waiting cannot fix', () => {
    expect(isBackoff(new FokusApiError('pro-required', 403, 'Pro required'))).toBe(true);
  });

  /** A problem with one file must not abandon the rest of the vault. */
  it('keeps going for errors that are about a single note', () => {
    expect(isBackoff(new FokusApiError('conflict', 409, 'Locked'))).toBe(false);
    expect(isBackoff(new FokusApiError('validation', 422, 'Unrepresentable'))).toBe(false);
    expect(isBackoff(new FokusApiError('server', 500, 'Boom'))).toBe(false);
    expect(isBackoff(new Error('something else'))).toBe(false);
    expect(isBackoff(undefined)).toBe(false);
  });
});
