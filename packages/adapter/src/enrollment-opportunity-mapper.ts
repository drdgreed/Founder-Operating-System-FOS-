import type { enrollmentOpportunity, projectionSyncStatusEnum } from "@fos/db/schema";

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

/**
 * Minimal §8.2/§11.3 ProjectionPolicy for the fields this slice projects.
 * `Stage` is marked `canonical_read_only`: this slice writes it FOS->Notion
 * only; nothing here lets a Notion edit flow back (that's the reconciliation
 * + command-intake slices, 0.2c/0.2d).
 */
export const enrollmentOpportunityProjectionPolicy = {
  entity_type: "EnrollmentOpportunity",
  provider: "notion",
  fields: {
    id: "canonical_read_only",
    version: "canonical_read_only",
    stage: "canonical_read_only",
  },
  redaction_rules: [],
  maximum_sensitivity: "internal",
  requires_founder_approval: false,
} as const;
