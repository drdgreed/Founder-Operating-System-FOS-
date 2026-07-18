import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import { fosWorkspace } from "./fos_workspace.js";
import { product } from "./product.js";
import { person } from "./person.js";
import { enrollmentOpportunity } from "./enrollment_opportunity.js";

/**
 * ApplicationSubmission (spec §9.5). Product-scoped per orchestrator build
 * instructions for slice 0.1a (`product_id` NOT NULL FK -> product; not an
 * original §9.5 field, added to satisfy §B0 scoping for this slice).
 *
 * `intake_idempotency_key` (PATCH-SET-01 §S3) is stored here — it is the
 * natural home for application-intake deduplication, and its uniqueness is
 * enforced at the DB layer as a backstop for the service-layer check. The
 * intake service catches a unique-violation on this constraint to dedupe
 * gracefully when a concurrent duplicate races past the service-layer SELECT
 * (see `isDuplicateIntakeIdempotencyKeyError` in `./services/idempotency.ts`).
 */
export const APPLICATION_SUBMISSION_INTAKE_IDEMPOTENCY_KEY_CONSTRAINT =
  "application_submission_intake_idempotency_key_unique";
export const applicationSubmission = pgTable(
  "application_submission",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => fosWorkspace.id),
    productId: uuid("product_id")
      .notNull()
      .references(() => product.id),
    personId: uuid("person_id")
      .notNull()
      .references(() => person.id),
    // FK named explicitly below (opportunityIdFk) — the auto-generated name
    // exceeds Postgres's 63-char identifier limit and silently truncates.
    opportunityId: uuid("opportunity_id").notNull(),
    formVersion: text("form_version").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    rawPayloadJson: jsonb("raw_payload_json").notNull(),
    normalizedPayloadJson: jsonb("normalized_payload_json"),
    // `Asset` table lands with PATCH-SET-01 §S4 — no FK yet.
    resumeAssetId: uuid("resume_asset_id"),
    linkedinSnapshotAssetId: uuid("linkedin_snapshot_asset_id"),
    sourceReference: text("source_reference").notNull(),
    // Spec does not enumerate `ingestion_status` values; left as open text.
    // DEVIATION — see slice report.
    ingestionStatus: text("ingestion_status").notNull().default("received"),
    ingestionError: text("ingestion_error"),
    // PATCH-SET-01 §S3.
    intakeIdempotencyKey: text("intake_idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    intakeIdempotencyKeyUnique: uniqueIndex(
      APPLICATION_SUBMISSION_INTAKE_IDEMPOTENCY_KEY_CONSTRAINT,
    ).on(table.intakeIdempotencyKey),
    opportunityIdFk: foreignKey({
      columns: [table.opportunityId],
      foreignColumns: [enrollmentOpportunity.id],
      name: "application_submission_opportunity_id_fk",
    }),
  }),
);
