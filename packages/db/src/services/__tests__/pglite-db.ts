import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../../schema/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/db/src/services/__tests__ -> packages/db/migrations
const MIGRATIONS_FOLDER = join(__dirname, "..", "..", "..", "migrations");

/**
 * Boots a fresh in-process Postgres (PGlite) and applies every migration in
 * `packages/db/migrations`, including the hand-authored append-only-trigger
 * migration. Hermetic — no external Postgres server required.
 */
export async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return {
    db,
    client,
    close: () => client.close(),
  };
}
