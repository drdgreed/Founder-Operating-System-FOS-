import { describe, expect, it } from "vitest";
import { eventEnvelopeSchema } from "./index.js";

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
