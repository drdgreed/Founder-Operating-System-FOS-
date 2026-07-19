/**
 * Reads for Notion page-property VALUES (issue #30, slice 0.2c) — the
 * inverse of the `richText()` / literal-object WRITE helpers in
 * `enrollment-opportunity-mapper.ts`. Each reader is defensive: a
 * malformed or absent property returns `null` rather than throwing, so one
 * unexpected page shape from a live workspace can never crash a
 * reconciliation pass (issue #29 item 4 — "malformed property objects...
 * only fail against real Notion").
 */

export function readRichTextProperty(prop: unknown): string | null {
  if (!prop || typeof prop !== "object") return null;
  const richText = (prop as { rich_text?: unknown }).rich_text;
  if (!Array.isArray(richText) || richText.length === 0) return null;
  const first: unknown = richText[0];
  if (!first || typeof first !== "object") return null;
  const plainText = (first as { plain_text?: unknown }).plain_text;
  if (typeof plainText === "string") return plainText;
  const text = (first as { text?: { content?: unknown } }).text;
  if (text && typeof text.content === "string") return text.content;
  return null;
}

export function readNumberProperty(prop: unknown): number | null {
  if (!prop || typeof prop !== "object") return null;
  const value = (prop as { number?: unknown }).number;
  return typeof value === "number" ? value : null;
}

export function readSelectProperty(prop: unknown): string | null {
  if (!prop || typeof prop !== "object") return null;
  const select = (prop as { select?: unknown }).select;
  if (!select || typeof select !== "object") return null;
  const name = (select as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}
