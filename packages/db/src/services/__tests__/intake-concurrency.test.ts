import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createRealPgTestDb } from "./postgres-db.js";
import { seedWorkspaceAndProduct } from "./fixtures.js";
import { intakeApplication, type IntakeInput } from "../intake.js";
import { operationalEvent } from "../../schema/operational_event.js";
import { person } from "../../schema/person.js";
import { enrollmentOpportunity } from "../../schema/enrollment_opportunity.js";
import { applicationSubmission } from "../../schema/application_submission.js";

/**
 * FOS0-CORE-14 (issue #16, PR #15 follow-up CD-1): the postgres-js branch of
 * `isDuplicateIntakeIdempotencyKeyError` (the `constraint_name` field) is
 * only exercised end-to-end here. idempotency.test.ts's FOS0-CORE-09 checks
 * it against a hand-built object, and intake.test.ts's FOS0-CORE-07 forces
 * the SELECT-miss on single-connection PGlite, which surfaces PGlite's
 * `constraint`-shaped error, not postgres-js's `constraint_name` shape. This
 * suite fires genuinely concurrent `intakeApplication` calls (same derived
 * idempotency key) at a real multi-connection Postgres (`DATABASE_URL`, the
 * same server CI already provisions), so the losing transactions' INSERTs
 * hit postgres-js's real driver error. Skipped when no real Postgres is
 * reachable, so `npm test` still needs no DB server.
 */
describe.skipIf(!process.env.DATABASE_URL)(
  "intake application idempotency under real concurrency (real Postgres)",
  () => {
    let ctx: Awaited<ReturnType<typeof createRealPgTestDb>>;
    let workspaceId: string;
    let productId: string;

    beforeAll(async () => {
      ctx = await createRealPgTestDb();
      const seeded = await seedWorkspaceAndProduct(ctx.db);
      workspaceId = seeded.workspace.id;
      productId = seeded.product.id;
    });

    afterAll(async () => {
      // operational_event FK-references workspace/product and is append-only
      // (DB trigger blocks DELETE, per append-only-event.test.ts), so it and
      // the workspace/product rows are left behind — harmless (CI's Postgres
      // container is destroyed after each run; local runs just accumulate
      // small fixture rows), mirroring artifact-transition-concurrency.test.ts.
      // The leaf rows below (in FK dependency order) are removable.
      await ctx.db
        .delete(applicationSubmission)
        .where(eq(applicationSubmission.workspaceId, workspaceId));
      await ctx.db
        .delete(enrollmentOpportunity)
        .where(eq(enrollmentOpportunity.workspaceId, workspaceId));
      await ctx.db.delete(person).where(eq(person.workspaceId, workspaceId));
      await ctx.close();
    });

    it("FOS0-CORE-14: N genuinely concurrent duplicate intakes on the same idempotency key — exactly one creates rows/events, the rest dedupe gracefully via a real postgres-js 23505", async () => {
      const input: IntakeInput = {
        workspaceId,
        productId,
        actor: { type: "founder", id: "founder-1" },
        person: {
          firstName: "Grace",
          lastName: "Hopper",
          email: "grace-concurrency@example.com",
          source: "website_application",
        },
        application: {
          formVersion: "v1",
          rawPayloadJson: { answers: { goal: "career change" } },
          sourceReference: "web-form",
        },
      };

      const results = await Promise.all(
        Array.from({ length: 5 }, () => intakeApplication(ctx.db, input)),
      );

      const created = results.filter((r) => !r.deduped);
      const deduped = results.filter((r) => r.deduped);
      expect(created).toHaveLength(1);
      expect(deduped).toHaveLength(4);

      const winner = created[0]!;
      expect(winner.correlationId).not.toBeNull();
      for (const r of deduped) {
        expect(r.personId).toBe(winner.personId);
        expect(r.opportunityId).toBe(winner.opportunityId);
        expect(r.submissionId).toBe(winner.submissionId);
        expect(r.eventIds).toHaveLength(0);
      }

      // negative case: no partial/duplicate data survives the losing,
      // rolled-back transactions.
      const people = await ctx.db.select().from(person).where(eq(person.workspaceId, workspaceId));
      const opportunities = await ctx.db
        .select()
        .from(enrollmentOpportunity)
        .where(eq(enrollmentOpportunity.workspaceId, workspaceId));
      const submissions = await ctx.db
        .select()
        .from(applicationSubmission)
        .where(eq(applicationSubmission.workspaceId, workspaceId));
      const events = await ctx.db
        .select()
        .from(operationalEvent)
        .where(eq(operationalEvent.correlationId, winner.correlationId!));
      expect(people).toHaveLength(1);
      expect(opportunities).toHaveLength(1);
      expect(submissions).toHaveLength(1);
      expect(events).toHaveLength(3);
    });
  },
);
