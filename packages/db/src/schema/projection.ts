import { pgTable, uuid, text, timestamp, bigint, pgEnum, uniqueIndex } from "drizzle-orm/pg-core";
import { fosWorkspace } from "./fos_workspace.js";
import { product } from "./product.js";

/**
 * Projection (issue #27, slice 0.2b) — the canonical<->provider page mapping
 * record. One row per (workspace, entity_type, entity_id, provider): the
 * UNIQUE index below is what makes `projectOpportunity` idempotent (a second
 * call for the same entity finds the existing row instead of creating a
 * duplicate page). Reconciliation (0.2c) will read/write this same table to
 * detect provider-side edits.
 */
export const projectionProviderEnum = pgEnum("projection_provider", ["notion"]);

// Spec §12.4 projection sync-state machine (mirrors §11.4 `sync_status`).
export const projectionSyncStatusEnum = pgEnum("projection_sync_status", [
  "pending",
  "in_sync",
  "fos_ahead",
  "provider_ahead",
  "conflict",
  "failed",
  "disabled",
]);

export const projection = pgTable(
  "projection",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => fosWorkspace.id),
    // Nullable — mirrors §B0 (some projected entities are founder-level).
    productId: uuid("product_id").references(() => product.id),
    entityType: text("entity_type").notNull(),
    // Text, not uuid: the canonical entity id is always a stable string, but
    // not every future entity_type is guaranteed to key on a uuid column.
    entityId: text("entity_id").notNull(),
    provider: projectionProviderEnum("provider").notNull(),
    providerPageId: text("provider_page_id"),
    syncStatus: projectionSyncStatusEnum("sync_status").notNull().default("pending"),
    // C2: for a versioned entity, FOS Version = entity.version (an integer);
    // bigint headroom for the unversioned-entity epoch-derivation case C2
    // also defines, which later projections (ProductSignal etc.) will use.
    fosVersion: bigint("fos_version", { mode: "number" }).notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // A canonical entity projects to exactly one page per provider.
    entityProviderUnique: uniqueIndex("projection_workspace_entity_provider_unique").on(
      table.workspaceId,
      table.entityType,
      table.entityId,
      table.provider,
    ),
  }),
);
