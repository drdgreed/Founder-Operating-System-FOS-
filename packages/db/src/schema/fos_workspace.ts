import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

/**
 * FOSWorkspace (spec §9.1) — the canonical FOS tenant. Do not confuse with a
 * Notion `provider_workspace_id` (spec §2.2 REF-0A-004); this table only ever
 * holds the FOS-side identity.
 */
export const fosWorkspace = pgTable("fos_workspace", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  // Spec lists `owner_user_id` with no type/nullability given, and this repo
  // slice has no user/auth table yet (Phase 0 auth is out of scope for
  // 0.1a). Kept as an opaque reference string rather than inventing a second
  // auth system. DEVIATION — see slice report.
  ownerUserId: text("owner_user_id").notNull(),
  defaultTimezone: text("default_timezone").notNull().default("UTC"),
  // Spec does not enumerate a `status` value set for FOSWorkspace; left as
  // open text rather than inventing an enum. DEVIATION — see slice report.
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
