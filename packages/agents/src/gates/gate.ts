import type { FeatureMode } from "../mode.js";

/**
 * Deterministic gate evaluation context (ADR-07 D7). Gates read ONLY
 * structured, typed, already-Zod-validated data — `input` (the definition's
 * validated input) and `output` (the definition's validated structured model
 * output) — never a raw prompt string. This is the D9 prompt-injection
 * invariant made structural rather than a matter of prompt discipline: there
 * is no code path by which free-text content (untrusted application data,
 * resumes, transcripts, ...) can reach a gate's decision, because a gate
 * never receives free text at all — only the typed fields the definition's
 * Zod schemas already constrained.
 */
export interface GateContext<TInput = unknown, TOutput = unknown> {
  workspaceId: string;
  agentKey: string;
  mode: FeatureMode;
  input: TInput;
  output: TOutput;
}

export interface GateResult {
  allowed: boolean;
  reason?: string;
}

/**
 * The shared deterministic-gate interface (D7). The model RECOMMENDS; gates
 * ENFORCE — a gate's `evaluate` is pure/synchronous-or-async code, never a
 * model call, and its result is never overridden by the model's own output.
 */
export interface Gate<TInput = unknown, TOutput = unknown> {
  key: string;
  evaluate(ctx: GateContext<TInput, TOutput>): GateResult | Promise<GateResult>;
}

export interface GateEvaluation extends GateResult {
  key: string;
}

/**
 * Runs every gate in order and stops at the first block (fail-closed): once
 * one gate blocks, the run is `policy_blocked` regardless of any later gate's
 * verdict. Returns every evaluation performed so far for the audit trail.
 */
export async function evaluateGates<TInput, TOutput>(
  gates: ReadonlyArray<Gate<TInput, TOutput>>,
  ctx: GateContext<TInput, TOutput>,
): Promise<{ allowed: boolean; evaluations: GateEvaluation[]; blockedBy?: GateEvaluation }> {
  const evaluations: GateEvaluation[] = [];
  for (const gate of gates) {
    const result = await gate.evaluate(ctx);
    const evaluation: GateEvaluation = { key: gate.key, ...result };
    evaluations.push(evaluation);
    if (!result.allowed) {
      return { allowed: false, evaluations, blockedBy: evaluation };
    }
  }
  return { allowed: true, evaluations };
}
