import { describe, expect, it } from "vitest";
import { eventEnvelopeSchema, validateEventPayload } from "./index.js";

const validEnvelope = {
  id: "00000000-0000-0000-0000-000000000001",
  workspace_id: "00000000-0000-0000-0000-000000000002",
  product_id: "00000000-0000-0000-0000-000000000003",
  entity_type: "EnrollmentOpportunity",
  entity_id: "opp_123",
  source: "api",
  correlation_id: "00000000-0000-0000-0000-000000000004",
  causation_id: null,
  occurred_at: "2026-07-16T12:00:00.000Z",
  actor: { type: "founder" as const, id: "founder_1" },
  type: "opportunity.created",
  payload: { stage: "new" },
};

describe("eventEnvelopeSchema (PATCH-SET-01 §S1)", () => {
  it("accepts a well-formed envelope", () => {
    expect(eventEnvelopeSchema.safeParse(validEnvelope).success).toBe(true);
  });

  it("allows a null product_id (founder-level events, §B0)", () => {
    const founderLevel = { ...validEnvelope, product_id: null };
    expect(eventEnvelopeSchema.safeParse(founderLevel).success).toBe(true);
  });

  it("rejects an envelope missing entity_type (§S1 keeps it on the envelope)", () => {
    const { entity_type: _omit, ...missing } = validEnvelope;
    expect(eventEnvelopeSchema.safeParse(missing).success).toBe(false);
  });

  it("rejects a non-uuid correlation_id", () => {
    const bad = { ...validEnvelope, correlation_id: "not-a-uuid" };
    expect(eventEnvelopeSchema.safeParse(bad).success).toBe(false);
  });
});

describe("validateEventPayload — artifact payload registry (PATCH-SET-02 §C)", () => {
  const aId = "00000000-0000-0000-0000-0000000000a1";
  const vId = "00000000-0000-0000-0000-0000000000b2";

  it("FOS0-ART-44: accepts a well-formed lifecycle payload", () => {
    expect(() =>
      validateEventPayload("artifact.approved", {
        artifactId: aId,
        versionId: vId,
        fromStatus: "in_review",
        toStatus: "approved",
      }),
    ).not.toThrow();
  });

  it("FOS0-ART-45: rejects a malformed lifecycle payload (missing toStatus)", () => {
    expect(() =>
      validateEventPayload("artifact.approved", {
        artifactId: aId,
        versionId: vId,
        fromStatus: "in_review",
      }),
    ).toThrow();
  });

  it("FOS0-ART-46: rejects a lifecycle payload with an out-of-range status", () => {
    expect(() =>
      validateEventPayload("artifact.approved", {
        artifactId: aId,
        versionId: vId,
        fromStatus: "in_review",
        toStatus: "not_a_state",
      }),
    ).toThrow();
  });

  it("FOS0-ART-47: rejects an unregistered artifact.* event type", () => {
    expect(() => validateEventPayload("artifact.frobnicated", { any: "thing" })).toThrow(
      /unregistered artifact event type/i,
    );
  });

  it("FOS0-ART-48: passes through a non-artifact event type unchecked", () => {
    expect(() =>
      validateEventPayload("opportunity.stage_changed", { whatever: true }),
    ).not.toThrow();
  });

  it("FOS0-ART-49: validates the created / version_created / draft_edited shapes", () => {
    expect(() =>
      validateEventPayload("artifact.created", {
        artifactId: aId,
        versionId: vId,
        artifactType: "internal_note",
      }),
    ).not.toThrow();
    expect(() =>
      validateEventPayload("artifact.version_created", {
        artifactId: aId,
        versionId: vId,
        versionNumber: 2,
      }),
    ).not.toThrow();
    expect(() =>
      validateEventPayload("artifact.draft_edited", {
        artifactId: aId,
        versionId: vId,
        previousContentHash: "aaa",
        contentHash: "bbb",
      }),
    ).not.toThrow();
    // extra key rejected (strict shape)
    expect(() =>
      validateEventPayload("artifact.version_created", {
        artifactId: aId,
        versionId: vId,
        versionNumber: 2,
        extra: "x",
      }),
    ).toThrow();
  });
});

describe("validateEventPayload — approval payload registry (slice 0.1c, §S1)", () => {
  const approvalId = "00000000-0000-0000-0000-0000000000c3";
  const versionId = "00000000-0000-0000-0000-0000000000d4";

  it("FOS0-APV-08: accepts a well-formed approval.recorded payload", () => {
    expect(() =>
      validateEventPayload("approval.recorded", {
        approvalId,
        artifactVersionId: versionId,
        decision: "approved",
        riskLevel: "high",
      }),
    ).not.toThrow();
  });

  it("FOS0-APV-09: rejects a malformed approval.recorded payload (bad decision / missing field / extra key)", () => {
    expect(() =>
      validateEventPayload("approval.recorded", {
        approvalId,
        artifactVersionId: versionId,
        decision: "not_a_decision",
        riskLevel: "high",
      }),
    ).toThrow();
    expect(() =>
      validateEventPayload("approval.recorded", {
        approvalId,
        artifactVersionId: versionId,
        decision: "approved",
      }),
    ).toThrow();
    expect(() =>
      validateEventPayload("approval.recorded", {
        approvalId,
        artifactVersionId: versionId,
        decision: "approved",
        riskLevel: "low",
        extra: "x",
      }),
    ).toThrow();
  });

  it("FOS0-APV-10: rejects an unregistered approval.* event type", () => {
    expect(() => validateEventPayload("approval.frobnicated", { any: "thing" })).toThrow(
      /unregistered approval event type/i,
    );
  });
});
