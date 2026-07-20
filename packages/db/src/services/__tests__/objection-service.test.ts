import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./pglite-db.js";
import { seedWorkspaceAndProduct, seedPerson, seedOpportunity } from "./fixtures.js";
import { objectionRecord } from "../../schema/objection_record.js";
import { interaction } from "../../schema/interaction.js";
import {
  createObjection,
  getObjectionById,
  updateObjectionResolution,
  StaleObjectionVersionError,
  ObjectionNotFoundError,
} from "../objection-service.js";
import { createInteraction } from "../interaction-service.js";

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

describe("objection_record migration applies clean (issue #70)", () => {
  it("FOS1-OBJ-01: the objection_record table is queryable on a fresh PGlite instance", async () => {
    const ctx = await createTestDb();
    try {
      expect(await ctx.db.select().from(objectionRecord)).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});

describe("objection_record entity (issue #70 P1.4a)", () => {
  it("FOS1-OBJ-02: workspace_id is a required FK — a bogus workspace_id is rejected", async () => {
    const ctx = await createTestDb();
    try {
      const { opportunity } = await seedFullOpportunity(ctx.db);
      await expect(
        createObjection(ctx.db, {
          workspaceId: NIL_UUID,
          opportunityId: opportunity.id,
          category: "price",
          statement: "Too expensive",
          classification: "observed",
        }),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-OBJ-03: opportunity_id is a required FK — a bogus opportunity_id is rejected", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace } = await seedWorkspaceAndProduct(ctx.db);
      await expect(
        createObjection(ctx.db, {
          workspaceId: workspace.id,
          opportunityId: NIL_UUID,
          category: "price",
          statement: "Too expensive",
          classification: "observed",
        }),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-OBJ-04: source_interaction_id accepts null (objection inferred without a recorded conversation)", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, opportunity } = await seedFullOpportunity(ctx.db);
      const row = await createObjection(ctx.db, {
        workspaceId: workspace.id,
        opportunityId: opportunity.id,
        category: "price",
        statement: "Too expensive",
        classification: "inferred",
      });
      expect(row.sourceInteractionId).toBeNull();
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-OBJ-05: source_interaction_id, when present, is enforced as a real interaction FK", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, opportunity } = await seedFullOpportunity(ctx.db);
      await expect(
        createObjection(ctx.db, {
          workspaceId: workspace.id,
          opportunityId: opportunity.id,
          category: "price",
          statement: "Too expensive",
          classification: "observed",
          sourceInteractionId: NIL_UUID,
        }),
      ).rejects.toThrow();

      const source = await createInteraction(ctx.db, {
        workspaceId: workspace.id,
        opportunityId: opportunity.id,
        interactionType: "discovery_call",
      });
      const row = await createObjection(ctx.db, {
        workspaceId: workspace.id,
        opportunityId: opportunity.id,
        category: "price",
        statement: "Too expensive",
        classification: "observed",
        sourceInteractionId: source.id,
      });
      expect(row.sourceInteractionId).toBe(source.id);

      const [reread] = await ctx.db.select().from(interaction).where(eq(interaction.id, source.id));
      expect(reread).toBeDefined();
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-OBJ-06: createObjection inserts with defaults applied (resolution_status=open, version=1)", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, opportunity } = await seedFullOpportunity(ctx.db);
      const row = await createObjection(ctx.db, {
        workspaceId: workspace.id,
        opportunityId: opportunity.id,
        category: "price",
        statement: "Too expensive",
        classification: "observed",
      });

      expect(row.resolutionStatus).toBe("open");
      expect(row.version).toBe(1);
      expect(row.resolutionSummary).toBeNull();

      const [reread] = await ctx.db
        .select()
        .from(objectionRecord)
        .where(eq(objectionRecord.id, row.id));
      expect(reread).toMatchObject({
        workspaceId: workspace.id,
        opportunityId: opportunity.id,
        category: "price",
        resolutionStatus: "open",
        version: 1,
      });
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-OBJ-07: getObjectionById returns the row when the workspace matches", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, opportunity } = await seedFullOpportunity(ctx.db);
      const row = await createObjection(ctx.db, {
        workspaceId: workspace.id,
        opportunityId: opportunity.id,
        category: "price",
        statement: "Too expensive",
        classification: "observed",
      });

      const found = await getObjectionById(ctx.db, workspace.id, row.id);
      expect(found).toMatchObject({ id: row.id, workspaceId: workspace.id });
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-OBJ-08: getObjectionById returns null for a cross-workspace id", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, opportunity } = await seedFullOpportunity(ctx.db);
      const row = await createObjection(ctx.db, {
        workspaceId: workspace.id,
        opportunityId: opportunity.id,
        category: "price",
        statement: "Too expensive",
        classification: "observed",
      });

      const { workspace: otherWorkspace } = await seedWorkspaceAndProduct(ctx.db);
      const found = await getObjectionById(ctx.db, otherWorkspace.id, row.id);
      expect(found).toBeNull();

      const missing = await getObjectionById(ctx.db, workspace.id, NIL_UUID);
      expect(missing).toBeNull();
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-OBJ-09: updateObjectionResolution round-trips a resolution change and bumps version", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, opportunity } = await seedFullOpportunity(ctx.db);
      const row = await createObjection(ctx.db, {
        workspaceId: workspace.id,
        opportunityId: opportunity.id,
        category: "price",
        statement: "Too expensive",
        classification: "observed",
      });

      const updated = await updateObjectionResolution(ctx.db, {
        objectionId: row.id,
        expectedVersion: 1,
        resolutionStatus: "addressed",
        resolutionSummary: "Offered payment plan",
      });

      expect(updated.resolutionStatus).toBe("addressed");
      expect(updated.resolutionSummary).toBe("Offered payment plan");
      expect(updated.version).toBe(2);

      const [reread] = await ctx.db
        .select()
        .from(objectionRecord)
        .where(eq(objectionRecord.id, row.id));
      expect(reread).toMatchObject({ resolutionStatus: "addressed", version: 2 });
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-OBJ-10: updateObjectionResolution throws on a stale expectedVersion and writes nothing", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, opportunity } = await seedFullOpportunity(ctx.db);
      const row = await createObjection(ctx.db, {
        workspaceId: workspace.id,
        opportunityId: opportunity.id,
        category: "price",
        statement: "Too expensive",
        classification: "observed",
      });

      await expect(
        updateObjectionResolution(ctx.db, {
          objectionId: row.id,
          expectedVersion: 99,
          resolutionStatus: "addressed",
        }),
      ).rejects.toThrow(StaleObjectionVersionError);

      const [reread] = await ctx.db
        .select()
        .from(objectionRecord)
        .where(eq(objectionRecord.id, row.id));
      expect(reread).toMatchObject({ resolutionStatus: "open", version: 1 });
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-OBJ-11: updateObjectionResolution on a nonexistent id throws ObjectionNotFoundError", async () => {
    const ctx = await createTestDb();
    try {
      await expect(
        updateObjectionResolution(ctx.db, {
          objectionId: NIL_UUID,
          expectedVersion: 1,
          resolutionStatus: "addressed",
        }),
      ).rejects.toThrow(ObjectionNotFoundError);
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-OBJ-12: the resolution_status CHECK constraint rejects a value outside the allowed set", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, opportunity } = await seedFullOpportunity(ctx.db);
      await expect(
        createObjection(ctx.db, {
          workspaceId: workspace.id,
          opportunityId: opportunity.id,
          category: "price",
          statement: "Too expensive",
          classification: "observed",
          resolutionStatus: "bogus_status",
        }),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });
});
