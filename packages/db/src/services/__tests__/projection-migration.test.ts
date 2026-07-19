import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./pglite-db.js";
import { seedWorkspaceAndProduct, seedPerson, seedOpportunity } from "./fixtures.js";
import { projection } from "../../schema/projection.js";

describe("slice 0.2b migration applies clean on empty DB (issue #27)", () => {
  it("FOS0-PRJ-08: all migrations (incl. projection) apply to a fresh PGlite instance; the table is queryable", async () => {
    const { db, close } = await createTestDb();
    try {
      expect(await db.select().from(projection)).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe("projection entity round-trip (issue #27)", () => {
  it("FOS0-PRJ-09: a projection row inserts and reads back with defaults applied", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, product } = await seedWorkspaceAndProduct(ctx.db);
      const person = await seedPerson(ctx.db, workspace.id);
      const opportunity = await seedOpportunity(ctx.db, {
        workspaceId: workspace.id,
        productId: product.id,
        personId: person.id,
      });

      const [inserted] = await ctx.db
        .insert(projection)
        .values({
          workspaceId: workspace.id,
          productId: product.id,
          entityType: "EnrollmentOpportunity",
          entityId: opportunity.id,
          provider: "notion",
          fosVersion: opportunity.version,
        })
        .returning();
      if (!inserted) throw new Error("projection insert returned no row");

      expect(inserted.syncStatus).toBe("pending");
      expect(inserted.providerPageId).toBeNull();
      expect(inserted.lastSyncedAt).toBeNull();

      const [reread] = await ctx.db.select().from(projection).where(eq(projection.id, inserted.id));
      expect(reread).toMatchObject({
        workspaceId: workspace.id,
        productId: product.id,
        entityType: "EnrollmentOpportunity",
        entityId: opportunity.id,
        provider: "notion",
        syncStatus: "pending",
      });
    } finally {
      await ctx.close();
    }
  });

  it("FOS0-PRJ-10: UNIQUE (workspace_id, entity_type, entity_id, provider) rejects a second row for the same entity", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, product } = await seedWorkspaceAndProduct(ctx.db);
      const person = await seedPerson(ctx.db, workspace.id);
      const opportunity = await seedOpportunity(ctx.db, {
        workspaceId: workspace.id,
        productId: product.id,
        personId: person.id,
      });

      await ctx.db.insert(projection).values({
        workspaceId: workspace.id,
        productId: product.id,
        entityType: "EnrollmentOpportunity",
        entityId: opportunity.id,
        provider: "notion",
        fosVersion: opportunity.version,
      });

      await expect(
        ctx.db.insert(projection).values({
          workspaceId: workspace.id,
          productId: product.id,
          entityType: "EnrollmentOpportunity",
          entityId: opportunity.id,
          provider: "notion",
          fosVersion: opportunity.version,
        }),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });

  it("FOS0-PRJ-11: workspace_id is a required FK — a bogus workspace_id is rejected", async () => {
    const ctx = await createTestDb();
    try {
      await expect(
        ctx.db.insert(projection).values({
          workspaceId: "00000000-0000-0000-0000-000000000000",
          entityType: "EnrollmentOpportunity",
          entityId: "some-entity-id",
          provider: "notion",
          fosVersion: 1,
        }),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });
});
