import type { Gate, GateContext, GateResult } from "./gate.js";

export interface ConsentGateOptions<TInput, TOutput> {
  key: string;
  /** The channel (e.g. "email", "sms") the proposed action would contact the
   * person through, or `undefined` for an action that contacts no channel
   * (e.g. an internal task) — always allowed. */
  selectProposedActionChannel: (output: TOutput) => string | undefined;
  /** Channels for which consent has been AFFIRMATIVELY recorded — the
   * ALLOWLIST (FOUNDER DECISION, issue #78: "option B" — opt-in / fail-
   * closed), from the run's own (Zod-validated) input context — never from
   * the model's output. FLAG: consent registry not seeded — this gate
   * operates on a caller-provided consented-channel set (least-privilege
   * input, same convention as prior agents' `availablePathways`/
   * `evidenceRecords`, issue #60 precedent), not a live consent-service
   * lookup. An absent/empty/unknown channel is NOT in this set by
   * construction — there is no separate "unknown" state to special-case. */
  selectConsentedChannels: (input: TInput) => ReadonlyArray<string>;
}

/**
 * Next-Best-Action Agent guardrail gate (spec §8.6, §12): "Contact is blocked
 * when consent is revoked [or absent]." FOUNDER DECISION (issue #78):
 * consent is OPTION B — opt-in / fail-closed. A proposed CONTACT action's
 * channel must be AFFIRMATIVELY present in the caller-supplied
 * `consentedChannels` ALLOWLIST; an absent, empty, or unknown consent state
 * for that channel BLOCKS the contact. This is a breaking change from the
 * gate's original #77 shape (a DENYLIST over `selectRevokedChannels` —
 * "option A"): that gate had NO production callers yet, so it is generalized
 * here in place rather than kept alongside a second denylist gate. Reads
 * only the Zod-validated `input`/`output` (ADR-07 D9): not steerable by
 * anything in free-text application/interaction content.
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
      const consented = options.selectConsentedChannels(ctx.input);
      if (!consented.includes(channel)) {
        return {
          allowed: false,
          reason: `no recorded consent for channel "${channel}" — contact requires an affirmative, recorded consent (fail-closed)`,
        };
      }
      return { allowed: true };
    },
  };
}
