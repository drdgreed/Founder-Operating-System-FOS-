import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, integer, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { fosWorkspace } from "./fos_workspace.js";
import { artifactRecord, artifactLifecycleStatusEnum } from "./artifact_record.js";

/**
 * ArtifactVersion (spec §9.13, amended by PATCH-SET-01). A version is an
 * immutable CONTENT snapshot:
 * - §E2: `approval_status` is the AUTHORITATIVE lifecycle carrier, ranging
 *   over the full §12.2 state set (shared enum with the record mirror).
 * - §S3: `content_hash` = SHA-256(normalized_markdown) (a stored, derived
 *   field; not in the literal §9.13 list but required by S3 and the build).
 * - Content immutability (`body_markdown` / `content_hash` never change once
 *   written) is enforced by a DB trigger in a hand-authored migration, since
 *   it is not expressible in the Drizzle schema. `approval_status` and
 *   `updated_at` remain mutable (lifecycle transitions).
 *
 * Deferred §9.13 fields (`structured_content_json`, `evidence_manifest_json`,
 * `consent_manifest_json`, `source_context_manifest_json`, `created_by_*`,
 * `parent_version_id`, `immutable_at`) land with the slices that use them.
 */
export const artifactVersion = pgTable(
  "artifact_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => fosWorkspace.id),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifactRecord.id),
    versionNumber: integer("version_number").notNull(),
    bodyMarkdown: text("body_markdown").notNull(),
    // §S3: SHA-256 of the normalized markdown.
    contentHash: text("content_hash").notNull(),
    claimsManifestJson: jsonb("claims_manifest_json")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // §E2 / §12.2: authoritative lifecycle carrier.
    approvalStatus: artifactLifecycleStatusEnum("approval_status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    versionNumberUnique: uniqueIndex("artifact_version_artifact_id_version_number_unique").on(
      table.artifactId,
      table.versionNumber,
    ),
  }),
);
