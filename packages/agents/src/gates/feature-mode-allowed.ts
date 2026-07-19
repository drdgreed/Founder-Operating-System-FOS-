import type { Gate, GateContext, GateResult } from "./gate.js";
import type { FeatureMode } from "../mode.js";

export interface FeatureModeAllowedGateOptions {
  key: string;
  allowedModes: readonly FeatureMode[];
}

/**
 * Minimal foundational gate (ADR-07 D7 example): a deterministic,
 * code-enforced re-check that the run's EFFECTIVE mode (stage 2's
 * flag-mode-capped-by-autonomy-ceiling — see mode.ts) is one this agent
 * permits. Defense in depth alongside stage 2's own flag-disabled check: a
 * gate can never be waived by the model (D2 — "the model recommends; stages
 * 6-7 enforce").
 */
export function featureModeAllowedGate<TInput, TOutput>(
  options: FeatureModeAllowedGateOptions,
): Gate<TInput, TOutput> {
  return {
    key: options.key,
    evaluate(ctx: GateContext<TInput, TOutput>): GateResult {
      if (!options.allowedModes.includes(ctx.mode)) {
        return { allowed: false, reason: `mode "${ctx.mode}" is not permitted for this agent` };
      }
      return { allowed: true };
    },
  };
}
