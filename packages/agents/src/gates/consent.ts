import type { Gate, GateContext, GateResult } from "./gate.js";

export interface ConsentGateOptions<TInput, TOutput> {
  key: string;
  /** The channel (e.g. "email", "sms") the proposed action would contact the
   * person through, or `undefined` for an action that contacts no channel
   * (e.g. an internal task) — always allowed. */
  selectProposedActionChannel: (output: TOutput) => string | undefined;
  /** Channels for which consent has been revoked, from the run's own
   * (Zod-validated) input context — never from the model's output.
   * FLAG: consent registry not seeded — this gate operates on a
   * caller-provided revoked-channel set (least-privilege input), the same
   * convention as prior agents' `availablePathways`/`evidenceRecords`
   * (issue #60 precedent), not a live consent-service lookup. */
  selectRevokedChannels: (input: TInput) => ReadonlyArray<string>;
}

/**
 * Next-Best-Action Agent guardrail gate (spec §8.6, §12): "Contact is blocked
 * when consent is revoked." A proposed action that targets a channel with
 * revoked consent is blocked before it can ever reach a founder as a
 * recommendation. Reads only the Zod-validated `input`/`output` (ADR-07 D9):
 * not steerable by anything in free-text application/interaction content.
 */
export function consentGate<TInput, TOutput>(
  options: ConsentGateOptions<TInput, TOutput>,
): Gate<TInput, TOutput> {
  return {
    key: options.key,
    evaluate(ctx: GateContext<TInput, TOutput>): GateResult {
      const channel = options.selectProposedActionChannel(ctx.output);
      if (channel === undefined) {
        return { allowed: true };
      }
      const revoked = options.selectRevokedChannels(ctx.input);
      if (revoked.includes(channel)) {
        return {
          allowed: false,
          reason: `consent for channel "${channel}" has been revoked`,
        };
      }
      return { allowed: true };
    },
  };
}
