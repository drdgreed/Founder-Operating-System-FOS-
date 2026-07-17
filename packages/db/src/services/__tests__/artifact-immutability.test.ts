import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./pglite-db.js";
import { seedWorkspaceAndProduct } from "./fixtures.js";
import { createArtifact, createArtifactRevision } from "../artifact-service.js";
import { computeContentHash } from "../content-hash.js";
import { artifactVersion } from "../../schema/artifact_version.js";

const ACTOR = { type: "founder" as const, id: "founder-1" };
const BODY = "# Original\n\nOriginal body.";

/**
 * Drizzle wraps the underlying Postgres trigger error inside a "Failed query:"
 * error and chains the original via `.cause`. Walk the cause chain.
 */
function causeChainMatches(err: unknown, pattern: RegExp): boolean {
  let current: unknown = err;
  for (let i = 0; i < 10 && current; i += 1) {
    if (current instanceof Error && pattern.test(current.message)) return true;
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

describe("artifact_version content immutability (spec §12.2/§9.13, migration 0003)", () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>;
  let workspaceId: string;
  let productId: string;
  let versionId: string;

  beforeEach(async () => {
    ctx = await createTestDb();
    const seeded = await seedWorkspaceAndProduct(ctx.db);
    workspaceId = seeded.workspace.id;
    productId = seeded.product.id;
    const created = await createArtifact(ctx.db, {
      workspaceId,
      productId,
      artifactType: "internal_note",
      domain: "editorial",
      title: "Note",
      bodyMarkdown: BODY,
      actor: ACTOR,
    });
    versionId = created.versionId;
  });
  afterEach(async () => {
    await ctx.close();
  });

  it("FOS0-ART-20: a direct UPDATE of body_markdown RAISES at the DB layer", async () => {
    await expect(
      ctx.db
        .update(artifactVersion)
        .set({ bodyMarkdown: "tampered body" })
        .where(eq(artifactVersion.id, versionId)),
    ).rejects.toSatisfy((err: unknown) => causeChainMatches(err, /immutable/i));
  });

  it("FOS0-ART-21: a direct UPDATE of content_hash RAISES at the DB layer", async () => {
    await expect(
      ctx.db
        .update(artifactVersion)
        .set({ contentHash: "deadbeef" })
        .where(eq(artifactVersion.id, versionId)),
    ).rejects.toSatisfy((err: unknown) => causeChainMatches(err, /immutable/i));
  });

  it("FOS0-ART-22: updating approval_status alone is ALLOWED (content unchanged)", async () => {
    await ctx.db
      .update(artifactVersion)
      .set({ approvalStatus: "in_review" })
      .where(eq(artifactVersion.id, versionId));
    const [v] = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, versionId));
    expect(v!.approvalStatus).toBe("in_review");
    expect(v!.bodyMarkdown).toBe(BODY); // content intact
  });

  it("FOS0-ART-23: create-revision produces a v2 with new content while the OLD v1 stays unchanged", async () => {
    const [v1Before] = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, versionId));

    const newBody = "# Revised\n\nRevised body.";
    const revision = await createArtifactRevision(ctx.db, {
      artifactId: v1Before!.artifactId,
      bodyMarkdown: newBody,
      actor: ACTOR,
    });

    const [v1After] = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, versionId));
    expect(v1After).toEqual(v1Before); // v1 immutable — not touched by revision

    const [v2] = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, revision.versionId));
    expect(v2!.versionNumber).toBe(2);
    expect(v2!.bodyMarkdown).toBe(newBody);
    expect(v2!.contentHash).toBe(computeContentHash(newBody));
    expect(v2!.contentHash).not.toBe(v1Before!.contentHash);
  });
});
