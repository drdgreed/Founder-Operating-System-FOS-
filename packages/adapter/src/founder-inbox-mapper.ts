import type { artifactRecord, projectionSyncStatusEnum } from "@fos/db/schema";

export type ArtifactRecordRow = typeof artifactRecord.$inferSelect;
export type ProjectionSyncStatus = (typeof projectionSyncStatusEnum.enumValues)[number];

/**
 * The two founder-action ArtifactRecord states the Founder Inbox projects
 * (spec §7.2 — "decisions and drafts requiring founder action"):
 * - `in_review`        = a draft awaiting founder approval.
 * - `ready_for_action` = approved, awaiting execution.
 * Callers filter to these before projecting.
 */
export type FounderActionStatus = "in_review" | "ready_for_action";

export interface FounderInboxProjectionContext {
  workspaceId: string;
  productId: string | null;
  syncStatus: ProjectionSyncStatus;
  /** The instant this projection write is happening — not the entity's own timestamps. */
  lastSyncedAt: Date;
}

// --- Notion write-helpers (P1.5c) ---
// TODO(DRY): extract shared Notion write-helpers into a shared module
// (rule-of-three; also used by enrollment-opportunity-mapper.ts).
// Duplicated verbatim here (not imported/extracted) to keep this slice's
// changes isolated to NEW files — extracting would edit the already-tested
// enrollment-opportunity-mapper.ts.

/** Notion caps a single rich_text object's `content` at 2000 characters. */
const NOTION_RICH_TEXT_MAX = 2000;
/** Notion also caps a rich_text property's array at 100 objects. */
const NOTION_RICH_TEXT_MAX_OBJECTS = 100;
/** Visible marker appended when content is truncated at the 100-object cap. */
const RICH_TEXT_TRUNCATION_MARKER = " […truncated]";

/**
 * Notion rich_text property. `null` -> `{ rich_text: [] }`. A non-null string is
 * emitted as one text object, EXCEPT content longer than Notion's 2000-char
 * per-object cap, which is split into consecutive <=2000-char objects (Notion
 * concatenates them into one continuous value). Without the split, a single
 * over-long value would make the Notion API reject the ENTIRE page write with a
 * 400 `validation_error`, silently dropping the whole projection.
 *
 * Notion ALSO caps a rich_text property's array at 100 objects; content beyond
 * 100 objects is truncated with a VISIBLE marker (never a silent drop).
 */
function richText(content: string | null) {
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
 * Notion `select` property from a value. `null` OR empty string ->
 * `{ select: null }` (property cleared). Notion rejects a select whose option
 * `name` is empty. (Enum-backed selects are guaranteed non-empty; the guard is
 * harmless there.)
 */
function selectProp(name: string | null) {
  return { select: name === null || name === "" ? null : { name } };
}

/**
 * Notion `number` property. `null` is a VALID value (`{ number: null }` clears
 * the property) — do NOT wrap it in an object. Keeps the mapper pure.
 */
function numberProp(value: number | null) {
  return { number: value };
}

/**
 * Notion `date` property. Per the Notion API, an unset date is `{ date: null }`
 * — NOT `{ date: { start: null } }`, which is rejected. A populated date is
 * serialized ISO-8601 (UTC) so the projection is deterministic from its input.
 */
function dateProp(value: Date | null) {
  return { date: value === null ? null : { start: value.toISOString() } };
}

/**
 * PATCH-SET-01 §C2 "FOS Version" for an UNVERSIONED entity. ArtifactRecord has
 * no `version` column (its lifecycle is carried on artifact_version), so §C2
 * defines its projection version as epoch SECONDS of the record's `updated_at`
 * (`Math.floor(updatedAt.getTime() / 1000)`) — a monotonically non-decreasing,
 * bigint-safe integer that advances on every record write, exactly what the
 * projection's staleness check needs in place of a `.version`.
 */
export function artifactFosVersion(updatedAt: Date): number {
  return Math.floor(updatedAt.getTime() / 1000);
}

/**
 * "Action Needed" — the derived founder cue for each projected state.
 * `in_review` (draft awaiting approval) -> "Review & approve";
 * `ready_for_action` (approved, awaiting execution) -> "Ready to execute".
 */
function actionNeeded(status: FounderActionStatus): string {
  return status === "in_review" ? "Review & approve" : "Ready to execute";
}

/**
 * Pure mapper: an ArtifactRecord in a founder-action state (§7.2 Founder Inbox)
 * -> Notion page-properties object.
 *
 * Emits all 7 PATCH-SET-01 §C1 hidden properties. FOS Version is the §C2
 * epoch-derived value (see `artifactFosVersion`), NOT a `.version` — the record
 * is unversioned. Visible fields surface the founder-action item: Title,
 * Artifact Type, Status, Domain, the derived "Action Needed", and a Canonical
 * Link (the record id until the P1.9 dashboard ships real deep links, mirroring
 * the enrollment-opportunity mapper's convention).
 *
 * TITLE: projected as a `rich_text` "Title" property (not the Notion-native
 * `title` property) to match the enrollment-opportunity mapper's field style
 * and keep the closed-signature mapper database-schema-agnostic. Created pages
 * therefore have an empty Notion-native title (allowed by the API; not broken,
 * just untitled in the UI) — same trade-off the opportunity mapper documents.
 *
 * ENUM SELECTS: Artifact Type, Status, and Domain are closed Postgres enums, so
 * they project as Notion `select` safely (a value outside the option set would
 * be a schema/DB bug, not user input).
 */
export function artifactToFounderInboxProperties(
  artifact: ArtifactRecordRow,
  ctx: FounderInboxProjectionContext,
): Record<string, unknown> {
  return {
    // --- §C1 hidden-property contract (all 7, exact names) ---
    "FOS Record ID": richText(artifact.id),
    "FOS Entity Type": richText("ArtifactRecord"),
    "FOS Workspace ID": richText(ctx.workspaceId),
    "FOS Product ID": richText(ctx.productId),
    "Sync Status": { select: { name: ctx.syncStatus } },
    // §C2: UNVERSIONED entity -> FOS Version = epoch seconds of updated_at.
    "FOS Version": numberProp(artifactFosVersion(artifact.updatedAt)),
    "Last Synced At": dateProp(ctx.lastSyncedAt),

    // --- §7.2 visible Founder Inbox fields ---
    Title: richText(artifact.title),
    "Artifact Type": selectProp(artifact.artifactType),
    Status: selectProp(artifact.status),
    Domain: selectProp(artifact.domain),
    // Derived founder cue for the two projected states.
    "Action Needed": selectProp(actionNeeded(artifact.status as FounderActionStatus)),
    // Canonical link (record id until the P1.9 dashboard ships deep links).
    "Canonical Link": richText(artifact.id),
  };
}

/**
 * §8.2/§11.3 ProjectionPolicy for the Founder Inbox fields. Every field is
 * `canonical_read_only`: P1.5c writes FOS->Notion only (no Notion edit flows
 * back here — that is the reconciliation/command-intake slices). Lists the
 * ArtifactRecord's OWN columns that this projection reads.
 */
export const founderInboxProjectionPolicy = {
  entity_type: "ArtifactRecord",
  provider: "notion",
  fields: {
    id: "canonical_read_only",
    title: "canonical_read_only",
    artifactType: "canonical_read_only",
    status: "canonical_read_only",
    domain: "canonical_read_only",
    updatedAt: "canonical_read_only",
  },
  redaction_rules: [],
  maximum_sensitivity: "internal",
  requires_founder_approval: false,
} as const;
