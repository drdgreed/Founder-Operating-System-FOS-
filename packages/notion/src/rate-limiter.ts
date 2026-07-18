/**
 * Token-bucket pacing + bounded concurrency for the shared Notion client
 * (ADR-06: "one shared, rate-limited Notion client — token bucket ~3 rps,
 * ... bounded concurrency. All projection writes + fetch-latest reads go
 * through it."). Spacing is timestamp-based (no background interval timer)
 * so it plays correctly with vitest fake timers in tests.
 */
export interface RateLimiterOptions {
  /** Steady-state request rate. Defaults to Notion's ~3 req/s (ADR-06). */
  requestsPerSecond?: number;
  /** Max requests in flight at once. Defaults to requestsPerSecond. */
  maxConcurrent?: number;
}

export type ReleaseFn = () => void;

export class TokenBucketRateLimiter {
  private readonly intervalMs: number;
  private readonly maxConcurrent: number;
  private nextSlotAt = 0;
  private active = 0;
  private readonly waiters: ReleaseFn[] = [];

  constructor(options: RateLimiterOptions = {}) {
    const requestsPerSecond = options.requestsPerSecond ?? 3;
    this.intervalMs = 1000 / requestsPerSecond;
    this.maxConcurrent = options.maxConcurrent ?? Math.ceil(requestsPerSecond);
  }

  /** Waits until a rate-limit slot AND a concurrency slot are free, then
   * reserves both. Callers MUST invoke the returned function exactly once
   * when the request completes to free the concurrency slot. */
  async acquire(): Promise<ReleaseFn> {
    await this.waitForPacingSlot();
    await this.waitForConcurrencySlot();
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next();
    };
  }

  private async waitForPacingSlot(): Promise<void> {
    const now = Date.now();
    const slotAt = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slotAt + this.intervalMs;
    const delay = slotAt - now;
    if (delay > 0) {
      await sleep(delay);
    }
  }

  private waitForConcurrencySlot(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
