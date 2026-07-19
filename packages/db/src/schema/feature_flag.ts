import { pgTable, uuid, text, boolean, timestamp, pgEnum, uniqueIndex } from "drizzle-orm/pg-core";
import { fosWorkspace } from "./fos_workspace.js";

/**
 * FeatureFlag (ADR-07 D8, issue #48 P1.0) — per-agent/per-workspace flag read
 * at runtime stage 2 (authorization + feature-flag/mode check). Independent
 * Postgres enum from `agent_run.feature_mode` (same value set, decoupled
 * type) — mirrors this codebase's existing precedent of NOT sharing one
 * Postgres enum across conceptually-separate columns with the same value set
 * (see `approval_risk_level` vs `workspace_command_risk_level`).
 *
 * Field list is exactly ADR-07 D8's: `workspace_id, key, enabled, mode,
 * updated_at` — no `created_at` column (not in the ADR's list; a flag is
 * upserted, not appended).
 */
export const featureFlagModeEnum = pgEnum("feature_flag_mode", ["shadow", "review", "live"]);
export type FeatureFlagMode = (typeof featureFlagModeEnum.enumValues)[number];

export const featureFlag = pgTable(
  "feature_flag",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => fosWorkspace.id),
    key: text("key").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    mode: featureFlagModeEnum("mode").notNull().default("shadow"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceKeyUnique: uniqueIndex("feature_flag_workspace_id_key_unique").on(
      table.workspaceId,
      table.key,
    ),
  }),
);
