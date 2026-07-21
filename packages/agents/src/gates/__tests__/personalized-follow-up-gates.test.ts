import { describe, it, expect } from "vitest";
import type { GateContext } from "../gate.js";
import { claimsInApprovedSetGate } from "../claims-in-approved-set.js";
import { consentGate } from "../consent.js";

interface FakeInput {
  channel: string;
  consentedChannels: string[];
  approvedClaims: string[];
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
    input: { channel: "email", consentedChannels: [], approvedClaims: [], ...input },
    output: { claimsManifest: [], ...output },
  };
}

describe("FOS1-FOLLOWUP-GATE-claims-in-approved-set", () => {
  const gate = claimsInApprovedSetGate<FakeInput, FakeOutput>({
    key: "fos.personalized_follow_up.claims-in-approved-set",
    selectClaims: (output) => output.claimsManifest,
    selectApprovedClaims: (input) => input.approvedClaims,
  });

  it("ALLOW: every claim is in the approved set", async () => {
    const result = await gate.evaluate(
      ctx({ approvedClaims: ["a", "b", "c"] }, { claimsManifest: ["a", "c"] }),
    );
    expect(result.allowed).toBe(true);
  });

  it("ALLOW: an empty manifest is trivially allowed", async () => {
    const result = await gate.evaluate(ctx({ approvedClaims: ["a"] }, { claimsManifest: [] }));
    expect(result.allowed).toBe(true);
  });

  it("BLOCK: any claim not in the approved set blocks (fail-closed against an empty approved set)", async () => {
    const result = await gate.evaluate(ctx({ approvedClaims: [] }, { claimsManifest: ["a"] }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not in the approved-claims set/);
  });

  it("BLOCK: a single unapproved claim among approved ones still blocks", async () => {
    const result = await gate.evaluate(
      ctx({ approvedClaims: ["a", "b"] }, { claimsManifest: ["a", "rogue"] }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/"rogue"/);
  });
});

describe("FOS1-FOLLOWUP-GATE-consent (channel read from INPUT via the generalized selector)", () => {
  // issue #82: unlike next-best-action, this agent's channel is a caller INPUT.
  // The generalized second selector parameter lets the same allowlist gate read
  // `input.channel`.
  const gate = consentGate<FakeInput, FakeOutput>({
    key: "fos.personalized_follow_up.consent",
    selectProposedActionChannel: (_output, input) => input.channel,
    selectConsentedChannels: (input) => input.consentedChannels,
  });

  it("ALLOW: input channel is in the consented allowlist", async () => {
    const result = await gate.evaluate(
      ctx({ channel: "email", consentedChannels: ["email", "sms"] }, {}),
    );
    expect(result.allowed).toBe(true);
  });

  it("BLOCK: input channel not in the allowlist", async () => {
    const result = await gate.evaluate(ctx({ channel: "sms", consentedChannels: ["email"] }, {}));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/no recorded consent/);
  });

  it("DECISIVE (option B, fail-closed): an empty allowlist blocks the input channel", async () => {
    const result = await gate.evaluate(ctx({ channel: "email", consentedChannels: [] }, {}));
    expect(result.allowed).toBe(false);
  });
});
