import { pgTable, uuid, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { fosWorkspace } from "./fos_workspace.js";

/**
 * WorkspaceIntegration (spec §11.1) — a provider adapter connection
 * (e.g. Notion) for a workspace. Slice 0.2a scope: the connection record
 * only. Spec §11.1 also lists `capabilities_json`, `connected_by`,
 * `last_health_check_at`, `last_successful_sync_at` — deferred to the later
 * 0.2 sub-slices that populate them (issue #24). Workspace-level, no
 * `product_id` (an integration is not scoped to a single product).
 */
export const workspaceIntegrationProviderEnum = pgEnum("workspace_integration_provider", [
  "notion",
]);

// Reduced from the full §11.1 status set (pending|connected|degraded|
// disconnected|revoked|error) to the 3 states this slice's client needs;
// the rest land with the sub-slice that drives them (issue #24).
export const workspaceIntegrationStatusEnum = pgEnum("workspace_integration_status", [
  "connected",
  "disconnected",
  "error",
]);

export const workspaceIntegration = pgTable("workspace_integration", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => fosWorkspace.id),
  provider: workspaceIntegrationProviderEnum("provider").notNull(),
  providerWorkspaceId: text("provider_workspace_id"),
  // §11.1 `credential_reference` — a REFERENCE (e.g. an env var name), never
  // the secret itself (ADR-04).
  credentialReference: text("credential_reference").notNull(),
  status: workspaceIntegrationStatusEnum("status").notNull().default("disconnected"),
  connectedAt: timestamp("connected_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
