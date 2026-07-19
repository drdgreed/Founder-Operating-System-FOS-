import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@fos/db/schema";
import { fosWorkspace, featureFlag, type FeatureFlagMode } from "@fos/db/schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/agents/src/__tests__ -> packages/db/migrations
const MIGRATIONS_FOLDER = join(__dirname, "..", "..", "..", "db", "migrations");

/**
 * Hermetic in-process Postgres (PGlite) with every migration applied,
 * including the P1.1 index migration (0013). Mirrors
 * packages/adapter/src/__tests__/test-db.ts / packages/db/.../pglite-db.ts
 * for this package's own tests. NO external Postgres server, NO network.
 */
export async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return {
    db,
    close: () => client.close(),
  };
}

export async function seedWorkspace(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  const [workspace] = await db
    .insert(fosWorkspace)
    .values({ name: "Test Workspace", ownerUserId: "founder-1" })
    .returning();
  if (!workspace) throw new Error("seedWorkspace: fos_workspace insert returned no row");
  return workspace;
}

export async function setFeatureFlag(
  db: Awaited<ReturnType<typeof createTestDb>>["db"],
  input: { workspaceId: string; key: string; enabled: boolean; mode: FeatureFlagMode },
) {
  const [row] = await db
    .insert(featureFlag)
    .values({
      workspaceId: input.workspaceId,
      key: input.key,
      enabled: input.enabled,
      mode: input.mode,
    })
    .onConflictDoUpdate({
      target: [featureFlag.workspaceId, featureFlag.key],
      set: { enabled: input.enabled, mode: input.mode, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("setFeatureFlag: feature_flag upsert returned no row");
  return row;
}
