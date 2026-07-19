import type { enrollmentOpportunity, projectionSyncStatusEnum } from "@fos/db/schema";
import { readRichTextProperty, readSelectProperty } from "./notion-properties.js";

export type EnrollmentOpportunityRow = typeof enrollmentOpportunity.$inferSelect;
export type ProjectionSyncStatus = (typeof projectionSyncStatusEnum.enumValues)[number];

export interface EnrollmentOpportunityProjectionContext {
  workspaceId: string;
  productId: string | null;
  syncStatus: ProjectionSyncStatus;
  /** The instant this projection write is happening — not the entity's own timestamps. */
  lastSyncedAt: Date;
}

function richText(content: string | null) {
  return { rich_text: content === null ? [] : [{ text: { content } }] };
}

/**
 * Pure mapper: EnrollmentOpportunity (§9.4) -> Notion page-properties object.
 *
 * Emits all 7 PATCH-SET-01 §C1 hidden properties (FOS Version per §C2: for a
 * versioned entity, `FOS Version = entity.version`) plus one visible field,
 * `Stage` (§13.2 "Stage is a controlled command field" — this slice only
 * projects it read-only; command intake that would let Notion drive Stage is
 * 0.2d). No title-type property is set: §13.2's Enrollment Pipeline template
 * implies a person-name title column, but that requires a Person join this
 * slice's minimal mapper signature (opp + workspace/product ids) does not
 * have. FLAG (PATCH-SET candidate): add a title-bearing field once a
 * Person-joined projection exists — until then, created pages have an empty
 * Notion-native title (allowed by the API; not a broken page, just untitled
 * in the Notion UI).
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

    // --- visible fields (minimal per issue #27; full §13.2 property set +
    // §8.2/§11.3 policy enforcement is deferred to a later slice) ---
    Stage: { select: { name: opp.stage } },
  };
}

export type FieldOwnership = "canonical_read_only" | "working_copy_editable";

/**
 * Reconciliation field table (issue #30, slice 0.2c) — for each canonical
 * EnrollmentOpportunity field that reconcile() diffs against its Notion
 * page: which visible property carries it, how to parse that property's
 * value back off the page, how to read the current canonical value, and
 * its §8.1 ownership class (which decides command-vs-conflict per §8.3).
 *
 * FLAG (PATCH-SET candidate — founder-editable field set underspecified):
 * 0.2b's mapper only ever WRITES `Stage` (marked `canonical_read_only`
 * there, per spec §8.1's own "Opportunity stage" example) — no
 * `working_copy_editable` EnrollmentOpportunity property exists yet in the
 * outbound projection. Spec §8.1's `working_copy_editable` examples
 * ("Founder annotations", "research notes", "open questions") are
 * artifact-shaped, not enumerated for EnrollmentOpportunity specifically.
 * `next_action_summary` is the closest existing canonical field to that
 * archetype (a founder's free-text working note on the opportunity), so
 * this slice adopts it as the minimal defensible founder-editable field to
 * make the reconcile command path real rather than untestable. This is a
 * genuine business-fact choice, not a mechanical default — it needs a
 * founder/product sign-off pass into a real ProjectionPolicy record
 * (§11.3) and, if kept, a corresponding outbound-mapper change so Notion
 * actually surfaces "Next Action Summary" as an editable property.
 */
export const enrollmentOpportunityReconcilableFields = {
  stage: {
    propertyName: "Stage",
    ownership: "canonical_read_only" as FieldOwnership,
    readValue: readSelectProperty,
    canonicalValue: (opp: EnrollmentOpportunityRow): string | null => opp.stage,
  },
  nextActionSummary: {
    propertyName: "Next Action Summary",
    ownership: "working_copy_editable" as FieldOwnership,
    readValue: readRichTextProperty,
    canonicalValue: (opp: EnrollmentOpportunityRow): string | null => opp.nextActionSummary,
  },
} satisfies Record<
  string,
  {
    propertyName: string;
    ownership: FieldOwnership;
    readValue: (prop: unknown) => string | null;
    canonicalValue: (opp: EnrollmentOpportunityRow) => string | null;
  }
>;

/**
 * Minimal §8.2/§11.3 ProjectionPolicy for the fields this slice projects
 * and/or reconciles. `fields` is derived from
 * `enrollmentOpportunityReconcilableFields` (plus `id`/`version`, which are
 * hidden-property-only — never a visible, reconcilable field) so the two
 * never drift apart.
 */
export const enrollmentOpportunityProjectionPolicy = {
  entity_type: "EnrollmentOpportunity",
  provider: "notion",
  fields: {
    id: "canonical_read_only",
    version: "canonical_read_only",
    ...Object.fromEntries(
      Object.entries(enrollmentOpportunityReconcilableFields).map(([field, def]) => [
        field,
        def.ownership,
      ]),
    ),
  },
  redaction_rules: [],
  maximum_sensitivity: "internal",
  requires_founder_approval: false,
} as const;
