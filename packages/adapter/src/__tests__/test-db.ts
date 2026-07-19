import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@fos/db/schema";
import { fosWorkspace, product, person, enrollmentOpportunity } from "@fos/db/schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/adapter/src/__tests__ -> packages/db/migrations
const MIGRATIONS_FOLDER = join(__dirname, "..", "..", "..", "db", "migrations");

/** Mirrors packages/db/src/services/__tests__/pglite-db.ts for this package's own tests. */
export async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return {
    db,
    close: () => client.close(),
  };
}

export async function seedOpportunity(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  const [workspace] = await db
    .insert(fosWorkspace)
    .values({ name: "Test Workspace", ownerUserId: "founder-1" })
    .returning();
  if (!workspace) throw new Error("seedOpportunity: fos_workspace insert returned no row");

  const [prod] = await db
    .insert(product)
    .values({
      workspaceId: workspace.id,
      productKey: "career-foundry",
      name: "Career Foundry",
      productType: "product",
      parentProductId: null,
    })
    .returning();
  if (!prod) throw new Error("seedOpportunity: product insert returned no row");

  const [personRow] = await db
    .insert(person)
    .values({
      workspaceId: workspace.id,
      firstName: "Ada",
      lastName: "Lovelace",
      source: "website_application",
      lifecycleType: "applicant",
    })
    .returning();
  if (!personRow) throw new Error("seedOpportunity: person insert returned no row");

  const [opportunity] = await db
    .insert(enrollmentOpportunity)
    .values({
      workspaceId: workspace.id,
      productId: prod.id,
      personId: personRow.id,
      stage: "new_lead",
      currency: "USD",
      version: 1,
    })
    .returning();
  if (!opportunity)
    throw new Error("seedOpportunity: enrollment_opportunity insert returned no row");

  return { workspace, product: prod, person: personRow, opportunity };
}
