// ===========================================================================
// Guarantee classifier eval corpus (issue #106, Option C slice 1).
//
// DAVID'S CONFIRMED corpus, encoded as labeled entries. This is the CONTRACT
// the semantic classifier is measured against: every `block` row is a real
// EMPLOYMENT-OUTCOME guarantee that must never reach a student unchallenged;
// every `allow` row is legitimate READINESS/PREPARATION copy the program is
// entitled to make. The load-bearing rows are the BOUNDARY pairs where the same
// word flips meaning ("interview" practice vs. acquired; "job-ready" vs. "get
// you a job"). RECALL IS PARAMOUNT: an `allow` on a `block` row is a hard fail.
// ===========================================================================

export interface GuaranteeCorpusEntry {
  text: string;
  expected: "allow" | "block";
  note?: string;
}

export const GUARANTEE_CORPUS: GuaranteeCorpusEntry[] = [
  // --- CONFIRMED ALLOW (readiness / preparation) --------------------------
  {
    text: "you'll graduate job-ready",
    expected: "allow",
    note: "confirmed; BOUNDARY: capability, not an acquired job",
  },
  { text: "prepared to enter the market", expected: "allow", note: "confirmed readiness" },
  {
    text: "your LinkedIn & resume will be employer-ready",
    expected: "allow",
    note: "confirmed; the program controls the artifact",
  },
  {
    text: "a portfolio that proves your expertise",
    expected: "allow",
    note: "confirmed; evidences capability",
  },
  {
    text: "you'll be well-practiced at interviewing",
    expected: "allow",
    note: "confirmed; BOUNDARY: interview as PRACTICE",
  },
  {
    text: "interview-ready by the end of the module",
    expected: "allow",
    note: "confirmed; readiness, not an acquired interview",
  },
  {
    text: "we make sure you're prepared for interviews",
    expected: "allow",
    note: "confirmed; preparation",
  },

  // --- CONFIRMED BLOCK (employment outcome the employer controls) ---------
  { text: "we guarantee you a job", expected: "block", note: "confirmed; acquired job" },
  { text: "guaranteed employment on completion", expected: "block", note: "confirmed" },
  {
    text: "we'll get you an interview with hiring partners",
    expected: "block",
    note: "confirmed; BOUNDARY: interview ACQUIRED from an employer",
  },
  {
    text: "guaranteed interviews with employers",
    expected: "block",
    note: "confirmed; employer interviews",
  },
  { text: "a guaranteed $90k salary", expected: "block", note: "confirmed; compensation figure" },
  { text: "we'll get you hired", expected: "block", note: "confirmed; being hired" },
  { text: "guaranteed placement", expected: "block", note: "confirmed; placement" },
  {
    text: "we promise you a role at a partner company",
    expected: "block",
    note: "confirmed; a role at a company",
  },
  { text: "you'll land a job in 90 days", expected: "block", note: "confirmed; acquired job" },

  // --- BOUNDARY rows (labeled exactly per the contract) -------------------
  {
    text: "you'll be well-practiced at interviewing",
    expected: "allow",
    note: "BOUNDARY pair A: practice → allow",
  },
  {
    text: "we'll get you an interview",
    expected: "block",
    note: "BOUNDARY pair A: acquired interview → block",
  },
  {
    text: "you'll graduate job-ready",
    expected: "allow",
    note: "BOUNDARY pair B: readiness → allow",
  },
  { text: "we'll get you a job", expected: "block", note: "BOUNDARY pair B: acquired job → block" },

  // --- ADDED ALLOW (mine; strengthen precision on readiness copy) ---------
  {
    text: "graduate market-ready with a portfolio that shows your skills",
    expected: "allow",
    note: "added; readiness + evidence",
  },
  {
    text: "you'll be prepared to ace technical interviews",
    expected: "allow",
    note: "added; BOUNDARY: 'interviews' as skill preparation, not acquisition",
  },
  {
    text: "our mock interviews leave you well-practiced and confident",
    expected: "allow",
    note: "added; practice interviews the program runs",
  },
  {
    text: "build an employer-ready resume that showcases your expertise",
    expected: "allow",
    note: "added; program-controlled artifact",
  },
  {
    text: "by graduation your skills will be market-ready",
    expected: "allow",
    note: "added; capability",
  },

  // --- ADDED BLOCK (mine; strengthen recall on outcome guarantees) --------
  {
    text: "we guarantee you'll be hired within six months",
    expected: "block",
    note: "added; being hired",
  },
  {
    text: "guaranteed job placement with our partner employers",
    expected: "block",
    note: "added; placement",
  },
  {
    text: "we'll secure you an interview at a top tech company",
    expected: "block",
    note: "added; acquired interview",
  },
  {
    text: "you're guaranteed a six-figure salary after the program",
    expected: "block",
    note: "added; compensation figure",
  },
  {
    text: "we promise to land you a role at a Fortune 500 company",
    expected: "block",
    note: "added; a role at a company",
  },
];
