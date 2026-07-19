import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { POST } from "../app/api/fos/notion/webhook/route.js";

/**
 * Route-wrapper-level tests (issue #41 item 3). Every `FOS0-WHK-*` test
 * elsewhere drives `handleNotionWebhook` directly — none of them exercise
 * `route.ts` itself: the `req.text()` raw-body read, the `x-notion-signature`
 * header lookup, env plumbing, or the size-cap/logging wiring. A regression
 * swapping `req.text()` for `req.json()` (which would silently break HMAC
 * verification on any body needing byte-exact reproduction) would not be
 * caught anywhere else.
 *
 * Scope: only paths that resolve WITHOUT touching a real DB or the real
 * Notion API (401/403/413/503/handshake/stale-event) — `route.ts` doesn't
 * (and per the other apps/api routes' convention, shouldn't) support
 * dependency injection, so the full trigger path stays covered at the
 * `handleNotionWebhook` unit level (FOS0-WHK-06 etc.) instead of here.
 */

const ENV_KEYS = [
  "FOS_NOTION_WEBHOOK_SECRET",
  "FOS_SERVICE_WORKSPACE_ID",
  "FOS_NOTION_ENROLLMENT_DATA_SOURCE_ID",
  "FOS_NOTION_WORKSPACE_INTEGRATION_ID",
  "DATABASE_URL",
] as const;
const saved: Record<string, string | undefined> = {};

const TOKEN = "route-level-test-webhook-secret";
const URL = "http://localhost/api/fos/notion/webhook";

function sign(rawBody: string, token = TOKEN): string {
  return `sha256=${createHmac("sha256", token).update(rawBody).digest("hex")}`;
}

function postRequest(body: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(URL, { method: "POST", body, headers });
}

describe("POST /api/fos/notion/webhook (route wrapper, issue #41 item 3)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.FOS_NOTION_WEBHOOK_SECRET = TOKEN;
    process.env.FOS_SERVICE_WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
    process.env.FOS_NOTION_ENROLLMENT_DATA_SOURCE_ID = "route-test-data-source";
    delete process.env.FOS_NOTION_WORKSPACE_INTEGRATION_ID;
    // getDb() is a process-lifetime singleton (lib/db.ts) and postgres-js
    // connects lazily — this URL is never actually dialed by any path these
    // tests exercise (all of them return before a query would run).
    process.env.DATABASE_URL ??= "postgres://fos:fos@localhost:5432/fos";
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
  });

  it("FOS0-WHK-28: HMAC is computed over the EXACT raw bytes (req.text(), never req.json()-then-restringify)", async () => {
    // Non-canonical whitespace/key order: JSON.parse(x) then
    // JSON.stringify(parsed) would NOT reproduce these exact bytes. Use an
    // event type outside the documented catalog so it's ack'd 200 without
    // ever needing a DB/Notion call — this test is only about whether the
    // signature verifies against the SAME bytes that were signed.
    const rawBody = '{ "type":   "some.unrecognized.event" ,\n "entity": {"id":"p1"} }';

    const res = await POST(postRequest(rawBody, { "x-notion-signature": sign(rawBody) }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("FOS0-WHK-29: an invalid signature is rejected 401 through the real route (x-notion-signature header lookup works)", async () => {
    const rawBody = JSON.stringify({ type: "some.unrecognized.event" });
    const res = await POST(
      postRequest(rawBody, { "x-notion-signature": sign(rawBody, "wrong-token") }),
    );
    expect(res.status).toBe(401);
  });

  it("FOS0-WHK-30: a missing signature header is rejected 401 through the real route", async () => {
    const rawBody = JSON.stringify({ type: "some.unrecognized.event" });
    const res = await POST(postRequest(rawBody));
    expect(res.status).toBe(401);
  });

  it("FOS0-WHK-31: a verification handshake is handled end-to-end (200, token surfaced) without needing workspace/data-source config", async () => {
    delete process.env.FOS_SERVICE_WORKSPACE_ID;
    delete process.env.FOS_NOTION_ENROLLMENT_DATA_SOURCE_ID;
    const rawBody = JSON.stringify({ verification_token: "route-level-handshake-token" });

    const res = await POST(postRequest(rawBody));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verification_token).toBe("route-level-handshake-token");
  });

  it("FOS0-WHK-32: an unconfigured webhook credential reference -> 503 through the real route (env plumbing)", async () => {
    delete process.env.FOS_NOTION_WEBHOOK_SECRET;
    const rawBody = JSON.stringify({ type: "some.unrecognized.event" });

    const res = await POST(postRequest(rawBody, { "x-notion-signature": sign(rawBody) }));

    expect(res.status).toBe(503);
  });

  it("FOS0-WHK-33 (issue #41 item 2): an oversized body is rejected 413 through the real route, before any signature work", async () => {
    const hugeBody = "x".repeat(300 * 1024); // over the 256 KiB default cap
    const res = await POST(postRequest(hugeBody, { "x-notion-signature": "sha256=irrelevant" }));
    expect(res.status).toBe(413);
  });

  it("FOS0-WHK-34: a stale, validly-signed event is ack'd 200 and logs a warning (skippedReason plumbed through to console.warn)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Far enough in the past that it's stale under any real wall clock and
    // any reasonable freshness ceiling, without needing to inject `now`.
    const rawBody = JSON.stringify({
      type: "page.properties_updated",
      entity: { id: "page-1", type: "page" },
      timestamp: "2020-01-01T00:00:00.000Z",
    });

    const res = await POST(postRequest(rawBody, { "x-notion-signature": sign(rawBody) }));

    expect(res.status).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("fetch-latest trigger skipped: stale-event"),
    );
  });
});
