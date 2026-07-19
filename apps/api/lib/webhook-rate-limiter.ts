/**
 * Bounds how often the Notion webhook's fetch-latest trigger (the expensive
 * step — a DB poll + Notion API calls) may run (issue #41 item 1: a captured
 * VALID signed body can otherwise be replayed indefinitely, each replay
 * paying full reconcile/capture cost even though the resulting STATE stays
 * idempotent). This gates the TRIGGER, not the whole endpoint — verification
 * handshakes and signature/config failures are cheap and unaffected.
 *
 * This is an in-memory, single-process limiter. It does NOT coordinate
 * across multiple deployed instances — a horizontally-scaled deploy needs a
 * shared store (e.g. Redis) to enforce this cluster-wide. Documented
 * limitation, acceptable for the current single-process deploy target.
 */
export interface WebhookRateLimiter {
  /** Returns true if a trigger may proceed now, false if it should be
   * throttled. Never throws. */
  tryAcquire(now: number): boolean;
}

export interface FixedWindowRateLimiterOptions {
  /** Max triggers allowed within one window. */
  maxRequests: number;
  windowMs: number;
}

export class FixedWindowRateLimiter implements WebhookRateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private windowStart: number | null = null;
  private count = 0;

  constructor(options: FixedWindowRateLimiterOptions) {
    this.maxRequests = options.maxRequests;
    this.windowMs = options.windowMs;
  }

  tryAcquire(now: number): boolean {
    if (this.windowStart === null || now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.count = 0;
    }
    if (this.count >= this.maxRequests) return false;
    this.count += 1;
    return true;
  }
}

/** ADR-06 notes high-frequency edits are batched by Notion itself; this is a
 * generous ceiling for legitimate traffic on a single-workspace deploy while
 * still bounding sustained replay abuse. */
export const DEFAULT_TRIGGER_RATE_LIMIT: FixedWindowRateLimiterOptions = {
  maxRequests: 30,
  windowMs: 60_000,
};
