import type { Gate, GateContext, GateResult } from "./gate.js";

/**
 * One entry of the caller-supplied approved-claims context. This is a RICHER
 * structure than the minimal `claimsInApprovedSetGate`'s flat allowlist (issue
 * #82 FLAG): each approved claim carries the channels and offers it is approved
 * FOR, plus an optional effectiveness window.
 *
 * FLAG (issue #116): this is Phase-0 data the CALLER provides as least-
 * privilege input (same convention as `availablePathways`/`availableOffers`/
 * `consentedChannels`, issue #60/#68/#78 precedent), NOT a live claims-registry
 * lookup. The claims registry itself (Phase-0 §4 "Approved and prohibited
 * claims" precondition) is seeded/owned elsewhere; the run projects the
 * relevant approved-claims rows into this shape and hands them to the gate.
 */
export interface ApprovedClaim {
  /** The exact approved claim string (must match a model claim verbatim). */
  claim: string;
  /** Channels this claim is approved for (e.g. ["linkedin", "email"]). */
  channels: readonly string[];
  /** Offers this claim is approved for (e.g. ["cohort-2026-a"]). */
  offers: readonly string[];
  /** ISO-8601 start of the effectiveness window (inclusive). */
  effectiveFrom?: string;
  /** ISO-8601 end of the effectiveness window (inclusive). */
  effectiveTo?: string;
}

export interface ClaimsApprovedForChannelAndOfferGateOptions<TInput, TOutput> {
  key: string;
  /** The (already-Zod-validated) claims the model wants to make in the
   * artifact's claims manifest. */
  selectClaims: (output: TOutput) => readonly string[];
  /** The richer approved-claims context — from the run's own (Zod-validated)
   * input, NEVER from the model. See `ApprovedClaim` for the FLAG. */
  selectApprovedClaims: (input: TInput) => readonly ApprovedClaim[];
  /** The channel the run targets. Receives BOTH `output` and `input`: the
   * channel is a caller INPUT for `fos.personalized_follow_up` but a model
   * OUTPUT for other agents — same generalized-selector convention as
   * `consentGate.selectProposedActionChannel`. */
  selectChannel: (output: TOutput, input: TInput) => string | undefined;
  /** The offer the run targets, from output and/or input. */
  selectOffer: (output: TOutput, input: TInput) => string | undefined;
  /** OPTIONAL ISO-8601 "now" reference for the run. When supplied, every claim
   * is additionally checked to be EFFECTIVE (now within `[effectiveFrom,
   * effectiveTo]`), and an approved entry that lacks a complete, parseable
   * window FAILS CLOSED. When omitted, the effectiveness dimension is not
   * enforced (the caller has explicitly opted out of the time check — same
   * caller-supplies-the-clock convention as `cooldownGate`); approval +
   * channel + offer are still enforced. */
  now?: (input: TInput) => string;
}

/**
 * The fuller Personalized Follow-Up / Launch claims gate (spec §12 line 405:
 * "Claims must be approved, effective, and allowed for the channel and offer";
 * §11.404-405). Extends the minimal `claimsInApprovedSetGate` (issue #82) from
 * a flat in-SET membership check to the full three-part test, per claim:
 *   (a) APPROVED  — present in the caller-supplied approved-claims context;
 *   (b) ALLOWED   — approved for the run's CHANNEL and its OFFER;
 *   (c) EFFECTIVE — the run's time is within the claim's effectiveness window
 *                   (only when a `now` reference is supplied).
 * Blocks on the FIRST failing claim with a precise reason. FAILS CLOSED on an
 * absent channel/offer (cannot prove the claim is allowed) and, when a `now`
 * is supplied, on a missing/malformed effectiveness window. Reads only the
 * Zod-validated `input`/`output` (ADR-07 D9): not steerable by anything in
 * free-text application/interaction content.
 */
export function claimsApprovedForChannelAndOfferGate<TInput, TOutput>(
  options: ClaimsApprovedForChannelAndOfferGateOptions<TInput, TOutput>,
): Gate<TInput, TOutput> {
  return {
    key: options.key,
    evaluate(ctx: GateContext<TInput, TOutput>): GateResult {
      const claims = options.selectClaims(ctx.output);
      // An empty manifest is trivially allowed (nothing to validate), matching
      // the minimal gate's behavior — there is no claim that could be unapproved.
      if (claims.length === 0) {
        return { allowed: true };
      }

      // FAIL CLOSED: without a channel and an offer we cannot prove any claim is
      // ALLOWED for the run, so the whole manifest is unverifiable — block.
      const channel = options.selectChannel(ctx.output, ctx.input);
      if (channel === undefined) {
        return {
          allowed: false,
          reason: "cannot validate claims — the run's channel is absent (fail-closed)",
        };
      }
      const offer = options.selectOffer(ctx.output, ctx.input);
      if (offer === undefined) {
        return {
          allowed: false,
          reason: "cannot validate claims — the run's offer is absent (fail-closed)",
        };
      }

      // Effectiveness is only enforced when the caller supplies a clock.
      let nowMs: number | undefined;
      if (options.now !== undefined) {
        const nowStr = options.now(ctx.input);
        nowMs = new Date(nowStr).getTime();
        if (Number.isNaN(nowMs)) {
          return {
            allowed: false,
            reason: `cannot validate claim effectiveness — invalid time input (now: ${nowStr})`,
          };
        }
      }

      const approvedByClaim = new Map<string, ApprovedClaim>();
      for (const entry of options.selectApprovedClaims(ctx.input)) {
        approvedByClaim.set(entry.claim, entry);
      }

      for (const claim of claims) {
        const approved = approvedByClaim.get(claim);
        if (approved === undefined) {
          return {
            allowed: false,
            reason: `claim is not in the approved-claims context: "${claim}"`,
          };
        }
        if (!approved.channels.includes(channel)) {
          return {
            allowed: false,
            reason: `claim "${claim}" is not approved for channel "${channel}"`,
          };
        }
        if (!approved.offers.includes(offer)) {
          return {
            allowed: false,
            reason: `claim "${claim}" is not approved for offer "${offer}"`,
          };
        }
        const hasWindow =
          approved.effectiveFrom !== undefined || approved.effectiveTo !== undefined;
        if (nowMs === undefined) {
          // No clock supplied. Effectiveness (§11 line 405 — a MANDATORY claim
          // dimension) cannot be proven, so if this approved claim declares a
          // window, block rather than silently skip it — weaken-by-omission is
          // the failure to avoid for a safety gate. Only a windowless approved
          // claim may pass without a clock (there is nothing to enforce).
          if (hasWindow) {
            return {
              allowed: false,
              reason: `claim "${claim}" carries an effective window but no clock was supplied to validate effectiveness (fail-closed)`,
            };
          }
        } else {
          // FAIL CLOSED: an approved entry checked for effectiveness must carry
          // a complete, parseable window; a missing or malformed bound means we
          // cannot prove the claim is currently effective — the dangerous
          // direction for a compliance gate, so block.
          const { effectiveFrom, effectiveTo } = approved;
          if (effectiveFrom === undefined || effectiveTo === undefined) {
            return {
              allowed: false,
              reason: `claim "${claim}" has a missing or malformed effective window (fail-closed)`,
            };
          }
          const fromMs = new Date(effectiveFrom).getTime();
          const toMs = new Date(effectiveTo).getTime();
          if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
            return {
              allowed: false,
              reason: `claim "${claim}" has a missing or malformed effective window (fail-closed)`,
            };
          }
          if (nowMs < fromMs) {
            return {
              allowed: false,
              reason: `claim "${claim}" is not yet effective (effectiveFrom: ${effectiveFrom})`,
            };
          }
          if (nowMs > toMs) {
            return {
              allowed: false,
              reason: `claim "${claim}" is expired (effectiveTo: ${effectiveTo})`,
            };
          }
        }
      }

      return { allowed: true };
    },
  };
}
