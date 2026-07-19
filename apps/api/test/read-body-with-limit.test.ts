import { describe, it, expect } from "vitest";
import { readBodyWithLimit, RequestBodyTooLargeError } from "../lib/read-body-with-limit.js";

function requestWithBody(body: string, extraHeaders: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/fos/notion/webhook", {
    method: "POST",
    body,
    headers: extraHeaders,
  });
}

describe("readBodyWithLimit (issue #41 item 2 — request body size cap)", () => {
  it("FOS0-WHK-BL-01: a body under the limit reads back exactly", async () => {
    const body = JSON.stringify({ type: "page.properties_updated" });
    const result = await readBodyWithLimit(requestWithBody(body), 1024);
    expect(result).toBe(body);
  });

  it("FOS0-WHK-BL-02: a body exceeding the limit throws RequestBodyTooLargeError, never returns partial content", async () => {
    const body = "x".repeat(2000);
    await expect(readBodyWithLimit(requestWithBody(body), 1024)).rejects.toThrow(
      RequestBodyTooLargeError,
    );
  });

  it("FOS0-WHK-BL-03: a declared Content-Length over the limit is rejected via the fast path (header alone)", async () => {
    // Content-Length lies about a huge body while the actual stream is small
    // — the declared-length fast path must still catch it.
    const req = requestWithBody("small", { "content-length": String(10 * 1024 * 1024) });
    await expect(readBodyWithLimit(req, 1024)).rejects.toThrow(RequestBodyTooLargeError);
  });

  it("FOS0-WHK-BL-04: an ABSENT/understated Content-Length does not bypass the cap — the streamed byte count is enforced independently", async () => {
    // Simulate a request whose body stream yields more bytes than any
    // declared Content-Length would suggest (or omits the header entirely,
    // which the Request/fetch API may do for a string body depending on
    // runtime) — the streaming counter must catch it regardless.
    const body = "y".repeat(5000);
    const req = new Request("http://localhost/api/fos/notion/webhook", {
      method: "POST",
      body,
    });
    await expect(readBodyWithLimit(req, 1024)).rejects.toThrow(RequestBodyTooLargeError);
  });

  it("an empty body reads back as an empty string", async () => {
    const req = new Request("http://localhost/api/fos/notion/webhook", { method: "POST" });
    const result = await readBodyWithLimit(req, 1024);
    expect(result).toBe("");
  });
});
