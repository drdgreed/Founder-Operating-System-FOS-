import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The webhook `verification_token` is a SECRET (ADR-06 Finding 2), handled
 * with the SAME credential-reference pattern as `NotionClient.getToken`
 * (`client.ts`): a `process.env` key name is passed around, never the
 * value, and the value is resolved at call time (so rotation/tests don't
 * need a restart). The error intentionally names only the REFERENCE, never
 * the token value.
 */
export class WebhookTokenUnconfiguredError extends Error {
  constructor(credentialReference: string) {
    super(`Notion webhook credential reference "${credentialReference}" is not set`);
    this.name = "WebhookTokenUnconfiguredError";
  }
}

/** Resolves the webhook `verification_token` from its credential reference
 * (env var name). Defaults to `FOS_NOTION_WEBHOOK_SECRET` (see .env.example). */
export function resolveWebhookVerificationToken(
  credentialReference = "FOS_NOTION_WEBHOOK_SECRET",
): string {
  const token = process.env[credentialReference];
  if (!token) {
    throw new WebhookTokenUnconfiguredError(credentialReference);
  }
  return token;
}

/**
 * Verifies a Notion webhook delivery's `X-Notion-Signature` header (ADR-06
 * Finding 2): `HMAC-SHA256(rawBody, verificationToken)`, hex-encoded,
 * constant-time compared.
 *
 * SECURITY-CRITICAL contract:
 * - Never throws — a missing header, malformed hex, or wrong-length digest
 *   all just return `false`. The caller is responsible for mapping `false`
 *   to a 401 without distinguishing WHY it failed (no oracle).
 * - The comparison is length-checked before `timingSafeEqual` (which itself
 *   throws on mismatched-length buffers) and always compares against a
 *   digest of FIXED length (32 bytes for SHA-256) that never depends on
 *   attacker input, so the length check leaks nothing.
 * - The HMAC is computed and `timingSafeEqual` is run UNCONDITIONALLY, even
 *   when the header is entirely absent (issue #41 NIT) — a missing header no
 *   longer short-circuits before that work, which equalizes its timing
 *   profile against a present-but-wrong header (both do a full compute +
 *   compare). This closes a minor timing side-channel that revealed only
 *   attacker-controlled header presence, never any part of the secret.
 * - Never logs the token, the provided signature, or the computed digest —
 *   callers must not either.
 */
export function verifyNotionWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  verificationToken: string,
): boolean {
  const headerValue = signatureHeader ?? "";

  // Notion's documented header carries a `sha256=` prefix; tolerate a bare
  // hex digest too.
  const provided = headerValue.startsWith("sha256=")
    ? headerValue.slice("sha256=".length)
    : headerValue;

  // Buffer.from(_, "hex") never throws — invalid hex just truncates the
  // decoded buffer, which then fails the length check below.
  const providedBuf = Buffer.from(provided, "hex");
  const expectedBuf = createHmac("sha256", verificationToken).update(rawBody).digest();
  const lengthMatches = providedBuf.length === expectedBuf.length;

  // Always compare a FIXED-length buffer (a zeroed stand-in when the length
  // doesn't match, incl. when the header was absent entirely) so every path
  // — missing, malformed, wrong-length, or a present-but-wrong same-length
  // digest — runs through the identical timingSafeEqual call.
  const comparableProvided = lengthMatches ? providedBuf : Buffer.alloc(expectedBuf.length);
  const isEqual = timingSafeEqual(comparableProvided, expectedBuf);

  return lengthMatches && isEqual;
}
