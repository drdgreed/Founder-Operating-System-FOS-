import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, index, check } from "drizzle-orm/pg-core";
import { fosWorkspace } from "./fos_workspace.js";
import { enrollmentOpportunity } from "./enrollment_opportunity.js";
import { agentRun } from "./agent_run.js";
import { artifactRecord } from "./artifact_record.js";

/**
 * EnrollmentActionRecommendation (spec §6.6, issue #70 P1.4a) — an
 * agent-or-founder-authored recommended next action on an enrollment
 * opportunity. Schema + service only in this slice; no agent/API wiring
 * (that's later P1.4 sub-slices).
 *
 * - `workspace_id` FK NOT NULL direct-scopes reads for authz (mirrors
 *   `objection_record.workspace_id` / `interaction.workspace_id`) even
 *   though `opportunity_id` alone would also resolve a workspace
 *   transitively — same direct-scoping convention used throughout this
 *   domain. FLAG.
 * - `opportunity_id` FK NOT NULL -> enrollment_opportunity (spec §6.6).
 * - `agent_run_id` FK NULLABLE -> agent_run: mirrors
 *   `enrollment_assessment.agent_run_id` — a recommendation can be
 *   seeded/tested without a real agent run in this slice.
 * - `artifact_record_id` FK NULLABLE -> artifact_record: a recommendation
 *   may or may not carry a recovery artifact (spec §6.6 note in issue #70).
 * - `action_type`, `summary`, `rationale`, `business_impact`, `urgency`,
 *   `confidence`, `outcome`: spec §6.6 gives no enums/types for any of
 *   these. `summary`/`rationale` are free-form narrative text.
 *   `action_type`, `business_impact`, `urgency`, `confidence`, `outcome`
 *   are modeled as open `text` (minimal-defensible-type convention, mirrors
 *   `enrollment_assessment.fit_confidence`) — FLAG, no closed set is
 *   evident in the spec for any of them.
 * - `status`: spec gives no enum, but issue #70 explicitly calls out a
 *   founder decision to mirror `interaction.status` (text+CHECK over
 *   pgEnum) wherever a clear closed set exists. A recommendation lifecycle
 *   IS a clearly-closed set (proposed -> accepted/dismissed/actioned/
 *   expired), so this is DB-enforced via CHECK, defaulted to `'proposed'`.
 *   FLAG (value set is our inference, not spec-given — see PR body).
 * - `recommended_due_at`: nullable timestamptz per spec §6.6.
 * - Mutable lifecycle record (status/outcome change over time, NOT
 *   append-only): `version` integer guards optimistic concurrency (mirrors
 *   `interaction.version` / `objection_record.version`).
 */
export const enrollmentActionRecommendation = pgTable(
  "enrollment_action_recommendation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => fosWorkspace.id),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => enrollmentOpportunity.id),
    agentRunId: uuid("agent_run_id").references(() => agentRun.id),
    // FLAG: no enum in spec — see header note.
    actionType: text("action_type").notNull(),
    summary: text("summary").notNull(),
    rationale: text("rationale"),
    // FLAG: no enum in spec — see header note.
    businessImpact: text("business_impact"),
    // FLAG: no enum in spec — see header note.
    urgency: text("urgency"),
    // FLAG: no enum in spec — see header note.
    confidence: text("confidence"),
    recommendedDueAt: timestamp("recommended_due_at", { withTimezone: true }),
    artifactRecordId: uuid("artifact_record_id").references(() => artifactRecord.id),
    // FLAG: closed set is our inference, DB-enforced via CHECK — see header note.
    status: text("status").notNull().default("proposed"),
    // FLAG: no enum in spec — see header note.
    outcome: text("outcome"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdIdx: index("enrollment_action_recommendation_workspace_id_idx").on(
      table.workspaceId,
    ),
    opportunityIdIdx: index("enrollment_action_recommendation_opportunity_id_idx").on(
      table.opportunityId,
    ),
    agentRunIdIdx: index("enrollment_action_recommendation_agent_run_id_idx").on(table.agentRunId),
    artifactRecordIdIdx: index("enrollment_action_recommendation_artifact_record_id_idx").on(
      table.artifactRecordId,
    ),
    // Founder decision (issue #70, mirrors interaction.ts): DB-enforce the
    // recommendation lifecycle value set via CHECK (over pgEnum) so it
    // evolves transactionally while the vocabulary is young.
    statusValid: check(
      "enrollment_action_recommendation_status_valid",
      sql`${table.status} IN ('proposed', 'accepted', 'dismissed', 'actioned', 'expired')`,
    ),
  }),
);
