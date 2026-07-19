import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NotionClient, type FetchLike } from "../client.js";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function stubFetch(factories: Array<() => Response>): {
  fetchImpl: FetchLike;
  calls: Array<{ path: string; init?: RequestInit }>;
} {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (path, init) => {
    calls.push({ path, init });
    const factory = factories[Math.min(calls.length - 1, factories.length - 1)]!;
    return factory();
  };
  return { fetchImpl, calls };
}

describe("NotionClient (issue #24 — ADR-06 §5: rate-limited, Retry-After aware)", () => {
  const originalToken = process.env.FOS_NOTION_TOKEN;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.FOS_NOTION_TOKEN = "test-token";
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalToken === undefined) delete process.env.FOS_NOTION_TOKEN;
    else process.env.FOS_NOTION_TOKEN = originalToken;
  });

  it("FOS0-ADP-07: sends the Bearer token from FOS_NOTION_TOKEN and the Notion-Version header", async () => {
    const { fetchImpl, calls } = stubFetch([() => jsonResponse(200, { object: "page" })]);
    const client = new NotionClient({ fetchImpl, requestsPerSecond: 100 });

    await client.getPage("page-1");

    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["Notion-Version"]).toBe("2026-03-01");
  });

  it("FOS0-ADP-08: a 429 with Retry-After waits that long, then retries and succeeds", async () => {
    const { fetchImpl, calls } = stubFetch([
      () => jsonResponse(429, { message: "rate limited" }, { "Retry-After": "2" }),
      () => jsonResponse(200, { object: "page", id: "page-1" }),
    ]);
    const client = new NotionClient({ fetchImpl, requestsPerSecond: 100 });

    const promise = client.getPage("page-1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1); // still waiting out the 2s Retry-After

    await vi.advanceTimersByTimeAsync(1500);
    const result = await promise;

    expect(calls).toHaveLength(2);
    expect(result).toEqual({ object: "page", id: "page-1" });
  });

  it("FOS0-ADP-09: a 529 with Retry-After waits that long, then retries and succeeds", async () => {
    const { fetchImpl, calls } = stubFetch([
      () => jsonResponse(529, { message: "overloaded" }, { "Retry-After": "1" }),
      () => jsonResponse(200, { object: "page" }),
    ]);
    const client = new NotionClient({ fetchImpl, requestsPerSecond: 100 });

    const promise = client.getPage("page-1");
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(calls).toHaveLength(2);
    expect(result).toEqual({ object: "page" });
  });

  it("FOS0-ADP-10: gives up after maxRetries and throws", async () => {
    const { fetchImpl, calls } = stubFetch([() => jsonResponse(429, {}, { "Retry-After": "0" })]);
    const client = new NotionClient({ fetchImpl, requestsPerSecond: 100, maxRetries: 2 });

    const outcome = client.getPage("page-1").then(
      () => "resolved",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(10000);
    const result = await outcome;

    expect(result).toBeInstanceOf(Error);
    expect(calls).toHaveLength(3); // initial attempt + 2 retries
  });

  it("FOS0-ADP-11: a missing credential throws before any network call", async () => {
    delete process.env.FOS_NOTION_TOKEN;
    const { fetchImpl, calls } = stubFetch([() => jsonResponse(200, {})]);
    const client = new NotionClient({ fetchImpl, requestsPerSecond: 100 });

    await expect(client.getPage("page-1")).rejects.toThrow(/FOS_NOTION_TOKEN/);
    expect(calls).toHaveLength(0);
  });

  it("FOS0-ADP-12: a Retry-After far beyond the max is clamped to 60s, not honored verbatim", async () => {
    const { fetchImpl, calls } = stubFetch([
      () => jsonResponse(429, {}, { "Retry-After": "999999999" }),
      () => jsonResponse(200, { object: "page" }),
    ]);
    const client = new NotionClient({ fetchImpl, requestsPerSecond: 100 });

    const promise = client.getPage("page-1");
    await vi.advanceTimersByTimeAsync(59000);
    expect(calls).toHaveLength(1); // still waiting out the clamped 60s, not 999999999s

    await vi.advanceTimersByTimeAsync(1500);
    const result = await promise;

    expect(calls).toHaveLength(2);
    expect(result).toEqual({ object: "page" });
  });

  it("FOS0-ADP-13: a non-numeric Retry-After falls back to the 1s default, not an immediate retry", async () => {
    const { fetchImpl, calls } = stubFetch([
      () => jsonResponse(429, {}, { "Retry-After": "not-a-number" }),
      () => jsonResponse(200, { object: "page" }),
    ]);
    const client = new NotionClient({ fetchImpl, requestsPerSecond: 100 });

    const promise = client.getPage("page-1");
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(1); // NaN must not collapse to an immediate (0ms) retry

    await vi.advanceTimersByTimeAsync(600);
    const result = await promise;

    expect(calls).toHaveLength(2);
    expect(result).toEqual({ object: "page" });
  });

  it("FOS0-ADP-14: an HTTP-date Retry-After (RFC 7231 form) waits until that date, then retries", async () => {
    const { fetchImpl, calls } = stubFetch([
      () => jsonResponse(429, {}, { "Retry-After": new Date(Date.now() + 40000).toUTCString() }),
      () => jsonResponse(200, { object: "page" }),
    ]);
    const client = new NotionClient({ fetchImpl, requestsPerSecond: 100 });

    const promise = client.getPage("page-1");
    await vi.advanceTimersByTimeAsync(20000);
    expect(calls).toHaveLength(1); // still waiting out the ~40s until the HTTP-date

    await vi.advanceTimersByTimeAsync(25000);
    const result = await promise;

    expect(calls).toHaveLength(2);
    expect(result).toEqual({ object: "page" });
  });

  it("FOS0-ADP-15: a negative Retry-After falls back to the 1s default rather than retrying immediately", async () => {
    const { fetchImpl, calls } = stubFetch([
      () => jsonResponse(429, {}, { "Retry-After": "-5" }),
      () => jsonResponse(200, { object: "page" }),
    ]);
    const client = new NotionClient({ fetchImpl, requestsPerSecond: 100 });

    const promise = client.getPage("page-1");
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(1); // a negative value must not collapse to an immediate retry

    await vi.advanceTimersByTimeAsync(600);
    const result = await promise;

    expect(calls).toHaveLength(2);
    expect(result).toEqual({ object: "page" });
  });
});
