import type { Gate, GateContext, GateResult } from "./gate.js";

export interface FactsResolveToSourcesGateOptions<TInput, TOutput> {
  key: string;
  /** Selects the structured (already-validated) `observedFacts`-shaped entries. */
  selectObservedFacts: (output: TOutput) => ReadonlyArray<{ sourceRef: string }>;
  /** Selects every `sourceRef` value present in the run's own input context
   * (evidence/source records the agent was given to reason over). */
  selectValidSourceRefs: (input: TInput) => ReadonlyArray<string>;
}

/**
 * Enrollment Brief Agent hard gate (spec §8.1, ADR-07 D7): "all observed
 * facts resolve to source records." Every `observedFacts[].sourceRef` the
 * model emits must name a source record that was actually present in the
 * input context handed to it — never a source the model invented. Reads only
 * the Zod-validated `input`/`output` (D9): a gate this is not steerable by
 * anything in free-text application content.
 */
export function factsResolveToSourcesGate<TInput, TOutput>(
  options: FactsResolveToSourcesGateOptions<TInput, TOutput>,
): Gate<TInput, TOutput> {
  return {
    key: options.key,
    evaluate(ctx: GateContext<TInput, TOutput>): GateResult {
      const validRefs = new Set(options.selectValidSourceRefs(ctx.input));
      const facts = options.selectObservedFacts(ctx.output);
      const unresolved = facts.find((fact) => !validRefs.has(fact.sourceRef));
      if (unresolved) {
        return {
          allowed: false,
          reason: `observed fact cites an unresolvable sourceRef: "${unresolved.sourceRef}"`,
        };
      }
      return { allowed: true };
    },
  };
}
