import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, index, check } from "drizzle-orm/pg-core";
import { fosWorkspace } from "./fos_workspace.js";
import { enrollmentOpportunity } from "./enrollment_opportunity.js";
import { interaction } from "./interaction.js";

/**
 * ObjectionRecord (spec §6.5, issue #70 P1.4a) — a founder- or agent-noted
 * objection raised against an enrollment opportunity. Schema + service only
 * in this slice; no agent/API wiring (that's later P1.4 sub-slices).
 *
 * - `workspace_id` FK NOT NULL direct-scopes `/api/fos/objections/*` reads for
 *   authz (mirrors `interaction.workspace_id`) even though `opportunity_id`
 *   alone would also resolve a workspace transitively — same direct-scoping
 *   convention used throughout this domain. FLAG.
 * - `opportunity_id` FK NOT NULL -> enrollment_opportunity (spec §6.5).
 * - `source_interaction_id` FK NULLABLE -> interaction: an objection may be
 *   observed in a recorded conversation OR inferred without one (spec §6.5
 *   note in issue #70).
 * - `category`, `statement`, `classification`, `confidence`, `severity`: spec
 *   §6.5 gives no enums/types for any of these. `statement` is free-form
 *   narrative text. `category`, `classification`, `confidence`, `severity`
 *   are modeled as open `text` (minimal-defensible-type convention, mirrors
 *   `enrollment_assessment.fit_confidence`) — FLAG, no closed set is evident
 *   in the spec for any of them (unlike `interaction.status`, there is no
 *   narrated small vocabulary to CHECK against).
 * - `resolution_status`: spec gives no enum, but issue #70 explicitly calls
 *   out a founder decision to mirror `interaction.status` (text+CHECK over
 *   pgEnum) wherever a clear closed set exists. A resolution lifecycle IS a
 *   clearly-closed set (open -> addressed/withdrawn/unresolved), so this is
 *   DB-enforced via CHECK, defaulted to `'open'`. FLAG (value set is our
 *   inference, not spec-given — see PR body).
 * - `resolution_summary`: nullable narrative, populated once resolved.
 * - Mutable lifecycle record (resolution_status/summary change over time,
 *   NOT append-only): `version` integer guards optimistic concurrency
 *   (mirrors `interaction.version`).
 */
export const objectionRecord = pgTable(
  "objection_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => fosWorkspace.id),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => enrollmentOpportunity.id),
    sourceInteractionId: uuid("source_interaction_id").references(() => interaction.id),
    // FLAG: no enum in spec — see header note.
    category: text("category").notNull(),
    statement: text("statement").notNull(),
    // FLAG: no enum in spec — see header note.
    classification: text("classification").notNull(),
    // FLAG: no enum in spec — see header note.
    confidence: text("confidence"),
    // FLAG: no enum in spec — see header note.
    severity: text("severity"),
    // FLAG: closed set is our inference, DB-enforced via CHECK — see header note.
    resolutionStatus: text("resolution_status").notNull().default("open"),
    resolutionSummary: text("resolution_summary"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdIdx: index("objection_record_workspace_id_idx").on(table.workspaceId),
    opportunityIdIdx: index("objection_record_opportunity_id_idx").on(table.opportunityId),
    sourceInteractionIdIdx: index("objection_record_source_interaction_id_idx").on(
      table.sourceInteractionId,
    ),
    // Founder decision (issue #70, mirrors interaction.ts): DB-enforce the
    // resolution lifecycle value set via CHECK (over pgEnum) so it evolves
    // transactionally while the vocabulary is young.
    resolutionStatusValid: check(
      "objection_record_resolution_status_valid",
      sql`${table.resolutionStatus} IN ('open', 'addressed', 'withdrawn', 'unresolved')`,
    ),
  }),
);
