import { describe, it, expect } from "vitest";
import type { Gate, GateContext } from "../gate.js";
import { platformDraftGate } from "../platform-draft.js";
import {
  claimsApprovedForChannelAndOfferGate,
  type ApprovedClaim,
} from "../claims-approved-for-channel-and-offer.js";
import { contactConsentGate, type ContactConsentGrant } from "../contact-consent.js";

interface FakeInput {
  approvalState?: string;
  channel: string;
  offer: string;
  now: string;
  approvedClaims: ApprovedClaim[];
  purpose: string;
  grants: ContactConsentGrant[];
}
interface FakeOutput {
  claimsManifest: string[];
}

const APPROVED_2026: ApprovedClaim = {
  claim: "graduates report a median 20% salary increase",
  channels: ["email"],
  offers: ["cohort-2026-a"],
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: "2026-12-31T23:59:59.000Z",
};

function ctx(
  input: Partial<FakeInput>,
  output: Partial<FakeOutput>,
): GateContext<FakeInput, FakeOutput> {
  return {
    workspaceId: "ws-1",
    agentKey: "fos.personalized_follow_up",
    mode: "review",
    input: {
      approvalState: "approved",
      channel: "email",
      offer: "cohort-2026-a",
      now: "2026-06-15T00:00:00.000Z",
      approvedClaims: [APPROVED_2026],
      purpose: "operational",
      grants: [{ purpose: "operational", channel: "email" }],
      ...input,
    },
    output: { claimsManifest: [APPROVED_2026.claim], ...output },
  };
}

// The real claims + consent preconditions, composed by the platform-draft gate.
const claimsGate = claimsApprovedForChannelAndOfferGate<FakeInput, FakeOutput>({
  key: "claims",
  selectClaims: (output) => output.claimsManifest,
  selectApprovedClaims: (input) => input.approvedClaims,
  selectChannel: (_output, input) => input.channel,
  selectOffer: (_output, input) => input.offer,
  now: (input) => input.now,
});
const consentGateReal = contactConsentGate<FakeInput, FakeOutput>({
  key: "consent",
  selectContactPurpose: (_output, input) => input.purpose,
  selectContactChannel: (_output, input) => input.channel,
  selectConsentGrants: (input) => input.grants,
});

const gate = platformDraftGate<FakeInput, FakeOutput>({
  key: "fos.personalized_follow_up.platform-draft",
  selectApprovalState: (input) => input.approvalState,
  preconditionGates: [claimsGate, consentGateReal],
});

describe("FOS1-PLATDRAFT-allow", () => {
  it("ALLOW: approved state AND claims+consent preconditions both (re)validate", async () => {
    const result = await gate.evaluate(ctx({}, {}));
    expect(result.allowed).toBe(true);
  });
});

describe("FOS1-PLATDRAFT-block", () => {
  it("BLOCK: artifact not in an approved state", async () => {
    const result = await gate.evaluate(ctx({ approvalState: "pending_approval" }, {}));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not in an approved state/);
  });

  it("BLOCK: approved but a claim precondition fails (expired) — surfaces the child reason", async () => {
    const result = await gate.evaluate(ctx({ now: "2027-01-02T00:00:00.000Z" }, {}));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/precondition failed/);
    expect(result.reason).toMatch(/is expired/);
  });

  it("BLOCK: approved but a consent precondition fails — surfaces the child reason", async () => {
    const result = await gate.evaluate(ctx({ grants: [] }, {}));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/precondition failed/);
    expect(result.reason).toMatch(/no recorded operational-contact consent/);
  });
});

describe("FOS1-PLATDRAFT-fail-closed", () => {
  it("FAIL-CLOSED: absent approval state is not eligible (never defaults to approved)", async () => {
    const result = await gate.evaluate(ctx({ approvalState: undefined }, {}));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not in an approved state/);
  });

  it("edge: a custom approvedStates set is honored", async () => {
    const custom = platformDraftGate<FakeInput, FakeOutput>({
      key: "custom",
      selectApprovalState: (input) => input.approvalState,
      approvedStates: ["founder_approved"],
      preconditionGates: [claimsGate, consentGateReal],
    });
    expect((await custom.evaluate(ctx({ approvalState: "founder_approved" }, {}))).allowed).toBe(
      true,
    );
    expect((await custom.evaluate(ctx({ approvalState: "approved" }, {}))).allowed).toBe(false);
  });

  it("throws at construction when no precondition gates are supplied (claims/consent revalidation is mandatory, §9.4 step 9)", () => {
    expect(() =>
      platformDraftGate<FakeInput, FakeOutput>({
        key: "bare",
        selectApprovalState: (input) => input.approvalState,
        preconditionGates: [],
      }),
    ).toThrow(/at least one precondition/);
  });

  it("edge: a blocking precondition gate short-circuits (fail-closed composition)", async () => {
    const alwaysBlock: Gate<FakeInput, FakeOutput> = {
      key: "always-block",
      evaluate: () => ({ allowed: false, reason: "sentinel block" }),
    };
    const composed = platformDraftGate<FakeInput, FakeOutput>({
      key: "composed",
      selectApprovalState: (input) => input.approvalState,
      preconditionGates: [alwaysBlock],
    });
    const result = await composed.evaluate(ctx({}, {}));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/sentinel block/);
  });
});
