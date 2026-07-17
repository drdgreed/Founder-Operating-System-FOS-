import { pgTable, uuid, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { fosWorkspace } from "./fos_workspace.js";
import { product } from "./product.js";

/**
 * ArtifactRecord (spec §9.12) — a logical working artifact independent of its
 * versions. Amended by PATCH-SET-01:
 * - §B0: gains a NULLABLE `product_id` (founder-level artifacts like
 *   `operating_review` have none; most are product-scoped).
 * - §E4: `artifact_type` uses the fully-enumerated canonical enum (verbatim).
 * - §E2: `status` is a DERIVED read-only mirror of the current version's
 *   `approval_status`; it is never written independently of a version
 *   transition/revision.
 *
 * This slice (0.1b) implements the columns the artifact lifecycle needs; the
 * remaining §9.12 fields (`owner_user_id`, `sensitivity`, `source_entity_*`,
 * `audience_segment_id`, `campaign_id`, `created_by_*`) are deferred to the
 * slices that populate them. `title` (a required §9.12 field) is included.
 */

// §E4 canonical artifact_type enum — the exact strings, base set + additive
// canonical members. No unregistered value ships.
export const artifactTypeEnum = pgEnum("artifact_type", [
  // Phase 0 base (P0 §9.12)
  "internal_note",
  "enrollment_message",
  "call_brief",
  "onboarding_plan",
  "support_response",
  "product_specification",
  "research_brief",
  "linkedin_post",
  "linkedin_carousel_script",
  "substack_paper",
  "newsletter",
  "landing_page_copy",
  "email_sequence",
  "release_report",
  "operating_review",
  // Additive canonical members (from P1 §7.1, per §E4 — not aliases)
  "post_call_recap",
  "initial_response",
  "information_request",
  "objection_response",
  "offer_follow_up",
  "no_show_recovery",
  "unresponsive_recovery",
  "beta_launch_source_brief",
  "webinar_package",
  "referral_kit",
]);

// PATCH-SET-01 §S2 domain value set.
export const artifactDomainEnum = pgEnum("artifact_domain", [
  "enrollment",
  "editorial",
  "release",
  "marketing",
  "research",
]);

/**
 * The full §12.2 artifact lifecycle state set (per §E2). Shared by
 * `artifact_version.approval_status` (the authoritative lifecycle carrier) and
 * `artifact_record.status` (the derived mirror) so both columns are guaranteed
 * to range over exactly the same values.
 */
export const artifactLifecycleStatusEnum = pgEnum("artifact_lifecycle_status", [
  "draft",
  "in_review",
  "approved",
  "approved_with_edits",
  "rejected",
  "deferred",
  "ready_for_action",
  "executed",
  "failed",
  "superseded",
]);

export type ArtifactType = (typeof artifactTypeEnum.enumValues)[number];
export type ArtifactDomain = (typeof artifactDomainEnum.enumValues)[number];

export const artifactRecord = pgTable("artifact_record", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => fosWorkspace.id),
  // §B0: nullable — founder-level artifacts have no product.
  productId: uuid("product_id").references(() => product.id),
  artifactType: artifactTypeEnum("artifact_type").notNull(),
  domain: artifactDomainEnum("domain").notNull(),
  title: text("title").notNull(),
  // Denormalized pointer to the current ArtifactVersion (the §C2 "FOS Version"
  // source). Nullable and intentionally WITHOUT an FK: adding one would create
  // a circular artifact_record <-> artifact_version constraint. Integrity is
  // anchored on the child side (artifact_version.artifact_id -> artifact_record.id).
  currentVersionId: uuid("current_version_id"),
  // §E2: DERIVED read-only mirror of the current version's approval_status.
  // Never written except in lockstep with a version transition/revision.
  status: artifactLifecycleStatusEnum("status").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
