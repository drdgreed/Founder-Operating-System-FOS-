import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./pglite-db.js";
import { seedWorkspaceAndProduct } from "./fixtures.js";
import { createArtifact } from "../artifact-service.js";
import { artifactRecord } from "../../schema/artifact_record.js";

const ACTOR = { type: "founder" as const, id: "founder-1" };

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

describe("artifact_record.current_version_id same-record guard (issue #8, migration 0007)", () => {
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

  it("FOS0-ART-54: create-artifact (same-record pointer) succeeds at the DB layer", async () => {
    const created = await createArtifact(ctx.db, {
      workspaceId,
      productId,
      artifactType: "internal_note",
      domain: "editorial",
      title: "Note",
      bodyMarkdown: "# Body\n",
      actor: ACTOR,
    });
    const [record] = await ctx.db
      .select()
      .from(artifactRecord)
      .where(eq(artifactRecord.id, created.artifactId));
    expect(record!.currentVersionId).toBe(created.versionId);
  });

  it("FOS0-ART-55: pointing current_version_id at ANOTHER record's version RAISES at the DB layer", async () => {
    const a = await createArtifact(ctx.db, {
      workspaceId,
      productId,
      artifactType: "internal_note",
      domain: "editorial",
      title: "Artifact A",
      bodyMarkdown: "# A\n",
      actor: ACTOR,
    });
    const b = await createArtifact(ctx.db, {
      workspaceId,
      productId,
      artifactType: "internal_note",
      domain: "editorial",
      title: "Artifact B",
      bodyMarkdown: "# B\n",
      actor: ACTOR,
    });

    await expect(
      ctx.db
        .update(artifactRecord)
        .set({ currentVersionId: b.versionId })
        .where(eq(artifactRecord.id, a.artifactId)),
    ).rejects.toSatisfy((err: unknown) =>
      causeChainMatches(err, /must reference an artifact_version belonging to this record/i),
    );

    // Unchanged: A still points at its own v1.
    const [recordA] = await ctx.db
      .select()
      .from(artifactRecord)
      .where(eq(artifactRecord.id, a.artifactId));
    expect(recordA!.currentVersionId).toBe(a.versionId);
  });

  it("FOS0-ART-56: setting current_version_id to NULL is always allowed", async () => {
    const created = await createArtifact(ctx.db, {
      workspaceId,
      productId,
      artifactType: "internal_note",
      domain: "editorial",
      title: "Note",
      bodyMarkdown: "# Body\n",
      actor: ACTOR,
    });

    await ctx.db
      .update(artifactRecord)
      .set({ currentVersionId: null })
      .where(eq(artifactRecord.id, created.artifactId));

    const [record] = await ctx.db
      .select()
      .from(artifactRecord)
      .where(eq(artifactRecord.id, created.artifactId));
    expect(record!.currentVersionId).toBeNull();
  });

  it("FOS0-ART-57: a direct INSERT pointing current_version_id at ANOTHER record's version RAISES (INSERT branch, not just UPDATE)", async () => {
    const other = await createArtifact(ctx.db, {
      workspaceId,
      productId,
      artifactType: "internal_note",
      domain: "editorial",
      title: "Other record",
      bodyMarkdown: "# Other\n",
      actor: ACTOR,
    });

    await expect(
      ctx.db.insert(artifactRecord).values({
        workspaceId,
        productId,
        artifactType: "internal_note",
        domain: "editorial",
        title: "Bad insert",
        currentVersionId: other.versionId,
      }),
    ).rejects.toSatisfy((err: unknown) =>
      causeChainMatches(err, /must reference an artifact_version belonging to this record/i),
    );

    // Nothing was inserted: the failed row does not exist.
    const rows = await ctx.db
      .select()
      .from(artifactRecord)
      .where(eq(artifactRecord.title, "Bad insert"));
    expect(rows).toHaveLength(0);
  });

  it("FOS0-ART-58: setting current_version_id to a non-existent (random) UUID RAISES, not just a wrong-record UUID", async () => {
    const created = await createArtifact(ctx.db, {
      workspaceId,
      productId,
      artifactType: "internal_note",
      domain: "editorial",
      title: "Note",
      bodyMarkdown: "# Body\n",
      actor: ACTOR,
    });

    const randomVersionId = randomUUID();
    await expect(
      ctx.db
        .update(artifactRecord)
        .set({ currentVersionId: randomVersionId })
        .where(eq(artifactRecord.id, created.artifactId)),
    ).rejects.toSatisfy((err: unknown) =>
      causeChainMatches(err, /must reference an artifact_version belonging to this record/i),
    );

    // Unchanged: still points at its own v1.
    const [record] = await ctx.db
      .select()
      .from(artifactRecord)
      .where(eq(artifactRecord.id, created.artifactId));
    expect(record!.currentVersionId).toBe(created.versionId);
  });
});
