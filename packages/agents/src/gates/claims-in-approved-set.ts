import type { Gate, GateContext, GateResult } from "./gate.js";

export interface ClaimsInApprovedSetGateOptions<TInput, TOutput> {
  key: string;
  /** Selects the (already-Zod-validated) claims the run wants to make in the
   * artifact — the model-authored claims manifest. */
  selectClaims: (output: TOutput) => ReadonlyArray<string>;
  /** The approved-claims allowlist — from the run's own (Zod-validated) input
   * context, NEVER from the model. FLAG (issue #82): the claims registry
   * (Phase-0 §111 precondition, the full "claims approved for THIS channel and
   * offer" gate) is P1.8 — this is the minimal in-approved-SET membership
   * check against a caller-provided allowlist (least-privilege input, same
   * convention as `availablePathways`/`availableOffers`/`consentedChannels`,
   * issue #60/#68/#78 precedent), not a live claims-service lookup. */
  selectApprovedClaims: (input: TInput) => ReadonlyArray<string>;
}

/**
 * Personalized Follow-Up Agent guardrail gate (spec §8.4, issue #82): every
 * claim the model puts in the applicant-facing draft's claims manifest must be
 * AFFIRMATIVELY present in the caller-supplied approved-claims allowlist — the
 * model can never introduce a claim that was not pre-approved. This is the
 * SAME shape of subset-membership check as `recommendedPathwayAvailableGate`
 * (a proposed value must be in a caller-provided set), generalized from a
 * single value to EVERY entry of an array — so it is a small sibling of that
 * gate rather than a re-implementation of the substring/regex guarantee scan.
 * Reads only the Zod-validated `input`/`output` (ADR-07 D9): not steerable by
 * anything in free-text application/interaction content.
 */
export function claimsInApprovedSetGate<TInput, TOutput>(
  options: ClaimsInApprovedSetGateOptions<TInput, TOutput>,
): Gate<TInput, TOutput> {
  return {
    key: options.key,
    evaluate(ctx: GateContext<TInput, TOutput>): GateResult {
      const approved = new Set(options.selectApprovedClaims(ctx.input));
      const claims = options.selectClaims(ctx.output);
      const unapproved = claims.find((claim) => !approved.has(claim));
      if (unapproved !== undefined) {
        return {
          allowed: false,
          reason: `claim is not in the approved-claims set: "${unapproved}"`,
        };
      }
      return { allowed: true };
    },
  };
}
