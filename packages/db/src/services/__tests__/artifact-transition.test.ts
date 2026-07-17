import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./pglite-db.js";
import { seedWorkspaceAndProduct, seedArtifactWithStatus } from "./fixtures.js";
import {
  transitionArtifactVersionStatus,
  IllegalArtifactTransitionError,
  StaleArtifactVersionError,
} from "../artifact-service.js";
import {
  LEGAL_ARTIFACT_EDGES,
  ILLEGAL_ARTIFACT_EDGES,
  ARTIFACT_STATUSES,
} from "../artifact-transitions.js";
import { artifactVersion } from "../../schema/artifact_version.js";
import { artifactRecord } from "../../schema/artifact_record.js";
import { artifactLifecycleStatusEnum } from "../../schema/artifact_record.js";
import { operationalEvent } from "../../schema/operational_event.js";

const ACTOR = { type: "founder" as const, id: "founder-1" };

describe("artifact version transition service (spec §12.2 — full transition matrix)", () => {
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

  it("FOS0-ART-09: the §12.2 pgEnum state set matches the state-machine data (no drift)", () => {
    expect([...artifactLifecycleStatusEnum.enumValues].sort()).toEqual(
      [...ARTIFACT_STATUSES].sort(),
    );
    expect(ARTIFACT_STATUSES).toHaveLength(10);
  });

  it(`FOS0-ART-10: covers all ${LEGAL_ARTIFACT_EDGES.length} legal §12.2 edges — each succeeds, updates approval_status + record mirror, emits artifact.status_changed`, async () => {
    expect(LEGAL_ARTIFACT_EDGES.length).toBe(14);

    for (const [from, to] of LEGAL_ARTIFACT_EDGES) {
      const { record, version } = await seedArtifactWithStatus(ctx.db, {
        workspaceId,
        productId,
        status: from,
      });

      const result = await transitionArtifactVersionStatus(ctx.db, {
        versionId: version.id,
        expectedStatus: from,
        toStatus: to,
        actor: ACTOR,
      });
      expect(result.fromStatus).toBe(from);
      expect(result.toStatus).toBe(to);

      const [v] = await ctx.db
        .select()
        .from(artifactVersion)
        .where(eq(artifactVersion.id, version.id));
      expect(v!.approvalStatus).toBe(to);

      // mirror synced (this seeded version is the record's current version)
      const [r] = await ctx.db
        .select()
        .from(artifactRecord)
        .where(eq(artifactRecord.id, record.id));
      expect(r!.status).toBe(to);

      const events = await ctx.db
        .select()
        .from(operationalEvent)
        .where(eq(operationalEvent.entityId, version.id));
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("artifact.status_changed");
      expect(events[0]!.payload).toEqual({
        artifactId: record.id,
        versionId: version.id,
        versionNumber: 1,
        from,
        to,
      });
    }
  });

  it(`FOS0-ART-11: rejects all ${ILLEGAL_ARTIFACT_EDGES.length} illegal §12.2 pairs (incl. self-transitions) — throws, no status change, no event`, async () => {
    // 10 states x 10 states minus the 14 legal edges.
    expect(ILLEGAL_ARTIFACT_EDGES.length).toBe(100 - 14);

    for (const [from, to] of ILLEGAL_ARTIFACT_EDGES) {
      const { record, version } = await seedArtifactWithStatus(ctx.db, {
        workspaceId,
        productId,
        status: from,
      });

      await expect(
        transitionArtifactVersionStatus(ctx.db, {
          versionId: version.id,
          expectedStatus: from,
          toStatus: to,
          actor: ACTOR,
        }),
      ).rejects.toBeInstanceOf(IllegalArtifactTransitionError);

      const [v] = await ctx.db
        .select()
        .from(artifactVersion)
        .where(eq(artifactVersion.id, version.id));
      expect(v!.approvalStatus).toBe(from); // unchanged

      const [r] = await ctx.db
        .select()
        .from(artifactRecord)
        .where(eq(artifactRecord.id, record.id));
      expect(r!.status).toBe(from); // mirror unchanged

      const events = await ctx.db
        .select()
        .from(operationalEvent)
        .where(eq(operationalEvent.entityId, version.id));
      expect(events).toHaveLength(0); // nothing emitted
    }
  });

  it("FOS0-ART-12: a stale-status (optimistic-concurrency) transition is rejected and emits nothing", async () => {
    const { version } = await seedArtifactWithStatus(ctx.db, {
      workspaceId,
      productId,
      status: "in_review",
    });

    // Caller believes the version is still `draft` (stale view) and tries a
    // draft-legal edge; actual status is `in_review` -> rejected.
    await expect(
      transitionArtifactVersionStatus(ctx.db, {
        versionId: version.id,
        expectedStatus: "draft",
        toStatus: "superseded",
        actor: ACTOR,
      }),
    ).rejects.toBeInstanceOf(StaleArtifactVersionError);

    const [v] = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, version.id));
    expect(v!.approvalStatus).toBe("in_review");

    const events = await ctx.db
      .select()
      .from(operationalEvent)
      .where(eq(operationalEvent.entityId, version.id));
    expect(events).toHaveLength(0);
  });
});
