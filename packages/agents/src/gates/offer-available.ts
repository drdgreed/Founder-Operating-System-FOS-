import type { Gate } from "./gate.js";
import { recommendedPathwayAvailableGate } from "./recommended-pathway-available.js";

export interface OfferAvailableGateOptions<TInput, TOutput> {
  key: string;
  selectProposedOffer: (output: TOutput) => string;
  /** FLAG: offer registry not seeded — the run's own (Zod-validated) input
   * context supplies the currently-available offer/pathway set
   * (least-privilege input, same convention as `availablePathways`), not a
   * live offer-registry lookup: no Offer entity is seeded yet (spec §111
   * precondition, `recommendedPathwayAvailableGate`'s original FLAG). */
  selectAvailableOffers: (input: TInput) => ReadonlyArray<string>;
  /** Sentinel value the model may emit when it has insufficient information
   * to recommend an offer — allowed unconditionally, never fabricated. */
  undeterminedValue?: string;
}

/**
 * Next-Best-Action Agent guardrail gate (spec §8.6): "the action's
 * referenced offer/pathway must be currently available." An offer-
 * availability check is the SAME shape of check as
 * `recommendedPathwayAvailableGate`'s pathway-availability check — a
 * proposed value must be in a caller-provided available set, exempt for an
 * explicit undetermined sentinel — so this gate REUSES that gate (issue #60
 * precedent) rather than duplicating its logic, only renaming the domain
 * vocabulary from "pathway" to "offer" via `subjectLabel`.
 */
export function offerAvailableGate<TInput, TOutput>(
  options: OfferAvailableGateOptions<TInput, TOutput>,
): Gate<TInput, TOutput> {
  return recommendedPathwayAvailableGate<TInput, TOutput>({
    key: options.key,
    selectRecommendedPathway: options.selectProposedOffer,
    selectAvailablePathways: options.selectAvailableOffers,
    undeterminedValue: options.undeterminedValue,
    subjectLabel: "offer",
  });
}
