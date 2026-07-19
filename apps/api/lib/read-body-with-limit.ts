/**
 * Reads a `Request` body as text with a hard byte cap, enforced BEFORE the
 * body is handed off for HMAC verification (issue #41 item 2). `req.text()`
 * alone reads an unbounded body into memory on a public,
 * unauthenticated-until-HMAC endpoint, and the signature is computed over
 * the FULL body before it can be rejected — a huge-body flood is a cheap
 * memory/compute DoS vector against that endpoint.
 *
 * Checks BOTH the declared `Content-Length` header (fast-path rejection, no
 * body read at all) AND the actual bytes streamed (a `Content-Length` header
 * can be absent or understated — an attacker is not obligated to tell the
 * truth about how much they're sending), aborting the read the moment the
 * cap is exceeded rather than buffering the whole oversized body first.
 */
export class RequestBodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`request body exceeds the ${maxBytes}-byte limit`);
    this.name = "RequestBodyTooLargeError";
  }
}

/** Notion webhook payloads are small, IDs-only JSON (ADR-06 Finding 1) — even
 * a batched, high-frequency delivery stays well under this. Generous on
 * purpose; this is a DoS backstop, not a tight content-shape constraint. */
export const DEFAULT_MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

export async function readBodyWithLimit(req: Request, maxBytes: number): Promise<string> {
  const declaredLength = req.headers.get("content-length");
  if (declaredLength !== null) {
    const declared = Number(declaredLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new RequestBodyTooLargeError(maxBytes);
    }
  }

  const reader = req.body?.getReader();
  if (!reader) {
    // No readable body stream (e.g. a genuinely empty body) — nothing to
    // exceed the cap with.
    return req.text();
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new RequestBodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf-8");
}
