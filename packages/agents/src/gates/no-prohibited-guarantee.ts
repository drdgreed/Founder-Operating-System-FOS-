import type { Gate, GateContext, GateResult } from "./gate.js";

export interface NoProhibitedGuaranteeGateOptions<TOutput> {
  key: string;
  /** Selects every free-text field of the structured output a founder-facing
   * brief could carry a prohibited claim in (never the raw prompt/input —
   * only Zod-validated output fields, per D9). */
  selectText: (output: TOutput) => ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Recalibrated prohibited-guarantee detection (issue #101).
//
// RECALL IS PARAMOUNT: never let a real employment/salary/interview/recruiter
// guarantee through. Precision (not over-blocking benign business/marketing
// copy) is the secondary goal; on genuine ambiguity we fail CLOSED (block).
//
// The subject set is split into two tiers because the same word is a hard
// compliance signal next to "guarantee" but everyday copy next to a soft verb:
//   - STRONG subjects are employment outcomes that are almost never benign
//     ("job", "employment", "interview", "salary", "hired", "recruiter",
//     "placement" — the bootcamp "placement guarantee").
//   - WEAK subjects are ambiguous nouns that dominate benign marketing copy
//     ("offer", "pay", "role", "position", "compensation") — a launch "offer",
//     a "role in the campaign", "pay attention", the "compensation data".
//
// Verb ↔ subject firing matrix:
//   - "guarantee" fires against EITHER tier, either order, broad window.
//   - Soft verbs (promise/ensure/make-sure) fire against a STRONG subject in
//     ANY grammatical person, either order — "we ensure a job for every
//     graduate", "the program promises employment", "ensures a salary of
//     $100k" are all prohibited 3rd-person guarantees (Fix 1 / issue #101
//     recall regression). Against a WEAK subject the soft verbs fire ONLY on a
//     direct 2nd-person ("you") outcome promise, which is what separates
//     "promise you a role" (block) from "ensure the offer resonates" (pass).
//
// KNOWN RESIDUAL (Fix 6 — documented, intentionally NOT blocked): a WEAK
// subject in a 3rd-person soft-verb promise ("promise a role at a partner
// company", "ensure a position") slips through. WEAK subjects are inherently
// ambiguous and blocking them re-introduces high-frequency benign-marketing
// false-positives ("ensure the offer resonates"). Defense-in-depth catches
// these downstream (claims gate + mandatory founder approval). This
// precision/recall boundary needs compliance sign-off.
//
// Text is NORMALIZED before matching (see normalizeForMatch) so curly/smart
// apostrophes in ordinary LLM output ("you’ll") do not evade the "'ll" arms.
//
// ReDoS: every pattern is linear. All proximity windows are BOUNDED
// (`[^.!?]{0,80}` / `{0,40}`), there is no nested/overlapping unbounded
// quantifier, and the only `*` (`employ\w*`) is a single unanchored token
// repetition, not a repetition-of-a-repetition. No catastrophic backtracking.
// ---------------------------------------------------------------------------

// Unambiguous employment-outcome subjects. `hired?` catches "hire"/"hired";
// "job offer" is caught via "job" so no separate offer-qualifier is needed.
const STRONG_SUBJECT =
  "(?:jobs?|employ\\w*|interviews?|salary|salaries|hired?|recruiters?|placements?)";
// Ambiguous subjects — benign in ordinary business/marketing copy. Only ever
// reached via a "guarantee" verb or a direct 2nd-person ("you") outcome promise.
const WEAK_SUBJECT = "(?:positions?|roles?|compensation|pay|offers?)";
const ANY_SUBJECT = `(?:${STRONG_SUBJECT}|${WEAK_SUBJECT})`;

// "guarantee"/"guarantees"/"guaranteed"/"guaranteeing" — rarely benign near
// any subject, so it keeps the broad proximity window against ANY_SUBJECT.
const GUARANTEE_VERB = "(?:guarantee[sd]?|guaranteeing)";
// Soft verbs. Benign near a WEAK subject ("ensure the offer resonates") — so
// against WEAK they only fire on the "you"-anchored promise below. Near a
// STRONG subject they fire in any person (patterns 3a/3b).
const SOFT_VERB =
  "(?:promise[sd]?|promising|ensure[sd]?|ensuring|makes?\\s+(?:sure|certain)|making\\s+(?:sure|certain))";
// Outcome verbs used in "get/land you a job", "you'll land a role", etc.
const OUTCOME_VERB =
  "(?:gets?|getting|lands?|landing|secures?|securing|receives?|receiving|places?|placing)";
// Contracted or plain future: "will" or "…'ll" (you'll/we'll/they'll/I'll).
// Curly apostrophes are normalized to ASCII "'" before matching.
const WILL = "(?:\\bwill|'ll)";
// Article, incl. the definite article — "get you the job", "secure you the
// interview" (Fix 5).
const ARTICLE = "(?:(?:an?|the)\\s+)?";

const PROHIBITED_GUARANTEE_PATTERNS: RegExp[] = [
  // 1. "guarantee" near any subject, either order — broad (compliance-first).
  //    e.g. "we guarantee you a job within 90 days", "guaranteed interview",
  //    "guaranteed job offer", "guaranteed placement in a top firm".
  new RegExp(`\\b${GUARANTEE_VERB}\\b[^.!?]{0,80}\\b${ANY_SUBJECT}\\b`, "i"),
  new RegExp(`\\b${ANY_SUBJECT}\\b[^.!?]{0,80}\\b${GUARANTEE_VERB}\\b`, "i"),
  // 2. Soft verb + direct 2nd-person ("you") + any subject — a personal
  //    outcome promise. e.g. "promise you a $120k salary", "ensure you a role
  //    at a top firm", "I'll make sure you get an interview". The required
  //    "you" is what lets benign 3rd-person WEAK copy ("ensure the offer
  //    resonates") through.
  new RegExp(`\\b${SOFT_VERB}\\b[^.!?]{0,40}\\byou\\b[^.!?]{0,40}\\b${ANY_SUBJECT}\\b`, "i"),
  // 3. Soft verb ↔ STRONG subject, either order, ANY person, NO "you" required
  //    (Fix 1 — closes the 3rd-person/passive recall regression). A soft verb
  //    near a STRONG employment subject is essentially never benign:
  //    "we ensure a job for every graduate", "the program promises
  //    employment", "ensures a salary of $100k", "promises interviews".
  new RegExp(`\\b${SOFT_VERB}\\b[^.!?]{0,80}\\b${STRONG_SUBJECT}\\b`, "i"),
  new RegExp(`\\b${STRONG_SUBJECT}\\b[^.!?]{0,80}\\b${SOFT_VERB}\\b`, "i"),
  // 4. Will/'ll + outcome verb + subject — "you'll land a job", "we'll get you
  //    hired", "you will definitely land a role", "secure you the interview".
  new RegExp(
    `${WILL}\\s+(?:definitely\\s+|certainly\\s+)?${OUTCOME_VERB}(?:\\s+you)?\\s+${ARTICLE}\\b${ANY_SUBJECT}\\b`,
    "i",
  ),
  // 5. Bare "get/land you a job / you hired / you the job" (no "will").
  new RegExp(`\\b${OUTCOME_VERB}\\s+you\\s+${ARTICLE}\\b${ANY_SUBJECT}\\b`, "i"),
  // 6. "hire you" construction (Fix 3) — "we will hire you", "we'll hire you",
  //    "hire you for a role". "hire"/"hired" as a bare STRONG subject is
  //    already caught next to guarantee/soft verbs; this arm catches the
  //    transitive "hire you" employment promise that has no other verb.
  new RegExp(`\\bhir(?:e|es|ing)\\s+you\\b`, "i"),
];

// Normalize curly/smart apostrophes (U+2019 ’, U+02BC ʼ) to ASCII "'" so the
// contraction arms ("'ll") match ordinary LLM output, where curly quotes are
// the default (Fix 4). One place, covers every pattern. Linear replace.
function normalizeForMatch(text: string): string {
  return text.replace(/[’ʼ]/g, "'");
}

/**
 * Enrollment Brief Agent hard gate (spec §8.1, ADR-07 D7): "no employment,
 * recruiter, salary, or interview guarantee." A deterministic, code-only
 * prohibited-claim check over the model's structured output text — the model
 * can never waive this by how it phrases the brief.
 */
export function noProhibitedGuaranteeGate<TInput, TOutput>(
  options: NoProhibitedGuaranteeGateOptions<TOutput>,
): Gate<TInput, TOutput> {
  return {
    key: options.key,
    evaluate(ctx: GateContext<TInput, TOutput>): GateResult {
      const texts = options.selectText(ctx.output);
      for (const text of texts) {
        const normalized = normalizeForMatch(text);
        for (const pattern of PROHIBITED_GUARANTEE_PATTERNS) {
          if (pattern.test(normalized)) {
            return {
              allowed: false,
              reason: `prohibited employment/salary/interview guarantee detected: "${text}"`,
            };
          }
        }
      }
      return { allowed: true };
    },
  };
}
