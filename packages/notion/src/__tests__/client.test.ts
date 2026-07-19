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
    expect(headers["Notion-Version"]).toBe("2026-03-11");
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
});
