import { pgTable, uuid, text, timestamp, integer, pgEnum } from "drizzle-orm/pg-core";
import { fosWorkspace } from "./fos_workspace.js";
import { product } from "./product.js";
import { person } from "./person.js";

/**
 * EnrollmentOpportunity (spec §9.4, amended by PATCH-SET-01 §B0/§B1).
 * - §B0: product-scoped — `product_id` NOT NULL FK -> product.
 * - §B1: `offer_code` is REPLACED by `offer_id`. The `Offer` table is a
 *   later slice, so `offer_id` is a nullable uuid column with NO FK yet.
 *   The FK lands with the Offer slice (see PATCH-SET-01 §B1 "Wiring").
 */
export const opportunityStageEnum = pgEnum("opportunity_stage", [
  "new_lead",
  "reviewing",
  "contacted",
  "conversation_scheduled",
  "conversation_completed",
  "offered",
  "enrolled",
  "declined",
  "deferred",
  "unresponsive",
  "disqualified",
]);

export const enrollmentOpportunity = pgTable("enrollment_opportunity", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => fosWorkspace.id),
  // §B0: product-scoped.
  productId: uuid("product_id")
    .notNull()
    .references(() => product.id),
  personId: uuid("person_id")
    .notNull()
    .references(() => person.id),
  // `Program` / `Cohort` tables land with the B1 Offer slice — no FK yet.
  programId: uuid("program_id"),
  cohortId: uuid("cohort_id"),
  // §B1: replaces `offer_code`. `Offer` table + FK land with a later slice.
  offerId: uuid("offer_id"),
  stage: opportunityStageEnum("stage").notNull().default("new_lead"),
  statusReason: text("status_reason"),
  // Spec §9.4 lists `fit_status` with no enum values defined anywhere in the
  // spec or PATCH-SET-01 §S2. Phase 0 does not compute fit scoring (later
  // phase). Left as open nullable text rather than inventing enum values.
  // DEVIATION — see slice report.
  fitStatus: text("fit_status"),
  // Type not specified by spec; modeled as integer (e.g. 0-100).
  // DEVIATION — see slice report.
  fitScore: integer("fit_score"),
  fitSummary: text("fit_summary"),
  estimatedValueCents: integer("estimated_value_cents"),
  currency: text("currency").notNull().default("USD"),
  actualValueCents: integer("actual_value_cents"),
  primaryGoal: text("primary_goal"),
  targetRole: text("target_role"),
  targetTimeline: text("target_timeline"),
  recommendedPathway: text("recommended_pathway"),
  // No user/auth table exists in this slice; kept as an opaque reference and
  // made nullable (spec implies required but there is no FK target yet).
  // DEVIATION — see slice report.
  leadOwnerId: text("lead_owner_id"),
  lastInteractionAt: timestamp("last_interaction_at", { withTimezone: true }),
  nextActionType: text("next_action_type"),
  nextActionDueAt: timestamp("next_action_due_at", { withTimezone: true }),
  nextActionSummary: text("next_action_summary"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  // Optimistic concurrency (spec §9.4 `version`).
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
