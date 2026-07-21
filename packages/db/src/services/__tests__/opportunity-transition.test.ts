import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./pglite-db.js";
import { seedWorkspaceAndProduct, seedPerson, seedOpportunity } from "./fixtures.js";
import {
  transitionOpportunity,
  IllegalTransitionError,
  StaleVersionError,
} from "../opportunity-transition-service.js";
import { LEGAL_EDGES, ILLEGAL_EDGES } from "../opportunity-transitions.js";
import { operationalEvent } from "../../schema/operational_event.js";
import { enrollmentOpportunity } from "../../schema/enrollment_opportunity.js";
import type { Db } from "../types.js";

/**
 * Simulates the UPDATE-loses-the-race half of issue #58: PGlite is
 * single-connection, so two genuinely overlapping transactions can't be
 * produced here. This forces the in-transaction SELECT to return a stale
 * snapshot (as a losing concurrent transaction would have read) while the
 * real UPDATE and the fix's re-read both hit the real, already-advanced row.
 */
function withForcedStaleSnapshot(db: Db, staleRow: typeof enrollmentOpportunity.$inferSelect): Db {
  const wrapped = Object.create(db) as Db;
  wrapped.transaction = ((cb: (tx: Db) => Promise<unknown>) =>
    db.transaction.call(db, (tx: Db) => {
      let selectCalls = 0;
      const forcedTx = Object.create(tx) as Db;
      forcedTx.select = ((...args: Parameters<Db["select"]>) => {
        selectCalls += 1;
        if (selectCalls === 1) {
          return { from: () => ({ where: () => ({ limit: async () => [staleRow] }) }) };
        }
        return (tx.select as (...a: Parameters<Db["select"]>) => ReturnType<Db["select"]>)(...args);
      }) as unknown as Db["select"];
      return cb(forcedTx);
    })) as Db["transaction"];
  return wrapped;
}

describe("opportunity transition service (spec §12.1 — full transition matrix)", () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>;
  let workspaceId: string;
  let productId: string;
  let personId: string;

  beforeEach(async () => {
    ctx = await createTestDb();
    const seeded = await seedWorkspaceAndProduct(ctx.db);
    workspaceId = seeded.workspace.id;
    productId = seeded.product.id;
    const p = await seedPerson(ctx.db, workspaceId);
    personId = p.id;
  });

  afterEach(async () => {
    await ctx.close();
  });

  it(`FOS0-CORE-10: covers all ${LEGAL_EDGES.length} legal §12.1 edges — each succeeds, bumps version, emits opportunity.stage_changed`, async () => {
    expect(LEGAL_EDGES.length).toBe(28);

    for (const [from, to] of LEGAL_EDGES) {
      const opp = await seedOpportunity(ctx.db, { workspaceId, productId, personId, stage: from });

      const result = await transitionOpportunity(ctx.db, {
        opportunityId: opp.id,
        toStage: to,
        expectedVersion: 1,
        actor: { type: "founder", id: "founder-1" },
      });

      expect(result.fromStage).toBe(from);
      expect(result.toStage).toBe(to);
      expect(result.version).toBe(2);

      const [row] = await ctx.db
        .select()
        .from(enrollmentOpportunity)
        .where(eq(enrollmentOpportunity.id, opp.id));
      expect(row!.stage).toBe(to);
      expect(row!.version).toBe(2);

      const events = await ctx.db
        .select()
        .from(operationalEvent)
        .where(eq(operationalEvent.entityId, opp.id));
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("opportunity.stage_changed");
      expect(events[0]!.payload).toEqual({ from, to, version: 2 });
    }
  });

  it(`FOS0-CORE-11: rejects all ${ILLEGAL_EDGES.length} illegal §12.1 pairs (incl. self-transitions) — throws, no stage change, no event`, async () => {
    // 11 states x 11 states minus the 28 legal edges.
    expect(ILLEGAL_EDGES.length).toBe(121 - 28);

    for (const [from, to] of ILLEGAL_EDGES) {
      const opp = await seedOpportunity(ctx.db, { workspaceId, productId, personId, stage: from });

      await expect(
        transitionOpportunity(ctx.db, {
          opportunityId: opp.id,
          toStage: to,
          expectedVersion: 1,
          actor: { type: "founder", id: "founder-1" },
        }),
      ).rejects.toBeInstanceOf(IllegalTransitionError);

      const [row] = await ctx.db
        .select()
        .from(enrollmentOpportunity)
        .where(eq(enrollmentOpportunity.id, opp.id));
      expect(row!.stage).toBe(from); // unchanged
      expect(row!.version).toBe(1); // unchanged

      const events = await ctx.db
        .select()
        .from(operationalEvent)
        .where(eq(operationalEvent.entityId, opp.id));
      expect(events).toHaveLength(0); // nothing emitted
    }
  });

  it("FOS0-CORE-12: rejects a stale-version transition (even on an otherwise-legal edge) and emits nothing", async () => {
    const opp = await seedOpportunity(ctx.db, {
      workspaceId,
      productId,
      personId,
      stage: "new_lead",
    });

    await expect(
      transitionOpportunity(ctx.db, {
        opportunityId: opp.id,
        toStage: "reviewing",
        expectedVersion: 99, // stale
        actor: { type: "founder", id: "founder-1" },
      }),
    ).rejects.toBeInstanceOf(StaleVersionError);

    const [row] = await ctx.db
      .select()
      .from(enrollmentOpportunity)
      .where(eq(enrollmentOpportunity.id, opp.id));
    expect(row!.stage).toBe("new_lead");
    expect(row!.version).toBe(1);

    const events = await ctx.db
      .select()
      .from(operationalEvent)
      .where(eq(operationalEvent.entityId, opp.id));
    expect(events).toHaveLength(0);
  });

  it("FOS0-CORE-13: a legal transition against a stale version is still rejected as stale (version check precedes transition check)", async () => {
    const opp = await seedOpportunity(ctx.db, {
      workspaceId,
      productId,
      personId,
      stage: "new_lead",
    });
    // Advance it once so current version is 2.
    await transitionOpportunity(ctx.db, {
      opportunityId: opp.id,
      toStage: "reviewing",
      expectedVersion: 1,
      actor: { type: "founder", id: "founder-1" },
    });

    // Retry with the now-stale expectedVersion: 1 against a legal reviewing -> contacted edge.
    await expect(
      transitionOpportunity(ctx.db, {
        opportunityId: opp.id,
        toStage: "contacted",
        expectedVersion: 1,
        actor: { type: "founder", id: "founder-1" },
      }),
    ).rejects.toBeInstanceOf(StaleVersionError);
  });

  it("issue #58: a lost race reports the TRUE current version, not the stale expectedVersion", async () => {
    const staleSnapshot = await seedOpportunity(ctx.db, {
      workspaceId,
      productId,
      personId,
      stage: "new_lead",
    });

    // Advance it for real, so the DB now holds version 2 / stage "reviewing" —
    // what a losing concurrent transaction would NOT have seen.
    await transitionOpportunity(ctx.db, {
      opportunityId: staleSnapshot.id,
      toStage: "reviewing",
      expectedVersion: 1,
      actor: { type: "founder", id: "founder-1" },
    });

    const raceDb = withForcedStaleSnapshot(ctx.db, staleSnapshot);

    let caught: unknown;
    try {
      await transitionOpportunity(raceDb, {
        opportunityId: staleSnapshot.id,
        toStage: "disqualified",
        expectedVersion: 1,
        actor: { type: "founder", id: "founder-1" },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(StaleVersionError);
    const err = caught as StaleVersionError;
    expect(err.expectedVersion).toBe(1);
    // The bug reported `actualVersion: 1` here (the stale snapshot's version,
    // which was asserted equal to expectedVersion one line earlier). The fix
    // re-reads and reports the true current version: 2.
    expect(err.actualVersion).toBe(2);

    // No partial/duplicate effect: still at the real (reviewing, v2) state.
    const [row] = await ctx.db
      .select()
      .from(enrollmentOpportunity)
      .where(eq(enrollmentOpportunity.id, staleSnapshot.id));
    expect(row!.stage).toBe("reviewing");
    expect(row!.version).toBe(2);

    const events = await ctx.db
      .select()
      .from(operationalEvent)
      .where(eq(operationalEvent.entityId, staleSnapshot.id));
    expect(events).toHaveLength(1); // only the real "reviewing" transition's event
  });
});
