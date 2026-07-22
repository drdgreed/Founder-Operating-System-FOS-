import { describe, it, expect } from "vitest";
import {
  classifyGuarantee,
  evaluateGuaranteeText,
  tier1FloorBlock,
  GUARANTEE_CLASSIFIER_SYSTEM_PROMPT,
} from "../guarantee-classifier.js";
import type { GuaranteeClassifierDeps } from "../guarantee-classifier.js";
import { FakeModelClient, validResult } from "../../__tests__/fake-model-client.js";
import type { ModelClient } from "../../model-client.js";

// ===========================================================================
// Hermetic tests — FakeModelClient only. NO real model call ever occurs here.
// The load-bearing safety properties: (1) the Tier-1 floor hard-blocks the
// unambiguous employment-outcome guarantees WITHOUT a model call, and (2) every
// Tier-2 failure mode FAILS CLOSED (block). Wiring tests prove the plumbing
// (allow→allow, block→block), NOT the real model's judgment.
// ===========================================================================

function deps(
  model: ModelClient,
  extra?: Partial<GuaranteeClassifierDeps>,
): GuaranteeClassifierDeps {
  return { model, ...extra };
}

// The unambiguous employment-OUTCOME guarantees the DETERMINISTIC floor must
// catch on its own (David's confirmed block corpus + the block boundary rows).
const FLOOR_MUST_BLOCK: string[] = [
  "we guarantee you a job",
  "guaranteed employment on completion",
  "we'll get you an interview with hiring partners",
  "guaranteed interviews with employers",
  "a guaranteed $90k salary",
  "we'll get you hired",
  "guaranteed placement",
  "we promise you a role at a partner company",
  "you'll land a job in 90 days",
  "we'll get you an interview",
  "we'll get you a job",
];

describe("FOS1-GCLS Tier-1 deterministic floor", () => {
  it.each(FLOOR_MUST_BLOCK)("FOS1-GCLS-floor-blocks-without-model-call: %s", async (text) => {
    // Empty queue: if the model is invoked at all, the fake throws.
    const fake = new FakeModelClient([]);
    const result = await evaluateGuaranteeText(text, deps(fake));
    expect(result.verdict).toBe("block");
    expect(result.tier).toBe("tier1-floor");
    // THE recall-floor property: no model call happened.
    expect(fake.calls.length).toBe(0);
  });

  it("FOS1-GCLS-floor-excludes-readiness: readiness phrasings are NOT floored", () => {
    // These must fall THROUGH the floor to Tier 2 (tier1FloorBlock → null).
    expect(tier1FloorBlock("you'll graduate job-ready")).toBeNull();
    expect(tier1FloorBlock("interview-ready by the end of the module")).toBeNull();
    expect(tier1FloorBlock("you'll be well-practiced at interviewing")).toBeNull();
    expect(tier1FloorBlock("we make sure you're prepared for interviews")).toBeNull();
    expect(tier1FloorBlock("your LinkedIn & resume will be employer-ready")).toBeNull();
    expect(tier1FloorBlock("a portfolio that proves your expertise")).toBeNull();
  });

  it("FOS1-GCLS-floor-normalizes-curly-apostrophe", () => {
    expect(tier1FloorBlock("you’ll land a job")?.verdict).toBe("block");
    expect(tier1FloorBlock("we’ll get you hired")?.verdict).toBe("block");
  });
});

// A readiness phrase that the floor lets through, so Tier 2 is exercised.
const NEEDS_TIER2 = "we make sure you're prepared for interviews";

describe("FOS1-GCLS Tier-2 fail-closed semantics", () => {
  it("FOS1-GCLS-failclosed-throw: classifier throws → BLOCK", async () => {
    const fake = new FakeModelClient([
      () => {
        throw new Error("model exploded");
      },
    ]);
    const result = await classifyGuarantee(NEEDS_TIER2, deps(fake));
    expect(result.verdict).toBe("block");
    expect(result.reason).toMatch(/fail-closed \(error\)/);
  });

  it("FOS1-GCLS-failclosed-timeout: classifier hangs past timeout → BLOCK", async () => {
    // A client whose call never resolves — only the timeout can end it.
    const hangingClient: ModelClient = {
      generateStructured: () => new Promise(() => {}),
    };
    const result = await classifyGuarantee(NEEDS_TIER2, deps(hangingClient, { timeoutMs: 20 }));
    expect(result.verdict).toBe("block");
    expect(result.reason).toMatch(/fail-closed \(timeout\)/);
  });

  it("FOS1-GCLS-failclosed-schema-invalid: response off-schema → BLOCK", async () => {
    const fake = new FakeModelClient([validResult({ unexpected: true })]);
    const result = await classifyGuarantee(NEEDS_TIER2, deps(fake));
    expect(result.verdict).toBe("block");
    expect(result.reason).toMatch(/fail-closed \(schema-invalid\)/);
  });

  it("FOS1-GCLS-failclosed-low-confidence: low-confidence allow → BLOCK", async () => {
    const fake = new FakeModelClient([
      validResult({ verdict: "allow", confidence: "low", reason: "not sure" }),
    ]);
    const result = await classifyGuarantee(NEEDS_TIER2, deps(fake));
    expect(result.verdict).toBe("block");
    expect(result.reason).toMatch(/fail-closed \(low-confidence\)/);
  });

  it("FOS1-GCLS-failclosed-uncertain-block: low-confidence block stays BLOCK", async () => {
    const fake = new FakeModelClient([
      validResult({ verdict: "block", confidence: "low", reason: "leaning block" }),
    ]);
    const result = await classifyGuarantee(NEEDS_TIER2, deps(fake));
    expect(result.verdict).toBe("block");
  });
});

describe("FOS1-GCLS Tier-2 wiring (plumbing, not model judgment)", () => {
  it("FOS1-GCLS-wiring-allow: confident allow from model → allow", async () => {
    const fake = new FakeModelClient([
      validResult({ verdict: "allow", confidence: "high", reason: "readiness copy" }),
    ]);
    const result = await evaluateGuaranteeText(NEEDS_TIER2, deps(fake));
    expect(result.verdict).toBe("allow");
    expect(result.tier).toBe("tier2-classifier");
    expect(fake.calls.length).toBe(1);
  });

  it("FOS1-GCLS-wiring-block: block from model → block", async () => {
    const fake = new FakeModelClient([
      validResult({ verdict: "block", confidence: "high", reason: "acquired outcome" }),
    ]);
    const result = await evaluateGuaranteeText(NEEDS_TIER2, deps(fake));
    expect(result.verdict).toBe("block");
    expect(result.tier).toBe("tier2-classifier");
  });
});

describe("FOS1-GCLS prompt encodes the policy", () => {
  it("FOS1-GCLS-prompt-contains-policy: the classifier system prompt carries the contract", async () => {
    const fake = new FakeModelClient([
      validResult({ verdict: "allow", confidence: "high", reason: "ok" }),
    ]);
    await classifyGuarantee(NEEDS_TIER2, deps(fake));
    const call = fake.calls[0];
    expect(call).toBeDefined();
    const sent = call!.systemPrompt;
    // The same object is sent verbatim.
    expect(sent).toBe(GUARANTEE_CLASSIFIER_SYSTEM_PROMPT);
    // Key policy load-bearing phrases must be present.
    for (const phrase of [
      "READINESS",
      "EMPLOYMENT OUTCOMES",
      "RECALL IS PARAMOUNT",
      "job-ready",
      "get you an interview",
      "fail closed",
    ]) {
      expect(sent).toContain(phrase);
    }
    // The text under review is passed to the model.
    expect(call!.userContent).toContain(NEEDS_TIER2);
  });
});
