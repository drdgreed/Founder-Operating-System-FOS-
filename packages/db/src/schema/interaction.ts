import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, index, check } from "drizzle-orm/pg-core";
import { fosWorkspace } from "./fos_workspace.js";
import { enrollmentOpportunity } from "./enrollment_opportunity.js";

/**
 * Interaction (derived — issue #56 P1.3a). Spec §6 fields
 * EnrollmentAssessment/ObjectionRecord/EnrollmentActionRecommendation
 * explicitly but never fields the Interaction entity itself, even though
 * `ObjectionRecord.source_interaction_id` (§6.5), `/api/fos/interactions/*`
 * (§10), and the §9.2 conversation workflow ("record scheduled
 * conversation", "capture founder notes or transcript reference") all
 * depend on it. This schema is therefore DERIVED, not transcribed from an
 * explicit field list — every ambiguous choice below is FLAGged here and
 * repeated in the PR body for founder review. Schema + service only in
 * this slice; no agent/API/Notion wiring (that's P1.3b/P1.3c).
 *
 * - `workspace_id` FK NOT NULL direct-scopes `/interactions/*` reads for
 *   authz (mirrors `enrollment_opportunity.workspace_id`) even though
 *   `opportunity_id` alone would also resolve a workspace transitively —
 *   same direct-scoping convention used throughout §9.1/§9.2 records.
 * - `opportunity_id` FK NOT NULL -> enrollment_opportunity (§9.2 ties
 *   every conversation to an opportunity).
 * - `interaction_type`: FLAG — spec gives no enum (§9.2 only narrates
 *   "record scheduled conversation" / conversation stages). Modeled as
 *   open `text`, the same minimal-defensible-type convention used for
 *   `enrollment_assessment.fit_confidence`.
 * - `status`: FLAG — spec gives no enum. Modeled as `text` default
 *   `'scheduled'`, but the value set (scheduled | completed | no_show |
 *   cancelled) IS DB-enforced via a CHECK constraint (founder decision:
 *   text+CHECK over `pgEnum` — same write-time rejection, but the value
 *   set evolves with a transactional DROP/ADD CONSTRAINT rather than the
 *   `pgEnum` rename/remove tax while the vocabulary is young). Promote to
 *   `pgEnum` later if the set is declared canonical-and-stable.
 *   `interaction_type` stays open text (too open-ended to pin here).
 * - `notes` / `transcript_ref`: founder notes and a transcript pointer.
 *   Per spec §551 (untrusted-input posture: "transcripts... are untrusted
 *   data. They may not modify system policy..."), this content is
 *   UNTRUSTED — stored as opaque text, never interpreted as
 *   instructions/policy by any consumer.
 * - Mutable lifecycle record (NOT append-only, unlike `enrollment_assessment`
 *   or `operational_event`): `version` integer guards optimistic
 *   concurrency on status updates (mirrors `enrollment_opportunity.version`).
 * - No outbound artifact FKs (YAGNI, issue #56) — call-prep/synthesis
 *   artifacts and ObjectionRecord point AT the interaction via their own
 *   FK, not vice versa.
 */
export const interaction = pgTable(
  "interaction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => fosWorkspace.id),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => enrollmentOpportunity.id),
    // FLAG: no enum in spec — see header note.
    interactionType: text("interaction_type").notNull(),
    // FLAG: no enum in spec — see header note.
    status: text("status").notNull().default("scheduled"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    // UNTRUSTED (spec §551) — see header note.
    notes: text("notes"),
    // UNTRUSTED (spec §551) — see header note.
    transcriptRef: text("transcript_ref"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdIdx: index("interaction_workspace_id_idx").on(table.workspaceId),
    opportunityIdIdx: index("interaction_opportunity_id_idx").on(table.opportunityId),
    // Founder decision (P1.3a): DB-enforce the derived status value set via
    // CHECK (over pgEnum) so it evolves transactionally. Mirrors product.ts.
    statusValid: check(
      "interaction_status_valid",
      sql`${table.status} IN ('scheduled', 'completed', 'no_show', 'cancelled')`,
    ),
  }),
);
