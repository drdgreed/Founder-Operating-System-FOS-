import type { enrollmentOpportunity, projectionSyncStatusEnum } from "@fos/db/schema";

export type EnrollmentOpportunityRow = typeof enrollmentOpportunity.$inferSelect;
export type ProjectionSyncStatus = (typeof projectionSyncStatusEnum.enumValues)[number];

export interface EnrollmentOpportunityProjectionContext {
  workspaceId: string;
  productId: string | null;
  syncStatus: ProjectionSyncStatus;
  /** The instant this projection write is happening — not the entity's own timestamps. */
  lastSyncedAt: Date;
  /**
   * P1.5b join-backed §7.2 field: the opportunity's OPEN objections
   * (`objection_record` WHERE resolution_status='open'), ordered deterministically
   * by the CALLER. Read-only projection of a RELATED entity — the mapper stays
   * PURE, it does not query. Absent/undefined -> project as zero/empty
   * (backward-compatible with P1.5a callers that never set it).
   */
  openObjections?: Array<{
    category: string;
    classification: string;
    statement: string;
    severity: string | null;
  }>;
  /**
   * P1.5b join-backed §7.2 field: the most-recent artifact awaiting approval
   * (`artifact_record.status='in_review'`) reached via
   * `enrollment_action_recommendation`, resolved + deduplicated by the CALLER.
   * `null`/absent -> project empty.
   */
  pendingArtifact?: { id: string; title: string; artifactType: string } | null;
  /**
   * Total DISTINCT in_review artifacts for this opportunity. Feeds the ">1"
   * indicator on "Pending Artifact"; `pendingArtifact` is the first of them.
   * Absent -> treated as 0 (or 1 when `pendingArtifact` is present).
   */
  pendingArtifactCount?: number;
}

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
 * Notion `select` property from a FREE-TEXT value. `null` OR empty string ->
 * `{ select: null }` (property cleared). Notion rejects a select whose option
 * `name` is empty, and an empty-string `currency` still satisfies the column's
 * NOT NULL, so it must not become `{ select: { name: "" } }`. (Enum-backed
 * selects like `Stage`/`Sync Status` are guaranteed non-empty and do not need
 * this guard.)
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
 * Value in major currency units (cents / 100) as a Notion `number`. See the
 * cents-vs-major-unit decision in the mapper doc-comment below. `null` stays
 * `{ number: null }` (property cleared).
 */
function majorUnitProp(cents: number | null) {
  return { number: cents === null ? null : cents / 100 };
}

/**
 * P1.5b: deterministic, human-readable summary of the open objections — one
 * line each, `"[<classification>/<category>, <severity>] <statement>"` (the
 * `, <severity>` segment is omitted when severity is null). Severity ranks a
 * founder's urgency, so it IS rendered (not dropped). Returns `null` (-> empty
 * rich_text) when there are none, so callers pass it straight to `richText`,
 * whose chunking already protects an over-long `statement`. Order is the
 * caller's (deterministic) query order — this helper does not sort.
 */
function renderObjectionsSummary(
  objections: EnrollmentOpportunityProjectionContext["openObjections"],
): string | null {
  if (!objections || objections.length === 0) return null;
  return objections
    .map((o) => {
      const tag = o.severity
        ? `${o.classification}/${o.category}, ${o.severity}`
        : `${o.classification}/${o.category}`;
      return `[${tag}] ${o.statement}`;
    })
    .join("\n");
}

/**
 * P1.5b: label for the pending (in_review) artifact — `"<title> [<type>]"`,
 * plus a `" (+N more awaiting approval)"` suffix when more than one distinct
 * artifact is awaiting approval. `null` (-> empty rich_text) when there is none.
 */
function renderPendingArtifact(
  pending: EnrollmentOpportunityProjectionContext["pendingArtifact"],
  totalCount: number,
): string | null {
  if (!pending) return null;
  const label = `${pending.title} [${pending.artifactType}]`;
  return totalCount > 1 ? `${label} (+${totalCount - 1} more awaiting approval)` : label;
}

/**
 * Pure mapper: EnrollmentOpportunity (§9.4) -> Notion page-properties object.
 *
 * Emits all 7 PATCH-SET-01 §C1 hidden properties (FOS Version per §C2: for a
 * versioned entity, `FOS Version = entity.version`) plus the visible §7.2
 * Enrollment Pipeline fields sourced from the opportunity row's OWN columns
 * (P1.5a, issue #86): summary, stage, fit, value, last interaction, next
 * action, and the canonical link. The two join-requiring §7.2 fields —
 * open `objections` and the `pending artifact` — are added in P1.5b (issue
 * #88): the mapper STAYS PURE, so the CALLER runs the DB joins and passes the
 * resolved rows in via `ctx.openObjections` / `ctx.pendingArtifact(Count)`.
 * Both ctx fields are OPTIONAL — absent -> project as zero/empty, keeping
 * P1.5a callers that never set them working unchanged.
 *
 * VALUE UNITS: `estimated_value_cents` / `actual_value_cents` are stored as
 * integer cents but projected as MAJOR CURRENCY UNITS (cents / 100) under the
 * "Estimated Value" / "Actual Value" properties — a founder reads a pipeline
 * in dollars, not cents. The unit's currency is surfaced by the adjacent
 * "Currency" property (`enrollment_opportunity.currency`, non-null, default
 * USD), so the value + currency pair is unambiguous without hard-coding a
 * currency into the property name.
 *
 * CANONICAL LINK: "Canonical Link" surfaces the FOS record id. A real
 * deep-link URL awaits the P1.9 dashboard; until then the record id IS the
 * canonical reference (and mirrors the hidden "FOS Record ID" for humans).
 *
 * NULL HANDLING: most §7.2 columns are nullable. `richText(null)` yields an
 * empty array; `numberProp(null)` -> `{ number: null }`; `dateProp(null)` ->
 * `{ date: null }`. `fit_status`, `next_action_type`, `last_touch_source`,
 * and `recommended_pathway` are OPEN TEXT per the schema comments (no spec
 * enum), so they project as rich_text, never as an invented `select`.
 *
 * No title-type property is set: §13.2's Enrollment Pipeline template implies
 * a person-name title column, but that requires a Person join this slice's
 * minimal mapper signature (opp + workspace/product ids) does not have. FLAG
 * (PATCH-SET candidate): add a title-bearing field once a Person-joined
 * projection exists — until then, created pages have an empty Notion-native
 * title (allowed by the API; not a broken page, just untitled in the UI).
 */
export function enrollmentOpportunityToNotionProperties(
  opp: EnrollmentOpportunityRow,
  ctx: EnrollmentOpportunityProjectionContext,
): Record<string, unknown> {
  return {
    // --- §C1 hidden-property contract (all 7, exact names) ---
    "FOS Record ID": richText(opp.id),
    "FOS Entity Type": richText("EnrollmentOpportunity"),
    "FOS Workspace ID": richText(ctx.workspaceId),
    "FOS Product ID": richText(ctx.productId),
    "Sync Status": { select: { name: ctx.syncStatus } },
    // §C2: versioned entity -> FOS Version = entity.version.
    "FOS Version": { number: opp.version },
    "Last Synced At": { date: { start: ctx.lastSyncedAt.toISOString() } },

    // --- §7.2 visible fields (P1.5a; opportunity-owned columns only) ---
    Stage: { select: { name: opp.stage } },

    // Summary
    Summary: richText(opp.fitSummary),
    "Primary Goal": richText(opp.primaryGoal),
    "Target Role": richText(opp.targetRole),
    "Target Timeline": richText(opp.targetTimeline),

    // Fit
    "Fit Status": richText(opp.fitStatus),
    "Fit Score": numberProp(opp.fitScore),

    // Value (major units; see doc-comment)
    "Estimated Value": majorUnitProp(opp.estimatedValueCents),
    "Actual Value": majorUnitProp(opp.actualValueCents),
    Currency: selectProp(opp.currency),

    // Last interaction
    "Last Interaction At": dateProp(opp.lastInteractionAt),
    "Last Touch Source": richText(opp.lastTouchSource),

    // Next action
    "Next Action": richText(opp.nextActionSummary),
    "Next Action Type": richText(opp.nextActionType),
    "Next Action Due At": dateProp(opp.nextActionDueAt),
    "Recommended Pathway": richText(opp.recommendedPathway),

    // Canonical link (record id until the P1.9 dashboard ships deep links)
    "Canonical Link": richText(opp.id),

    // --- §7.2 join-backed fields (P1.5b, issue #88) ---
    // Read-only projections of RELATED entities (objection_record /
    // artifact_record via enrollment_action_recommendation), NOT the
    // opportunity's own columns — the CALLER supplies them via ctx. Absent ctx
    // fields degrade to zero/empty (backward-compatible with P1.5a callers).

    // Count of open objections (0 when none/absent).
    "Open Objections": numberProp(ctx.openObjections?.length ?? 0),
    // Human-readable rendering of the open objections; empty when none.
    Objections: richText(renderObjectionsSummary(ctx.openObjections)),
    // The most-recent in_review artifact (+ "+N more" when >1); empty when none.
    "Pending Artifact": richText(
      renderPendingArtifact(
        ctx.pendingArtifact,
        ctx.pendingArtifactCount ?? (ctx.pendingArtifact ? 1 : 0),
      ),
    ),
    // Canonical link to the pending artifact (its record id); empty when none.
    "Pending Artifact Link": richText(ctx.pendingArtifact?.id ?? null),
  };
}

/**
 * §8.2/§11.3 ProjectionPolicy for the fields this slice projects. Every field
 * is `canonical_read_only`: P1.5a writes FOS->Notion only; nothing here lets a
 * Notion edit flow back (that's the reconciliation + command-intake slices,
 * 0.2c/0.2d). The P1.5a §7.2 columns are listed alongside the pre-existing
 * id/version/stage entries. The P1.5b join fields (open objections, pending
 * artifact) are INTENTIONALLY still absent here: this policy lists
 * EnrollmentOpportunity's OWN columns, and those two are read-only projections
 * of RELATED entities (objection_record / artifact_record), not opp columns —
 * so they do not belong in this field-level policy map.
 */
export const enrollmentOpportunityProjectionPolicy = {
  entity_type: "EnrollmentOpportunity",
  provider: "notion",
  fields: {
    id: "canonical_read_only",
    version: "canonical_read_only",
    stage: "canonical_read_only",
    fitSummary: "canonical_read_only",
    primaryGoal: "canonical_read_only",
    targetRole: "canonical_read_only",
    targetTimeline: "canonical_read_only",
    fitStatus: "canonical_read_only",
    fitScore: "canonical_read_only",
    estimatedValueCents: "canonical_read_only",
    actualValueCents: "canonical_read_only",
    currency: "canonical_read_only",
    lastInteractionAt: "canonical_read_only",
    lastTouchSource: "canonical_read_only",
    nextActionSummary: "canonical_read_only",
    nextActionType: "canonical_read_only",
    nextActionDueAt: "canonical_read_only",
    recommendedPathway: "canonical_read_only",
  },
  redaction_rules: [],
  maximum_sensitivity: "internal",
  requires_founder_approval: false,
} as const;
