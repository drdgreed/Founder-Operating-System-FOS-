import { describe, it, expect } from "vitest";
import type { GateContext } from "../gate.js";
import { contactConsentGate, type ContactConsentGrant } from "../contact-consent.js";

interface FakeInput {
  purpose?: string;
  channel?: string;
  grants: ContactConsentGrant[];
}
type FakeOutput = Record<string, never>;

function ctx(input: Partial<FakeInput>): GateContext<FakeInput, FakeOutput> {
  return {
    workspaceId: "ws-1",
    agentKey: "fos.personalized_follow_up",
    mode: "review",
    input: { purpose: "operational", channel: "email", grants: [], ...input },
    output: {},
  };
}

const gate = contactConsentGate<FakeInput, FakeOutput>({
  key: "fos.personalized_follow_up.contact-consent",
  selectContactPurpose: (_output, input) => input.purpose,
  selectContactChannel: (_output, input) => input.channel,
  selectConsentGrants: (input) => input.grants,
});

describe("FOS1-CONSENT2-allow", () => {
  it("ALLOW: purpose+channel pair is affirmatively granted", async () => {
    const result = await gate.evaluate(
      ctx({
        purpose: "operational",
        channel: "email",
        grants: [{ purpose: "operational", channel: "email" }],
      }),
    );
    expect(result.allowed).toBe(true);
  });

  it("ALLOW: marketing purpose with a matching marketing grant", async () => {
    const result = await gate.evaluate(
      ctx({
        purpose: "marketing",
        channel: "email",
        grants: [{ purpose: "marketing", channel: "email" }],
      }),
    );
    expect(result.allowed).toBe(true);
  });
});

describe("FOS1-CONSENT2-block", () => {
  it("BLOCK: purpose+channel pair has no recorded grant", async () => {
    const result = await gate.evaluate(
      ctx({
        purpose: "operational",
        channel: "sms",
        grants: [{ purpose: "operational", channel: "email" }],
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/no recorded operational-contact consent for channel "sms"/);
  });

  it("BLOCK: consent for a DIFFERENT purpose does not extend across purposes", async () => {
    // Operational consent for email must NOT authorize marketing contact on email.
    const result = await gate.evaluate(
      ctx({
        purpose: "marketing",
        channel: "email",
        grants: [{ purpose: "operational", channel: "email" }],
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/no recorded marketing-contact consent/);
  });
});

describe("FOS1-CONSENT2-fail-closed", () => {
  it("FAIL-CLOSED: empty grant list blocks", async () => {
    const result = await gate.evaluate(
      ctx({ purpose: "operational", channel: "email", grants: [] }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/no recorded operational-contact consent/);
  });

  it("FAIL-CLOSED: absent purpose blocks", async () => {
    const result = await gate.evaluate(
      ctx({
        purpose: undefined,
        channel: "email",
        grants: [{ purpose: "operational", channel: "email" }],
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/unknown or absent contact purpose/);
  });

  it("FAIL-CLOSED: unknown/unrecognized purpose blocks", async () => {
    const result = await gate.evaluate(
      ctx({
        purpose: "sales",
        channel: "email",
        grants: [{ purpose: "operational", channel: "email" }],
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/unknown or absent contact purpose/);
  });

  it("FAIL-CLOSED: absent channel blocks (a contact purpose always implies a contact)", async () => {
    const result = await gate.evaluate(
      ctx({
        purpose: "operational",
        channel: undefined,
        grants: [{ purpose: "operational", channel: "email" }],
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/contact channel is absent/);
  });
});
