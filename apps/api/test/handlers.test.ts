import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { handleIntake, handleTransition } from "../lib/handlers.js";
import { createTestDb, seedWorkspaceAndProduct } from "./helpers.js";
import { operationalEvent, person, enrollmentOpportunity } from "@fos/db/schema";
import type { Principal } from "../lib/auth.js";

const SYSTEM_PRINCIPAL = (workspaceId: string): Principal => ({
  workspaceId,
  actor: { type: "system", id: "service-account" },
});

// Regex of substrings that must NEVER appear in a client-facing error body.
const LEAK_PATTERN =
  /operational_event|enrollment_opportunity|drizzle|postgres|pglite|stack|node_modules|at Object\./i;

describe("route handler cores (security regressions)", () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    ctx = await createTestDb();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it("FOS0-SEC-05: intake IGNORES a client-supplied actor; audit rows carry the SERVER actor (audit-poisoning regression)", async () => {
    const { workspace, product } = await seedWorkspaceAndProduct(ctx.db);
    const body = {
      productId: product.id,
      // Hostile fields an attacker injects — MUST be ignored by the schema:
      actor: { type: "founder", id: "attacker" },
      workspaceId: "99999999-9999-9999-9999-999999999999",
      person: {
        firstName: "Grace",
        lastName: "Hopper",
        email: "grace@example.com",
        source: "website_application",
      },
      application: { formVersion: "v1", rawPayloadJson: { goal: "x" }, sourceReference: "web" },
    };

    const res = await handleIntake(ctx.db, SYSTEM_PRINCIPAL(workspace.id), body);
    expect(res.status).toBe(201);

    const events = await ctx.db.select().from(operationalEvent);
    expect(events).toHaveLength(3);
    for (const e of events) {
      // The persisted actor is the server principal, NOT the client's "founder/attacker".
      expect(e.actorType).toBe("system");
      expect(e.actorId).toBe("service-account");
      expect(e.workspaceId).toBe(workspace.id); // not the forged workspace id
    }
  });

  it("FOS0-SEC-06: intake with a productId from ANOTHER workspace -> 403, nothing written (IDOR)", async () => {
    const a = await seedWorkspaceAndProduct(ctx.db, "a");
    const b = await seedWorkspaceAndProduct(ctx.db, "b");
    const body = {
      productId: b.product.id, // belongs to workspace B
      person: { firstName: "Ada", lastName: "Lovelace", source: "manual" },
      application: { formVersion: "v1", rawPayloadJson: {}, sourceReference: "web" },
    };

    const res = await handleIntake(ctx.db, SYSTEM_PRINCIPAL(a.workspace.id), body);
    expect(res.status).toBe(403);
    expect(await ctx.db.select().from(person)).toHaveLength(0);
    expect(await ctx.db.select().from(enrollmentOpportunity)).toHaveLength(0);
    expect(await ctx.db.select().from(operationalEvent)).toHaveLength(0);
  });

  it("FOS0-SEC-07: invalid intake body -> 400 generic, no internal/DB/stack text leaked", async () => {
    const { workspace, product } = await seedWorkspaceAndProduct(ctx.db);
    const res = await handleIntake(ctx.db, SYSTEM_PRINCIPAL(workspace.id), {
      productId: product.id,
      person: { firstName: "" }, // missing required fields
      application: {},
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(LEAK_PATTERN);
    expect(await ctx.db.select().from(person)).toHaveLength(0);
  });

  it("FOS0-SEC-08: unexpected service error -> 500 generic, internal detail NOT leaked", async () => {
    const productId = "22222222-2222-2222-2222-222222222222";
    // Fake db: passes the product tenant check, then blows up inside the service.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const throwingDb: any = {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [{ id: productId }] }) }),
      }),
      transaction: async () => {
        throw new Error("BOOM: secret internal detail xyz123");
      },
    };
    const body = {
      productId,
      person: { firstName: "A", lastName: "B", source: "manual" },
      application: { formVersion: "v1", rawPayloadJson: {}, sourceReference: "web" },
    };

    const res = await handleIntake(
      throwingDb,
      SYSTEM_PRINCIPAL("11111111-1111-1111-1111-111111111111"),
      body,
    );
    expect(res.status).toBe(500);
    expect((res.body as { error: string }).error).toBe("internal error");
    expect(JSON.stringify(res.body)).not.toMatch(/BOOM|secret|xyz123/);
  });

  it("FOS0-SEC-09: transition on an opportunity in ANOTHER workspace -> 404, nothing changed (IDOR)", async () => {
    const a = await seedWorkspaceAndProduct(ctx.db, "a");
    const b = await seedWorkspaceAndProduct(ctx.db, "b");
    const [personB] = await ctx.db
      .insert(person)
      .values({
        workspaceId: b.workspace.id,
        firstName: "X",
        lastName: "Y",
        source: "manual",
        lifecycleType: "applicant",
      })
      .returning();
    const [oppB] = await ctx.db
      .insert(enrollmentOpportunity)
      .values({
        workspaceId: b.workspace.id,
        productId: b.product.id,
        personId: personB!.id,
        stage: "new_lead",
        currency: "USD",
        version: 1,
      })
      .returning();

    const res = await handleTransition(ctx.db, SYSTEM_PRINCIPAL(a.workspace.id), oppB!.id, {
      to_stage: "reviewing",
      expected_version: 1,
    });
    expect(res.status).toBe(404);
    expect(await ctx.db.select().from(operationalEvent)).toHaveLength(0);
    const [row] = await ctx.db
      .select()
      .from(enrollmentOpportunity)
      .where(eq(enrollmentOpportunity.id, oppB!.id));
    expect(row!.stage).toBe("new_lead"); // unchanged
    expect(row!.version).toBe(1);
  });

  it("FOS0-SEC-10: legal transition persists the SERVER actor, ignoring a client-supplied actor", async () => {
    const { workspace, product } = await seedWorkspaceAndProduct(ctx.db);
    const [pers] = await ctx.db
      .insert(person)
      .values({
        workspaceId: workspace.id,
        firstName: "Grace",
        lastName: "Hopper",
        source: "manual",
        lifecycleType: "applicant",
      })
      .returning();
    const [opp] = await ctx.db
      .insert(enrollmentOpportunity)
      .values({
        workspaceId: workspace.id,
        productId: product.id,
        personId: pers!.id,
        stage: "new_lead",
        currency: "USD",
        version: 1,
      })
      .returning();

    const res = await handleTransition(ctx.db, SYSTEM_PRINCIPAL(workspace.id), opp!.id, {
      to_stage: "reviewing",
      expected_version: 1,
      // Injected hostile actor — must be stripped by the schema and ignored:
      actor: { type: "founder", id: "attacker" },
    });
    expect(res.status).toBe(200);

    const events = await ctx.db.select().from(operationalEvent);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("opportunity.stage_changed");
    expect(events[0]!.actorType).toBe("system");
    expect(events[0]!.actorId).toBe("service-account");
  });

  it("FOS0-SEC-11: invalid transition body -> 400 generic, no leak", async () => {
    const { workspace } = await seedWorkspaceAndProduct(ctx.db);
    const res = await handleTransition(
      ctx.db,
      SYSTEM_PRINCIPAL(workspace.id),
      "33333333-3333-3333-3333-333333333333",
      {
        to_stage: "not_a_real_stage",
        expected_version: "not-a-number",
      },
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(LEAK_PATTERN);
  });
});
