import { createHash } from "node:crypto";

/**
 * Markdown normalization for `content_hash` (PATCH-SET-01 §S3):
 *   "SHA-256(normalized_markdown), normalization = trim trailing whitespace +
 *    LF line endings + single trailing newline."
 *
 * Deterministic steps:
 *   1. LF line endings: CRLF and lone CR both become LF.
 *   2. Trim trailing whitespace: strip trailing spaces/tabs at the end of
 *      every line.
 *   3. Single trailing newline: collapse any run of trailing blank lines and
 *      terminate the document with exactly one LF.
 *
 * Consequence (asserted in tests): inputs differing only by line-ending style
 * or trailing whitespace/newlines hash identically; materially different text
 * hashes differently.
 */
export function normalizeMarkdown(markdown: string): string {
  const lf = markdown.replace(/\r\n?/g, "\n");
  const trimmedPerLine = lf
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
  const withoutTrailingBlank = trimmedPerLine.replace(/\n+$/, "");
  return `${withoutTrailingBlank}\n`;
}

/** `content_hash` = SHA-256 hex digest of the normalized markdown (§S3). */
export function computeContentHash(markdown: string): string {
  return createHash("sha256").update(normalizeMarkdown(markdown)).digest("hex");
}
