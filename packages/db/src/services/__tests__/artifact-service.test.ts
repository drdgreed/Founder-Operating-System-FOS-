import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./pglite-db.js";
import { seedWorkspaceAndProduct } from "./fixtures.js";
import {
  createArtifact,
  createArtifactRevision,
  transitionArtifactVersionStatus,
} from "../artifact-service.js";
import { computeContentHash } from "../content-hash.js";
import { artifactRecord } from "../../schema/artifact_record.js";
import { artifactVersion } from "../../schema/artifact_version.js";
import { operationalEvent } from "../../schema/operational_event.js";

const ACTOR = { type: "founder" as const, id: "founder-1" };
const BODY = "# Enrollment message\n\nHello, welcome.";

describe("artifact service — create / revision / mirror (spec §9.12/§9.13, §12.2)", () => {
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

  it("FOS0-ART-02: create-artifact makes 1 record + 1 version (v1 draft), content_hash = SHA-256(normalized md), exactly 1 event", async () => {
    const result = await createArtifact(ctx.db, {
      workspaceId,
      productId,
      artifactType: "enrollment_message",
      domain: "enrollment",
      title: "Welcome",
      bodyMarkdown: BODY,
      actor: ACTOR,
    });

    const records = await ctx.db.select().from(artifactRecord);
    const versions = await ctx.db.select().from(artifactVersion);
    expect(records).toHaveLength(1);
    expect(versions).toHaveLength(1);

    expect(records[0]!.status).toBe("draft");
    expect(records[0]!.currentVersionId).toBe(versions[0]!.id);
    expect(versions[0]!.versionNumber).toBe(1);
    expect(versions[0]!.approvalStatus).toBe("draft");
    expect(versions[0]!.contentHash).toBe(computeContentHash(BODY));
    expect(result.contentHash).toBe(computeContentHash(BODY));

    const events = await ctx.db.select().from(operationalEvent);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("artifact.created");
    expect(events[0]!.entityType).toBe("ArtifactRecord");
    expect(events[0]!.entityId).toBe(result.artifactId);
    expect(events[0]!.productId).toBe(productId);
  });

  it("FOS0-ART-03: a founder-level artifact (operating_review) is created with a NULL product_id (§B0)", async () => {
    const result = await createArtifact(ctx.db, {
      workspaceId,
      productId: null,
      artifactType: "operating_review",
      domain: "release",
      title: "Weekly review",
      bodyMarkdown: "# Review\n",
      actor: ACTOR,
    });
    const [record] = await ctx.db
      .select()
      .from(artifactRecord)
      .where(eq(artifactRecord.id, result.artifactId));
    expect(record!.productId).toBeNull();
    const events = await ctx.db.select().from(operationalEvent);
    expect(events[0]!.productId).toBeNull(); // founder-level event carries no product
  });

  it("FOS0-ART-04: create-revision makes v2 (draft) and leaves v1 completely unchanged; record points at v2", async () => {
    const created = await createArtifact(ctx.db, {
      workspaceId,
      productId,
      artifactType: "enrollment_message",
      domain: "enrollment",
      title: "Welcome",
      bodyMarkdown: BODY,
      actor: ACTOR,
    });
    const [v1Before] = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, created.versionId));

    const revBody = "# Enrollment message v2\n\nUpdated copy.";
    const revision = await createArtifactRevision(ctx.db, {
      artifactId: created.artifactId,
      bodyMarkdown: revBody,
      actor: ACTOR,
    });

    expect(revision.versionNumber).toBe(2);
    expect(revision.versionId).not.toBe(created.versionId);

    // v1 row is byte-for-byte unchanged.
    const [v1After] = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, created.versionId));
    expect(v1After).toEqual(v1Before);

    // record repointed to v2 with the mirror reset to draft.
    const [record] = await ctx.db
      .select()
      .from(artifactRecord)
      .where(eq(artifactRecord.id, created.artifactId));
    expect(record!.currentVersionId).toBe(revision.versionId);
    expect(record!.status).toBe("draft");

    const [v2] = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, revision.versionId));
    expect(v2!.approvalStatus).toBe("draft");
    expect(v2!.contentHash).toBe(computeContentHash(revBody));

    const versionCreated = (await ctx.db.select().from(operationalEvent)).filter(
      (e: typeof operationalEvent.$inferSelect) => e.type === "artifact.version_created",
    );
    expect(versionCreated).toHaveLength(1);
  });

  it("FOS0-ART-05: ArtifactRecord.status mirror stays consistent with the current version's approval_status after a transition AND after a revision", async () => {
    const created = await createArtifact(ctx.db, {
      workspaceId,
      productId,
      artifactType: "substack_paper",
      domain: "editorial",
      title: "Paper",
      bodyMarkdown: BODY,
      actor: ACTOR,
    });

    // draft -> in_review: mirror follows.
    await transitionArtifactVersionStatus(ctx.db, {
      versionId: created.versionId,
      expectedStatus: "draft",
      toStatus: "in_review",
      actor: ACTOR,
    });
    let [record] = await ctx.db
      .select()
      .from(artifactRecord)
      .where(eq(artifactRecord.id, created.artifactId));
    expect(record!.status).toBe("in_review");

    // in_review -> approved: mirror follows.
    await transitionArtifactVersionStatus(ctx.db, {
      versionId: created.versionId,
      expectedStatus: "in_review",
      toStatus: "approved",
      actor: ACTOR,
    });
    [record] = await ctx.db
      .select()
      .from(artifactRecord)
      .where(eq(artifactRecord.id, created.artifactId));
    expect(record!.status).toBe("approved");

    // revision resets the mirror to draft (new current version).
    await createArtifactRevision(ctx.db, {
      artifactId: created.artifactId,
      bodyMarkdown: "# Revised\n",
      actor: ACTOR,
    });
    [record] = await ctx.db
      .select()
      .from(artifactRecord)
      .where(eq(artifactRecord.id, created.artifactId));
    expect(record!.status).toBe("draft");
    // and the mirror equals the current version's approval_status
    const [currentVersion] = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, record!.currentVersionId!));
    expect(record!.status).toBe(currentVersion!.approvalStatus);
  });
});
