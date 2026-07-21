import { describe, it, expect } from "vitest";
import {
  artifactToFounderInboxProperties,
  artifactFosVersion,
  type ArtifactRecordRow,
} from "../founder-inbox-mapper.js";

/** A fully-populated ArtifactRecord row, overridable per test. */
function makeArtifact(overrides: Partial<ArtifactRecordRow> = {}): ArtifactRecordRow {
  return {
    id: "artifact-1",
    workspaceId: "workspace-1",
    productId: "product-1",
    artifactType: "objection_response",
    domain: "enrollment",
    title: "Objection response draft",
    currentVersionId: "version-1",
    status: "in_review",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-18T12:00:00Z"),
    ...overrides,
  } as ArtifactRecordRow;
}

const ctx = {
  workspaceId: "workspace-1",
  productId: "product-1" as string | null,
  syncStatus: "in_sync" as const,
  lastSyncedAt: new Date("2026-07-20T09:30:00Z"),
};

describe("artifactToFounderInboxProperties (issue #90, P1.5c)", () => {
  it("FOS1-INBOX-01: emits all 7 §C1 hidden props, with the epoch-derived FOS Version", () => {
    const artifact = makeArtifact();
    const props = artifactToFounderInboxProperties(artifact, ctx);

    expect(props["FOS Record ID"]).toEqual({ rich_text: [{ text: { content: "artifact-1" } }] });
    expect(props["FOS Entity Type"]).toEqual({
      rich_text: [{ text: { content: "ArtifactRecord" } }],
    });
    expect(props["FOS Workspace ID"]).toEqual({
      rich_text: [{ text: { content: "workspace-1" } }],
    });
    expect(props["FOS Product ID"]).toEqual({ rich_text: [{ text: { content: "product-1" } }] });
    expect(props["Sync Status"]).toEqual({ select: { name: "in_sync" } });
    // §C2 unversioned: epoch seconds of updated_at (2026-07-18T12:00:00Z).
    const expectedVersion = Math.floor(new Date("2026-07-18T12:00:00Z").getTime() / 1000);
    expect(props["FOS Version"]).toEqual({ number: expectedVersion });
    expect(artifactFosVersion(artifact.updatedAt)).toBe(expectedVersion);
    expect(props["Last Synced At"]).toEqual({ date: { start: "2026-07-20T09:30:00.000Z" } });
  });

  it("FOS1-INBOX-02: null productId clears the FOS Product ID property", () => {
    const props = artifactToFounderInboxProperties(makeArtifact({ productId: null }), {
      ...ctx,
      productId: null,
    });
    expect(props["FOS Product ID"]).toEqual({ rich_text: [] });
  });

  it("FOS1-INBOX-03: projects the visible fields (Title, Artifact Type, Status, Domain, Canonical Link)", () => {
    const props = artifactToFounderInboxProperties(makeArtifact(), ctx);
    expect(props.Title).toEqual({ rich_text: [{ text: { content: "Objection response draft" } }] });
    expect(props["Artifact Type"]).toEqual({ select: { name: "objection_response" } });
    expect(props.Status).toEqual({ select: { name: "in_review" } });
    expect(props.Domain).toEqual({ select: { name: "enrollment" } });
    expect(props["Canonical Link"]).toEqual({ rich_text: [{ text: { content: "artifact-1" } }] });
  });

  it("FOS1-INBOX-04: derived Action Needed for in_review = 'Review & approve'", () => {
    const props = artifactToFounderInboxProperties(makeArtifact({ status: "in_review" }), ctx);
    expect(props["Action Needed"]).toEqual({ select: { name: "Review & approve" } });
    expect(props.Status).toEqual({ select: { name: "in_review" } });
  });

  it("FOS1-INBOX-05: derived Action Needed for ready_for_action = 'Ready to execute'", () => {
    const props = artifactToFounderInboxProperties(
      makeArtifact({ status: "ready_for_action" }),
      ctx,
    );
    expect(props["Action Needed"]).toEqual({ select: { name: "Ready to execute" } });
    expect(props.Status).toEqual({ select: { name: "ready_for_action" } });
  });

  it("FOS1-INBOX-06: over-long title is split into <=2000-char rich_text objects (no silent 400)", () => {
    const longTitle = "x".repeat(4500);
    const props = artifactToFounderInboxProperties(makeArtifact({ title: longTitle }), ctx) as {
      Title: { rich_text: { text: { content: string } }[] };
    };
    const chunks = props.Title.rich_text;
    expect(chunks).toHaveLength(3); // 2000 + 2000 + 500
    expect(chunks.every((c) => c.text.content.length <= 2000)).toBe(true);
    expect(chunks.map((c) => c.text.content).join("")).toBe(longTitle);
  });

  it("FOS1-INBOX-07: an out-of-contract status throws (no silent 'Ready to execute' mislabel)", () => {
    // Only in_review / ready_for_action are founder-action states; every other
    // lifecycle value must fail loud, not fall through to a wrong Action Needed.
    for (const status of ["draft", "approved", "rejected", "executed", "failed"] as const) {
      expect(() => artifactToFounderInboxProperties(makeArtifact({ status }), ctx)).toThrow(
        /not a founder-action state/,
      );
    }
  });

  it("FOS1-INBOX-08: title past Notion's 100-object array cap truncates to 100 with a marker", () => {
    const huge = "y".repeat(2000 * 100 + 1); // 101 chunks pre-cap
    const props = artifactToFounderInboxProperties(makeArtifact({ title: huge }), ctx) as {
      Title: { rich_text: { text: { content: string } }[] };
    };
    const chunks = props.Title.rich_text;
    expect(chunks).toHaveLength(100);
    expect(chunks.every((c) => c.text.content.length <= 2000)).toBe(true);
    expect(chunks[99]!.text.content.endsWith(" […truncated]")).toBe(true);
  });

  it("FOS1-INBOX-09: invalid updatedAt throws instead of emitting NaN", () => {
    expect(() => artifactFosVersion(new Date("not-a-date"))).toThrow(/not a valid Date/);
  });
});
