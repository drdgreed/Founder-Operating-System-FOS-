import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  pgEnum,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { fosWorkspace } from "./fos_workspace.js";

/**
 * Product (PATCH-SET-01 §B0) — self-referential product tree. NULL
 * `parent_product_id` = top-level peer product; set = sub-offering.
 */
export const productTypeEnum = pgEnum("product_type", ["product", "sub_offering"]);
export const productStatusEnum = pgEnum("product_status", ["active", "paused", "retired"]);

export const product = pgTable(
  "product",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => fosWorkspace.id),
    // Self-FK (§B0). NULL = top-level peer product.
    parentProductId: uuid("parent_product_id").references((): AnyPgColumn => product.id),
    productKey: text("product_key").notNull(),
    name: text("name").notNull(),
    productType: productTypeEnum("product_type").notNull(),
    status: productStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    productKeyPerWorkspace: uniqueIndex("product_workspace_key_unique").on(
      table.workspaceId,
      table.productKey,
    ),
    // §B0 invariant: product_type = 'product' iff parent_product_id IS NULL.
    productTypeMatchesParent: check(
      "product_type_matches_parent",
      sql`(${table.productType} = 'product' AND ${table.parentProductId} IS NULL) OR (${table.productType} = 'sub_offering' AND ${table.parentProductId} IS NOT NULL)`,
    ),
  }),
);
