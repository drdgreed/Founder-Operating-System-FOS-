import {
  OPPORTUNITY_STAGES,
  OPPORTUNITY_TRANSITIONS,
  type OpportunityStage,
} from "@fos/db/services";
import type { Gate, GateContext, GateResult } from "./gate.js";

/**
 * FLAG: the terminal set is DERIVED, not hardcoded — a stage is terminal iff
 * `OPPORTUNITY_TRANSITIONS` lists NO outgoing edges for it (confirmed
 * against the §12.1 matrix transcribed in
 * `@fos/db/services/opportunity-transitions`, not assumed). As of that
 * matrix this evaluates to `enrolled`, `declined`, `disqualified` — if the
 * matrix ever changes, this set moves with it automatically rather than
 * silently going stale.
 */
export const TERMINAL_OPPORTUNITY_STAGES: ReadonlySet<OpportunityStage> = new Set(
  OPPORTUNITY_STAGES.filter((stage) => OPPORTUNITY_TRANSITIONS[stage].length === 0),
);

export interface NotTerminalStatusGateOptions<TInput, TOutput> {
  key: string;
  /** The opportunity's CURRENT stage, from the run's own (Zod-validated)
   * input context. */
  selectCurrentStage: (input: TInput) => OpportunityStage;
}

/**
 * Next-Best-Action Agent guardrail gate (spec §8.6): "must not recommend any
 * action when the opportunity is in a terminal stage." Blocks unconditionally
 * once the opportunity has reached a stage with no legal outgoing transition
 * — recommending further action on an already-closed opportunity is never
 * appropriate, regardless of what the model proposes.
 */
export function notTerminalStatusGate<TInput, TOutput>(
  options: NotTerminalStatusGateOptions<TInput, TOutput>,
): Gate<TInput, TOutput> {
  return {
    key: options.key,
    evaluate(ctx: GateContext<TInput, TOutput>): GateResult {
      const stage = options.selectCurrentStage(ctx.input);
      if (TERMINAL_OPPORTUNITY_STAGES.has(stage)) {
        return {
          allowed: false,
          reason: `opportunity is in terminal stage "${stage}"; no further action may be recommended`,
        };
      }
      return { allowed: true };
    },
  };
}
