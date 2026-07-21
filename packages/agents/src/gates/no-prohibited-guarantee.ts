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
//     ("job", "employment", "interview", "salary", "hired", "recruiter").
//   - WEAK subjects are ambiguous nouns that dominate benign marketing copy
//     ("offer", "pay", "role", "position", "compensation") — a launch "offer",
//     a "role in the campaign", "pay attention", the "compensation data".
// "guarantee" fires against EITHER tier (broad); the soft verbs
// promise/ensure/make-sure only fire on a direct 2nd-person ("you") outcome
// promise, which is what separates "promise you a $120k salary" (block) from
// "promise subscribers weekly job-market insights" (pass).
//
// ReDoS: every pattern is linear. All proximity windows are BOUNDED
// (`[^.!?]{0,80}` / `{0,40}`), there is no nested/overlapping unbounded
// quantifier, and the only `*` (`employ\w*`) is a single unanchored token
// repetition, not a repetition-of-a-repetition. No catastrophic backtracking.
// ---------------------------------------------------------------------------

// Unambiguous employment-outcome subjects. `hired?` catches "hire"/"hired";
// "job offer" is caught via "job" so no separate offer-qualifier is needed.
const STRONG_SUBJECT = "(?:jobs?|employ\\w*|interviews?|salary|salaries|hired?|recruiters?)";
// Ambiguous subjects — benign in ordinary business/marketing copy. Only ever
// reached via a "guarantee" verb or a direct 2nd-person ("you") outcome promise.
const WEAK_SUBJECT = "(?:positions?|roles?|compensation|pay|offers?)";
const ANY_SUBJECT = `(?:${STRONG_SUBJECT}|${WEAK_SUBJECT})`;

// "guarantee"/"guarantees"/"guaranteed"/"guaranteeing" — rarely benign near
// any subject, so it keeps the broad proximity window against ANY_SUBJECT.
const GUARANTEE_VERB = "(?:guarantee[sd]?|guaranteeing)";
// Soft verbs. Benign on their own ("ensure the offer resonates", "promise
// subscribers weekly insights") — so they only fire on the "you"-anchored
// direct-promise pattern below, never on bare proximity.
const SOFT_VERB =
  "(?:promise[sd]?|promising|ensure[sd]?|ensuring|makes?\\s+(?:sure|certain)|making\\s+(?:sure|certain))";
// Outcome verbs used in "get/land you a job", "you'll land a role", etc.
const OUTCOME_VERB =
  "(?:gets?|getting|lands?|landing|secures?|securing|receives?|receiving|places?|placing)";
// Contracted or plain future: "will" or "…'ll" (you'll/we'll/they'll/I'll).
const WILL = "(?:\\bwill|'ll)";

const PROHIBITED_GUARANTEE_PATTERNS: RegExp[] = [
  // 1. "guarantee" near any subject, either order — broad (compliance-first).
  //    e.g. "we guarantee you a job within 90 days", "guaranteed interview",
  //    "guaranteed job offer", "The program guarantees a job offer…".
  new RegExp(`\\b${GUARANTEE_VERB}\\b[^.!?]{0,80}\\b${ANY_SUBJECT}\\b`, "i"),
  new RegExp(`\\b${ANY_SUBJECT}\\b[^.!?]{0,80}\\b${GUARANTEE_VERB}\\b`, "i"),
  // 2. Soft verb + direct 2nd-person ("you") + any subject — a personal
  //    outcome promise. e.g. "promise you a $120k salary", "ensure you a role
  //    at a top firm", "I'll make sure you get an interview". The required
  //    "you" is what lets benign "ensure the offer resonates" / "promise
  //    subscribers … job-market insights" through.
  new RegExp(`\\b${SOFT_VERB}\\b[^.!?]{0,40}\\byou\\b[^.!?]{0,40}\\b${ANY_SUBJECT}\\b`, "i"),
  // 3. Will/'ll + outcome verb + subject — "you'll land a job", "we'll get you
  //    hired", "you will definitely land a role".
  new RegExp(
    `${WILL}\\s+(?:definitely\\s+|certainly\\s+)?${OUTCOME_VERB}(?:\\s+you)?\\s+(?:an?\\s+)?\\b${ANY_SUBJECT}\\b`,
    "i",
  ),
  // 4. Bare "get/land you a job / you hired" (no "will") — "get you hired".
  new RegExp(`\\b${OUTCOME_VERB}\\s+you\\s+(?:an?\\s+)?\\b${ANY_SUBJECT}\\b`, "i"),
];

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
        for (const pattern of PROHIBITED_GUARANTEE_PATTERNS) {
          if (pattern.test(text)) {
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
