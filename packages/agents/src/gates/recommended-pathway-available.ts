import type { Gate, GateContext, GateResult } from "./gate.js";

export interface RecommendedPathwayAvailableGateOptions<TInput, TOutput> {
  key: string;
  selectRecommendedPathway: (output: TOutput) => string;
  /** The pathway set the run considers available — from input context
   * (product/opportunity-declared pathways), NOT a live offer-registry
   * lookup: no Offer entity is seeded yet (spec §111 precondition). FLAG: the
   * full "pathway exists for the CURRENT offer" gate needs the seeded offer
   * registry; this is the minimal defensible stand-in against a
   * caller-provided/known pathway set. */
  selectAvailablePathways: (input: TInput) => ReadonlyArray<string>;
  /** Sentinel value the model may emit when it has insufficient information
   * to recommend a pathway — allowed unconditionally, never fabricated. */
  undeterminedValue?: string;
  /** Noun used in the block reason (e.g. "pathway", "offer"). Defaults to
   * "pathway" so existing callers are unaffected; `offerAvailableGate`
   * reuses this gate with `"offer"` rather than duplicating its logic. */
  subjectLabel?: string;
}

const DEFAULT_UNDETERMINED_VALUE = "undetermined";
const DEFAULT_SUBJECT_LABEL = "pathway";

/**
 * Enrollment Brief Agent hard gate (spec §8.1, ADR-07 D7): "recommended
 * pathway is available for the current offer." Minimal, deterministic check
 * against the pathway set the input context declares as available — the
 * model can never recommend a pathway that was not offered.
 */
export function recommendedPathwayAvailableGate<TInput, TOutput>(
  options: RecommendedPathwayAvailableGateOptions<TInput, TOutput>,
): Gate<TInput, TOutput> {
  const undeterminedValue = options.undeterminedValue ?? DEFAULT_UNDETERMINED_VALUE;
  const subjectLabel = options.subjectLabel ?? DEFAULT_SUBJECT_LABEL;
  return {
    key: options.key,
    evaluate(ctx: GateContext<TInput, TOutput>): GateResult {
      const recommended = options.selectRecommendedPathway(ctx.output);
      if (recommended === undeterminedValue) {
        return { allowed: true };
      }
      const available = options.selectAvailablePathways(ctx.input);
      if (!available.includes(recommended)) {
        return {
          allowed: false,
          reason: `recommended ${subjectLabel} "${recommended}" is not in the available ${subjectLabel} set`,
        };
      }
      return { allowed: true };
    },
  };
}
