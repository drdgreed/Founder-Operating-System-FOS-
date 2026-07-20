import { isLegalTransition, type OpportunityStage } from "@fos/db/services";
import type { Gate, GateContext, GateResult } from "./gate.js";

export interface StageProposalLegalGateOptions<TInput, TOutput> {
  key: string;
  /** The opportunity's CURRENT stage, from the run's own (Zod-validated)
   * input context — never from the model's output. */
  selectCurrentStage: (input: TInput) => OpportunityStage;
  /** The stage the model proposes moving to, or the no-change sentinel. */
  selectProposedStage: (output: TOutput) => OpportunityStage | string;
  /** Sentinel the model may emit when it has no basis to propose a move.
   * A self-transition (`from === to`) is illegal per the §12.1 matrix
   * (no state lists itself as an outgoing edge), so "stay put" needs a
   * distinct value rather than proposing `from === to`. */
  noChangeValue?: string;
}

const DEFAULT_NO_CHANGE_VALUE = "no_change";

/**
 * Post-Call Synthesis Agent hard gate (issue #68, spec §8.3): "It may not
 * apply the stage change" is enforced by the ABSENCE of any
 * `transitionOpportunity` call anywhere in this agent's definition (a design
 * invariant, not this gate's job) — this gate instead enforces that the
 * PROPOSAL itself is never nonsense: `stageProposal.proposedStage` must name
 * a stage reachable from the opportunity's current stage via the pure
 * `isLegalTransition` matrix (`@fos/db/services/opportunity-transitions`,
 * REUSED, not reimplemented). An illegal proposed stage (e.g. `new_lead` -&gt;
 * `enrolled`, skipping every intermediate stage) blocks the run
 * (`policy_blocked`) before any artifact is created — the model can propose,
 * but it can never propose garbage that later reaches a founder as if it
 * were a legitimate option.
 *
 * Modeled generically via selectors, like `recommendedPathwayAvailableGate`
 * (issue #60 precedent): reads only the Zod-validated `input`/`output`
 * (ADR-07 D9) — never raw transcript/notes text, so untrusted call content
 * can never influence this gate's verdict.
 */
export function stageProposalLegalGate<TInput, TOutput>(
  options: StageProposalLegalGateOptions<TInput, TOutput>,
): Gate<TInput, TOutput> {
  const noChangeValue = options.noChangeValue ?? DEFAULT_NO_CHANGE_VALUE;
  return {
    key: options.key,
    evaluate(ctx: GateContext<TInput, TOutput>): GateResult {
      const proposed = options.selectProposedStage(ctx.output);
      if (proposed === noChangeValue) {
        return { allowed: true };
      }
      const current = options.selectCurrentStage(ctx.input);
      if (!isLegalTransition(current, proposed as OpportunityStage)) {
        return {
          allowed: false,
          reason: `proposed stage "${proposed}" is not a legal transition from "${current}"`,
        };
      }
      return { allowed: true };
    },
  };
}
