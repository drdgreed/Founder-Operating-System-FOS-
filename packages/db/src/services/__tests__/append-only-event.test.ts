import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./pglite-db.js";
import { seedWorkspaceAndProduct } from "./fixtures.js";
import { operationalEvent } from "../../schema/operational_event.js";

describe("operational_event append-only guard (spec §9.7 / §17.8, migration 0001)", () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>;
  let eventId: string;

  beforeEach(async () => {
    ctx = await createTestDb();
    const { workspace } = await seedWorkspaceAndProduct(ctx.db);
    const [row] = await ctx.db
      .insert(operationalEvent)
      .values({
        workspaceId: workspace.id,
        entityType: "Person",
        entityId: "some-id",
        source: "api",
        correlationId: "00000000-0000-0000-0000-000000000001",
        occurredAt: new Date(),
        actorType: "founder",
        actorId: "founder-1",
        type: "person.created",
        payload: {},
      })
      .returning();
    eventId = row!.id;
  });

  afterEach(async () => {
    await ctx.close();
  });

  it("FOS0-CORE-20: a direct UPDATE raises at the DB layer", async () => {
    await expect(
      ctx.db
        .update(operationalEvent)
        .set({ type: "tampered" })
        .where(eq(operationalEvent.id, eventId)),
    ).rejects.toSatisfy((err: unknown) => causeChainMatches(err, /append-only/i));
  });

  it("FOS0-CORE-21: a direct DELETE raises at the DB layer", async () => {
    await expect(
      ctx.db.delete(operationalEvent).where(eq(operationalEvent.id, eventId)),
    ).rejects.toSatisfy((err: unknown) => causeChainMatches(err, /append-only/i));
  });
});

/**
 * Drizzle wraps the underlying Postgres error ("operational_event is
 * append-only: ...", raised by the trigger) inside a "Failed query: ..."
 * error and chains the original via `.cause`. Walk the cause chain so the
 * assertion is robust to that wrapping.
 */
function causeChainMatches(err: unknown, pattern: RegExp): boolean {
  let current: unknown = err;
  for (let i = 0; i < 10 && current; i += 1) {
    if (current instanceof Error && pattern.test(current.message)) return true;
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}
