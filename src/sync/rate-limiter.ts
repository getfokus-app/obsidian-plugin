/**
 * A token bucket, used to stay inside the server's limits rather than
 * discovering them by being refused.
 *
 * Uploads are capped at 10/min server-side; note writes are not currently
 * throttled, but a first sync of a large vault is exactly the traffic that
 * would justify adding one, so it self-limits anyway.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  /**
   * @param capacity sustained units allowed per `perMs`
   * @param burst how many may go at once. Defaults to `capacity`, which is the
   *   intuitive reading and also WRONG whenever the server measures a rolling
   *   window: a bucket that starts full spends all of `capacity` at t=0 and
   *   then refills for the rest of the window, so the first minute carries
   *   nearly `capacity + burst` units. At 8/min that is 15 — half again over a
   *   10/min server cap. Keep `burst + capacity - 1` under the real limit.
   */
  constructor(
    private readonly capacity: number,
    private readonly perMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly burst: number = capacity,
  ) {
    this.tokens = burst;
    this.lastRefill = now();
  }

  /**
   * Milliseconds to wait before one unit of work may proceed, and 0 when it can
   * go now. Either way the token is spent — the caller is going to do the work.
   *
   * Returning a wait WITHOUT charging for it let the next call reserve again
   * the moment the sleep finished, so every slot bought two units instead of
   * one and the limiter ran at exactly twice its configured rate.
   */
  reserve(): number {
    this.refill();

    const wait = this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) * (this.perMs / this.capacity));
    this.tokens -= 1;

    return wait;
  }

  private refill(): void {
    const at = this.now();
    const elapsed = at - this.lastRefill;
    if (elapsed <= 0) return;

    this.tokens = Math.min(this.burst, this.tokens + (elapsed / this.perMs) * this.capacity);
    this.lastRefill = at;
  }
}
