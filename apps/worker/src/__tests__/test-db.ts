import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@fos/db/schema";
import {
  enrollmentOpportunity,
  featureFlag,
  fosWorkspace,
  person,
  product,
  type FeatureFlagMode,
} from "@fos/db/schema";
import type { OpportunityStage } from "@fos/db/services";

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/worker/src/__tests__ -> packages/db/migrations
const MIGRATIONS_FOLDER = join(__dirname, "..", "..", "..", "..", "packages", "db", "migrations");

/**
 * Hermetic in-process Postgres (PGlite) with every migration applied. Mirrors
 * `packages/agents/src/__tests__/test-db.ts` — NO external Postgres, NO
 * network. The worker's tests exercise `runStalledOpportunityJob` end-to-end
 * against real canonical rows + `runAgent`, always with a `FakeModelClient`.
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

type Db = Awaited<ReturnType<typeof createTestDb>>["db"];

export async function seedWorkspace(db: Db) {
  const [workspace] = await db
    .insert(fosWorkspace)
    .values({ name: "Test Workspace", ownerUserId: "founder-1" })
    .returning();
  if (!workspace) throw new Error("seedWorkspace: fos_workspace insert returned no row");
  return workspace;
}

export async function setFeatureFlag(
  db: Db,
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

export interface SeedStalledFixtureOptions {
  /** Reuse an existing workspace (e.g. to seed a SECOND opportunity in the same
   * tenant, or to seed a cross-tenant opportunity). */
  existingWorkspace?: Awaited<ReturnType<typeof seedWorkspace>>;
  stage?: OpportunityStage;
  /** The opportunity's `last_interaction_at` — the stage-age reference instant.
   * Defaults to a value old enough to be stalled against the test thresholds. */
  lastInteractionAt?: Date | null;
}

/**
 * Seeds a Product + Person + EnrollmentOpportunity chain for the stalled-job
 * tests. Mirrors `seedNextBestActionFixture` in the agents package (the job
 * ultimately drives `fos.next_best_action`), plus explicit control over
 * `stage` and `last_interaction_at` so a test can dial an opportunity in or out
 * of the stall predicate.
 */
export async function seedStalledFixture(db: Db, opts: SeedStalledFixtureOptions = {}) {
  const workspace = opts.existingWorkspace ?? (await seedWorkspace(db));

  const [prod] = await db
    .insert(product)
    .values({
      workspaceId: workspace.id,
      productKey: `career-foundry-${randomUUID().slice(0, 8)}`,
      name: "Career Foundry",
      productType: "product",
      parentProductId: null,
    })
    .returning();
  if (!prod) throw new Error("seedStalledFixture: product insert returned no row");

  const [personRow] = await db
    .insert(person)
    .values({
      workspaceId: workspace.id,
      firstName: "Ada",
      lastName: "Lovelace",
      currentRole: "Data Analyst",
      currentCompany: "Acme Corp",
      location: "Remote",
      source: "website_application",
      lifecycleType: "applicant",
    })
    .returning();
  if (!personRow) throw new Error("seedStalledFixture: person insert returned no row");

  const [opportunity] = await db
    .insert(enrollmentOpportunity)
    .values({
      workspaceId: workspace.id,
      productId: prod.id,
      personId: personRow.id,
      stage: opts.stage ?? "contacted",
      primaryGoal: "Break into data analytics",
      targetRole: "Senior Data Analyst",
      targetTimeline: "3 months",
      lastInteractionAt:
        opts.lastInteractionAt === undefined
          ? new Date("2026-01-01T00:00:00.000Z")
          : opts.lastInteractionAt,
      currency: "USD",
      version: 1,
    })
    .returning();
  if (!opportunity)
    throw new Error("seedStalledFixture: enrollment_opportunity insert returned no row");

  return { workspace, product: prod, person: personRow, opportunity };
}
