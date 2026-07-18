import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./pglite-db.js";
import { seedWorkspaceAndProduct } from "./fixtures.js";
import { workspaceIntegration } from "../../schema/workspace_integration.js";

describe("slice 0.2a migration applies clean on empty DB (issue #24)", () => {
  it("FOS0-ADP-01: all migrations (incl. workspace_integration) apply to a fresh PGlite instance; the table is queryable", async () => {
    const { db, close } = await createTestDb();
    try {
      expect(await db.select().from(workspaceIntegration)).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe("workspace_integration entity round-trip (spec §11.1, issue #24)", () => {
  it("FOS0-ADP-02: a workspace_integration row inserts and reads back with defaults applied", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace } = await seedWorkspaceAndProduct(ctx.db);

      const [inserted] = await ctx.db
        .insert(workspaceIntegration)
        .values({
          workspaceId: workspace.id,
          provider: "notion",
          credentialReference: "FOS_NOTION_TOKEN",
        })
        .returning();
      if (!inserted) throw new Error("workspace_integration insert returned no row");

      expect(inserted.status).toBe("disconnected");
      expect(inserted.providerWorkspaceId).toBeNull();
      expect(inserted.connectedAt).toBeNull();

      const [reread] = await ctx.db
        .select()
        .from(workspaceIntegration)
        .where(eq(workspaceIntegration.id, inserted.id));
      expect(reread).toMatchObject({
        workspaceId: workspace.id,
        provider: "notion",
        credentialReference: "FOS_NOTION_TOKEN",
        status: "disconnected",
      });
    } finally {
      await ctx.close();
    }
  });

  it("FOS0-ADP-03: connecting sets provider_workspace_id, status, connected_at", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace } = await seedWorkspaceAndProduct(ctx.db);
      const connectedAt = new Date();

      const [inserted] = await ctx.db
        .insert(workspaceIntegration)
        .values({
          workspaceId: workspace.id,
          provider: "notion",
          providerWorkspaceId: "notion-ws-123",
          credentialReference: "FOS_NOTION_TOKEN",
          status: "connected",
          connectedAt,
        })
        .returning();
      if (!inserted) throw new Error("workspace_integration insert returned no row");

      expect(inserted.providerWorkspaceId).toBe("notion-ws-123");
      expect(inserted.status).toBe("connected");
      expect(inserted.connectedAt?.getTime()).toBe(connectedAt.getTime());
    } finally {
      await ctx.close();
    }
  });

  it("FOS0-ADP-04: workspace_id is a required FK — a bogus workspace_id is rejected", async () => {
    const ctx = await createTestDb();
    try {
      await expect(
        ctx.db.insert(workspaceIntegration).values({
          workspaceId: "00000000-0000-0000-0000-000000000000",
          provider: "notion",
          credentialReference: "FOS_NOTION_TOKEN",
        }),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });
});
