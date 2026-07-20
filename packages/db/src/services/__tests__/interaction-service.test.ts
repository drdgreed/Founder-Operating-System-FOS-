import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./pglite-db.js";
import { seedWorkspaceAndProduct, seedPerson, seedOpportunity } from "./fixtures.js";
import { interaction } from "../../schema/interaction.js";
import {
  createInteraction,
  getInteractionById,
  updateInteractionStatus,
  StaleInteractionVersionError,
  InteractionNotFoundError,
} from "../interaction-service.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

async function seedFullOpportunity(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  const { workspace, product } = await seedWorkspaceAndProduct(db);
  const person = await seedPerson(db, workspace.id);
  const opportunity = await seedOpportunity(db, {
    workspaceId: workspace.id,
    productId: product.id,
    personId: person.id,
  });
  return { workspace, product, person, opportunity };
}

describe("interaction migration applies clean (issue #56)", () => {
  it("FOS1-INT-01: the interaction table is queryable on a fresh PGlite instance", async () => {
    const ctx = await createTestDb();
    try {
      expect(await ctx.db.select().from(interaction)).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});

describe("interaction entity (issue #56 P1.3a)", () => {
  it("FOS1-INT-02: workspace_id is a required FK — a bogus workspace_id is rejected", async () => {
    const ctx = await createTestDb();
    try {
      const { opportunity } = await seedFullOpportunity(ctx.db);
      await expect(
        createInteraction(ctx.db, {
          workspaceId: NIL_UUID,
          opportunityId: opportunity.id,
          interactionType: "call",
        }),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-INT-03: opportunity_id is a required FK — a bogus opportunity_id is rejected", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace } = await seedWorkspaceAndProduct(ctx.db);
      await expect(
        createInteraction(ctx.db, {
          workspaceId: workspace.id,
          opportunityId: NIL_UUID,
          interactionType: "call",
        }),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-INT-04: createInteraction inserts with defaults applied (status=scheduled, version=1)", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, opportunity } = await seedFullOpportunity(ctx.db);

      const row = await createInteraction(ctx.db, {
        workspaceId: workspace.id,
        opportunityId: opportunity.id,
        interactionType: "discovery_call",
      });

      expect(row.status).toBe("scheduled");
      expect(row.version).toBe(1);
      expect(row.notes).toBeNull();
      expect(row.transcriptRef).toBeNull();
      expect(row.occurredAt).toBeNull();

      const [reread] = await ctx.db.select().from(interaction).where(eq(interaction.id, row.id));
      expect(reread).toMatchObject({
        workspaceId: workspace.id,
        opportunityId: opportunity.id,
        interactionType: "discovery_call",
        status: "scheduled",
        version: 1,
      });
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-INT-05: getInteractionById returns the row when the workspace matches", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, opportunity } = await seedFullOpportunity(ctx.db);
      const row = await createInteraction(ctx.db, {
        workspaceId: workspace.id,
        opportunityId: opportunity.id,
        interactionType: "discovery_call",
      });

      const found = await getInteractionById(ctx.db, workspace.id, row.id);
      expect(found).toMatchObject({ id: row.id, workspaceId: workspace.id });
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-INT-06: getInteractionById returns null for a cross-workspace id", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, opportunity } = await seedFullOpportunity(ctx.db);
      const row = await createInteraction(ctx.db, {
        workspaceId: workspace.id,
        opportunityId: opportunity.id,
        interactionType: "discovery_call",
      });

      const { workspace: otherWorkspace } = await seedWorkspaceAndProduct(ctx.db);
      const found = await getInteractionById(ctx.db, otherWorkspace.id, row.id);
      expect(found).toBeNull();

      // Also null for a genuinely nonexistent id under a real workspace.
      const missing = await getInteractionById(ctx.db, workspace.id, NIL_UUID);
      expect(missing).toBeNull();
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-INT-07: updateInteractionStatus round-trips a status change and bumps version", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, opportunity } = await seedFullOpportunity(ctx.db);
      const row = await createInteraction(ctx.db, {
        workspaceId: workspace.id,
        opportunityId: opportunity.id,
        interactionType: "discovery_call",
      });

      const occurredAt = new Date();
      const updated = await updateInteractionStatus(ctx.db, {
        interactionId: row.id,
        expectedVersion: 1,
        status: "completed",
        occurredAt,
      });

      expect(updated.status).toBe("completed");
      expect(updated.version).toBe(2);
      expect(updated.occurredAt?.toISOString()).toBe(occurredAt.toISOString());

      const [reread] = await ctx.db.select().from(interaction).where(eq(interaction.id, row.id));
      expect(reread).toMatchObject({ status: "completed", version: 2 });
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-INT-08: updateInteractionStatus throws on a stale expectedVersion and writes nothing", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, opportunity } = await seedFullOpportunity(ctx.db);
      const row = await createInteraction(ctx.db, {
        workspaceId: workspace.id,
        opportunityId: opportunity.id,
        interactionType: "discovery_call",
      });

      await expect(
        updateInteractionStatus(ctx.db, {
          interactionId: row.id,
          expectedVersion: 99,
          status: "completed",
        }),
      ).rejects.toThrow(StaleInteractionVersionError);

      const [reread] = await ctx.db.select().from(interaction).where(eq(interaction.id, row.id));
      expect(reread).toMatchObject({ status: "scheduled", version: 1 });
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-INT-09: updateInteractionStatus on a nonexistent id throws InteractionNotFoundError", async () => {
    const ctx = await createTestDb();
    try {
      // No interaction is created — the id is genuinely absent.
      await expect(
        updateInteractionStatus(ctx.db, {
          interactionId: NIL_UUID,
          expectedVersion: 1,
          status: "completed",
        }),
      ).rejects.toThrow(InteractionNotFoundError);
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-INT-10: createInteraction honors an explicit caller-supplied status (not silently defaulted)", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, opportunity } = await seedFullOpportunity(ctx.db);
      const row = await createInteraction(ctx.db, {
        workspaceId: workspace.id,
        opportunityId: opportunity.id,
        interactionType: "discovery_call",
        status: "no_show",
      });
      expect(row.status).toBe("no_show");

      const [reread] = await ctx.db.select().from(interaction).where(eq(interaction.id, row.id));
      expect(reread).toMatchObject({ status: "no_show" });
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-INT-11: the status CHECK constraint rejects a value outside the allowed set", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, opportunity } = await seedFullOpportunity(ctx.db);
      await expect(
        createInteraction(ctx.db, {
          workspaceId: workspace.id,
          opportunityId: opportunity.id,
          interactionType: "discovery_call",
          status: "bogus_status",
        }),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });
});
