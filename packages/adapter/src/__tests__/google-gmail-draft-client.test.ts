import { describe, it, expect } from "vitest";
import { GoogleGmailDraftClient, type GmailFetchLike } from "../google-gmail-draft-client.js";

interface CapturedRequest {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  bodyJson: { message: { raw: string } };
}

/**
 * A stub fetch that records every request and returns a caller-supplied
 * Response. NO network, NO credential. This is the ONLY transport the client is
 * exercised against here — the live OAuth handshake is validated out-of-band.
 */
function makeStubFetch(respond: () => Response) {
  const calls: CapturedRequest[] = [];
  const fetchImpl: GmailFetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    // init.headers is a plain object in this client; normalize defensively.
    const h = init?.headers as Record<string, string> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) headers[k] = v;
    calls.push({
      url,
      method: init?.method,
      headers,
      bodyJson: JSON.parse((init?.body as string) ?? "{}"),
    });
    return respond();
  };
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Decodes the Gmail `raw` (base64url) back to the RFC 5322 message text. */
function decodeRaw(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

/** Extracts + base64-decodes the message body (everything after the header/body blank line). */
function decodeBody(mime: string): string {
  const body = mime.split("\r\n\r\n").slice(1).join("\r\n\r\n");
  return Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
}

const OK_DRAFT = { id: "r-123456", message: { id: "m-789" } };

describe("GoogleGmailDraftClient — request/response contract (stubbed fetch, no network)", () => {
  it("POSTs to the drafts endpoint with a Bearer token and JSON content type", async () => {
    const { fetchImpl, calls } = makeStubFetch(() => jsonResponse(200, OK_DRAFT));
    const client = new GoogleGmailDraftClient({
      getAccessToken: () => "fake-access-token",
      fetchImpl,
    });

    const result = await client.createDraft({
      to: "ada@example.com",
      subject: "Your application",
      body: "Hi Ada,\n\nWelcome.",
    });

    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts");
    expect(req.headers.Authorization).toBe("Bearer fake-access-token");
    expect(req.headers["Content-Type"]).toBe("application/json");
    // The draft id is read from the top-level `id`, not message.id.
    expect(result).toEqual({ draftId: "r-123456" });
  });

  it("encodes a valid RFC 5322 message: To, Subject, UTF-8 content type, and the body all round-trip", async () => {
    const { fetchImpl, calls } = makeStubFetch(() => jsonResponse(200, OK_DRAFT));
    const client = new GoogleGmailDraftClient({
      getAccessToken: () => "t",
      fetchImpl,
    });

    await client.createDraft({
      to: "grace@example.com",
      subject: "Interview prep",
      body: "Line one.\nLine two.",
    });

    const raw = calls[0]!.bodyJson.message.raw;
    // The `raw` envelope must be base64URL, not standard base64: its alphabet
    // excludes +, /, and padding =. The MIME length here is not a multiple of
    // 3, so a downgrade to `.toString("base64")` would introduce padding/+//
    // — this pins base64url (a tolerant decoder alone would not catch it).
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(raw).not.toMatch(/[+/=]/);

    const mime = decodeRaw(raw);
    expect(mime).toContain("To: grace@example.com");
    expect(mime).toContain("Subject: Interview prep");
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime).toContain("MIME-Version: 1.0");
    expect(mime).toContain("Content-Transfer-Encoding: base64");
    // Body is base64-transfer-encoded; it decodes back to the original intact.
    expect(decodeBody(mime)).toBe("Line one.\nLine two.");
  });

  it("RFC 2047 encoded-word encodes a non-ASCII subject; a UTF-8 body round-trips byte-for-byte", async () => {
    const { fetchImpl, calls } = makeStubFetch(() => jsonResponse(200, OK_DRAFT));
    const client = new GoogleGmailDraftClient({ getAccessToken: () => "t", fetchImpl });

    await client.createDraft({
      to: "renée@example.com",
      subject: "Félicitations 🎉",
      body: "Café ☕ — you're ready.",
    });

    const mime = decodeRaw(calls[0]!.bodyJson.message.raw);
    // Subject header carries only ASCII (encoded-word), decodable back to the original.
    const subjectLine = mime.split("\r\n").find((l) => l.startsWith("Subject: "))!;
    expect(subjectLine).toMatch(/^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7F]/.test(subjectLine)).toBe(false);
    const b64 = subjectLine.replace("Subject: =?UTF-8?B?", "").replace("?=", "");
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe("Félicitations 🎉");
    // The UTF-8 body survives base64 transfer-encoding byte-for-byte.
    expect(decodeBody(mime)).toBe("Café ☕ — you're ready.");
  });

  it("fetches a fresh token per call (provider seam for OAuth refresh)", async () => {
    let n = 0;
    const { fetchImpl, calls } = makeStubFetch(() => jsonResponse(200, OK_DRAFT));
    const client = new GoogleGmailDraftClient({
      getAccessToken: () => `token-${++n}`,
      fetchImpl,
    });

    await client.createDraft({ to: "a@b.com", subject: "s", body: "b" });
    await client.createDraft({ to: "a@b.com", subject: "s", body: "b" });

    expect(calls[0]!.headers.Authorization).toBe("Bearer token-1");
    expect(calls[1]!.headers.Authorization).toBe("Bearer token-2");
  });

  it("fails closed on a CRLF-injected subject (header injection) — throws, no fetch", async () => {
    const { fetchImpl, calls } = makeStubFetch(() => jsonResponse(200, OK_DRAFT));
    const client = new GoogleGmailDraftClient({ getAccessToken: () => "t", fetchImpl });

    // A pure-ASCII subject carrying CRLF would smuggle a hidden Bcc header if
    // the value were interpolated raw (CR/LF are ASCII, so encoded-word does
    // NOT neutralize them). It must be rejected before any request.
    await expect(
      client.createDraft({ to: "a@b.com", subject: "Hi\r\nBcc: evil@example.com", body: "b" }),
    ).rejects.toThrow(/header injection/);
    expect(calls).toHaveLength(0);
  });

  it("fails closed on a CRLF-injected recipient (header injection) — throws, no fetch", async () => {
    const { fetchImpl, calls } = makeStubFetch(() => jsonResponse(200, OK_DRAFT));
    const client = new GoogleGmailDraftClient({ getAccessToken: () => "t", fetchImpl });

    await expect(
      client.createDraft({ to: "a@b.com\r\nBcc: evil@example.com", subject: "s", body: "b" }),
    ).rejects.toThrow(/header injection/);
    expect(calls).toHaveLength(0);
  });

  it("fails closed on an empty token — throws and never calls fetch", async () => {
    const { fetchImpl, calls } = makeStubFetch(() => jsonResponse(200, OK_DRAFT));
    const client = new GoogleGmailDraftClient({ getAccessToken: () => "", fetchImpl });

    await expect(client.createDraft({ to: "a@b.com", subject: "s", body: "b" })).rejects.toThrow(
      /empty token/,
    );
    expect(calls).toHaveLength(0); // no request attempted without a token
  });

  it("fails closed on a non-2xx response — throws with status + detail, returns no id", async () => {
    const { fetchImpl } = makeStubFetch(
      () => new Response('{"error":{"message":"insufficient scope"}}', { status: 403 }),
    );
    const client = new GoogleGmailDraftClient({ getAccessToken: () => "t", fetchImpl });

    await expect(client.createDraft({ to: "a@b.com", subject: "s", body: "b" })).rejects.toThrow(
      /Gmail draft creation failed: 403.*insufficient scope/s,
    );
  });

  it("fails closed on a 2xx with no draft id — never fabricates one", async () => {
    const { fetchImpl } = makeStubFetch(() => jsonResponse(200, { message: { id: "m-1" } }));
    const client = new GoogleGmailDraftClient({ getAccessToken: () => "t", fetchImpl });

    await expect(client.createDraft({ to: "a@b.com", subject: "s", body: "b" })).rejects.toThrow(
      /no draft id/,
    );
  });

  it("awaits an async token provider", async () => {
    const { fetchImpl, calls } = makeStubFetch(() => jsonResponse(200, OK_DRAFT));
    const client = new GoogleGmailDraftClient({
      getAccessToken: async () => Promise.resolve("async-token"),
      fetchImpl,
    });

    await client.createDraft({ to: "a@b.com", subject: "s", body: "b" });
    expect(calls[0]!.headers.Authorization).toBe("Bearer async-token");
  });
});
