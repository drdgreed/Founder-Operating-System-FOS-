import type { Gate, GateContext, GateResult } from "./gate.js";

export interface ActionKey {
  type: string;
  target: string;
}

export interface NoDuplicateTaskGateOptions<TInput, TOutput> {
  key: string;
  /** The proposed action's type + target (e.g. "send_follow_up_email" /
   * the person's id) — the identity a duplicate is matched against. */
  selectProposedAction: (output: TOutput) => ActionKey;
  /** Existing OPEN recommendations/tasks, from the run's own (Zod-validated)
   * input context — never a live task-store lookup inside the gate. */
  selectExistingOpenActions: (input: TInput) => ReadonlyArray<ActionKey>;
}

/**
 * Next-Best-Action Agent guardrail gate (spec §8.6): "the proposed action
 * must not duplicate an existing open recommendation/task." Blocks on an
 * EXACT `type` + `target` match against the caller-supplied open-action set
 * — a deterministic, code-only re-check the model can never waive by
 * rephrasing the same recommendation.
 */
export function noDuplicateTaskGate<TInput, TOutput>(
  options: NoDuplicateTaskGateOptions<TInput, TOutput>,
): Gate<TInput, TOutput> {
  return {
    key: options.key,
    evaluate(ctx: GateContext<TInput, TOutput>): GateResult {
      const proposed = options.selectProposedAction(ctx.output);
      const existing = options.selectExistingOpenActions(ctx.input);
      const duplicate = existing.find(
        (a) => a.type === proposed.type && a.target === proposed.target,
      );
      if (duplicate) {
        return {
          allowed: false,
          reason: `duplicate of an existing open action: type "${proposed.type}", target "${proposed.target}"`,
        };
      }
      return { allowed: true };
    },
  };
}
