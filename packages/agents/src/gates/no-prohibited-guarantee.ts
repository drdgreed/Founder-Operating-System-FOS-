import type { Gate, GateContext, GateResult } from "./gate.js";

export interface NoProhibitedGuaranteeGateOptions<TOutput> {
  key: string;
  /** Selects every free-text field of the structured output a founder-facing
   * brief could carry a prohibited claim in (never the raw prompt/input —
   * only Zod-validated output fields, per D9). */
  selectText: (output: TOutput) => ReadonlyArray<string>;
}

// A "subject" the run must never promise/guarantee. Deliberately broad
// (word-boundary alternation) so "job", "jobs", "employment", "employed",
// "salary", "compensation", "pay", "interview(s)", "offer(s)" are all caught.
const PROHIBITED_SUBJECT =
  "(?:jobs?|employ\\w*|positions?|roles?|salary|salaries|compensation|pay|interviews?|offers?|recruiters?)";
const GUARANTEE_VERB =
  "(?:guarantee[sd]?|guaranteeing|promise[sd]?|promising|ensure[sd]?|ensuring)";
// "will get/land/receive you a job/interview/offer" — an absolute-outcome
// promise even without the word "guarantee".
const WILL_OUTCOME = `will\\s+(?:definitely\\s+|certainly\\s+)?(?:get|land|receive|secure)(?:\\s+you)?\\s+(?:an?\\s+)?${PROHIBITED_SUBJECT}`;

const PROHIBITED_GUARANTEE_PATTERNS: RegExp[] = [
  new RegExp(`\\b${GUARANTEE_VERB}\\b[^.!?]{0,80}\\b${PROHIBITED_SUBJECT}\\b`, "i"),
  new RegExp(`\\b${PROHIBITED_SUBJECT}\\b[^.!?]{0,80}\\b${GUARANTEE_VERB}\\b`, "i"),
  new RegExp(`\\b${WILL_OUTCOME}\\b`, "i"),
  new RegExp(`\\bguaranteed\\s+${PROHIBITED_SUBJECT}\\b`, "i"),
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
