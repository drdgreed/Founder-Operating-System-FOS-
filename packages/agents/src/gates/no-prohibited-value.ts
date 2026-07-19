import type { Gate, GateContext, GateResult } from "./gate.js";

export interface NoProhibitedValueGateOptions<TOutput> {
  key: string;
  /** Selects the structured (already-validated) output field(s) to check. */
  select: (output: TOutput) => string | null | undefined;
  /** Case-insensitive substring match against the selected value. */
  prohibited: readonly string[];
}

/**
 * Minimal foundational gate (ADR-07 D7 example): blocks a run whose
 * structured output contains a prohibited value in a declared field. Reads
 * only the Zod-validated `output` — never the raw prompt or untrusted input
 * text — so it cannot be steered by prompt injection (D9). The full
 * claims/consent gates (prohibited employment/salary/interview guarantees,
 * etc.) land with the agents that need them (P1.2+); this is the reusable
 * primitive they will be built from.
 */
export function noProhibitedValueGate<TInput, TOutput>(
  options: NoProhibitedValueGateOptions<TOutput>,
): Gate<TInput, TOutput> {
  return {
    key: options.key,
    evaluate(ctx: GateContext<TInput, TOutput>): GateResult {
      const value = options.select(ctx.output);
      if (typeof value !== "string") {
        return { allowed: true };
      }
      const lowered = value.toLowerCase();
      const hit = options.prohibited.find((p) => lowered.includes(p.toLowerCase()));
      if (hit) {
        return { allowed: false, reason: `prohibited value matched: "${hit}"` };
      }
      return { allowed: true };
    },
  };
}
