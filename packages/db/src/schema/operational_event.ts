import { pgTable, uuid, text, timestamp, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { fosWorkspace } from "./fos_workspace.js";
import { product } from "./product.js";

/**
 * OperationalEvent (spec §9.7, envelope per PATCH-SET-01 §S1). Append-only:
 * enforced with a Postgres trigger added in a hand-authored migration
 * (`RAISE EXCEPTION` on UPDATE/DELETE), not expressible in the Drizzle
 * schema itself.
 *
 * Column `type` matches the §S1 envelope field name (`type`). Spec §9.7
 * names the equivalent column `event_type`; PATCH-SET-01 §S1 defines the
 * envelope with `type`, and the orchestrator build instructions for this
 * slice explicitly enumerate `type` as the column name. Following the more
 * specific/authoritative instruction. DEVIATION — see slice report.
 */
export const eventActorTypeEnum = pgEnum("operational_event_actor_type", [
  "founder",
  "agent",
  "provider",
  "system",
]);

export const operationalEvent = pgTable("operational_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => fosWorkspace.id),
  // §B0/§S1: nullable — founder-level events (e.g. person.created) have no product.
  productId: uuid("product_id").references(() => product.id),
  entityType: text("entity_type").notNull(),
  // Polymorphic reference (varies by entity_type); intentionally not an FK.
  entityId: text("entity_id").notNull(),
  source: text("source").notNull(),
  correlationId: uuid("correlation_id").notNull(),
  causationId: uuid("causation_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  actorType: eventActorTypeEnum("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
