import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { enrollmentOpportunity } from "./enrollment_opportunity.js";
import { agentRun } from "./agent_run.js";

/**
 * EnrollmentAssessment (spec §6.4, issue #48 P1.0) — the Enrollment Brief
 * Agent's (P1.2) versioned output on an opportunity. Schema only in this
 * slice; no writer exists yet.
 *
 * - `opportunity_id` FK NOT NULL (enrollment_opportunity exists in this
 *   slice); `agent_run_id` FK nullable (the agent runtime is P1.1 — a
 *   assessment can be seeded/tested without a real run in this slice).
 * - `*_json` structural containers default to `{}` (mirrors
 *   `artifact_version.claims_manifest_json`); the narrative/scalar fields
 *   (`fit_status`, `fit_rationale`, `recommended_pathway`) are left nullable
 *   since no writer in this slice guarantees they are always populated.
 * - `fit_confidence`: spec §6.4 gives no type ("text or numeric" per the
 *   issue). Modeled as `text` (minimal defensible type, consistent with
 *   `enrollment_opportunity.fit_status` being left as open text rather than
 *   inventing a numeric scale/precision). FLAG — see PR description.
 */
export const enrollmentAssessment = pgTable(
  "enrollment_assessment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => enrollmentOpportunity.id),
    agentRunId: uuid("agent_run_id").references(() => agentRun.id),
    version: integer("version").notNull().default(1),
    observedFactsJson: jsonb("observed_facts_json")
      .notNull()
      .default(sql`'{}'::jsonb`),
    inferencesJson: jsonb("inferences_json")
      .notNull()
      .default(sql`'{}'::jsonb`),
    fitStatus: text("fit_status"),
    // FLAG: type ambiguous in spec §6.4 ("text or numeric") — see header note.
    fitConfidence: text("fit_confidence"),
    fitRationale: text("fit_rationale"),
    recommendedPathway: text("recommended_pathway"),
    unknownsJson: jsonb("unknowns_json")
      .notNull()
      .default(sql`'{}'::jsonb`),
    riskFlagsJson: jsonb("risk_flags_json")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // P1.1 index migration (issue #50, folds in the P1.0 gate NIT).
    opportunityIdIdx: index("enrollment_assessment_opportunity_id_idx").on(table.opportunityId),
    agentRunIdIdx: index("enrollment_assessment_agent_run_id_idx").on(table.agentRunId),
  }),
);
