import { describe, it, expect } from "vitest";
import type { GateContext } from "../gate.js";
import {
  claimsApprovedForChannelAndOfferGate,
  type ApprovedClaim,
} from "../claims-approved-for-channel-and-offer.js";

interface FakeInput {
  channel?: string;
  offer?: string;
  now: string;
  approvedClaims: ApprovedClaim[];
}
interface FakeOutput {
  claimsManifest: string[];
}

function ctx(
  input: Partial<FakeInput>,
  output: Partial<FakeOutput>,
): GateContext<FakeInput, FakeOutput> {
  return {
    workspaceId: "ws-1",
    agentKey: "fos.personalized_follow_up",
    mode: "review",
    input: {
      channel: "email",
      offer: "cohort-2026-a",
      now: "2026-06-15T00:00:00.000Z",
      approvedClaims: [],
      ...input,
    },
    output: { claimsManifest: [], ...output },
  };
}

// A claim approved for email+linkedin / cohort-2026-a, effective all of 2026.
const APPROVED_2026: ApprovedClaim = {
  claim: "graduates report a median 20% salary increase",
  channels: ["email", "linkedin"],
  offers: ["cohort-2026-a"],
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: "2026-12-31T23:59:59.000Z",
};

const gate = claimsApprovedForChannelAndOfferGate<FakeInput, FakeOutput>({
  key: "fos.personalized_follow_up.claims-approved-for-channel-and-offer",
  selectClaims: (output) => output.claimsManifest,
  selectApprovedClaims: (input) => input.approvedClaims,
  selectChannel: (_output, input) => input.channel,
  selectOffer: (_output, input) => input.offer,
  now: (input) => input.now,
});

describe("FOS1-CLAIMOFFER-allow", () => {
  it("ALLOW: claim is approved, allowed for the channel+offer, and effective now", async () => {
    const result = await gate.evaluate(
      ctx({ approvedClaims: [APPROVED_2026] }, { claimsManifest: [APPROVED_2026.claim] }),
    );
    expect(result.allowed).toBe(true);
  });

  it("ALLOW: an empty manifest is trivially allowed (nothing to validate)", async () => {
    const result = await gate.evaluate(ctx({ approvedClaims: [] }, { claimsManifest: [] }));
    expect(result.allowed).toBe(true);
  });
});

describe("FOS1-CLAIMOFFER-block", () => {
  it("BLOCK: claim not present in the approved-claims context", async () => {
    const result = await gate.evaluate(
      ctx({ approvedClaims: [APPROVED_2026] }, { claimsManifest: ["a rogue unapproved claim"] }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not in the approved-claims context/);
  });

  it("BLOCK: claim is expired (now after effectiveTo)", async () => {
    const result = await gate.evaluate(
      ctx(
        { approvedClaims: [APPROVED_2026], now: "2027-01-02T00:00:00.000Z" },
        { claimsManifest: [APPROVED_2026.claim] },
      ),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/is expired/);
  });

  it("BLOCK: claim is not yet effective (now before effectiveFrom)", async () => {
    const result = await gate.evaluate(
      ctx(
        { approvedClaims: [APPROVED_2026], now: "2025-12-31T00:00:00.000Z" },
        { claimsManifest: [APPROVED_2026.claim] },
      ),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/is not yet effective/);
  });

  it("BLOCK: claim not approved for the run's channel", async () => {
    const result = await gate.evaluate(
      ctx(
        { approvedClaims: [APPROVED_2026], channel: "sms" },
        { claimsManifest: [APPROVED_2026.claim] },
      ),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not approved for channel "sms"/);
  });

  it("BLOCK: claim not approved for the run's offer", async () => {
    const result = await gate.evaluate(
      ctx(
        { approvedClaims: [APPROVED_2026], offer: "cohort-2026-b" },
        { claimsManifest: [APPROVED_2026.claim] },
      ),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not approved for offer "cohort-2026-b"/);
  });

  it("BLOCK: blocks on the FIRST failing claim among several", async () => {
    const second: ApprovedClaim = { ...APPROVED_2026, claim: "second approved claim" };
    const result = await gate.evaluate(
      ctx(
        { approvedClaims: [APPROVED_2026, second] },
        { claimsManifest: [APPROVED_2026.claim, "rogue", second.claim] },
      ),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/"rogue"/);
  });
});

describe("FOS1-CLAIMOFFER-fail-closed", () => {
  it("FAIL-CLOSED: absent channel blocks the whole manifest", async () => {
    const result = await gate.evaluate(
      ctx(
        { approvedClaims: [APPROVED_2026], channel: undefined },
        {
          claimsManifest: [APPROVED_2026.claim],
        },
      ),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/channel is absent/);
  });

  it("FAIL-CLOSED: absent offer blocks the whole manifest", async () => {
    const result = await gate.evaluate(
      ctx(
        { approvedClaims: [APPROVED_2026], offer: undefined },
        {
          claimsManifest: [APPROVED_2026.claim],
        },
      ),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/offer is absent/);
  });

  it("FAIL-CLOSED: an approved claim with a missing effective window blocks (effectiveness enforced)", async () => {
    const noWindow: ApprovedClaim = {
      claim: "windowless claim",
      channels: ["email"],
      offers: ["cohort-2026-a"],
    };
    const result = await gate.evaluate(
      ctx({ approvedClaims: [noWindow] }, { claimsManifest: [noWindow.claim] }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/missing or malformed effective window/);
  });

  it("FAIL-CLOSED: a malformed effective window bound blocks", async () => {
    const badWindow: ApprovedClaim = {
      claim: "bad window claim",
      channels: ["email"],
      offers: ["cohort-2026-a"],
      effectiveFrom: "not-a-date",
      effectiveTo: "2026-12-31T00:00:00.000Z",
    };
    const result = await gate.evaluate(
      ctx({ approvedClaims: [badWindow] }, { claimsManifest: [badWindow.claim] }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/missing or malformed effective window/);
  });

  it("FAIL-CLOSED: a malformed `now` blocks (does not silently allow via NaN)", async () => {
    const result = await gate.evaluate(
      ctx(
        { approvedClaims: [APPROVED_2026], now: "garbage" },
        {
          claimsManifest: [APPROVED_2026.claim],
        },
      ),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/invalid time input/);
  });
});

describe("FOS1-CLAIMOFFER-no-clock", () => {
  // Without a `now` selector, effectiveness cannot be PROVEN. A claim that
  // declares a window blocks fail-closed (weaken-by-omission is not allowed for
  // a safety gate — §11 line 405 makes "effective" mandatory); a WINDOWLESS
  // approved claim passes (there is nothing to enforce). Approval + channel +
  // offer are always enforced.
  const gateNoClock = claimsApprovedForChannelAndOfferGate<FakeInput, FakeOutput>({
    key: "fos.personalized_follow_up.claims-approved-no-clock",
    selectClaims: (output) => output.claimsManifest,
    selectApprovedClaims: (input) => input.approvedClaims,
    selectChannel: (_output, input) => input.channel,
    selectOffer: (_output, input) => input.offer,
  });

  const APPROVED_NO_WINDOW = {
    claim: APPROVED_2026.claim,
    channels: APPROVED_2026.channels,
    offers: APPROVED_2026.offers,
  };

  it("BLOCK: a windowed claim without a clock fails closed (effectiveness unprovable)", async () => {
    const result = await gateNoClock.evaluate(
      ctx({ approvedClaims: [APPROVED_2026] }, { claimsManifest: [APPROVED_2026.claim] }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/no clock was supplied/);
  });

  it("ALLOW: a windowless approved claim without a clock passes (nothing to enforce)", async () => {
    const result = await gateNoClock.evaluate(
      ctx({ approvedClaims: [APPROVED_NO_WINDOW] }, { claimsManifest: [APPROVED_NO_WINDOW.claim] }),
    );
    expect(result.allowed).toBe(true);
  });

  it("BLOCK: without a clock, channel is still enforced", async () => {
    const result = await gateNoClock.evaluate(
      ctx(
        { approvedClaims: [APPROVED_2026], channel: "sms" },
        { claimsManifest: [APPROVED_2026.claim] },
      ),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not approved for channel/);
  });
});
