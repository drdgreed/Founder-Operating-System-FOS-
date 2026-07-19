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
