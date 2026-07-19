import { describe, it, expect } from "vitest";
import { FixedWindowRateLimiter } from "../lib/webhook-rate-limiter.js";

describe("FixedWindowRateLimiter (issue #41 item 1 — replay/compute-DoS bounding)", () => {
  it("FOS0-WHK-RL-01: allows up to maxRequests within one window", () => {
    const limiter = new FixedWindowRateLimiter({ maxRequests: 3, windowMs: 1000 });
    expect(limiter.tryAcquire(0)).toBe(true);
    expect(limiter.tryAcquire(100)).toBe(true);
    expect(limiter.tryAcquire(200)).toBe(true);
  });

  it("FOS0-WHK-RL-02: denies once maxRequests is exhausted within the window", () => {
    const limiter = new FixedWindowRateLimiter({ maxRequests: 2, windowMs: 1000 });
    expect(limiter.tryAcquire(0)).toBe(true);
    expect(limiter.tryAcquire(500)).toBe(true);
    expect(limiter.tryAcquire(900)).toBe(false);
    expect(limiter.tryAcquire(999)).toBe(false);
  });

  it("FOS0-WHK-RL-03: resets and allows again once the window has elapsed", () => {
    const limiter = new FixedWindowRateLimiter({ maxRequests: 1, windowMs: 1000 });
    expect(limiter.tryAcquire(0)).toBe(true);
    expect(limiter.tryAcquire(999)).toBe(false);
    expect(limiter.tryAcquire(1000)).toBe(true);
    expect(limiter.tryAcquire(1001)).toBe(false);
    expect(limiter.tryAcquire(2000)).toBe(true);
  });

  it("a fresh limiter never shares state with another instance", () => {
    const a = new FixedWindowRateLimiter({ maxRequests: 1, windowMs: 1000 });
    const b = new FixedWindowRateLimiter({ maxRequests: 1, windowMs: 1000 });
    expect(a.tryAcquire(0)).toBe(true);
    expect(a.tryAcquire(0)).toBe(false);
    expect(b.tryAcquire(0)).toBe(true);
  });
});
