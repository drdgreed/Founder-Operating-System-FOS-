import type { Gate, GateContext, GateResult } from "./gate.js";

export interface CooldownGateOptions<TInput, TOutput> {
  key: string;
  /** Whether the proposed action is a contact action (subject to cooldown)
   * at all — a non-contact action (e.g. an internal task) is always
   * allowed. */
  selectIsContactAction: (output: TOutput) => boolean;
  /** ISO-8601 "now" reference, from the run's own (Zod-validated) input
   * context. Gates are pure: the caller supplies any time reference — this
   * gate never calls `Date.now()`/`new Date()` itself. */
  selectNow: (input: TInput) => string;
  /** ISO-8601 timestamp before which a contact action is blocked, or
   * `null`/`undefined` if no cooldown is currently in effect. FLAG: the
   * cooldown policy/timing (e.g. "N days since last contact") is not looked
   * up live here — the caller computes and supplies the resulting
   * `cooldownUntil` boundary as input (least-privilege input, issue #60
   * precedent), same as the unseeded consent/offer registries. */
  selectCooldownUntil: (input: TInput) => string | null | undefined;
}

/**
 * Next-Best-Action Agent guardrail gate (spec §8.6, §12): "Contact is blocked
 * ... when cooldown is active." A proposed contact action is blocked while
 * `now` is still before the caller-supplied `cooldownUntil` boundary. At (or
 * after) the boundary, cooldown has elapsed and the action is allowed.
 */
export function cooldownGate<TInput, TOutput>(
  options: CooldownGateOptions<TInput, TOutput>,
): Gate<TInput, TOutput> {
  return {
    key: options.key,
    evaluate(ctx: GateContext<TInput, TOutput>): GateResult {
      if (!options.selectIsContactAction(ctx.output)) {
        return { allowed: true };
      }
      const cooldownUntil = options.selectCooldownUntil(ctx.input);
      if (!cooldownUntil) {
        return { allowed: true };
      }
      const now = options.selectNow(ctx.input);
      if (new Date(now).getTime() < new Date(cooldownUntil).getTime()) {
        return {
          allowed: false,
          reason: `contact cooldown active until ${cooldownUntil} (now: ${now})`,
        };
      }
      return { allowed: true };
    },
  };
}
