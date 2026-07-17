import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./pglite-db.js";
import { seedWorkspaceAndProduct } from "./fixtures.js";
import {
  createArtifact,
  editDraftContent,
  transitionArtifactVersionStatus,
  ArtifactNotDraftError,
} from "../artifact-service.js";
import { computeContentHash } from "../content-hash.js";
import { artifactVersion } from "../../schema/artifact_version.js";
import { operationalEvent } from "../../schema/operational_event.js";

const ACTOR = { type: "founder" as const, id: "founder-1" };
const BODY = "# Original\n\nOriginal body.";

function causeChainMatches(err: unknown, pattern: RegExp): boolean {
  let current: unknown = err;
  for (let i = 0; i < 10 && current; i += 1) {
    if (current instanceof Error && pattern.test(current.message)) return true;
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

describe("in-place draft edit + status-gated locking (PATCH-SET-02 §B)", () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>;
  let workspaceId: string;
  let productId: string;
  let artifactId: string;
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
    artifactId = created.artifactId;
    versionId = created.versionId;
  });
  afterEach(async () => {
    await ctx.close();
  });

  it("FOS0-ART-40: in-place draft edit mutates the SAME version row, recomputes content_hash, emits artifact.draft_edited (no new version)", async () => {
    const newBody = "# Edited\n\nEdited draft body.";
    const result = await editDraftContent(ctx.db, {
      versionId,
      newBodyMarkdown: newBody,
      actor: ACTOR,
    });

    // Same row, in place — still exactly one version for this artifact.
    const versions = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.artifactId, artifactId));
    expect(versions).toHaveLength(1);
    expect(versions[0]!.id).toBe(versionId);
    expect(versions[0]!.versionNumber).toBe(1);
    expect(versions[0]!.bodyMarkdown).toBe(newBody);
    expect(versions[0]!.contentHash).toBe(computeContentHash(newBody));
    expect(versions[0]!.approvalStatus).toBe("draft");

    expect(result.previousContentHash).toBe(computeContentHash(BODY));
    expect(result.contentHash).toBe(computeContentHash(newBody));

    const edited = (await ctx.db.select().from(operationalEvent)).filter(
      (e: typeof operationalEvent.$inferSelect) => e.type === "artifact.draft_edited",
    );
    expect(edited).toHaveLength(1);
    expect(edited[0]!.payload).toEqual({
      artifactId,
      versionId,
      previousContentHash: computeContentHash(BODY),
      contentHash: computeContentHash(newBody),
    });
  });

  it("FOS0-ART-41: editing a NON-draft version is rejected by the service (ArtifactNotDraftError) AND by the DB trigger", async () => {
    // Move the version out of draft.
    await transitionArtifactVersionStatus(ctx.db, {
      versionId,
      expectedStatus: "draft",
      toStatus: "in_review",
      actor: ACTOR,
    });

    // Service guard.
    await expect(
      editDraftContent(ctx.db, { versionId, newBodyMarkdown: "nope", actor: ACTOR }),
    ).rejects.toBeInstanceOf(ArtifactNotDraftError);

    // DB trigger backstop: a direct content UPDATE on the non-draft row raises.
    await expect(
      ctx.db
        .update(artifactVersion)
        .set({ bodyMarkdown: "nope", contentHash: "x" })
        .where(eq(artifactVersion.id, versionId)),
    ).rejects.toSatisfy((err: unknown) => causeChainMatches(err, /immutable/i));

    // Nothing changed, no draft_edited event.
    const [v] = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, versionId));
    expect(v!.bodyMarkdown).toBe(BODY);
    const edited = (await ctx.db.select().from(operationalEvent)).filter(
      (e: typeof operationalEvent.$inferSelect) => e.type === "artifact.draft_edited",
    );
    expect(edited).toHaveLength(0);
  });

  it("FOS0-ART-42: immutable_at is NULL while draft, and is set on the first transition OUT of draft", async () => {
    const [beforeV] = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, versionId));
    expect(beforeV!.immutableAt).toBeNull();

    // A draft edit does not lock it.
    await editDraftContent(ctx.db, { versionId, newBodyMarkdown: "# still draft\n", actor: ACTOR });
    const [stillDraft] = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, versionId));
    expect(stillDraft!.immutableAt).toBeNull();

    // Leaving draft stamps immutable_at.
    await transitionArtifactVersionStatus(ctx.db, {
      versionId,
      expectedStatus: "draft",
      toStatus: "in_review",
      actor: ACTOR,
    });
    const [afterV] = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, versionId));
    expect(afterV!.immutableAt).not.toBeNull();
  });

  it("FOS0-ART-43: immutable_at is stamped when a draft goes straight to superseded (the other draft exit)", async () => {
    await transitionArtifactVersionStatus(ctx.db, {
      versionId,
      expectedStatus: "draft",
      toStatus: "superseded",
      actor: ACTOR,
    });
    const [v] = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, versionId));
    expect(v!.approvalStatus).toBe("superseded");
    expect(v!.immutableAt).not.toBeNull();
  });

  it("FOS0-ART-53: a revision-request re-open (in_review -> draft) clears immutable_at and re-enables in-place editing", async () => {
    // Leave draft -> locks + stamps immutable_at.
    await transitionArtifactVersionStatus(ctx.db, {
      versionId,
      expectedStatus: "draft",
      toStatus: "in_review",
      actor: ACTOR,
    });
    const [locked] = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, versionId));
    expect(locked!.immutableAt).not.toBeNull();

    // Revision requested: in_review -> draft. Content editable again -> clear the lock.
    await transitionArtifactVersionStatus(ctx.db, {
      versionId,
      expectedStatus: "in_review",
      toStatus: "draft",
      actor: ACTOR,
    });
    const [reopened] = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, versionId));
    expect(reopened!.approvalStatus).toBe("draft");
    expect(reopened!.immutableAt).toBeNull(); // invariant: null while editable

    // And in-place editing works again (would raise if still locked).
    await editDraftContent(ctx.db, {
      versionId,
      newBodyMarkdown: "# revised in place\n",
      actor: ACTOR,
    });
    const [edited] = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, versionId));
    expect(edited!.bodyMarkdown).toBe("# revised in place\n");
  });
});
