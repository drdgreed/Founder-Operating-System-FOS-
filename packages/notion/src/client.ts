import { TokenBucketRateLimiter, sleep, type RateLimiterOptions } from "./rate-limiter.js";

/** Notion API version this client targets (ADR-06 capability spike). */
// Verified against the live Notion API (2026-07-19): "2026-03-01" is REJECTED
// with `missing_version`; the valid data-source-era versions are "2025-09-03"
// and "2026-03-11". Using the latter.
const NOTION_VERSION = "2026-03-11";
const DEFAULT_BASE_URL = "https://api.notion.com/v1";

// ADR-06 §5: 429/529, honor Retry-After.
const RETRYABLE_STATUS_CODES = new Set([429, 529]);

// Issue #26: a hostile/buggy server must not be able to dictate an
// unbounded (or setTimeout 32-bit-ms-overflow) block via Retry-After.
const DEFAULT_RETRY_AFTER_SECONDS = 1;
const MAX_RETRY_AFTER_SECONDS = 60;

// All three RFC 7231 §7.1.1.1 HTTP-date forms (IMF-fixdate, obsolete RFC 850,
// obsolete asctime) start with a weekday name followed by `, ` or a space
// then a month abbreviation. Gating Date.parse on this keeps numeric-looking
// junk (e.g. "-5") from being misread as a date — V8's Date.parse is lenient
// enough to resolve such strings to an unrelated real date instead of NaN.
const HTTP_DATE_PREFIX_RE = /^[A-Za-z]{3,9},\s|^[A-Za-z]{3}\s[A-Za-z]{3}\s/;

/**
 * Parses a `Retry-After` header per RFC 7231 §7.1.3: either a non-negative
 * integer number of seconds, or an HTTP-date. Falls back to the default on
 * anything non-numeric, negative, or NaN (a raw `Number(dateString)` is
 * NaN, so the HTTP-date form lands here too rather than retrying instantly).
 * The result is always clamped to `MAX_RETRY_AFTER_SECONDS`.
 */
function parseRetryAfterSeconds(headerValue: string | null): number {
  if (headerValue === null) return DEFAULT_RETRY_AFTER_SECONDS;

  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
  }

  if (HTTP_DATE_PREFIX_RE.test(headerValue)) {
    const dateMs = Date.parse(headerValue);
    if (!Number.isNaN(dateMs)) {
      const deltaSeconds = (dateMs - Date.now()) / 1000;
      if (deltaSeconds <= 0) return 0;
      return Math.min(deltaSeconds, MAX_RETRY_AFTER_SECONDS);
    }
  }

  return DEFAULT_RETRY_AFTER_SECONDS;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface NotionClientOptions extends RateLimiterOptions {
  /** Injected fetch-like function — tests supply a mock, no real network. */
  fetchImpl: FetchLike;
  /** process.env var name holding the token (ADR-04: reference, not the
   * secret itself). Defaults to FOS_NOTION_TOKEN. */
  credentialReference?: string;
  baseUrl?: string;
  /** Max 429/529 retries before giving up. */
  maxRetries?: number;
}

/**
 * Thin, rate-limited Notion API wrapper (slice 0.2a). Every request funnels
 * through the shared token-bucket limiter; 429/529 responses are retried
 * after the server-specified `Retry-After` delay. Method bodies are
 * intentionally minimal — projection/reconciliation logic lands in 0.2b/c.
 */
export class NotionClient {
  private readonly fetchImpl: FetchLike;
  private readonly credentialReference: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly limiter: TokenBucketRateLimiter;

  constructor(options: NotionClientOptions) {
    this.fetchImpl = options.fetchImpl;
    this.credentialReference = options.credentialReference ?? "FOS_NOTION_TOKEN";
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.maxRetries = options.maxRetries ?? 3;
    this.limiter = new TokenBucketRateLimiter(options);
  }

  private getToken(): string {
    const token = process.env[this.credentialReference];
    if (!token) {
      throw new Error(`Notion credential reference "${this.credentialReference}" is not set`);
    }
    return token;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const release = await this.limiter.acquire();
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          headers: {
            ...init.headers,
            Authorization: `Bearer ${this.getToken()}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
          },
        });
      } finally {
        release();
      }

      if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < this.maxRetries) {
        const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("Retry-After"));
        await sleep(retryAfterSeconds * 1000);
        continue;
      }

      if (!response.ok) {
        throw new Error(`Notion API error ${response.status} for ${path}`);
      }

      return (await response.json()) as T;
    }
  }

  queryDataSource(dataSourceId: string, body: Record<string, unknown> = {}): Promise<unknown> {
    return this.request(`/data_sources/${dataSourceId}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  getPage(pageId: string): Promise<unknown> {
    return this.request(`/pages/${pageId}`);
  }

  updatePageProperties(pageId: string, properties: Record<string, unknown>): Promise<unknown> {
    return this.request(`/pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    });
  }

  createPage(body: Record<string, unknown>): Promise<unknown> {
    return this.request(`/pages`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}
