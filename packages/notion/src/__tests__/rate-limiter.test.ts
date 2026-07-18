import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TokenBucketRateLimiter } from "../rate-limiter.js";

describe("TokenBucketRateLimiter (ADR-06 §5: token bucket, bounded concurrency)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("FOS0-ADP-05: paces a burst of N>capacity acquisitions to the configured rate (fake timers, no real sleeps)", async () => {
    const limiter = new TokenBucketRateLimiter({ requestsPerSecond: 4, maxConcurrent: 10 });
    const resolvedAt: number[] = [];

    const all = Promise.all(
      Array.from({ length: 5 }, () =>
        limiter.acquire().then((release) => {
          resolvedAt.push(Date.now());
          release();
        }),
      ),
    );

    await vi.advanceTimersByTimeAsync(2000);
    await all;

    expect(resolvedAt).toHaveLength(5);
    // 4 req/s => one slot every 250ms.
    for (let i = 1; i < resolvedAt.length; i++) {
      expect(resolvedAt[i]! - resolvedAt[i - 1]!).toBe(250);
    }
  });

  it("FOS0-ADP-06: bounded concurrency — an extra acquire waits for an earlier release even once pacing allows it", async () => {
    const limiter = new TokenBucketRateLimiter({ requestsPerSecond: 1000, maxConcurrent: 2 });
    const releases: Array<() => void> = [];
    let thirdAcquired = false;

    const p1 = limiter.acquire().then((release) => releases.push(release));
    const p2 = limiter.acquire().then((release) => releases.push(release));
    const p3 = limiter.acquire().then((release) => {
      thirdAcquired = true;
      releases.push(release);
    });

    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([p1, p2]);

    // Pacing (1000 req/s) would allow slot 3 within ~2ms, but maxConcurrent=2
    // is still holding both slots — it must remain blocked.
    expect(thirdAcquired).toBe(false);

    releases[0]!();
    await p3;

    expect(thirdAcquired).toBe(true);
    releases[1]!();
    releases[2]!();
  });
});
