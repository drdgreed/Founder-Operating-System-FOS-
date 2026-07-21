import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@fos/db/schema";
import {
  fosWorkspace,
  featureFlag,
  product,
  person,
  enrollmentOpportunity,
  applicationSubmission,
  type FeatureFlagMode,
} from "@fos/db/schema";
import { createInteraction } from "@fos/db/services";

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

/**
 * Seeds a full EnrollmentOpportunity + Person + ApplicationSubmission chain
 * (mirrors packages/adapter/src/__tests__/test-db.ts's seedOpportunity) for
 * the `fos.enrollment_brief` agent tests, which need real canonical rows to
 * project (stage 11) and to attach an EnrollmentAssessment to (stage 9b).
 */
export async function seedEnrollmentBriefFixture(
  db: Awaited<ReturnType<typeof createTestDb>>["db"],
) {
  const workspace = await seedWorkspace(db);

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
  if (!prod) throw new Error("seedEnrollmentBriefFixture: product insert returned no row");

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
  if (!personRow) throw new Error("seedEnrollmentBriefFixture: person insert returned no row");

  const [opportunity] = await db
    .insert(enrollmentOpportunity)
    .values({
      workspaceId: workspace.id,
      productId: prod.id,
      personId: personRow.id,
      stage: "reviewing",
      currency: "USD",
      version: 1,
    })
    .returning();
  if (!opportunity)
    throw new Error("seedEnrollmentBriefFixture: enrollment_opportunity insert returned no row");

  const [application] = await db
    .insert(applicationSubmission)
    .values({
      workspaceId: workspace.id,
      productId: prod.id,
      personId: personRow.id,
      opportunityId: opportunity.id,
      formVersion: "v1",
      rawPayloadJson: { note: "seeded fixture" },
      sourceReference: "website_application",
      intakeIdempotencyKey: `seed-${opportunity.id}`,
    })
    .returning();
  if (!application)
    throw new Error("seedEnrollmentBriefFixture: application_submission insert returned no row");

  return { workspace, product: prod, person: personRow, opportunity, application };
}

/**
 * Seeds an EnrollmentOpportunity + Person chain plus a scheduled Interaction
 * (P1.3a substrate) for the `fos.call_preparation` agent tests (issue #60),
 * which need real canonical rows to assert workspace ownership against at
 * the persistDomain seam (no domain record is written by this agent).
 *
 * Accepts an optional already-seeded `workspace` row so a test can seed a
 * SECOND opportunity/interaction chain inside the SAME workspace (e.g. to
 * exercise the "interaction belongs to a different opportunity" check,
 * distinct from the cross-workspace check).
 */
export async function seedCallPreparationFixture(
  db: Awaited<ReturnType<typeof createTestDb>>["db"],
  existingWorkspace?: Awaited<ReturnType<typeof seedWorkspace>>,
) {
  const workspace = existingWorkspace ?? (await seedWorkspace(db));

  const [prod] = await db
    .insert(product)
    .values({
      workspaceId: workspace.id,
      // Suffix with a fresh id: `existingWorkspace` lets a test seed a
      // SECOND opportunity chain in the same workspace, and
      // (workspace_id, product_key) is unique.
      productKey: `career-foundry-${randomUUID().slice(0, 8)}`,
      name: "Career Foundry",
      productType: "product",
      parentProductId: null,
    })
    .returning();
  if (!prod) throw new Error("seedCallPreparationFixture: product insert returned no row");

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
  if (!personRow) throw new Error("seedCallPreparationFixture: person insert returned no row");

  const [opportunity] = await db
    .insert(enrollmentOpportunity)
    .values({
      workspaceId: workspace.id,
      productId: prod.id,
      personId: personRow.id,
      stage: "conversation_scheduled",
      currency: "USD",
      version: 1,
    })
    .returning();
  if (!opportunity)
    throw new Error("seedCallPreparationFixture: enrollment_opportunity insert returned no row");

  const interactionRow = await createInteraction(db, {
    workspaceId: workspace.id,
    opportunityId: opportunity.id,
    interactionType: "discovery_call",
    status: "scheduled",
    scheduledAt: new Date("2026-07-25T15:00:00.000Z"),
  });

  return { workspace, product: prod, person: personRow, opportunity, interaction: interactionRow };
}

/**
 * Seeds an EnrollmentOpportunity + Person chain plus a COMPLETED Interaction
 * (P1.3a substrate) for the `fos.post_call_synthesis` agent tests (issue
 * #68) — mirrors `seedCallPreparationFixture` exactly, but the opportunity
 * starts at `conversation_scheduled` (a stage with legal outgoing edges to
 * `conversation_completed`, `contacted`, and `unresponsive` per the §12.1
 * matrix, so a test can freely exercise both legal and illegal proposed
 * stages) and the interaction is `completed` (the call already happened).
 *
 * Accepts an optional already-seeded `workspace` row for the same reason as
 * `seedCallPreparationFixture`: exercising the
 * "interaction belongs to a different opportunity" check.
 */
export async function seedPostCallSynthesisFixture(
  db: Awaited<ReturnType<typeof createTestDb>>["db"],
  existingWorkspace?: Awaited<ReturnType<typeof seedWorkspace>>,
) {
  const workspace = existingWorkspace ?? (await seedWorkspace(db));

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
  if (!prod) throw new Error("seedPostCallSynthesisFixture: product insert returned no row");

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
  if (!personRow) throw new Error("seedPostCallSynthesisFixture: person insert returned no row");

  const [opportunity] = await db
    .insert(enrollmentOpportunity)
    .values({
      workspaceId: workspace.id,
      productId: prod.id,
      personId: personRow.id,
      stage: "conversation_scheduled",
      currency: "USD",
      version: 1,
    })
    .returning();
  if (!opportunity)
    throw new Error("seedPostCallSynthesisFixture: enrollment_opportunity insert returned no row");

  const interactionRow = await createInteraction(db, {
    workspaceId: workspace.id,
    opportunityId: opportunity.id,
    interactionType: "discovery_call",
    status: "completed",
    scheduledAt: new Date("2026-07-25T15:00:00.000Z"),
    occurredAt: new Date("2026-07-25T15:32:00.000Z"),
  });

  return { workspace, product: prod, person: personRow, opportunity, interaction: interactionRow };
}

/**
 * Seeds an EnrollmentOpportunity + Person chain plus a COMPLETED Interaction
 * for the `fos.objection_intelligence` agent tests (issue #73) — mirrors
 * `seedPostCallSynthesisFixture` exactly, since both agents run on the same
 * completed-conversation substrate (spec §9.2 step 4).
 *
 * Accepts an optional already-seeded `workspace` row for the same reason as
 * `seedPostCallSynthesisFixture`: exercising the
 * "interaction belongs to a different opportunity" check.
 */
export async function seedObjectionIntelligenceFixture(
  db: Awaited<ReturnType<typeof createTestDb>>["db"],
  existingWorkspace?: Awaited<ReturnType<typeof seedWorkspace>>,
) {
  const workspace = existingWorkspace ?? (await seedWorkspace(db));

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
  if (!prod) throw new Error("seedObjectionIntelligenceFixture: product insert returned no row");

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
  if (!personRow)
    throw new Error("seedObjectionIntelligenceFixture: person insert returned no row");

  const [opportunity] = await db
    .insert(enrollmentOpportunity)
    .values({
      workspaceId: workspace.id,
      productId: prod.id,
      personId: personRow.id,
      stage: "conversation_scheduled",
      currency: "USD",
      version: 1,
    })
    .returning();
  if (!opportunity)
    throw new Error(
      "seedObjectionIntelligenceFixture: enrollment_opportunity insert returned no row",
    );

  const interactionRow = await createInteraction(db, {
    workspaceId: workspace.id,
    opportunityId: opportunity.id,
    interactionType: "discovery_call",
    status: "completed",
    scheduledAt: new Date("2026-07-25T15:00:00.000Z"),
    occurredAt: new Date("2026-07-25T15:32:00.000Z"),
  });

  return { workspace, product: prod, person: personRow, opportunity, interaction: interactionRow };
}

/**
 * Seeds an EnrollmentOpportunity + Person chain for the
 * `fos.next_best_action` agent tests (issue #78) — no Interaction is needed
 * (unlike `seedObjectionIntelligenceFixture`/`seedPostCallSynthesisFixture`):
 * this agent's ownership assertion is opportunity-only (see
 * `loadOwnedOpportunity` in `definitions/next-best-action.ts`). Defaults the
 * opportunity to `contacted` — a non-terminal stage with legal outgoing
 * edges, so a test can freely exercise both legal and illegal proposed
 * stages/action types.
 *
 * Accepts an optional already-seeded `workspace` row for the same reason as
 * the other fixtures: exercising the cross-workspace ownership check.
 */
export async function seedNextBestActionFixture(
  db: Awaited<ReturnType<typeof createTestDb>>["db"],
  existingWorkspace?: Awaited<ReturnType<typeof seedWorkspace>>,
) {
  const workspace = existingWorkspace ?? (await seedWorkspace(db));

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
  if (!prod) throw new Error("seedNextBestActionFixture: product insert returned no row");

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
  if (!personRow) throw new Error("seedNextBestActionFixture: person insert returned no row");

  const [opportunity] = await db
    .insert(enrollmentOpportunity)
    .values({
      workspaceId: workspace.id,
      productId: prod.id,
      personId: personRow.id,
      stage: "contacted",
      currency: "USD",
      version: 1,
    })
    .returning();
  if (!opportunity)
    throw new Error("seedNextBestActionFixture: enrollment_opportunity insert returned no row");

  return { workspace, product: prod, person: personRow, opportunity };
}

/**
 * Seeds an EnrollmentOpportunity + Person chain for the
 * `fos.personalized_follow_up` agent tests (issue #82) — no Interaction is
 * needed: like `fos.next_best_action`, this agent's ownership assertion is
 * opportunity-only (see `loadOwnedOpportunity` in
 * `definitions/personalized-follow-up.ts`). Defaults the opportunity to
 * `contacted` (a non-terminal stage) — mirrors `seedNextBestActionFixture`.
 *
 * Accepts an optional already-seeded `workspace` row for the same reason as
 * the other fixtures: exercising the cross-workspace ownership check.
 */
export async function seedPersonalizedFollowUpFixture(
  db: Awaited<ReturnType<typeof createTestDb>>["db"],
  existingWorkspace?: Awaited<ReturnType<typeof seedWorkspace>>,
) {
  const workspace = existingWorkspace ?? (await seedWorkspace(db));

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
  if (!prod) throw new Error("seedPersonalizedFollowUpFixture: product insert returned no row");

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
  if (!personRow) throw new Error("seedPersonalizedFollowUpFixture: person insert returned no row");

  const [opportunity] = await db
    .insert(enrollmentOpportunity)
    .values({
      workspaceId: workspace.id,
      productId: prod.id,
      personId: personRow.id,
      stage: "contacted",
      currency: "USD",
      version: 1,
    })
    .returning();
  if (!opportunity)
    throw new Error(
      "seedPersonalizedFollowUpFixture: enrollment_opportunity insert returned no row",
    );

  return { workspace, product: prod, person: personRow, opportunity };
}
