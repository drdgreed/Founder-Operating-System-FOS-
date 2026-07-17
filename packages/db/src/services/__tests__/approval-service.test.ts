import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./pglite-db.js";
import { seedWorkspaceAndProduct, seedArtifactWithStatus } from "./fixtures.js";
import {
  recordApprovalDecision,
  ArtifactNotDecidableError,
  APPROVAL_DECISION_TO_STATUS,
  type ApprovalDecision,
} from "../approval-service.js";
import { StaleArtifactVersionError } from "../artifact-service.js";
import { eventForArtifactTransition } from "../artifact-transitions.js";
import { approval, approvalRiskLevelEnum } from "../../schema/approval.js";
import { artifactVersion } from "../../schema/artifact_version.js";
import { artifactRecord } from "../../schema/artifact_record.js";
import { operationalEvent } from "../../schema/operational_event.js";

const ACTOR = { type: "founder" as const, id: "founder-1" };

describe("approval service — recordApprovalDecision (spec §9.14, §E2, §12.2)", () => {
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

  async function seedInReview() {
    return seedArtifactWithStatus(ctx.db, { workspaceId, productId, status: "in_review" });
  }

  it("FOS0-APV-02: an `approved` decision on an in_review version → Approval row, version approved, artifact.approved + approval.recorded events, mirror synced", async () => {
    const { record, version } = await seedInReview();

    const result = await recordApprovalDecision(ctx.db, {
      artifactVersionId: version.id,
      decision: "approved",
      riskLevel: "low",
      actor: ACTOR,
      reason: "looks good",
    });

    // Approval row.
    const approvals = await ctx.db.select().from(approval);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.status).toBe("approved");
    expect(approvals[0]!.riskLevel).toBe("low");
    expect(approvals[0]!.decidedBy).toBe(ACTOR.id);
    expect(approvals[0]!.reason).toBe("looks good");
    expect(approvals[0]!.artifactVersionId).toBe(version.id);
    expect(result.approvalId).toBe(approvals[0]!.id);

    // Version driven to approved + mirror synced.
    const [v] = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, version.id));
    expect(v!.approvalStatus).toBe("approved");
    const [r] = await ctx.db.select().from(artifactRecord).where(eq(artifactRecord.id, record.id));
    expect(r!.status).toBe("approved");

    // Both events emitted: the granular artifact event AND approval.recorded.
    const events = await ctx.db.select().from(operationalEvent);
    const types = events.map((e: typeof operationalEvent.$inferSelect) => e.type).sort();
    expect(types).toEqual(["approval.recorded", "artifact.approved"]);

    const approvalEvent = events.find(
      (e: typeof operationalEvent.$inferSelect) => e.type === "approval.recorded",
    );
    expect(approvalEvent!.entityType).toBe("Approval");
    expect(approvalEvent!.payload).toEqual({
      approvalId: approvals[0]!.id,
      artifactVersionId: version.id,
      decision: "approved",
      riskLevel: "low",
    });
  });

  it("FOS0-APV-03: each decision drives the §E2 lifecycle value + the correct granular artifact event", async () => {
    const decisions = Object.keys(APPROVAL_DECISION_TO_STATUS) as ApprovalDecision[];
    expect(decisions.sort()).toEqual(
      ["approved", "approved_with_edits", "deferred", "rejected"].sort(),
    );

    for (const decision of decisions) {
      const { record, version } = await seedInReview();
      await recordApprovalDecision(ctx.db, {
        artifactVersionId: version.id,
        decision,
        riskLevel: "medium",
        actor: ACTOR,
      });

      const expectedStatus = APPROVAL_DECISION_TO_STATUS[decision];
      const [v] = await ctx.db
        .select()
        .from(artifactVersion)
        .where(eq(artifactVersion.id, version.id));
      expect(v!.approvalStatus).toBe(expectedStatus);

      const [r] = await ctx.db
        .select()
        .from(artifactRecord)
        .where(eq(artifactRecord.id, record.id));
      expect(r!.status).toBe(expectedStatus);

      const events = await ctx.db
        .select()
        .from(operationalEvent)
        .where(eq(operationalEvent.entityId, version.id));
      expect(events).toHaveLength(1);
      // The granular artifact event mapped to in_review -> <decided status>.
      expect(events[0]!.type).toBe(eventForArtifactTransition("in_review", expectedStatus));

      const [a] = await ctx.db
        .select()
        .from(approval)
        .where(eq(approval.artifactVersionId, version.id));
      expect(a!.status).toBe(decision);
    }
  });

  it("FOS0-APV-04: a decision on a NON-in_review version (draft / already-decided / terminal) → rejected, NO Approval row, NO events", async () => {
    for (const status of ["draft", "approved", "rejected"] as const) {
      const { version } = await seedArtifactWithStatus(ctx.db, {
        workspaceId,
        productId,
        status,
      });

      await expect(
        recordApprovalDecision(ctx.db, {
          artifactVersionId: version.id,
          decision: "approved",
          riskLevel: "low",
          actor: ACTOR,
        }),
      ).rejects.toBeInstanceOf(ArtifactNotDecidableError);

      // Version unchanged.
      const [v] = await ctx.db
        .select()
        .from(artifactVersion)
        .where(eq(artifactVersion.id, version.id));
      expect(v!.approvalStatus).toBe(status);
    }

    // Nothing written across all attempts.
    expect(await ctx.db.select().from(approval)).toHaveLength(0);
    expect(await ctx.db.select().from(operationalEvent)).toHaveLength(0);
  });

  it("FOS0-APV-05: a double-decision (version already left in_review) is rejected; no second Approval row", async () => {
    const { version } = await seedInReview();

    await recordApprovalDecision(ctx.db, {
      artifactVersionId: version.id,
      decision: "approved",
      riskLevel: "low",
      actor: ACTOR,
    });

    await expect(
      recordApprovalDecision(ctx.db, {
        artifactVersionId: version.id,
        decision: "rejected",
        riskLevel: "low",
        actor: ACTOR,
      }),
    ).rejects.toBeInstanceOf(ArtifactNotDecidableError);

    expect(await ctx.db.select().from(approval)).toHaveLength(1); // only the first
    const [v] = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, version.id));
    expect(v!.approvalStatus).toBe("approved");
  });

  it("FOS0-APV-06: risk_level is restricted to the §S2 set {low, medium, high}", async () => {
    expect([...approvalRiskLevelEnum.enumValues].sort()).toEqual(["high", "low", "medium"]);

    const { version } = await seedInReview();
    // A direct insert with an out-of-range risk_level raises at the DB layer.
    await expect(
      ctx.db.insert(approval).values({
        workspaceId,
        artifactVersionId: version.id,
        status: "approved",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        riskLevel: "extreme" as any,
        decidedBy: ACTOR.id,
      }),
    ).rejects.toThrow();
  });

  it("FOS0-APV-07: atomicity — when the reused transition throws (stale CAS token), the Approval row is NOT persisted", async () => {
    const { version } = await seedInReview();

    // Decidability guard passes (version is in_review), but the caller supplies
    // a stale expectedStatus, so the reused transition's CAS rejects -> the
    // whole transaction (incl. the Approval insert) rolls back.
    await expect(
      recordApprovalDecision(ctx.db, {
        artifactVersionId: version.id,
        decision: "approved",
        riskLevel: "low",
        actor: ACTOR,
        expectedStatus: "draft", // deliberately stale
      }),
    ).rejects.toBeInstanceOf(StaleArtifactVersionError);

    // No Approval row, no events, version unchanged.
    expect(await ctx.db.select().from(approval)).toHaveLength(0);
    expect(await ctx.db.select().from(operationalEvent)).toHaveLength(0);
    const [v] = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, version.id));
    expect(v!.approvalStatus).toBe("in_review");
  });

  it("FOS0-APV-11: audit lineage — the two events share ONE correlation_id AND artifact.approved is caused-by approval.recorded (decision → transition, PATCH-SET-03 §B)", async () => {
    const { version } = await seedInReview();

    const result = await recordApprovalDecision(ctx.db, {
      artifactVersionId: version.id,
      decision: "approved",
      riskLevel: "low",
      actor: ACTOR,
    });

    const events = await ctx.db.select().from(operationalEvent);
    expect(events).toHaveLength(2);

    const approvalEvent = events.find(
      (e: typeof operationalEvent.$inferSelect) => e.type === "approval.recorded",
    )!;
    const artifactEvent = events.find(
      (e: typeof operationalEvent.$inferSelect) => e.type === "artifact.approved",
    )!;
    expect(approvalEvent).toBeDefined();
    expect(artifactEvent).toBeDefined();

    // (a) shared correlation_id — one operation.
    expect(approvalEvent.correlationId).toBe(artifactEvent.correlationId);
    expect(result.correlationId).toBe(approvalEvent.correlationId);

    // (b) causation direction: the DECISION causes the TRANSITION.
    // artifact.approved.causation_id === approval.recorded.id (effect points at cause).
    expect(artifactEvent.causationId).toBe(approvalEvent.id);
    // The decision fact is the root of this operation's causal chain.
    expect(approvalEvent.causationId).toBeNull();
    // Explicitly assert the direction is NOT inverted.
    expect(approvalEvent.causationId).not.toBe(artifactEvent.id);
  });
});
