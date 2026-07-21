import { describe, it, expect } from "vitest";
import type { GateContext } from "../gate.js";
import { noProhibitedGuaranteeGate } from "../no-prohibited-guarantee.js";

// The gate is corpus-driven: the two tables below ARE the contract (issue
// #101). RECALL IS PARAMOUNT — every MUST-BLOCK phrase is a real
// employment/salary/interview/recruiter guarantee that must never reach
// canonical state; every MUST-PASS phrase is benign business/marketing copy
// the old patterns over-blocked. On genuine ambiguity the gate fails CLOSED.

interface Out {
  text: string;
}

const gate = noProhibitedGuaranteeGate<unknown, Out>({
  key: "test.no-prohibited-guarantee",
  selectText: (o) => [o.text],
});

function evalText(text: string) {
  const ctx: GateContext<unknown, Out> = {
    workspaceId: "ws-1",
    agentKey: "test",
    mode: "shadow",
    input: {},
    output: { text },
  };
  return gate.evaluate(ctx) as { allowed: boolean; reason?: string };
}

// --- MUST-BLOCK: real prohibited guarantees (recall) -----------------------
const MUST_BLOCK: string[] = [
  // Core corpus (issue #101).
  "we guarantee you a job within 90 days",
  "you'll land a job",
  "we'll get you hired",
  "get you hired",
  "guaranteed interview",
  "guaranteed job offer",
  "promise you a $120k salary",
  "ensure you a role at a top firm",
  "you will definitely land a role",
  "I'll make sure you get an interview",
  // Contraction forms of the future-outcome promise.
  "I'll land you a job",
  "we'll secure you an interview",
  "you'll get a job offer",
  "they'll get you hired at a top firm",
  // Recall-gap regressions the old patterns missed.
  "we will certainly get you a role",
  "we make sure you get hired",
  "we guarantee your salary will grow",
  "guaranteed employment after graduation",
  "we promise you an interview with our recruiter partners",
  // Existing agent-injected guarantee strings (these MUST keep blocking).
  "The program guarantees a job offer within 30 days of completion.",
  "We guarantee Ada a job offer within 30 days if she enrolls now.",
  "we guarantee Ada a job offer within 30 days",
  "We guarantee you a job offer within 30 days of graduating.",
  "We guarantee you a job offer within 30 days, so this objection is moot.",
  "We guarantee you a job offer within 30 days of enrolling.",
];

// --- MUST-PASS: benign business / marketing copy (precision) ---------------
const MUST_PASS: string[] = [
  // The five real over-blocked examples (issue #101).
  "Ensure the offer resonates with candidates before the webinar",
  "Ensure Your Offer Resonates: LinkedIn Post",
  "promise subscribers weekly job-market insights",
  "Drive signups by promising exclusive access to salary benchmarks",
  "ensure offer letter is sent",
  // Additional benign corpus.
  "Announce the launch offer to the email list",
  "pay attention to the CTA",
  "your role in the campaign narrative",
  "showcase the compensation data",
  "ensure clarity on the coaching offer's value",
  "promise subscribers weekly insights",
  "our special launch offer ends Friday",
  // Existing benign phrases from other agents' suites that route through this
  // gate (must NOT be blocked here — a different gate handles them): a factual
  // 3rd-person "get hired" claim has no 2nd-person "you" outcome promise.
  "Our alumni all get hired at FAANG.",
  "Ada wondered if graduates actually get hired.",
];

describe("no-prohibited-guarantee gate — MUST-BLOCK corpus (recall)", () => {
  it.each(MUST_BLOCK)("BLOCKS: %s", (text) => {
    const result = evalText(text);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/prohibited employment\/salary\/interview guarantee/);
  });
});

describe("no-prohibited-guarantee gate — MUST-PASS corpus (precision)", () => {
  it.each(MUST_PASS)("PASSES: %s", (text) => {
    const result = evalText(text);
    expect(result.allowed).toBe(true);
  });
});

describe("no-prohibited-guarantee gate — scanning semantics", () => {
  it("blocks when ANY selected field carries a guarantee", () => {
    const g = noProhibitedGuaranteeGate<unknown, { a: string; b: string }>({
      key: "test.multi",
      selectText: (o) => [o.a, o.b],
    });
    const result = g.evaluate({
      workspaceId: "ws-1",
      agentKey: "test",
      mode: "shadow",
      input: {},
      output: { a: "All clear here.", b: "we guarantee you a job" },
    }) as { allowed: boolean };
    expect(result.allowed).toBe(false);
  });

  it("allows when every selected field is clean", () => {
    const result = evalText("Announce the launch offer and pay attention to the CTA.");
    expect(result.allowed).toBe(true);
  });
});
