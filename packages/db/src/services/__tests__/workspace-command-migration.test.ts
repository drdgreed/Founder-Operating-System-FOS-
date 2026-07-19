import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./pglite-db.js";
import { seedWorkspaceAndProduct, seedPerson, seedOpportunity } from "./fixtures.js";
import { workspaceCommand } from "../../schema/workspace_command.js";

describe("slice 0.2c migration applies clean on empty DB (issue #30)", () => {
  it("FOS0-RCN-01: all migrations (incl. workspace_command) apply to a fresh PGlite instance; the table is queryable", async () => {
    const { db, close } = await createTestDb();
    try {
      expect(await db.select().from(workspaceCommand)).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe("workspace_command entity round-trip (spec §11.5-derived, issue #30)", () => {
  it("FOS0-RCN-02: a workspace_command row inserts and reads back with status/source defaults applied", async () => {
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
        .insert(workspaceCommand)
        .values({
          workspaceId: workspace.id,
          entityType: "EnrollmentOpportunity",
          entityId: opportunity.id,
          provider: "notion",
          providerPageId: "notion-page-1",
          commandType: "propose_field_update",
          payloadJson: { changes: { nextActionSummary: { from: null, to: "Call Tuesday" } } },
          payloadHash: "hash-1",
          providerLastEditedAt: new Date("2026-07-18T12:00:00Z"),
        })
        .returning();
      if (!inserted) throw new Error("workspace_command insert returned no row");

      expect(inserted.status).toBe("pending");
      expect(inserted.source).toBe("notion_reconcile");

      const [reread] = await ctx.db
        .select()
        .from(workspaceCommand)
        .where(eq(workspaceCommand.id, inserted.id));
      expect(reread).toMatchObject({
        workspaceId: workspace.id,
        entityType: "EnrollmentOpportunity",
        entityId: opportunity.id,
        provider: "notion",
        providerPageId: "notion-page-1",
        commandType: "propose_field_update",
        status: "pending",
        source: "notion_reconcile",
      });
      expect(reread!.payloadJson).toEqual({
        changes: { nextActionSummary: { from: null, to: "Call Tuesday" } },
      });
    } finally {
      await ctx.close();
    }
  });

  it("FOS0-RCN-03: workspace_id is a required FK — a bogus workspace_id is rejected", async () => {
    const ctx = await createTestDb();
    try {
      await expect(
        ctx.db.insert(workspaceCommand).values({
          workspaceId: "00000000-0000-0000-0000-000000000000",
          entityType: "EnrollmentOpportunity",
          entityId: "some-entity-id",
          provider: "notion",
          providerPageId: "notion-page-1",
          commandType: "propose_field_update",
          payloadJson: {},
          payloadHash: "hash-1",
          providerLastEditedAt: new Date(),
        }),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });

  it("FOS0-RCN-04: UNIQUE (provider, provider_page_id, provider_last_edited_at, payload_hash) rejects an identical (page, edit-time, diff) triple", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, product } = await seedWorkspaceAndProduct(ctx.db);
      const person = await seedPerson(ctx.db, workspace.id);
      const opportunity = await seedOpportunity(ctx.db, {
        workspaceId: workspace.id,
        productId: product.id,
        personId: person.id,
      });
      const editedAt = new Date("2026-07-18T12:00:00Z");

      await ctx.db.insert(workspaceCommand).values({
        workspaceId: workspace.id,
        entityType: "EnrollmentOpportunity",
        entityId: opportunity.id,
        provider: "notion",
        providerPageId: "notion-page-1",
        commandType: "propose_field_update",
        payloadJson: {},
        payloadHash: "hash-1",
        providerLastEditedAt: editedAt,
      });

      await expect(
        ctx.db.insert(workspaceCommand).values({
          workspaceId: workspace.id,
          entityType: "EnrollmentOpportunity",
          entityId: opportunity.id,
          provider: "notion",
          providerPageId: "notion-page-1",
          commandType: "propose_field_update",
          payloadJson: {},
          payloadHash: "hash-1",
          providerLastEditedAt: editedAt,
        }),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });

  it("FOS0-RCN-12: a DIFFERENT payload_hash at the same (page, edit-time) is allowed — two distinct edits in one tick both persist (PR #31 review fix)", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, product } = await seedWorkspaceAndProduct(ctx.db);
      const person = await seedPerson(ctx.db, workspace.id);
      const opportunity = await seedOpportunity(ctx.db, {
        workspaceId: workspace.id,
        productId: product.id,
        personId: person.id,
      });
      const editedAt = new Date("2026-07-18T12:00:00Z");

      await ctx.db.insert(workspaceCommand).values({
        workspaceId: workspace.id,
        entityType: "EnrollmentOpportunity",
        entityId: opportunity.id,
        provider: "notion",
        providerPageId: "notion-page-1",
        commandType: "propose_field_update",
        payloadJson: { changes: { nextActionSummary: { from: null, to: "First edit" } } },
        payloadHash: "hash-1",
        providerLastEditedAt: editedAt,
      });

      await ctx.db.insert(workspaceCommand).values({
        workspaceId: workspace.id,
        entityType: "EnrollmentOpportunity",
        entityId: opportunity.id,
        provider: "notion",
        providerPageId: "notion-page-1",
        commandType: "propose_field_update",
        payloadJson: {
          changes: { nextActionSummary: { from: null, to: "First edit then second edit" } },
        },
        payloadHash: "hash-2",
        providerLastEditedAt: editedAt,
      });

      const rows = await ctx.db
        .select()
        .from(workspaceCommand)
        .where(eq(workspaceCommand.providerPageId, "notion-page-1"));
      expect(rows).toHaveLength(2);
    } finally {
      await ctx.close();
    }
  });
});
