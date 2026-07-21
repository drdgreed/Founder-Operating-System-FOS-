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
  // Fix 1 — 3rd-person / passive soft-verb + STRONG subject (these BLOCKED on
  // main and regressed to PASS when soft verbs were narrowed to "you"-only;
  // all must block again). No 2nd-person "you".
  "we ensure a job for every graduate",
  "the program promises employment to all enrollees",
  "ensures a salary of $100k",
  "we promise an interview at a top firm",
  "the bootcamp ensures job placement for graduates",
  "promises a salary increase for every alum",
  "we ensure employment within 90 days",
  "the course promises interviews with recruiters",
  "ensures graduates are hired",
  "promises a job to every student",
  "we ensure interviews for all attendees",
  "the program ensures a salary of six figures",
  "promised employment upon completion",
  "ensures recruiter introductions for all",
  "the bootcamp promises job placement",
  "we ensure a 100% hire rate",
  "promises salaries above market",
  "the academy ensures a placement at a partner company",
  // Fix 2 — placement guarantee (bootcamp's most common real phrasing).
  "guaranteed placement in a top firm",
  // Fix 3 — transitive "hire you" employment promise.
  "we will hire you",
  "we'll hire you after graduation",
  "the firm will hire you",
  // Fix 4 — CURLY apostrophe (U+2019) must not evade the "'ll" arms.
  "you’ll land a job",
  "we’ll get you hired",
  "I’ll make sure you get an interview",
  // Fix 5 — definite article "the" in the outcome-promise arms.
  "get you the job",
  "we'll secure you the interview",
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
  // Real over-blocked examples that remain benign after Fix 1 (their subjects
  // are WEAK, so the soft-verb 3rd-person arm does not touch them).
  "Ensure the offer resonates with candidates before the webinar",
  "Ensure Your Offer Resonates: LinkedIn Post",
  "ensure offer letter is sent",
  // NOTE: "promise subscribers weekly job-market insights" (contains "job")
  // and "promising exclusive access to salary benchmarks" (contains "salary")
  // are ACCEPTED OVER-BLOCKS under Fix 1 — soft verb + STRONG subject now
  // fails closed (recall-paramount). They are rewordable and are asserted in
  // MUST_BLOCK_ACCEPTED_OVERBLOCK below.
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

// ACCEPTED OVER-BLOCKS (Fix 1): benign marketing strings whose STRONG subject
// makes them indistinguishable from a 3rd-person guarantee. Per
// recall-paramount they fail closed; they are trivially rewordable.
const ACCEPTED_OVERBLOCK: string[] = [
  "promise subscribers weekly job-market insights",
  "Drive signups by promising exclusive access to salary benchmarks",
];

describe("no-prohibited-guarantee gate — accepted over-blocks (Fix 1, fail-closed)", () => {
  it.each(ACCEPTED_OVERBLOCK)("BLOCKS (accepted): %s", (text) => {
    expect(evalText(text).allowed).toBe(false);
  });
});

// KNOWN RESIDUAL (Fix 6): 3rd-person soft-verb promise over a WEAK subject.
// We would prefer to block these, but WEAK subjects are inherently ambiguous
// and blocking them re-breaks benign marketing precision. Documented, NOT
// blocked here — defense-in-depth (claims gate + founder approval) covers them.
// These assertions pin CURRENT behavior; flipping one to block is a conscious
// precision/recall change requiring compliance sign-off, not an accident.
const KNOWN_RESIDUAL_PASS: string[] = [
  "promise a role at a partner company",
  "we ensure a position for every applicant",
];

describe("no-prohibited-guarantee gate — known WEAK-subject residual (Fix 6, documented)", () => {
  it.each(KNOWN_RESIDUAL_PASS)("PASSES (known residual): %s", (text) => {
    expect(evalText(text).allowed).toBe(true);
  });
});

describe("no-prohibited-guarantee gate — curly-apostrophe normalization (Fix 4)", () => {
  it("normalizes U+2019 so the curly and ASCII forms are equivalent", () => {
    expect(evalText("you’ll land a job").allowed).toBe(false);
    expect(evalText("you'll land a job").allowed).toBe(false);
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
