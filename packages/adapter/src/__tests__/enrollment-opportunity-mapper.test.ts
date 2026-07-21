import { describe, it, expect } from "vitest";
import {
  enrollmentOpportunityToNotionProperties,
  type EnrollmentOpportunityRow,
} from "../enrollment-opportunity-mapper.js";

function makeOpportunity(
  overrides: Partial<EnrollmentOpportunityRow> = {},
): EnrollmentOpportunityRow {
  return {
    id: "opp-1",
    workspaceId: "ws-1",
    productId: "prod-1",
    personId: "person-1",
    programId: null,
    cohortId: null,
    offerId: null,
    stage: "reviewing",
    statusReason: null,
    fitStatus: null,
    fitScore: null,
    fitSummary: null,
    estimatedValueCents: null,
    currency: "USD",
    actualValueCents: null,
    primaryGoal: null,
    targetRole: null,
    targetTimeline: null,
    recommendedPathway: null,
    leadOwnerId: null,
    lastInteractionAt: null,
    nextActionType: null,
    nextActionDueAt: null,
    nextActionSummary: null,
    closedAt: null,
    version: 3,
    campaignId: null,
    firstTouchSource: null,
    lastTouchSource: null,
    attributionConfidence: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  };
}

describe("enrollmentOpportunityToNotionProperties (issue #27, §C1/§C2)", () => {
  it("FOS0-PRJ-01: emits all 7 §C1 hidden properties with correct values", () => {
    const opp = makeOpportunity();
    const lastSyncedAt = new Date("2026-07-18T12:00:00Z");

    const properties = enrollmentOpportunityToNotionProperties(opp, {
      workspaceId: "ws-1",
      productId: "prod-1",
      syncStatus: "in_sync",
      lastSyncedAt,
    });

    expect(properties["FOS Record ID"]).toEqual({ rich_text: [{ text: { content: "opp-1" } }] });
    expect(properties["FOS Entity Type"]).toEqual({
      rich_text: [{ text: { content: "EnrollmentOpportunity" } }],
    });
    expect(properties["FOS Workspace ID"]).toEqual({
      rich_text: [{ text: { content: "ws-1" } }],
    });
    expect(properties["FOS Product ID"]).toEqual({
      rich_text: [{ text: { content: "prod-1" } }],
    });
    expect(properties["Sync Status"]).toEqual({ select: { name: "in_sync" } });
    // §C2: versioned entity -> FOS Version = entity.version.
    expect(properties["FOS Version"]).toEqual({ number: 3 });
    expect(properties["Last Synced At"]).toEqual({
      date: { start: "2026-07-18T12:00:00.000Z" },
    });
  });

  it("FOS0-PRJ-02: FOS Product ID is empty rich_text when productId is null (§B0 founder-level)", () => {
    const opp = makeOpportunity();

    const properties = enrollmentOpportunityToNotionProperties(opp, {
      workspaceId: "ws-1",
      productId: null,
      syncStatus: "pending",
      lastSyncedAt: new Date("2026-07-18T12:00:00Z"),
    });

    expect(properties["FOS Product ID"]).toEqual({ rich_text: [] });
  });

  it("FOS0-PRJ-03: projects the visible Stage field from opp.stage", () => {
    const opp = makeOpportunity({ stage: "offered" });

    const properties = enrollmentOpportunityToNotionProperties(opp, {
      workspaceId: "ws-1",
      productId: "prod-1",
      syncStatus: "in_sync",
      lastSyncedAt: new Date("2026-07-18T12:00:00Z"),
    });

    expect(properties.Stage).toEqual({ select: { name: "offered" } });
  });

  it("FOS0-PRJ-04: FOS Version tracks a version bump (C2 conflict-check target)", () => {
    const opp = makeOpportunity({ version: 7 });

    const properties = enrollmentOpportunityToNotionProperties(opp, {
      workspaceId: "ws-1",
      productId: "prod-1",
      syncStatus: "in_sync",
      lastSyncedAt: new Date("2026-07-18T12:00:00Z"),
    });

    expect(properties["FOS Version"]).toEqual({ number: 7 });
  });
});

const CTX = {
  workspaceId: "ws-1",
  productId: "prod-1",
  syncStatus: "in_sync" as const,
  lastSyncedAt: new Date("2026-07-18T12:00:00Z"),
};

describe("enrollmentOpportunityToNotionProperties §7.2 fields (issue #86, P1.5a)", () => {
  it("FOS1-PRJ-01: projects all §7.2 opportunity-owned fields when POPULATED", () => {
    const opp = makeOpportunity({
      fitSummary: "Strong ICP fit, urgent timeline",
      primaryGoal: "Land a senior PM role",
      targetRole: "Senior Product Manager",
      targetTimeline: "Q3 2026",
      fitStatus: "qualified-high",
      fitScore: 87,
      estimatedValueCents: 1200000,
      actualValueCents: 950000,
      currency: "USD",
      lastInteractionAt: new Date("2026-07-15T09:30:00Z"),
      lastTouchSource: "reply_email",
      nextActionSummary: "Send offer packet",
      nextActionType: "send_offer",
      nextActionDueAt: new Date("2026-07-22T17:00:00Z"),
      recommendedPathway: "accelerator-track",
    });

    const properties = enrollmentOpportunityToNotionProperties(opp, CTX);

    // Summary group
    expect(properties.Summary).toEqual({
      rich_text: [{ text: { content: "Strong ICP fit, urgent timeline" } }],
    });
    expect(properties["Primary Goal"]).toEqual({
      rich_text: [{ text: { content: "Land a senior PM role" } }],
    });
    expect(properties["Target Role"]).toEqual({
      rich_text: [{ text: { content: "Senior Product Manager" } }],
    });
    expect(properties["Target Timeline"]).toEqual({
      rich_text: [{ text: { content: "Q3 2026" } }],
    });

    // Fit group — fitStatus is OPEN TEXT (rich_text, not a select enum)
    expect(properties["Fit Status"]).toEqual({
      rich_text: [{ text: { content: "qualified-high" } }],
    });
    expect(properties["Fit Score"]).toEqual({ number: 87 });

    // Value group — cents projected as MAJOR UNITS (cents / 100)
    expect(properties["Estimated Value"]).toEqual({ number: 12000 });
    expect(properties["Actual Value"]).toEqual({ number: 9500 });
    expect(properties.Currency).toEqual({ select: { name: "USD" } });

    // Last interaction group
    expect(properties["Last Interaction At"]).toEqual({
      date: { start: "2026-07-15T09:30:00.000Z" },
    });
    expect(properties["Last Touch Source"]).toEqual({
      rich_text: [{ text: { content: "reply_email" } }],
    });

    // Next action group — nextActionType is OPEN TEXT (rich_text)
    expect(properties["Next Action"]).toEqual({
      rich_text: [{ text: { content: "Send offer packet" } }],
    });
    expect(properties["Next Action Type"]).toEqual({
      rich_text: [{ text: { content: "send_offer" } }],
    });
    expect(properties["Next Action Due At"]).toEqual({
      date: { start: "2026-07-22T17:00:00.000Z" },
    });
    expect(properties["Recommended Pathway"]).toEqual({
      rich_text: [{ text: { content: "accelerator-track" } }],
    });

    // Canonical link surfaces the FOS record id
    expect(properties["Canonical Link"]).toEqual({
      rich_text: [{ text: { content: "opp-1" } }],
    });
  });

  it("FOS1-PRJ-02: nullable §7.2 fields map to correct empty Notion shapes when NULL", () => {
    // makeOpportunity() defaults every §7.2 column to null (except currency).
    const opp = makeOpportunity();

    const properties = enrollmentOpportunityToNotionProperties(opp, CTX);

    // rich_text nulls -> empty array
    expect(properties.Summary).toEqual({ rich_text: [] });
    expect(properties["Primary Goal"]).toEqual({ rich_text: [] });
    expect(properties["Target Role"]).toEqual({ rich_text: [] });
    expect(properties["Target Timeline"]).toEqual({ rich_text: [] });
    expect(properties["Fit Status"]).toEqual({ rich_text: [] });
    expect(properties["Last Touch Source"]).toEqual({ rich_text: [] });
    expect(properties["Next Action"]).toEqual({ rich_text: [] });
    expect(properties["Next Action Type"]).toEqual({ rich_text: [] });
    expect(properties["Recommended Pathway"]).toEqual({ rich_text: [] });

    // number nulls -> { number: null } (NOT omitted, NOT wrapped)
    expect(properties["Fit Score"]).toEqual({ number: null });
    expect(properties["Estimated Value"]).toEqual({ number: null });
    expect(properties["Actual Value"]).toEqual({ number: null });

    // date nulls -> { date: null } (NOT { date: { start: null } })
    expect(properties["Last Interaction At"]).toEqual({ date: null });
    expect(properties["Next Action Due At"]).toEqual({ date: null });

    // Canonical link is never null (record id is non-null)
    expect(properties["Canonical Link"]).toEqual({
      rich_text: [{ text: { content: "opp-1" } }],
    });
  });

  it("FOS1-PRJ-03: currency projects as a select from a non-USD value", () => {
    const opp = makeOpportunity({ currency: "EUR" });

    const properties = enrollmentOpportunityToNotionProperties(opp, CTX);

    expect(properties.Currency).toEqual({ select: { name: "EUR" } });
  });

  it("FOS1-PRJ-04: value cents divide to major units, incl. fractional cents", () => {
    const opp = makeOpportunity({ estimatedValueCents: 12345, actualValueCents: 99 });

    const properties = enrollmentOpportunityToNotionProperties(opp, CTX);

    expect(properties["Estimated Value"]).toEqual({ number: 123.45 });
    expect(properties["Actual Value"]).toEqual({ number: 0.99 });
  });

  it("FOS1-PRJ-05: regression — 7 §C1 hidden properties + Stage still emitted unchanged", () => {
    const opp = makeOpportunity({
      stage: "enrolled",
      version: 4,
      // populate §7.2 fields to prove they do not perturb the §C1 contract
      fitSummary: "x",
      fitScore: 50,
      estimatedValueCents: 500,
    });
    const lastSyncedAt = new Date("2026-07-18T12:00:00Z");

    const properties = enrollmentOpportunityToNotionProperties(opp, {
      workspaceId: "ws-1",
      productId: "prod-1",
      syncStatus: "in_sync",
      lastSyncedAt,
    });

    expect(properties["FOS Record ID"]).toEqual({ rich_text: [{ text: { content: "opp-1" } }] });
    expect(properties["FOS Entity Type"]).toEqual({
      rich_text: [{ text: { content: "EnrollmentOpportunity" } }],
    });
    expect(properties["FOS Workspace ID"]).toEqual({ rich_text: [{ text: { content: "ws-1" } }] });
    expect(properties["FOS Product ID"]).toEqual({ rich_text: [{ text: { content: "prod-1" } }] });
    expect(properties["Sync Status"]).toEqual({ select: { name: "in_sync" } });
    expect(properties["FOS Version"]).toEqual({ number: 4 });
    expect(properties["Last Synced At"]).toEqual({ date: { start: "2026-07-18T12:00:00.000Z" } });
    expect(properties.Stage).toEqual({ select: { name: "enrolled" } });
  });

  it("FOS1-PRJ-06: rich_text over Notion's 2000-char cap splits into lossless, concatenating chunks", () => {
    // A realistic LLM-generated summary can exceed Notion's 2000-char per-object
    // limit; one over-long value must not 400 the whole page write.
    const long = "a".repeat(4500); // -> 2000 + 2000 + 500
    const opp = makeOpportunity({ nextActionSummary: long });

    const properties = enrollmentOpportunityToNotionProperties(opp, CTX) as {
      "Next Action": { rich_text: { text: { content: string } }[] };
    };
    const parts = properties["Next Action"].rich_text;

    expect(parts).toHaveLength(3);
    expect(parts.map((p) => p.text.content.length)).toEqual([2000, 2000, 500]);
    expect(parts.every((p) => p.text.content.length <= 2000)).toBe(true);
    // lossless: chunks concatenate back to the original value
    expect(parts.map((p) => p.text.content).join("")).toEqual(long);
  });

  it("FOS1-PRJ-06b: content at exactly the 2000-char boundary stays a single chunk", () => {
    const exact = "b".repeat(2000);
    const opp = makeOpportunity({ fitSummary: exact });

    const properties = enrollmentOpportunityToNotionProperties(opp, CTX);

    expect(properties.Summary).toEqual({ rich_text: [{ text: { content: exact } }] });
  });

  it("FOS1-PRJ-07: empty-string currency projects as { select: null }, not an invalid empty-name select", () => {
    // Empty string satisfies the column's NOT NULL; Notion rejects a select
    // whose option name is empty, so it must clear the property instead.
    const opp = makeOpportunity({ currency: "" });

    const properties = enrollmentOpportunityToNotionProperties(opp, CTX);

    expect(properties.Currency).toEqual({ select: null });
  });
});

describe("enrollmentOpportunityToNotionProperties §7.2 join-backed fields (issue #88, P1.5b)", () => {
  it("FOS1-PRJ-08: open objections -> count + deterministic rendered summary", () => {
    const opp = makeOpportunity();

    const properties = enrollmentOpportunityToNotionProperties(opp, {
      ...CTX,
      openObjections: [
        {
          classification: "price",
          category: "budget",
          statement: "The program is out of my current budget.",
          severity: "high",
        },
        {
          classification: "timing",
          category: "schedule",
          statement: "I can't start until Q4.",
          severity: null,
        },
      ],
    });

    expect(properties["Open Objections"]).toEqual({ number: 2 });
    expect(properties.Objections).toEqual({
      rich_text: [
        {
          text: {
            content:
              "[price/budget] The program is out of my current budget.\n[timing/schedule] I can't start until Q4.",
          },
        },
      ],
    });
  });

  it("FOS1-PRJ-09: no objections (empty array) -> { number: 0 } + empty rich_text", () => {
    const opp = makeOpportunity();

    const properties = enrollmentOpportunityToNotionProperties(opp, {
      ...CTX,
      openObjections: [],
    });

    expect(properties["Open Objections"]).toEqual({ number: 0 });
    expect(properties.Objections).toEqual({ rich_text: [] });
  });

  it("FOS1-PRJ-10: objections field ABSENT from ctx (P1.5a caller) -> { number: 0 } + empty rich_text", () => {
    const opp = makeOpportunity();

    // CTX has no openObjections/pendingArtifact — backward-compat with P1.5a.
    const properties = enrollmentOpportunityToNotionProperties(opp, CTX);

    expect(properties["Open Objections"]).toEqual({ number: 0 });
    expect(properties.Objections).toEqual({ rich_text: [] });
    expect(properties["Pending Artifact"]).toEqual({ rich_text: [] });
    expect(properties["Pending Artifact Link"]).toEqual({ rich_text: [] });
  });

  it("FOS1-PRJ-11: single pending artifact -> title/type label + id link, no count suffix", () => {
    const opp = makeOpportunity();

    const properties = enrollmentOpportunityToNotionProperties(opp, {
      ...CTX,
      pendingArtifact: {
        id: "art-1",
        title: "Objection response draft",
        artifactType: "objection_response",
      },
      pendingArtifactCount: 1,
    });

    expect(properties["Pending Artifact"]).toEqual({
      rich_text: [{ text: { content: "Objection response draft [objection_response]" } }],
    });
    expect(properties["Pending Artifact Link"]).toEqual({
      rich_text: [{ text: { content: "art-1" } }],
    });
  });

  it("FOS1-PRJ-12: pending artifact null -> both fields empty rich_text", () => {
    const opp = makeOpportunity();

    const properties = enrollmentOpportunityToNotionProperties(opp, {
      ...CTX,
      pendingArtifact: null,
      pendingArtifactCount: 0,
    });

    expect(properties["Pending Artifact"]).toEqual({ rich_text: [] });
    expect(properties["Pending Artifact Link"]).toEqual({ rich_text: [] });
  });

  it("FOS1-PRJ-13: >1 pending artifacts -> most-recent shown with '+N more awaiting approval'", () => {
    const opp = makeOpportunity();

    const properties = enrollmentOpportunityToNotionProperties(opp, {
      ...CTX,
      pendingArtifact: {
        id: "art-recent",
        title: "Offer follow-up",
        artifactType: "offer_follow_up",
      },
      pendingArtifactCount: 3,
    });

    expect(properties["Pending Artifact"]).toEqual({
      rich_text: [
        { text: { content: "Offer follow-up [offer_follow_up] (+2 more awaiting approval)" } },
      ],
    });
    // The link always points at the single most-recent artifact.
    expect(properties["Pending Artifact Link"]).toEqual({
      rich_text: [{ text: { content: "art-recent" } }],
    });
  });

  it("FOS1-PRJ-14: pending artifact present but count absent -> treated as 1 (no suffix)", () => {
    const opp = makeOpportunity();

    const properties = enrollmentOpportunityToNotionProperties(opp, {
      ...CTX,
      pendingArtifact: { id: "art-1", title: "Draft", artifactType: "call_brief" },
      // pendingArtifactCount intentionally omitted
    });

    expect(properties["Pending Artifact"]).toEqual({
      rich_text: [{ text: { content: "Draft [call_brief]" } }],
    });
  });
});
