import { evaluateGates, type Gate, type GateContext, type GateResult } from "./gate.js";

/** The approval states an artifact may be considered eligible from. Default is
 * the single canonical `"approved"` state. */
const DEFAULT_APPROVED_STATES = ["approved"] as const;

export interface PlatformDraftGateOptions<TInput, TOutput> {
  key: string;
  /** The caller-supplied approval state of the artifact/output (e.g. "draft",
   * "pending_approval", "approved"), from the run's own (Zod-validated) input.
   * FLAG (issue #116): the approval state is Phase-0 canonical state the CALLER
   * projects into the gate input (least-privilege convention), not a live
   * approvals-service lookup. */
  selectApprovalState: (input: TInput) => string | undefined;
  /** Which approval states count as "approved" for external-draft eligibility.
   * Defaults to `["approved"]`. */
  approvedStates?: readonly string[];
  /** The claims + consent gates that must (re)pass before an external draft may
   * be created (spec §9.4 step 6 "Approved platform drafts are created"; §12
   * line 407 "Founder edits trigger claims revalidation"; §7.3 "revalidate
   * claims/consent"). This gate COMPOSES them — running each against the same
   * `GateContext` — so external-draft eligibility asserts approval AND a fresh
   * claims/consent pass in one deterministic check. Typically the P1.8a
   * `claimsApprovedForChannelAndOfferGate` + `contactConsentGate`. */
  preconditionGates: ReadonlyArray<Gate<TInput, TOutput>>;
}

/**
 * The platform-draft eligibility gate (spec §9.4 steps 5-6, §7.3): an
 * artifact/output is eligible for EXTERNAL-draft creation ONLY when it is (a)
 * in an approved state AND (b) its claims + consent preconditions (re)validate
 * at draft time. This composes the claims and consent gates rather than
 * duplicating their logic, so the "revalidate on draft" requirement is enforced
 * by the same deterministic gates that guarded approval. Fails closed: an
 * absent/unknown approval state is not approved (block), and any failing
 * precondition gate blocks with that gate's own reason. External-draft creation
 * remains a separate explicit action (§12 line 409) — this gate only decides
 * ELIGIBILITY; it never itself creates or sends anything. Reads only the
 * Zod-validated `input`/`output` (ADR-07 D9).
 */
export function platformDraftGate<TInput, TOutput>(
  options: PlatformDraftGateOptions<TInput, TOutput>,
): Gate<TInput, TOutput> {
  // REQUIRE ≥1 precondition. Spec §9.4 step 9 / §7.3 mandate claims + consent
  // REVALIDATION at draft time; an empty precondition list would certify
  // eligibility on approval-state alone, silently skipping that revalidation —
  // weaken-by-omission, the failure to avoid for a safety gate. Fail fast at
  // wiring time so a caller can never forget the preconditions.
  if (options.preconditionGates.length === 0) {
    throw new Error(
      "platformDraftGate requires at least one precondition gate (claims + consent revalidation, §9.4 step 9) — approval state alone cannot certify external-draft eligibility",
    );
  }
  const approvedStates = options.approvedStates ?? DEFAULT_APPROVED_STATES;
  return {
    key: options.key,
    async evaluate(ctx: GateContext<TInput, TOutput>): Promise<GateResult> {
      const state = options.selectApprovalState(ctx.input);
      // FAIL CLOSED: an absent/unknown state is not in the approved set, so it
      // never defaults to eligible.
      if (state === undefined || !approvedStates.includes(state)) {
        return {
          allowed: false,
          reason: `artifact is not in an approved state (state: ${String(
            state,
          )}) — not eligible for platform-draft creation`,
        };
      }
      // Re-assert claims + consent at draft time by composing the same gates.
      const composed = await evaluateGates(options.preconditionGates, ctx);
      if (!composed.allowed) {
        return {
          allowed: false,
          reason: `platform-draft precondition failed — ${
            composed.blockedBy?.reason ?? "a claims/consent precondition did not (re)validate"
          }`,
        };
      }
      return { allowed: true };
    },
  };
}
