import { pgTable, uuid, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { fosWorkspace } from "./fos_workspace.js";
import { artifactVersion } from "./artifact_version.js";

/**
 * Approval (spec §9.14) — the human-gate decision recorded on an
 * ArtifactVersion. Amended by PATCH-SET-01:
 * - §E2: an Approval records a DECISION on a specific version; the version's
 *   `approval_status` takes the decided value (decision → lifecycle map lives
 *   in the approval service).
 * - §S2: `risk_level` is low | medium | high.
 *
 * Decision-only scope ratified by PATCH-SET-03 §C:
 * - `decided_by` / `decided_at` are NOT NULL — this slice records only DECIDED
 *   approvals (no `pending` rows). The later approval-request slice (§14.6/
 *   §15.7 "request approval", `pending` state) is the disclosed forward
 *   migration that relaxes these to nullable.
 * - The §9.14 polymorphic target (`target_entity_type` / `target_entity_id` /
 *   `target_version_id`) is collapsed to a single typed FK `artifact_version_id`
 *   — approvals in this slice are always on an ArtifactVersion; the same forward
 *   migration generalizes the target.
 * - The `approval_status` enum carries the full §9.14 set, but the service
 *   writes only the 4 in_review-reachable decisions (approved,
 *   approved_with_edits, rejected, deferred). `superseded` is EXCLUDED as a
 *   decidable outcome because `in_review → superseded` is not a legal §12.2
 *   edge; `pending`/`expired` are unused this slice.
 *
 * Deferred §9.14 fields (`approval_type`, `requested_by_type/_id`, `summary`,
 * `requested_at`, `original_snapshot_json`, `final_snapshot_json`) land with the
 * slices that populate them.
 */

// Full §9.14 approval-state set. The service writes only the decision subset
// {approved, approved_with_edits, rejected, deferred} (PATCH-SET-03 §C).
export const approvalStatusEnum = pgEnum("approval_status", [
  "pending",
  "approved",
  "approved_with_edits",
  "rejected",
  "deferred",
  "expired",
  "superseded",
]);

// PATCH-SET-01 §S2.
export const approvalRiskLevelEnum = pgEnum("approval_risk_level", ["low", "medium", "high"]);

export const approval = pgTable("approval", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => fosWorkspace.id),
  // §9.14 target collapsed to a typed FK (approvals here are on ArtifactVersions).
  artifactVersionId: uuid("artifact_version_id")
    .notNull()
    .references(() => artifactVersion.id),
  // The decided value (§9.14 `status`). NOT NULL: this slice only records
  // decided approvals (no `pending` rows are created here).
  status: approvalStatusEnum("status").notNull(),
  riskLevel: approvalRiskLevelEnum("risk_level").notNull(),
  // §9.14 `decided_by`: opaque actor reference (no auth FK — no auth system in
  // Phase 0 yet). NOT NULL because a recorded decision always has a decider.
  decidedBy: text("decided_by").notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  // §9.14 `decision_reason` (surfaced as `reason` per the slice build).
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
