import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./pglite-db.js";
import {
  seedWorkspaceAndProduct,
  seedPerson,
  seedOpportunity,
  seedArtifactWithStatus,
} from "./fixtures.js";
import { enrollmentActionRecommendation } from "../../schema/enrollment_action_recommendation.js";
import { agentRun } from "../../schema/agent_run.js";
import {
  createActionRecommendation,
  getActionRecommendationById,
  updateActionRecommendationStatus,
  StaleActionRecommendationVersionError,
  ActionRecommendationNotFoundError,
} from "../enrollment-action-recommendation-service.js";

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

async function seedAgentRun(
  db: Awaited<ReturnType<typeof createTestDb>>["db"],
  workspaceId: string,
) {
  const [row] = await db
    .insert(agentRun)
    .values({
      workspaceId,
      agentKey: "fos.enrollment_action_recommendation",
      agentVersion: "1",
      promptVersion: "1",
      trigger: "opportunity.stalled",
      actorJson: { type: "agent", id: "fos.enrollment_action_recommendation" },
      featureMode: "shadow",
      contextManifestJson: { sources: [] },
      correlationId: crypto.randomUUID(),
    })
    .returning();
  if (!row) throw new Error("seedAgentRun: agent_run insert returned no row");
  return row;
}

describe("enrollment_action_recommendation migration applies clean (issue #70)", () => {
  it("FOS1-REC-01: the enrollment_action_recommendation table is queryable on a fresh PGlite instance", async () => {
    const ctx = await createTestDb();
    try {
      expect(await ctx.db.select().from(enrollmentActionRecommendation)).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});

describe("enrollment_action_recommendation entity (issue #70 P1.4a)", () => {
  it("FOS1-REC-02: workspace_id is a required FK — a bogus workspace_id is rejected", async () => {
    const ctx = await createTestDb();
    try {
      const { opportunity } = await seedFullOpportunity(ctx.db);
      await expect(
        createActionRecommendation(ctx.db, {
          workspaceId: NIL_UUID,
          opportunityId: opportunity.id,
          actionType: "follow_up_call",
          summary: "Call to address pricing concern",
        }),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-REC-03: opportunity_id is a required FK — a bogus opportunity_id is rejected", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace } = await seedWorkspaceAndProduct(ctx.db);
      await expect(
        createActionRecommendation(ctx.db, {
          workspaceId: workspace.id,
          opportunityId: NIL_UUID,
          actionType: "follow_up_call",
          summary: "Call to address pricing concern",
        }),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-REC-04: agent_run_id and artifact_record_id accept null (recommendation seeded without a run or artifact)", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, opportunity } = await seedFullOpportunity(ctx.db);
      const row = await createActionRecommendation(ctx.db, {
        workspaceId: workspace.id,
        opportunityId: opportunity.id,
        actionType: "follow_up_call",
        summary: "Call to address pricing concern",
      });
      expect(row.agentRunId).toBeNull();
      expect(row.artifactRecordId).toBeNull();
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-REC-05: agent_run_id, when present, is enforced as a real agent_run FK", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, opportunity } = await seedFullOpportunity(ctx.db);
      await expect(
        createActionRecommendation(ctx.db, {
          workspaceId: workspace.id,
          opportunityId: opportunity.id,
          actionType: "follow_up_call",
          summary: "Call to address pricing concern",
          agentRunId: NIL_UUID,
        }),
      ).rejects.toThrow();

      const run = await seedAgentRun(ctx.db, workspace.id);
      const row = await createActionRecommendation(ctx.db, {
        workspaceId: workspace.id,
        opportunityId: opportunity.id,
        actionType: "follow_up_call",
        summary: "Call to address pricing concern",
        agentRunId: run.id,
      });
      expect(row.agentRunId).toBe(run.id);
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-REC-06: artifact_record_id, when present, is enforced as a real artifact_record FK", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, opportunity } = await seedFullOpportunity(ctx.db);
      await expect(
        createActionRecommendation(ctx.db, {
          workspaceId: workspace.id,
          opportunityId: opportunity.id,
          actionType: "follow_up_call",
          summary: "Call to address pricing concern",
          artifactRecordId: NIL_UUID,
        }),
      ).rejects.toThrow();

      const { record } = await seedArtifactWithStatus(ctx.db, {
        workspaceId: workspace.id,
        status: "draft",
      });
      const row = await createActionRecommendation(ctx.db, {
        workspaceId: workspace.id,
        opportunityId: opportunity.id,
        actionType: "follow_up_call",
        summary: "Call to address pricing concern",
        artifactRecordId: record.id,
      });
      expect(row.artifactRecordId).toBe(record.id);
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-REC-07: createActionRecommendation inserts with defaults applied (status=proposed, version=1)", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, opportunity } = await seedFullOpportunity(ctx.db);
      const row = await createActionRecommendation(ctx.db, {
        workspaceId: workspace.id,
        opportunityId: opportunity.id,
        actionType: "follow_up_call",
        summary: "Call to address pricing concern",
      });

      expect(row.status).toBe("proposed");
      expect(row.version).toBe(1);
      expect(row.outcome).toBeNull();

      const [reread] = await ctx.db
        .select()
        .from(enrollmentActionRecommendation)
        .where(eq(enrollmentActionRecommendation.id, row.id));
      expect(reread).toMatchObject({
        workspaceId: workspace.id,
        opportunityId: opportunity.id,
        actionType: "follow_up_call",
        status: "proposed",
        version: 1,
      });
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-REC-08: getActionRecommendationById returns the row when the workspace matches", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, opportunity } = await seedFullOpportunity(ctx.db);
      const row = await createActionRecommendation(ctx.db, {
        workspaceId: workspace.id,
        opportunityId: opportunity.id,
        actionType: "follow_up_call",
        summary: "Call to address pricing concern",
      });

      const found = await getActionRecommendationById(ctx.db, workspace.id, row.id);
      expect(found).toMatchObject({ id: row.id, workspaceId: workspace.id });
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-REC-09: getActionRecommendationById returns null for a cross-workspace id", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, opportunity } = await seedFullOpportunity(ctx.db);
      const row = await createActionRecommendation(ctx.db, {
        workspaceId: workspace.id,
        opportunityId: opportunity.id,
        actionType: "follow_up_call",
        summary: "Call to address pricing concern",
      });

      const { workspace: otherWorkspace } = await seedWorkspaceAndProduct(ctx.db);
      const found = await getActionRecommendationById(ctx.db, otherWorkspace.id, row.id);
      expect(found).toBeNull();

      const missing = await getActionRecommendationById(ctx.db, workspace.id, NIL_UUID);
      expect(missing).toBeNull();
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-REC-10: updateActionRecommendationStatus round-trips a status change and bumps version", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, opportunity } = await seedFullOpportunity(ctx.db);
      const row = await createActionRecommendation(ctx.db, {
        workspaceId: workspace.id,
        opportunityId: opportunity.id,
        actionType: "follow_up_call",
        summary: "Call to address pricing concern",
      });

      const updated = await updateActionRecommendationStatus(ctx.db, {
        recommendationId: row.id,
        expectedVersion: 1,
        status: "actioned",
        outcome: "Founder sent follow-up email",
      });

      expect(updated.status).toBe("actioned");
      expect(updated.outcome).toBe("Founder sent follow-up email");
      expect(updated.version).toBe(2);

      const [reread] = await ctx.db
        .select()
        .from(enrollmentActionRecommendation)
        .where(eq(enrollmentActionRecommendation.id, row.id));
      expect(reread).toMatchObject({ status: "actioned", version: 2 });
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-REC-11: updateActionRecommendationStatus throws on a stale expectedVersion and writes nothing", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, opportunity } = await seedFullOpportunity(ctx.db);
      const row = await createActionRecommendation(ctx.db, {
        workspaceId: workspace.id,
        opportunityId: opportunity.id,
        actionType: "follow_up_call",
        summary: "Call to address pricing concern",
      });

      await expect(
        updateActionRecommendationStatus(ctx.db, {
          recommendationId: row.id,
          expectedVersion: 99,
          status: "actioned",
        }),
      ).rejects.toThrow(StaleActionRecommendationVersionError);

      const [reread] = await ctx.db
        .select()
        .from(enrollmentActionRecommendation)
        .where(eq(enrollmentActionRecommendation.id, row.id));
      expect(reread).toMatchObject({ status: "proposed", version: 1 });
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-REC-12: updateActionRecommendationStatus on a nonexistent id throws ActionRecommendationNotFoundError", async () => {
    const ctx = await createTestDb();
    try {
      await expect(
        updateActionRecommendationStatus(ctx.db, {
          recommendationId: NIL_UUID,
          expectedVersion: 1,
          status: "actioned",
        }),
      ).rejects.toThrow(ActionRecommendationNotFoundError);
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-REC-13: the status CHECK constraint rejects a value outside the allowed set", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, opportunity } = await seedFullOpportunity(ctx.db);
      await expect(
        createActionRecommendation(ctx.db, {
          workspaceId: workspace.id,
          opportunityId: opportunity.id,
          actionType: "follow_up_call",
          summary: "Call to address pricing concern",
          status: "bogus_status",
        }),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });
});
