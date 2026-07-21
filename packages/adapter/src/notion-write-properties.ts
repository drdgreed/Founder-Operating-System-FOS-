/**
 * Shared Notion page-property WRITE helpers — the counterpart to the defensive
 * READ helpers in `notion-properties.ts` (`readRichTextProperty` etc.). These
 * build the literal property objects the Notion API expects from a projection's
 * source values, and are shared by every FOS->Notion mapper
 * (`enrollment-opportunity-mapper.ts`, `founder-inbox-mapper.ts`, …) so the
 * cap/null-handling logic lives in exactly one place (DRY, rule-of-three).
 */

/** Notion caps a single rich_text object's `content` at 2000 characters. */
export const NOTION_RICH_TEXT_MAX = 2000;
/** Notion also caps a rich_text property's array at 100 objects. */
export const NOTION_RICH_TEXT_MAX_OBJECTS = 100;
/** Visible marker appended when content is truncated at the 100-object cap. */
export const RICH_TEXT_TRUNCATION_MARKER = " […truncated]";

/**
 * Notion rich_text property. `null` -> `{ rich_text: [] }`. A non-null string is
 * emitted as one text object, EXCEPT content longer than Notion's 2000-char
 * per-object cap, which is split into consecutive <=2000-char objects (Notion
 * concatenates them into one continuous value). Without the split, a single
 * over-long value — e.g. an LLM-generated `fit_summary` / `next_action_summary`
 * — would make the Notion API reject the ENTIRE page write with a 400
 * `validation_error`, silently dropping the whole projection. (Splitting on
 * UTF-16 code units can in theory divide a surrogate pair at a chunk boundary;
 * acceptable for the business prose these fields carry.)
 *
 * Notion ALSO caps a rich_text property's array at 100 objects — the "Objections"
 * field concatenates an UNBOUNDED number of open objections, so a very large set
 * could exceed 100 chunks and 400 the page write. Content beyond 100 objects is
 * truncated with a VISIBLE marker (never a silent drop).
 */
export function richText(content: string | null) {
  if (content === null) return { rich_text: [] };
  if (content.length <= NOTION_RICH_TEXT_MAX) return { rich_text: [{ text: { content } }] };
  const parts: { text: { content: string } }[] = [];
  for (let i = 0; i < content.length; i += NOTION_RICH_TEXT_MAX) {
    parts.push({ text: { content: content.slice(i, i + NOTION_RICH_TEXT_MAX) } });
  }
  if (parts.length > NOTION_RICH_TEXT_MAX_OBJECTS) {
    const capped = parts.slice(0, NOTION_RICH_TEXT_MAX_OBJECTS);
    const last = capped[capped.length - 1];
    if (last) {
      last.text.content =
        last.text.content.slice(0, NOTION_RICH_TEXT_MAX - RICH_TEXT_TRUNCATION_MARKER.length) +
        RICH_TEXT_TRUNCATION_MARKER;
    }
    return { rich_text: capped };
  }
  return { rich_text: parts };
}

/**
 * Notion `select` property from a FREE-TEXT value. `null` OR empty string ->
 * `{ select: null }` (property cleared). Notion rejects a select whose option
 * `name` is empty, and an empty-string `currency` still satisfies the column's
 * NOT NULL, so it must not become `{ select: { name: "" } }`. (Enum-backed
 * selects like `Stage`/`Sync Status` are guaranteed non-empty and do not need
 * this guard.)
 */
export function selectProp(name: string | null) {
  return { select: name === null || name === "" ? null : { name } };
}

/**
 * Notion `number` property. `null` is a VALID value (`{ number: null }` clears
 * the property) — do NOT wrap it in an object. Keeps the mapper pure.
 */
export function numberProp(value: number | null) {
  return { number: value };
}

/**
 * Notion `date` property. Per the Notion API, an unset date is `{ date: null }`
 * — NOT `{ date: { start: null } }`, which is rejected. A populated date is
 * serialized ISO-8601 (UTC) so the projection is deterministic from its input.
 */
export function dateProp(value: Date | null) {
  return { date: value === null ? null : { start: value.toISOString() } };
}
