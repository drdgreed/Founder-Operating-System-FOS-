import { z } from "zod";
import { claimsInApprovedSetGate } from "../gates/claims-in-approved-set.js";
import { factsResolveToSourcesGate } from "../gates/facts-resolve-to-sources.js";
import { featureModeAllowedGate } from "../gates/feature-mode-allowed.js";
import type { AgentDefinition } from "../types.js";
// REUSE the editorial agent's CLOSED channel enum (P1.7a, spec §8.7): the
// cornerstone's promotion snippets go out on the SAME five launch channels, so
// there is no reason to fork a second channel vocabulary (DRY).
import { CAMPAIGN_CHANNELS } from "./beta-launch-editorial.js";

/**
 * `fos.substack_cornerstone` (issue #104, spec §8.8) — the Substack Cornerstone
 * Agent, the long-form editorial ANCHOR of a beta-launch campaign. Spec §8.8:
 * "Produces thesis, research questions, evidence matrix, counterarguments,
 * outline, full draft, summary, promotion assets, and claims manifest."
 * Workflow §9.4 step 3 ("Substack Cornerstone Agent generates long-form
 * anchor"), which runs after the Editorial Agent's channel plan (§9.4 step 2 /
 * §8.7 / P1.7a) and before the derivative-asset generation (§9.4 step 4).
 *
 * SCOPE (mirrors P1.7a's boundary): this builds ONLY the agent definition on
 * the existing 12-stage runtime — it produces ONE `substack_paper` artifact
 * (the cornerstone paper) for founder review. It does NOT build the campaign
 * workflow orchestration/queueing (§9.4), the derivative-asset generation and
 * independent verification (§9.4 step 4 — "Substack anchor to LinkedIn
 * derivatives", §11), or the per-channel derivative artifacts. It writes the
 * anchor; it does not fan it out.
 *
 * MAY-NOT-PUBLISH INVARIANT (spec §8.7/§8.8 sibling posture, §12 "External send
 * and publication remain separate explicit actions"). IDENTICAL construction to
 * the editorial agent, defense in depth:
 *   1. `permittedTools: []` — no publish/HTTP/command capability exists.
 *   2. `autonomyCeiling: "review"` + `featureModeAllowedGate` allow ONLY
 *      `shadow`/`review` — `live` (the reserved would-be-execution mode) is
 *      blocked both by the ceiling (mode.ts `effectiveMode` caps it) AND by
 *      the gate re-check. There is no publish path in ANY mode regardless.
 *   3. NO `projection` hook — the ONLY external-side-effect seam the runtime
 *      offers (stage 11) is absent, so nothing external is ever invoked.
 *   4. The created `substack_paper` artifact is routed to a PRE-PUBLICATION
 *      approval state ONLY: `draft` in shadow mode, `in_review` in review mode
 *      (stage 10) — NEVER `approved`/`ready_for_action`/`executed`, and the
 *      runtime never auto-decides an approval (a founder action). Publication is
 *      a later, separate, explicit `Mark artifact published` command (§7.3).
 * NOTE the artifact TYPE is a real publishable asset type (`substack_paper`) —
 * unlike the editorial plan's `internal_note` stopgap. That is correct: the
 * cornerstone IS a Substack paper. "May not publish" is enforced by the
 * lifecycle STATE (draft/in_review) + the four defenses above, NOT by using a
 * non-publishable artifact type. Creating a draft `substack_paper` is exactly
 * §9.4 step 3; publishing it is §9.4 step 7.
 *
 * ARTIFACT-ONLY, NO OWNERSHIP SEAM (same as the editorial agent): there is no
 * `persistDomain`. Spec §6 defines no Campaign/Paper domain entity, so there is
 * no domain record to write and no caller-supplied opportunity id to re-assert.
 * The approved source brief + source records are taken as least-privilege INLINE
 * content the model reasons over (UNTRUSTED — §12 posture); their refs are
 * carried for provenance but are NOT dereferenced from the DB in this slice, so
 * there is no confused-deputy cross-workspace read to guard here. The paper
 * artifact is created under `runContext.workspaceId` by the runtime.
 *
 * FLAG (issue #104, §6 gap): no seeded Campaign entity, no source-brief/source-
 * record dereference, and no ownership assertion — dereferencing the source
 * artifacts (+ their workspace-ownership checks) and joining the paper to a
 * canonical Campaign row belong to the campaign-workflow slice (§9.4), not this
 * agent-definition slice. `sourceBrief.content`, `sourceRecords`, and
 * `approvedClaims` are least-privilege caller-provided input (the same
 * convention every prior P1 agent used for its un-seeded registries — the
 * `evidenceRecords`/`availablePathways`/`authorizedChannels` precedent), never
 * live lookups.
 *
 * SECURITY-SENSITIVE (ADR-07 D7/D9): the model writes; the deterministic gates
 * enforce. Untrusted source content reaches the model ONLY via
 * `sourceBrief.content` / `sourceRecords[].content` (opaque data) — the gates
 * only ever see the Zod-validated `input`/`output`, never raw text, so injected
 * content can change what the model WRITES but never what the GATES, MODE, or
 * APPROVAL routing decide.
 */

// ---- Input (stage 1/3): least-privilege campaign + research context --------

/** A single source record the evidence matrix's FACT rows must ground to —
 * the ONLY sourceRefs a fact may cite (spec §8.1 "observed facts resolve to
 * source records" discipline, applied to the cornerstone's evidence matrix).
 * `sourceType` is a CLOSED enum. Not a canonical Evidence table (none is seeded
 * — see file header FLAG); the least-privilege slice of research/source content
 * the agent is given for this run. */
export const SUBSTACK_SOURCE_TYPES = [
  "research_source",
  "interview_note",
  "data_point",
  "prior_publication",
  "source_brief_excerpt",
] as const;

export const substackSourceRecordSchema = z.object({
  /** Stable identifier an evidence-matrix FACT row cites via its own sourceRef. */
  sourceRef: z.string().min(1),
  sourceType: z.enum(SUBSTACK_SOURCE_TYPES),
  /** The actual source content/excerpt the model may summarize or quote.
   * UNTRUSTED (spec §12 posture): passed as data, NEVER as instructions. */
  content: z.string().min(1),
});

export const substackCornerstoneInputSchema = z.object({
  campaign: z.object({
    /** Provenance id for the campaign this paper anchors (NOT dereferenced in
     * this slice — see file header FLAG). */
    id: z.string().uuid(),
    /** The campaign's objective (context the model writes toward). */
    objective: z.string().min(1),
    /** The target audience description. */
    audience: z.string().min(1),
    /** The offer being launched. */
    offer: z.string().min(1),
  }),
  /** The APPROVED campaign source brief this paper is derived from. */
  sourceBrief: z.object({
    /** Provenance ref to the `beta_launch_source_brief` artifact (§7.1). Carried
     * for audit; NOT dereferenced from the DB in this slice (file header FLAG). */
    artifactRef: z.string().min(1),
    /** The approved brief content the model reasons over. UNTRUSTED (§12). */
    content: z.string().min(1),
  }),
  /** The topic/thesis seed the founder wants the cornerstone to argue. Context
   * the model develops into a full thesis — least-privilege caller input. */
  thesisSeed: z.string().min(1),
  /** Research/source records (spec §8.1's "observed facts resolve to source
   * records" discipline) — the ONLY sourceRefs an evidence-matrix FACT row may
   * cite. FLAG: a provided/known set, not a live Evidence-table lookup. */
  sourceRecords: z.array(substackSourceRecordSchema),
  /** The founder-approved claim allowlist for THIS campaign/offer — every claim
   * the paper's `claimsManifest` asserts MUST be in this set
   * (`claims-in-approved-set` gate). FLAG (issue #82 precedent): least-privilege
   * caller input, not a live claims-registry lookup (that registry is P1.8). */
  approvedClaims: z.array(z.string().min(1)),
});

export type SubstackCornerstoneInput = z.infer<typeof substackCornerstoneInputSchema>;

// ---- Output (stage 6): the long-form cornerstone (spec §8.8) ---------------

/** Evidence-matrix label — a fact must ground to a source record; an inference
 * is the author's reasoning and does not (mirrors enrollment-brief's structural
 * fact/inference separation, §8.1 D4). A CLOSED enum. */
export const SUBSTACK_EVIDENCE_KINDS = ["fact", "inference"] as const;

const evidenceRowSchema = z.object({
  /** The claim this row asserts. Model free text — SCANNED. */
  claim: z.string().min(1),
  /** CLOSED enum: a `fact` (must resolve to a source) or an `inference`. */
  kind: z.enum(SUBSTACK_EVIDENCE_KINDS),
  /** For a `fact` row: the source record it cites — MUST resolve to a
   * `sourceRef` present in the input's `sourceRecords`
   * (`evidence-facts-resolve-to-sources` gate; a `fact` with no/unknown
   * sourceRef is BLOCKED). Optional for an `inference` row (author reasoning,
   * not a sourced fact). Also SCANNED (see P-004 enumeration) so an
   * inference-row ref — which the facts gate does NOT validate — cannot smuggle
   * guarantee prose into the rendered matrix. */
  sourceRef: z.string().min(1).optional(),
});

export type EvidenceRow = z.infer<typeof evidenceRowSchema>;

const promotionAssetSchema = z.object({
  /** CLOSED enum — one of the five launch channels (reused from §8.7). The
   * model can never target a promotion channel outside this set. */
  channel: z.enum(CAMPAIGN_CHANNELS),
  /** The per-channel promotion snippet. Model free text — SCANNED. */
  text: z.string().min(1),
});

export type PromotionAsset = z.infer<typeof promotionAssetSchema>;

export const substackCornerstoneOutputSchema = z.object({
  /** The paper's central thesis. Model free text — SCANNED. */
  thesis: z.string().min(1),
  /** The research questions the paper investigates (at least one). Each a model
   * free-text string — SCANNED. */
  researchQuestions: z.array(z.string().min(1)).min(1),
  /** The evidence matrix: each row a claim, a fact/inference label, and (for
   * facts) a source ref. FACT rows are grounded by
   * `evidenceFactsResolveToSourcesGate`. */
  evidenceMatrix: z.array(evidenceRowSchema).min(1),
  /** Counterarguments the paper acknowledges (at least one — a cornerstone that
   * concedes nothing is not credible). Each a model free-text string — SCANNED. */
  counterarguments: z.array(z.string().min(1)).min(1),
  /** The ordered outline (array position IS the section order — inherently
   * ordered, so no separate ordering gate is needed). Each heading a model
   * free-text string — SCANNED. */
  outline: z.array(z.string().min(1)).min(1),
  /** The full long-form draft. Model free text (LONG) — SCANNED. */
  fullDraft: z.string().min(1),
  /** A short summary of the paper. Model free text — SCANNED. */
  summary: z.string().min(1),
  /** Per-channel promotion snippets. Channel is a closed enum; text is SCANNED. */
  promotionAssets: z.array(promotionAssetSchema).min(1),
  /** The claims manifest: every substantive claim the paper makes. Each entry
   * MUST be in the founder-approved `approvedClaims` set
   * (`claimsInApprovedSetGate`) — the model can never assert an unapproved
   * claim, so these are gate-validated closed values, NOT a free-text scan
   * surface. */
  claimsManifest: z.array(z.string().min(1)).min(1),
});

export type SubstackCornerstoneOutput = z.infer<typeof substackCornerstoneOutputSchema>;

/** Selects the evidence-matrix FACT rows for the facts-resolve-to-sources gate.
 * Coerces a missing sourceRef to "" so a `fact` that omitted its source fails
 * the gate (""  is never a valid sourceRef) — "a fact without a source is
 * blocked". Inference rows are excluded: they are reasoning, not sourced facts. */
function selectFactRows(output: SubstackCornerstoneOutput): ReadonlyArray<{ sourceRef: string }> {
  return output.evidenceMatrix
    .filter((row) => row.kind === "fact")
    .map((row) => ({ sourceRef: row.sourceRef ?? "" }));
}

// ---- Definition ------------------------------------------------------------

export const FOS_SUBSTACK_CORNERSTONE_AGENT_KEY = "fos.substack_cornerstone";
export const FOS_SUBSTACK_CORNERSTONE_FEATURE_FLAG_KEY = "fos.substack_cornerstone";

export const fosSubstackCornerstoneAgentDefinition: AgentDefinition<
  SubstackCornerstoneInput,
  SubstackCornerstoneOutput
> = {
  key: FOS_SUBSTACK_CORNERSTONE_AGENT_KEY,
  version: "1.0.0",
  objective:
    "Given an approved beta-launch campaign source brief, a thesis seed, the approved research " +
    "source records, and the founder-approved claim set, produce a long-form Substack CORNERSTONE " +
    "paper: a thesis, research questions, an evidence matrix (each row a claim labeled fact or " +
    "inference, facts grounded to a source record), counterarguments, an ordered outline, a full " +
    "draft, a summary, per-channel promotion snippets, and a claims manifest drawn only from the " +
    "approved claim set. Ground every fact in a provided source, assert only approved claims. This " +
    "CREATES a draft paper artifact for founder review — it NEVER publishes — and NEVER guarantees " +
    "an employment, recruiter, salary, or interview outcome.",
  inputSchema: substackCornerstoneInputSchema,
  outputSchema: substackCornerstoneOutputSchema,
  // NO tools: no publish/command/HTTP capability by construction (may-not-
  // publish invariant, file header point 1).
  permittedTools: [],
  permittedMemoryScopes: ["campaign", "beta_launch_source_brief"],
  autonomyCeiling: "review",
  featureFlagKey: FOS_SUBSTACK_CORNERSTONE_FEATURE_FLAG_KEY,
  deterministicGates: [
    featureModeAllowedGate({
      key: "fos.substack_cornerstone.mode-allowed",
      // shadow/review ONLY — `live` (would-be execution) is never permitted
      // (may-not-publish invariant, file header point 2).
      allowedModes: ["shadow", "review"],
    }),
    // Every claim in the manifest must be in the founder-approved set — the
    // model can never assert a claim the founder did not pre-approve (REUSE of
    // the personalized-follow-up / issue #82 gate).
    claimsInApprovedSetGate<SubstackCornerstoneInput, SubstackCornerstoneOutput>({
      key: "fos.substack_cornerstone.claims-in-approved-set",
      selectClaims: (output) => output.claimsManifest,
      selectApprovedClaims: (input) => input.approvedClaims,
    }),
    // Every FACT row in the evidence matrix must resolve to a provided source
    // record (spec §8.1 discipline). An inference row is exempt (reasoning, not
    // a sourced fact); a `fact` with a missing/unknown sourceRef is BLOCKED.
    factsResolveToSourcesGate<SubstackCornerstoneInput, SubstackCornerstoneOutput>({
      key: "fos.substack_cornerstone.evidence-facts-resolve-to-sources",
      selectObservedFacts: selectFactRows,
      selectValidSourceRefs: (input) => input.sourceRecords.map((r) => r.sourceRef),
    }),
    // ============================================================
    // MECHANICAL guarantee-scan classification (AGENT_LESSONS P-004).
    // EVERY value `buildBodyMarkdown`/`buildClaimsManifest` renders or
    // persists, classified as exactly one of:
    //   (i)   input-derived (not model output)
    //   (ii)  a closed Zod enum
    //   (iii) gate-validated against a set (an earlier-ordered gate above)
    //   (iv)  SCANNED by complianceReviewText below
    // Re-run this enumeration on ANY change to the output schema,
    // `buildBodyMarkdown`, `buildClaimsManifest`, OR a gate's coverage. A
    // model-authored rendered/persisted value that is none of (i)-(iv) is a
    // guarantee leak. Long-form = MANY free-text sinks; miss none.
    //
    //   input.campaign.objective/audience/offer   → (i) input-derived
    //   input.thesisSeed                           → (i) input-derived
    //   input.sourceBrief.artifactRef              → (i) input-derived (ref only)
    //   input.sourceBrief.content                  → (i) input-derived (untrusted
    //                                                data; NOT rendered raw)
    //   input.sourceRecords[].*                    → (i) input-derived (untrusted;
    //                                                NOT rendered raw)
    //   output.thesis                              → (iv) SCANNED
    //   output.researchQuestions[]                 → (iv) SCANNED
    //   output.evidenceMatrix[].claim              → (iv) SCANNED
    //   output.evidenceMatrix[].kind               → (ii) closed enum
    //                                                SUBSTACK_EVIDENCE_KINDS
    //   output.evidenceMatrix[].sourceRef          → FACT rows: (iii) gate-
    //                                                validated (evidence-facts-
    //                                                resolve-to-sources); ALL
    //                                                rows also (iv) SCANNED —
    //                                                inference-row refs are NOT
    //                                                gate-validated, so scanning
    //                                                closes that leak
    //   output.counterarguments[]                  → (iv) SCANNED
    //   output.outline[]                           → (iv) SCANNED
    //   output.fullDraft                           → (iv) SCANNED
    //   output.summary                             → (iv) SCANNED
    //   output.promotionAssets[].channel           → (ii) closed enum
    //                                                CAMPAIGN_CHANNELS
    //   output.promotionAssets[].text              → (iv) SCANNED
    //   output.claimsManifest[]                    → (iii) gate-validated
    //                                                (claims-in-approved-set:
    //                                                each ==s a founder-approved,
    //                                                pre-vetted claim string)
    // `buildClaimsManifest` persists ONLY: claimsManifest (iii gate-validated),
    // the cited fact sourceRefs (iii/iv per above), and counts — no NEW model
    // free-text sink beyond what is already scanned above.
    // ============================================================
  ],
  // Stage-7b semantic compliance review (Option C slice 2, issue #109) — the
  // eval-validated guarantee classifier replaces the removed keyword gate. Same
  // fields the old gate's `selectText` scanned (see the mechanical enumeration
  // above) — keep in sync with `buildBodyMarkdown`.
  complianceReviewText: (output) => [
    output.thesis,
    ...output.researchQuestions,
    ...output.evidenceMatrix.map((r) => r.claim),
    // Inference-row refs are not gate-validated — scan every row's ref.
    ...output.evidenceMatrix.map((r) => r.sourceRef ?? ""),
    ...output.counterarguments,
    ...output.outline,
    output.fullDraft,
    output.summary,
    ...output.promotionAssets.map((a) => a.text),
  ],
  artifact: {
    // The cornerstone IS a Substack paper — `substack_paper` is the canonical,
    // already-registered §7.1/§E4 artifact type (NO enum value added — slice
    // boundary). `domain: "editorial"` is the exact fit for a long-form
    // editorial anchor. May-not-publish is enforced by the draft/in_review
    // LIFECYCLE STATE + the four file-header defenses, not by the type.
    artifactType: "substack_paper",
    domain: "editorial",
    buildTitle: (input, output) =>
      `Substack Cornerstone: ${output.thesis.slice(0, 80).trim() || input.campaign.objective}`,
    buildBodyMarkdown: (input, output) =>
      [
        `# Substack Cornerstone`,
        "",
        `**Campaign objective:** ${input.campaign.objective}`,
        `**Audience:** ${input.campaign.audience}`,
        `**Offer:** ${input.campaign.offer}`,
        `**Source brief:** ${input.sourceBrief.artifactRef}`,
        "",
        "## Thesis",
        output.thesis,
        "",
        "## Research questions",
        ...output.researchQuestions.map((q) => `- ${q}`),
        "",
        "## Evidence matrix",
        ...output.evidenceMatrix.map((r) =>
          r.kind === "fact"
            ? `- **[fact]** ${r.claim} _(source: ${r.sourceRef})_`
            : `- **[inference]** ${r.claim}`,
        ),
        "",
        "## Counterarguments",
        ...output.counterarguments.map((c) => `- ${c}`),
        "",
        "## Outline",
        ...output.outline.map((h, i) => `${i + 1}. ${h}`),
        "",
        "## Full draft",
        output.fullDraft,
        "",
        "## Summary",
        output.summary,
        "",
        "## Promotion assets",
        ...output.promotionAssets.map((a) => `- **[${a.channel}]** ${a.text}`),
      ].join("\n"),
    buildClaimsManifest: (_input, output) => {
      // Internal audit aid: the manifest's approved claims (gate-validated), the
      // source refs the paper's FACT rows actually cited (so a reviewer can
      // spot-check grounding), and counts — no new model free-text scan surface.
      const factSourceRefs = output.evidenceMatrix
        .filter((r) => r.kind === "fact")
        .map((r) => r.sourceRef ?? "");
      return {
        claims: output.claimsManifest,
        citedSourceRefs: [...new Set(factSourceRefs)],
        factCount: factSourceRefs.length,
        inferenceCount: output.evidenceMatrix.filter((r) => r.kind === "inference").length,
        promotionChannels: [...new Set(output.promotionAssets.map((a) => a.channel))],
      };
    },
  },
  // NO `persistDomain` (no domain entity, no opportunity to own — file header)
  // and NO `projection` (no external side effect / no publish path — may-not-
  // publish invariant, file header point 3).
};
