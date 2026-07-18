import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./pglite-db.js";
import { seedWorkspaceAndProduct } from "./fixtures.js";
import { intakeApplication, type IntakeInput } from "../intake.js";
import { operationalEvent } from "../../schema/operational_event.js";
import { person } from "../../schema/person.js";
import { enrollmentOpportunity } from "../../schema/enrollment_opportunity.js";
import { applicationSubmission } from "../../schema/application_submission.js";

describe("intake service (spec §15.8, PATCH-SET-01 §S3)", () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>;
  let workspaceId: string;
  let productId: string;

  beforeEach(async () => {
    ctx = await createTestDb();
    const seeded = await seedWorkspaceAndProduct(ctx.db);
    workspaceId = seeded.workspace.id;
    productId = seeded.product.id;
  });

  afterEach(async () => {
    await ctx.close();
  });

  function makeInput(overrides: Partial<IntakeInput> = {}): IntakeInput {
    return {
      workspaceId,
      productId,
      actor: { type: "founder", id: "founder-1" },
      person: {
        firstName: "Grace",
        lastName: "Hopper",
        email: "grace@example.com",
        source: "website_application",
      },
      application: {
        formVersion: "v1",
        rawPayloadJson: { answers: { goal: "career change" } },
        sourceReference: "web-form",
      },
      ...overrides,
    };
  }

  it("FOS0-CORE-02: creates exactly one Person, one EnrollmentOpportunity, one ApplicationSubmission", async () => {
    const result = await intakeApplication(ctx.db, makeInput());

    expect(result.deduped).toBe(false);
    const people = await ctx.db.select().from(person);
    const opportunities = await ctx.db.select().from(enrollmentOpportunity);
    const submissions = await ctx.db.select().from(applicationSubmission);

    expect(people).toHaveLength(1);
    expect(opportunities).toHaveLength(1);
    expect(submissions).toHaveLength(1);
    expect(opportunities[0]!.stage).toBe("new_lead");
    expect(opportunities[0]!.productId).toBe(productId);
  });

  it("FOS0-CORE-03: emits exactly 3 events (person.created, opportunity.created, application.received) sharing ONE correlation_id", async () => {
    const result = await intakeApplication(ctx.db, makeInput());

    const events = await ctx.db.select().from(operationalEvent);
    expect(events).toHaveLength(3);

    const types = events.map((e: typeof operationalEvent.$inferSelect) => e.type).sort();
    expect(types).toEqual(["application.received", "opportunity.created", "person.created"]);

    const correlationIds = new Set(
      events.map((e: typeof operationalEvent.$inferSelect) => e.correlationId),
    );
    expect(correlationIds.size).toBe(1);
    expect(result.correlationId).not.toBeNull();
    expect([...correlationIds][0]).toBe(result.correlationId);
    expect(result.eventIds).toHaveLength(3);
  });

  it("FOS0-CORE-04: a duplicate intake (same derived idempotency key) creates zero new rows and zero new events", async () => {
    const first = await intakeApplication(ctx.db, makeInput());
    const second = await intakeApplication(ctx.db, makeInput());

    expect(second.deduped).toBe(true);
    expect(second.personId).toBe(first.personId);
    expect(second.opportunityId).toBe(first.opportunityId);
    expect(second.submissionId).toBe(first.submissionId);
    expect(second.eventIds).toHaveLength(0);

    const people = await ctx.db.select().from(person);
    const opportunities = await ctx.db.select().from(enrollmentOpportunity);
    const submissions = await ctx.db.select().from(applicationSubmission);
    const events = await ctx.db.select().from(operationalEvent);

    expect(people).toHaveLength(1);
    expect(opportunities).toHaveLength(1);
    expect(submissions).toHaveLength(1);
    expect(events).toHaveLength(3); // still just the first intake's 3 events
  });

  it("FOS0-CORE-05: a different person/application (different natural key) is NOT deduped", async () => {
    await intakeApplication(ctx.db, makeInput());
    const second = await intakeApplication(
      ctx.db,
      makeInput({
        person: {
          firstName: "Ada",
          lastName: "Lovelace",
          email: "ada@example.com",
          source: "referral",
        },
      }),
    );

    expect(second.deduped).toBe(false);
    const people = await ctx.db.select().from(person);
    expect(people).toHaveLength(2);
  });

  it("FOS0-CORE-06: application.received references the opportunity created in the same intake", async () => {
    const result = await intakeApplication(ctx.db, makeInput());
    const [submission] = await ctx.db
      .select()
      .from(applicationSubmission)
      .where(eq(applicationSubmission.id, result.submissionId));
    expect(submission!.opportunityId).toBe(result.opportunityId);
    expect(submission!.personId).toBe(result.personId);
  });

  // Issue #6 / PATCH-SET-01 §S3: person_natural_key is undefined by spec.
  // This slice's definition (email, else firstName|lastName|phone) degrades
  // to firstName|lastName when both email and phone are absent, so two
  // distinct applicants sharing a name silently collide. Documented as a
  // known, accepted (non-blocking) limitation — these tests prove it holds
  // and contrast it against the cases that are correctly NOT deduped.
  it("FOS0-CORE-08: two distinct applicants with the same name and no email/phone silently collide (documented limitation)", async () => {
    const first = await intakeApplication(
      ctx.db,
      makeInput({
        person: { firstName: "Sam", lastName: "Lee", source: "website_application" },
      }),
    );
    const second = await intakeApplication(
      ctx.db,
      makeInput({
        person: { firstName: "Sam", lastName: "Lee", source: "website_application" },
        application: {
          formVersion: "v1",
          rawPayloadJson: { answers: { goal: "a completely different application" } },
          sourceReference: "web-form-2",
        },
      }),
    );

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.personId).toBe(first.personId);

    const people = await ctx.db.select().from(person);
    expect(people).toHaveLength(1); // the second (distinct) applicant was NOT recorded
  });

  it("FOS0-CORE-09: two applicants with the same name but different phone numbers are NOT deduped", async () => {
    const first = await intakeApplication(
      ctx.db,
      makeInput({
        person: {
          firstName: "Sam",
          lastName: "Lee",
          phone: "+1-555-0100",
          source: "website_application",
        },
      }),
    );
    const second = await intakeApplication(
      ctx.db,
      makeInput({
        person: {
          firstName: "Sam",
          lastName: "Lee",
          phone: "+1-555-0199",
          source: "website_application",
        },
      }),
    );

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(false);
    expect(second.personId).not.toBe(first.personId);

    const people = await ctx.db.select().from(person);
    expect(people).toHaveLength(2);
  });
});
