import type { GmailDraftClient, GmailDraftInput, GmailDraftResult } from "./gmail-draft-client.js";

/** Injected fetch-like function — tests supply a stub, no real network. */
export type GmailFetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_BASE_URL = "https://gmail.googleapis.com";
/** Gmail REST: create a draft for the authenticated user. */
const DRAFTS_PATH = "/gmail/v1/users/me/drafts";

export interface GoogleGmailDraftClientOptions {
  /**
   * Supplies a CURRENT OAuth2 access token. This is a PROVIDER, not a stored
   * secret: token acquisition and refresh live in the caller's OAuth flow
   * (ADR-04 — FOS references the credential, it never persists a long-lived
   * secret here). Called once per request so an expired token can be refreshed
   * transparently by the provider.
   */
  getAccessToken: () => string | Promise<string>;
  /** Injected fetch — tests supply a stub, no real network. Defaults to global `fetch`. */
  fetchImpl?: GmailFetchLike;
  /** Override the API host (tests point this at nothing; the stub ignores it). */
  baseUrl?: string;
}

/**
 * The live `GmailDraftClient` — creates a real Gmail DRAFT via the Gmail REST
 * API (`POST /gmail/v1/users/me/drafts`). It creates a DRAFT only; it NEVER
 * sends mail, and it never acquires or stores a credential — the access token
 * arrives through the injected `getAccessToken` provider (the OAuth handshake is
 * the caller's concern). Fails closed: any non-2xx response, an empty token, or
 * a response missing a draft id throws rather than returning a fabricated id, so
 * a founder-approved draft is never silently recorded as created when it wasn't.
 *
 * This is the implementation the deferred activation slice wires in place of
 * `NotImplementedGmailDraftClient`. Its request/response contract is pinned by
 * `google-gmail-draft-client.test.ts` against a stubbed fetch (no network, no
 * credential); the live OAuth handshake itself is validated out-of-band by a
 * credentialed run the operator performs.
 */
export class GoogleGmailDraftClient implements GmailDraftClient {
  private readonly getAccessToken: () => string | Promise<string>;
  private readonly fetchImpl: GmailFetchLike;
  private readonly baseUrl: string;

  constructor(options: GoogleGmailDraftClientOptions) {
    this.getAccessToken = options.getAccessToken;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  }

  async createDraft(input: GmailDraftInput): Promise<GmailDraftResult> {
    // Build the RFC 5322 message FIRST (pure, no I/O), then fetch the token as
    // late as possible so a provider refresh is as fresh as it can be.
    const raw = encodeRawMessage(input);

    const token = await this.getAccessToken();
    if (!token || token.trim().length === 0) {
      // Fail closed: without a real token we cannot create the draft, and we
      // must never proceed with an empty/blank Bearer header.
      throw new Error("GoogleGmailDraftClient: getAccessToken returned an empty token");
    }

    const response = await this.fetchImpl(`${this.baseUrl}${DRAFTS_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: { raw } }),
    });

    if (!response.ok) {
      // Surface the provider's error detail for diagnostics, but fail closed —
      // never fabricate a draft id from a failed call.
      const detail = await safeReadBody(response);
      throw new Error(
        `Gmail draft creation failed: ${response.status} ${response.statusText}` +
          (detail ? ` — ${detail}` : ""),
      );
    }

    const body = (await response.json()) as { id?: unknown };
    if (typeof body.id !== "string" || body.id.length === 0) {
      // A 2xx with no usable draft id is still a failure — do not record a
      // success we can't point at.
      throw new Error("Gmail draft creation succeeded but returned no draft id");
    }
    return { draftId: body.id };
  }
}

/** Reads an error response body for diagnostics; never throws. */
async function safeReadBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "";
  }
}

/**
 * Builds a base64url-encoded RFC 5322 message for the Gmail `raw` field. The
 * body is base64-transfer-encoded (RFC 2045) so an 8-bit UTF-8 body is
 * strictly conformant rather than relying on the `7bit` default; a non-ASCII
 * subject is RFC 2047 encoded-word encoded so header parsers see valid ASCII.
 * Header values are rejected if they contain a raw line break (header-injection
 * defense — see `assertNoCrlf`).
 */
function encodeRawMessage(input: GmailDraftInput): string {
  const headers = [
    `To: ${assertNoCrlf(input.to, "to")}`,
    `Subject: ${encodeSubject(input.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const body = foldBase64(Buffer.from(input.body, "utf8").toString("base64"));
  const message = `${headers.join("\r\n")}\r\n\r\n${body}`;
  return Buffer.from(message, "utf8").toString("base64url");
}

/**
 * Header-injection defense: a raw CR or LF in a header value would let crafted
 * input (a tampered/adversarial recipient or subject) smuggle extra headers
 * (e.g. a hidden `Bcc:`) into a founder-approved draft. CR/LF are ASCII, so the
 * encoded-word path below does NOT neutralize them — reject fail-closed instead
 * of silently stripping, so malformed input never yields a subtly different
 * draft than what was approved.
 */
function assertNoCrlf(value: string, field: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `GoogleGmailDraftClient: ${field} header contains a line break (possible header injection) — refusing to build the draft`,
    );
  }
  return value;
}

/**
 * RFC 2047 encoded-word for a subject that contains non-ASCII (an accented name
 * or emoji). ASCII-only subjects pass through unchanged so the common case
 * stays human-readable. Rejects a raw line break first (see `assertNoCrlf`).
 */
function encodeSubject(subject: string): string {
  assertNoCrlf(subject, "subject");
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(subject)) {
    return subject;
  }
  const encoded = Buffer.from(subject, "utf8").toString("base64");
  return `=?UTF-8?B?${encoded}?=`;
}

/** Folds a base64 string into <=76-char CRLF-separated lines (RFC 2045). */
function foldBase64(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return lines.join("\r\n");
}
