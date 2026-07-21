import type { Gate, GateContext, GateResult } from "./gate.js";
import type { ActionKey } from "./no-duplicate-task.js";

export interface NoScheduledActivityConflictGateOptions<TInput, TOutput> {
  key: string;
  /** The proposed action's type + target (e.g. "schedule_conversation" /
   * the person's id) — the identity checked against already-scheduled
   * future activity. */
  selectProposedAction: (output: TOutput) => ActionKey;
  /** Scheduled FUTURE activities (e.g. an already-scheduled conversation),
   * from the run's own (Zod-validated) input context — never a live
   * calendar/activity-store lookup inside the gate. */
  selectScheduledActivities: (input: TInput) => ReadonlyArray<ActionKey>;
}

/**
 * Next-Best-Action Agent guardrail gate (spec §8.6): "must not propose an
 * action already covered by a scheduled future activity." Distinct from
 * `noDuplicateTaskGate` (which checks open recommendations/tasks): this
 * checks against activities the person already has SCHEDULED (e.g. a
 * conversation already on the calendar) — proposing the same action again
 * would be redundant or conflicting, not merely duplicative of a task
 * record. Blocks on an exact `type` + `target` match.
 */
export function noScheduledActivityConflictGate<TInput, TOutput>(
  options: NoScheduledActivityConflictGateOptions<TInput, TOutput>,
): Gate<TInput, TOutput> {
  return {
    key: options.key,
    evaluate(ctx: GateContext<TInput, TOutput>): GateResult {
      const proposed = options.selectProposedAction(ctx.output);
      const scheduled = options.selectScheduledActivities(ctx.input);
      const conflict = scheduled.find(
        (a) => a.type === proposed.type && a.target === proposed.target,
      );
      if (conflict) {
        return {
          allowed: false,
          reason: `conflicts with an already-scheduled future activity: type "${proposed.type}", target "${proposed.target}"`,
        };
      }
      return { allowed: true };
    },
  };
}
