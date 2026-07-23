import type { Gate, GateContext, GateResult } from "./gate.js";

/**
 * The two contact PURPOSES this gate distinguishes (spec §127
 * "Operational-contact and marketing-contact consent rules"; Phase-0 §9.4
 * consent types `operational_contact` / `marketing_contact`). Consent for one
 * purpose NEVER extends to the other: an applicant who consented to
 * operational contact (e.g. enrollment logistics) has NOT thereby consented to
 * marketing contact, and vice versa.
 */
export const CONTACT_PURPOSES = ["operational", "marketing"] as const;
export type ContactPurpose = (typeof CONTACT_PURPOSES)[number];

/** One affirmatively-recorded (purpose, channel) consent grant. */
export interface ContactConsentGrant {
  purpose: ContactPurpose;
  channel: string;
}

export interface ContactConsentGateOptions<TInput, TOutput> {
  key: string;
  /** The contact PURPOSE the run declares for this contact
   * (operational | marketing). Receives both `output` and `input` (the purpose
   * may be a model OUTPUT field or a caller INPUT field, same generalized-
   * selector convention as `consentGate`). */
  selectContactPurpose: (output: TOutput, input: TInput) => string | undefined;
  /** The channel the contact would go through (e.g. "email", "sms"). */
  selectContactChannel: (output: TOutput, input: TInput) => string | undefined;
  /** Per-purpose, per-channel consent grants that have been AFFIRMATIVELY
   * recorded — the ALLOWLIST, from the run's own (Zod-validated) input, never
   * from the model. FLAG (issue #116): consent registry not seeded — this gate
   * operates on a caller-provided grant list (least-privilege input, issue #78
   * precedent), NOT a live consent-service lookup. A (purpose, channel) pair
   * absent from this list is NOT consented by construction. */
  selectConsentGrants: (input: TInput) => readonly ContactConsentGrant[];
}

function isContactPurpose(value: string | undefined): value is ContactPurpose {
  return value !== undefined && (CONTACT_PURPOSES as readonly string[]).includes(value);
}

/**
 * The purpose-aware contact-consent gate (spec §12 line 404 "Contact is blocked
 * when consent is revoked [or absent]", §127). Distinct from the base
 * `consentGate` (which is a flat per-channel allowlist): here a contact is
 * consented only when the run's PURPOSE + CHANNEL pair is affirmatively in the
 * caller-supplied grant list. Opt-in / fail-closed (FOUNDER DECISION, issue
 * #78 "option B"): an absent/unknown purpose, an absent channel, or a
 * purpose+channel pair with no recorded grant all BLOCK the contact. Consent
 * for one purpose never extends to the other. Reads only the Zod-validated
 * `input`/`output` (ADR-07 D9).
 */
export function contactConsentGate<TInput, TOutput>(
  options: ContactConsentGateOptions<TInput, TOutput>,
): Gate<TInput, TOutput> {
  return {
    key: options.key,
    evaluate(ctx: GateContext<TInput, TOutput>): GateResult {
      const purpose = options.selectContactPurpose(ctx.output, ctx.input);
      // FAIL CLOSED: an absent or unrecognized purpose cannot be matched
      // against any grant, so it can never be affirmatively consented — block.
      if (!isContactPurpose(purpose)) {
        return {
          allowed: false,
          reason: `unknown or absent contact purpose "${String(
            purpose,
          )}" — contact requires a recognized purpose (operational | marketing) with recorded consent (fail-closed)`,
        };
      }
      const channel = options.selectContactChannel(ctx.output, ctx.input);
      // FAIL CLOSED: a contact PURPOSE always implies a contact; without a
      // channel we cannot check consent, so an absent channel blocks.
      if (channel === undefined) {
        return {
          allowed: false,
          reason: `contact channel is absent — cannot validate ${purpose}-contact consent (fail-closed)`,
        };
      }
      const grants = options.selectConsentGrants(ctx.input);
      const consented = grants.some(
        (grant) => grant.purpose === purpose && grant.channel === channel,
      );
      if (!consented) {
        return {
          allowed: false,
          reason: `no recorded ${purpose}-contact consent for channel "${channel}" — contact requires an affirmative, recorded per-purpose consent (fail-closed)`,
        };
      }
      return { allowed: true };
    },
  };
}
