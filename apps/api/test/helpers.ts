import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@fos/db/schema";
import { fosWorkspace, product } from "@fos/db/schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/api/test -> repo root -> packages/db/migrations
const MIGRATIONS_FOLDER = join(__dirname, "..", "..", "..", "packages", "db", "migrations");

/** Hermetic in-process Postgres (PGlite) with all migrations applied. */
export async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, client, close: () => client.close() };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function seedWorkspaceAndProduct(db: any, tag = "a") {
  const [workspace] = await db
    .insert(fosWorkspace)
    .values({ name: `ws-${tag}`, ownerUserId: "founder-1" })
    .returning();
  const [prod] = await db
    .insert(product)
    .values({
      workspaceId: workspace.id,
      productKey: `product-${tag}`,
      name: `Product ${tag}`,
      productType: "product",
      parentProductId: null,
    })
    .returning();
  return { workspace, product: prod };
}
