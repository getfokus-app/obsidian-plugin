import { describe, expect, it } from 'vitest';

import { RateLimiter } from '@/sync/rate-limiter';

describe('RateLimiter', () => {
  it('lets a full bucket through immediately', () => {
    const limiter = new RateLimiter(3, 1000, () => 0);

    expect([limiter.reserve(), limiter.reserve(), limiter.reserve()]).toEqual([0, 0, 0]);
  });

  it('asks the caller to wait once the bucket is empty', () => {
    const limiter = new RateLimiter(2, 1000, () => 0);
    limiter.reserve();
    limiter.reserve();

    expect(limiter.reserve()).toBeGreaterThan(0);
  });

  it('refills over time', () => {
    let now = 0;
    const limiter = new RateLimiter(2, 1000, () => now);
    limiter.reserve();
    limiter.reserve();
    expect(limiter.reserve()).toBeGreaterThan(0);

    now = 1000;

    expect(limiter.reserve()).toBe(0);
  });

  /**
   * Measures throughput across waits, which is the only way the real bug was
   * visible: returning a wait without spending the token let the next call
   * reserve again the instant the sleep ended, so every slot bought two units
   * and the limiter ran at exactly twice its configured rate. Asserting a
   * single wait value looked perfectly correct throughout.
   */
  it('holds to its configured rate over a sustained burst', () => {
    let now = 0;
    const limiter = new RateLimiter(10, 60_000, () => now);
    let done = 0;

    // drive it the way flush() does: reserve, sleep, work
    while (now <= 60_000) {
      const wait = limiter.reserve();
      now += wait;
      if (now > 60_000) break;
      done++;
    }

    // capacity as an opening burst, then ten a minute — never twenty
    expect(done).toBeLessThanOrEqual(21);
    expect(done).toBeGreaterThanOrEqual(19);
  });

  it('never returns a negative or NaN wait', () => {
    let now = 0;
    const limiter = new RateLimiter(5, 1000, () => now);

    for (let i = 0; i < 50; i++) {
      const wait = limiter.reserve();
      expect(Number.isFinite(wait)).toBe(true);
      expect(wait).toBeGreaterThanOrEqual(0);
      now += 37;
    }
  });

  it('is unbothered by a clock that goes backwards', () => {
    let now = 10_000;
    const limiter = new RateLimiter(2, 1000, () => now);
    limiter.reserve();

    now = 0;

    expect(limiter.reserve()).toBeGreaterThanOrEqual(0);
  });
});
