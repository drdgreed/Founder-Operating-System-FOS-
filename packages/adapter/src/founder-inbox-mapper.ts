import type { artifactRecord, projectionSyncStatusEnum } from "@fos/db/schema";
import { richText, selectProp, numberProp, dateProp } from "./notion-write-properties.js";

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

/**
 * PATCH-SET-01 §C2 "FOS Version" for an UNVERSIONED entity. ArtifactRecord has
 * no `version` column (its lifecycle is carried on artifact_version), so §C2
 * defines its projection version as epoch SECONDS of the record's `updated_at`
 * (`Math.floor(updatedAt.getTime() / 1000)`) — a monotonically non-decreasing,
 * bigint-safe integer in place of a `.version`.
 *
 * RESOLUTION IS ONE SECOND: two writes within the same wall-clock second
 * collapse to the same version. Harmless today — no consumer reads it yet
 * (`reconcile.ts` is wired only for EnrollmentOpportunity, not ArtifactRecord).
 * The reconcile-extension slice that adds ArtifactRecord staleness checks MUST
 * account for this (or move the epoch to milliseconds then). Throws on an
 * invalid `updated_at` rather than emitting a NaN that would silently serialize
 * to `{ number: null }` and clear the staleness key.
 */
export function artifactFosVersion(updatedAt: Date): number {
  const epochSeconds = Math.floor(updatedAt.getTime() / 1000);
  if (!Number.isFinite(epochSeconds)) {
    throw new Error("artifactFosVersion: updatedAt is not a valid Date");
  }
  return epochSeconds;
}

/**
 * "Action Needed" — the derived founder cue for each projected state.
 * `in_review` (draft awaiting approval) -> "Review & approve";
 * `ready_for_action` (approved, awaiting execution) -> "Ready to execute".
 *
 * TOTAL over the founder-action states and FAILS LOUD otherwise: a status
 * outside the two-state contract (e.g. `draft`/`rejected`/`executed`) must NOT
 * silently fall through to a wrong cue like "Ready to execute" on a rejected
 * artifact. This runs while building `properties`, BEFORE any Notion write, so
 * the throw prevents a mislabeled page instead of writing one — the single
 * choke point enforcing "callers filter to founder-action states first".
 */
function actionNeeded(status: ArtifactRecordRow["status"]): string {
  switch (status) {
    case "in_review":
      return "Review & approve";
    case "ready_for_action":
      return "Ready to execute";
    default:
      throw new Error(
        `artifactToFounderInboxProperties: status "${status}" is not a founder-action state ` +
          `(expected "in_review" | "ready_for_action") — callers must filter before projecting`,
      );
  }
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
    // Derived founder cue; throws on an out-of-contract status (no silent mislabel).
    "Action Needed": selectProp(actionNeeded(artifact.status)),
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
