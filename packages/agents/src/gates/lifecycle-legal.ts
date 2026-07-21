import { isLegalTransition, type OpportunityStage } from "@fos/db/services";
import type { Gate, GateContext, GateResult } from "./gate.js";

export interface LifecycleLegalGateOptions<TInput, TOutput> {
  key: string;
  /** The opportunity's CURRENT stage, from the run's own (Zod-validated)
   * input context — never from the model's output. */
  selectCurrentStage: (input: TInput) => OpportunityStage;
  /** The action type the model proposes (e.g. "send_follow_up_email",
   * "schedule_conversation"). */
  selectProposedActionType: (output: TOutput) => string;
  /** If the proposed action implies moving the opportunity to a specific
   * stage (e.g. proposing an offer implies `offered`), return that stage;
   * otherwise return `undefined` and the action is checked against
   * `allowedActionsByStage` instead. Reuses the same `isLegalTransition`
   * matrix `stageProposalLegalGate` uses (issue #68 precedent) rather than
   * reimplementing it. */
  selectImpliedStage?: (output: TOutput) => OpportunityStage | undefined;
  /** Stage -> allowed action-type set, for actions with no implied stage
   * move, from the run's own (Zod-validated) input context — never a
   * hardcoded value baked into the gate at definition-construction time.
   * FLAG (issue #78): this gate had no production callers as of #77 (only a
   * static-value shape exercised by its own unit test); generalized here to
   * a selector — matching every other gate in this file's convention
   * (consent/cooldown/no-duplicate-task/etc. all read per-run caller input,
   * never a fixed option) — so the derived action-type/stage-legality
   * mapping (spec §8.6 gives no explicit table) can be supplied as
   * least-privilege caller input alongside consent/cooldown/offer, per the
   * #60 precedent, rather than fixed at gate-construction time. */
  selectAllowedActionsByStage: (
    input: TInput,
  ) => Readonly<Record<OpportunityStage, readonly string[]>>;
}

/**
 * Next-Best-Action Agent guardrail gate (spec §8.6): "the proposed action
 * must be appropriate for the opportunity's current lifecycle stage."
 * Deterministic, code-only re-check — never overridden by the model's own
 * judgment about stage-appropriateness. Reads only the Zod-validated
 * `input`/`output` (ADR-07 D9).
 */
export function lifecycleLegalGate<TInput, TOutput>(
  options: LifecycleLegalGateOptions<TInput, TOutput>,
): Gate<TInput, TOutput> {
  return {
    key: options.key,
    evaluate(ctx: GateContext<TInput, TOutput>): GateResult {
      const current = options.selectCurrentStage(ctx.input);
      const impliedStage = options.selectImpliedStage?.(ctx.output);
      if (impliedStage !== undefined) {
        if (!isLegalTransition(current, impliedStage)) {
          return {
            allowed: false,
            reason: `proposed action implies an illegal stage transition from "${current}" to "${impliedStage}"`,
          };
        }
        return { allowed: true };
      }
      const actionType = options.selectProposedActionType(ctx.output);
      const allowedActionsByStage = options.selectAllowedActionsByStage(ctx.input);
      const allowedActions = allowedActionsByStage[current] ?? [];
      if (!allowedActions.includes(actionType)) {
        return {
          allowed: false,
          reason: `action type "${actionType}" is not permitted at stage "${current}"`,
        };
      }
      return { allowed: true };
    },
  };
}
