import { eq } from "drizzle-orm";
import { z } from "zod";
import { enrollmentOpportunity } from "@fos/db/schema";
import { getInteractionById } from "@fos/db/services";
import type { Db } from "@fos/db/services";
import { factsResolveToSourcesGate } from "../gates/facts-resolve-to-sources.js";
import { featureModeAllowedGate } from "../gates/feature-mode-allowed.js";
import type { AgentDefinition } from "../types.js";

/**
 * Re-reads the target opportunity and asserts it belongs to this run's
 * workspace, mirroring `loadOwnedOpportunity` in `enrollment-brief.ts:20`
 * (issue #53 security review, reused here per issue #60): never trust a
 * caller-supplied `opportunity.id` across the workspace boundary. Not
 * imported from enrollment-brief.ts — that file is out of scope for this
 * slice (see PR body); this is an intentional, small duplication of the
 * pattern rather than a cross-agent dependency.
 */
async function loadOwnedOpportunity(db: Db, opportunityId: string, workspaceId: string) {
  const [row] = await db
    .select()
    .from(enrollmentOpportunity)
    .where(eq(enrollmentOpportunity.id, opportunityId))
    .limit(1);
  if (!row) {
    throw new Error(`fos.call_preparation: enrollment_opportunity ${opportunityId} not found`);
  }
  if (row.workspaceId !== workspaceId) {
    throw new Error(
      `fos.call_preparation: opportunity ${opportunityId} is not in workspace ${workspaceId}`,
    );
  }
  return row;
}

/**
 * `fos.call_preparation` (issue #60, spec §8.2) — the second P1.3 agent, run
 * ahead of a scheduled conversation recorded via the P1.3a `interaction`
 * substrate (§9.2 step 2 follows step 1 "record scheduled conversation").
 * Produces the founder's pre-call brief: meeting objective, a three-sentence
 * summary, critical unknowns, top questions, likely objections, permitted
 * claims, claims to avoid, and a recommended close.
 *
 * KEY ARCHITECTURAL DIFFERENCE FROM `fos.enrollment_brief` (do not copy that
 * agent's shape blindly): spec §7.1 gives Call Preparation NO domain entity
 * (unlike EnrollmentAssessment) — this agent produces ONLY an artifact. There
 * is therefore no `persistDomain` domain-record write and no `projection`
 * (Founder-Inbox projection is P1.5). BUT the artifact is still canonical
 * state, so `persistDomain` below is used purely as the ownership-assertion
 * seam that runs at stage 9b (inside the pipeline's canonical try block,
 * after `createArtifact`, before the run can complete `succeeded`) — it
 * writes no record, it only asserts that BOTH the opportunity and the
 * interaction belong to this run's workspace, and that the interaction
 * actually belongs to the opportunity it claims to. A failure here fails the
 * run closed, exactly like enrollment-brief's own domain write would.
 *
 * SECURITY-SENSITIVE (ADR-07 D7/D9): the model recommends; the deterministic
 * gates below enforce. Untrusted interaction notes / evidence content can
 * never change a gate outcome, mode, or approval routing — gates only ever
 * see the Zod-validated `input`/`output`, never raw text.
 *
 * FLAG (issue #60, mirrors enrollment-brief's precedent): no seeded Evidence
 * table and no live claims registry exist yet. `evidenceRecords` and
 * `availableClaims` are least-privilege, caller-provided input sets — the
 * same convention as enrollment-brief's `evidenceRecords`/`availablePathways`
 * — not live registry lookups.
 *
 * FLAG (issue #60): no dedicated claims-approved gate exists in this slice.
 * The full "claims approved for this channel and offer" gate is P1.8; the
 * stage-7b semantic compliance review (issue #109) is the safety net for
 * `permittedClaims` here — it cannot verify a claim is *approved*, only that it
 * does not smuggle a prohibited employment/salary/interview guarantee.
 */

// ---- Input (stage 1/3): least-privilege context the agent reasons over ---

export const callPreparationSourceRecordSchema = z.object({
  /** Stable identifier an observedFact can cite via its own sourceRef. */
  sourceRef: z.string().min(1),
  sourceType: z.enum([
    "application_field",
    "person_field",
    "opportunity_field",
    "interaction_note",
    "prior_assessment",
  ]),
  /** The actual source content/excerpt the model may summarize or quote.
   * UNTRUSTED (spec §551 posture, same as `interaction.notes`/`transcript_ref`)
   * — stored/passed as data, never interpreted as instructions. */
  content: z.string().min(1),
});

export const callPreparationInputSchema = z.object({
  opportunity: z.object({
    id: z.string().uuid(),
    stage: z.string().min(1),
    primaryGoal: z.string().optional(),
    targetRole: z.string().optional(),
    targetTimeline: z.string().optional(),
  }),
  person: z.object({
    id: z.string().uuid(),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    currentRole: z.string().optional(),
    currentCompany: z.string().optional(),
    location: z.string().optional(),
  }),
  /** The scheduled conversation (P1.3a `interaction`) this brief prepares
   * for. `scheduledAt` is passed as an ISO-8601 string (least-privilege
   * flattening of the canonical timestamp, mirrors the rest of this input's
   * plain-string convention). */
  interaction: z.object({
    id: z.string().uuid(),
    interactionType: z.string().min(1),
    scheduledAt: z.string().optional(),
  }),
  /** Evidence/source records — the ONLY sourceRefs an observedFact may cite.
   * FLAG: no seeded Evidence table (same as enrollment-brief). */
  evidenceRecords: z.array(callPreparationSourceRecordSchema),
  /** Approved claims the founder may reference on the call. FLAG: the claims
   * registry (Phase-0 §111 precondition) is not seeded — provided as a
   * least-privilege input set, same convention as enrollment-brief's
   * `availablePathways`. NOT a live registry lookup. */
  availableClaims: z.array(z.string().min(1)),
});

export type CallPreparationInput = z.infer<typeof callPreparationInputSchema>;

// ---- Output (stage 6, D4): observedFacts/inferences separated BY TYPE -----

export const CALL_PREPARATION_CONFIDENCE_VALUES = ["low", "medium", "high"] as const;

const observedFactSchema = z.object({
  statement: z.string().min(1),
  /** MUST resolve to a `sourceRef` present in the input's `evidenceRecords`
   * (enforced by the `factsResolveToSources` gate, not by this schema alone —
   * this schema only enforces that a fact is STRUCTURALLY incapable of
   * omitting a source). */
  sourceRef: z.string().min(1),
});

const inferenceSchema = z.object({
  statement: z.string().min(1),
  confidence: z.enum(CALL_PREPARATION_CONFIDENCE_VALUES),
});

export const callPreparationOutputSchema = z.object({
  meetingObjective: z.string().min(1),
  /** Spec §8.2: "three-sentence summary" — documented expectation, not
   * structurally enforced beyond non-empty (mirrors the rest of this
   * runtime's convention of enforcing shape, not prose length, in Zod). */
  summary: z.string().min(1),
  recommendedClose: z.string().min(1),
  criticalUnknowns: z.array(z.string()),
  topQuestions: z.array(z.string()),
  likelyObjections: z.array(z.string()),
  /** Claims the founder is permitted to reference on this call, drawn from
   * `availableClaims`. The critical field for the semantic compliance review:
   * a prohibited guarantee smuggled in here (rather than a narrative field)
   * must still be blocked — see `complianceReviewText` below. */
  permittedClaims: z.array(z.string()),
  claimsToAvoid: z.array(z.string()),
  /** D4: every entry MUST carry a sourceRef — an inference can never be
   * placed here because it lacks one. */
  observedFacts: z.array(observedFactSchema),
  /** D4: inferences are LABELED with a confidence and structurally kept out
   * of `observedFacts` — the type itself forbids inference-as-fact. */
  inferences: z.array(inferenceSchema),
});

export type CallPreparationOutput = z.infer<typeof callPreparationOutputSchema>;

// ---- Definition ------------------------------------------------------------

export const FOS_CALL_PREPARATION_AGENT_KEY = "fos.call_preparation";
export const FOS_CALL_PREPARATION_FEATURE_FLAG_KEY = "fos.call_preparation";

export const fosCallPreparationAgentDefinition: AgentDefinition<
  CallPreparationInput,
  CallPreparationOutput
> = {
  key: FOS_CALL_PREPARATION_AGENT_KEY,
  version: "1.0.0",
  objective:
    "Produce the founder's pre-call brief for a scheduled enrollment conversation: a meeting " +
    "objective, a three-sentence summary, critical unknowns, top questions, likely objections, " +
    "permitted claims, claims to avoid, and a recommended close. Never state a fact without a " +
    "source, and never guarantee an employment, recruiter, salary, or interview outcome — " +
    "including inside a 'permitted' claim.",
  inputSchema: callPreparationInputSchema,
  outputSchema: callPreparationOutputSchema,
  permittedTools: [],
  permittedMemoryScopes: [
    "enrollment_opportunity",
    "person",
    "interaction",
    "evidence_records",
    "available_claims",
  ],
  autonomyCeiling: "review",
  featureFlagKey: FOS_CALL_PREPARATION_FEATURE_FLAG_KEY,
  deterministicGates: [
    featureModeAllowedGate({
      key: "fos.call_preparation.mode-allowed",
      allowedModes: ["shadow", "review"],
    }),
    factsResolveToSourcesGate<CallPreparationInput, CallPreparationOutput>({
      key: "fos.call_preparation.facts-resolve-to-sources",
      selectObservedFacts: (output) => output.observedFacts,
      selectValidSourceRefs: (input) => input.evidenceRecords.map((r) => r.sourceRef),
    }),
    // No recommended-pathway gate here (spec §8.2/issue #60): call
    // preparation recommends no pathway, unlike enrollment-brief.
    //
    // FLAG (issue #60): no dedicated claims-approved gate — the full
    // claims-approved-for-channel-and-offer gate is P1.8. This
    // no-prohibited-guarantee gate is the safety net for `permittedClaims`
    // in this slice; it cannot verify a claim is *approved*, only that it
    // carries no prohibited guarantee.
  ],
  // Stage-7b semantic compliance review (Option C slice 2, issue #109) — the
  // eval-validated guarantee classifier replaces the removed keyword gate. It
  // must scan EVERY field that `buildBodyMarkdown` renders into the canonical
  // founder-facing brief (mirrors the enrollment-brief issue-#53 security fix):
  // a prohibited guarantee otherwise reaches canonical state via any free-text
  // field. `permittedClaims` is the critical one — a prohibited guarantee
  // smuggled into a "permitted" claim must still be blocked. Same fields the
  // old gate's `selectText` scanned — keep in sync with `buildBodyMarkdown`.
  complianceReviewText: (output) => [
    output.meetingObjective,
    output.summary,
    output.recommendedClose,
    ...output.criticalUnknowns,
    ...output.topQuestions,
    ...output.likelyObjections,
    ...output.permittedClaims,
    ...output.claimsToAvoid,
    ...output.observedFacts.map((f) => f.statement),
    ...output.inferences.map((i) => i.statement),
  ],
  artifact: {
    artifactType: "call_preparation_brief",
    domain: "enrollment",
    buildTitle: (input) => `Call Preparation: ${input.person.firstName} ${input.person.lastName}`,
    buildBodyMarkdown: (input, output) =>
      [
        `# Call Preparation: ${input.person.firstName} ${input.person.lastName}`,
        "",
        `**Interaction:** ${input.interaction.interactionType}` +
          (input.interaction.scheduledAt ? ` (scheduled: ${input.interaction.scheduledAt})` : ""),
        "",
        "## Meeting objective",
        output.meetingObjective,
        "",
        "## Summary",
        output.summary,
        "",
        "## Critical unknowns",
        ...(output.criticalUnknowns.length
          ? output.criticalUnknowns.map((u) => `- ${u}`)
          : ["- none noted"]),
        "",
        "## Top questions",
        ...(output.topQuestions.length
          ? output.topQuestions.map((q) => `- ${q}`)
          : ["- none noted"]),
        "",
        "## Likely objections",
        ...(output.likelyObjections.length
          ? output.likelyObjections.map((o) => `- ${o}`)
          : ["- none noted"]),
        "",
        "## Permitted claims",
        ...(output.permittedClaims.length
          ? output.permittedClaims.map((c) => `- ${c}`)
          : ["- none noted"]),
        "",
        "## Claims to avoid",
        ...(output.claimsToAvoid.length
          ? output.claimsToAvoid.map((c) => `- ${c}`)
          : ["- none noted"]),
        "",
        "## Observed facts",
        ...output.observedFacts.map((f) => `- ${f.statement} _(source: ${f.sourceRef})_`),
        "",
        "## Inferences (labeled, not facts)",
        ...output.inferences.map((i) => `- ${i.statement} _(confidence: ${i.confidence})_`),
        "",
        "## Recommended close",
        output.recommendedClose,
      ].join("\n"),
    buildClaimsManifest: (_input, output) => ({
      // Internal evidence-audit aid: every sourceRef this brief actually
      // cited, so a reviewer can spot-check grounding without re-deriving it.
      observedFactSourceRefs: output.observedFacts.map((f) => f.sourceRef),
      permittedClaims: output.permittedClaims,
    }),
  },
  // Stage 9b: NO domain record is written (spec §7.1 gives Call Preparation
  // no domain entity, unlike EnrollmentAssessment) — this hook exists SOLELY
  // as the ownership-assertion seam (issue #60): it re-reads the opportunity
  // and the interaction and asserts both belong to this run's workspace
  // (defense-in-depth, mirrors enrollment-brief's own persistDomain check),
  // and that the interaction actually belongs to the claimed opportunity.
  // Runs at stage 9b, inside the pipeline's canonical try block — a failure
  // here fails the run closed, same as any other stage-9 write, before the
  // artifact can be routed to review (stage 10) or considered `succeeded`.
  persistDomain: async ({ deps, runContext }, input) => {
    const opportunityRow = await loadOwnedOpportunity(
      deps.db,
      input.opportunity.id,
      runContext.workspaceId,
    );
    const interactionRow = await getInteractionById(
      deps.db,
      runContext.workspaceId,
      input.interaction.id,
    );
    if (!interactionRow) {
      throw new Error(
        `fos.call_preparation: interaction ${input.interaction.id} is not in workspace ${runContext.workspaceId}`,
      );
    }
    if (interactionRow.opportunityId !== opportunityRow.id) {
      throw new Error(
        `fos.call_preparation: interaction ${input.interaction.id} does not belong to opportunity ${opportunityRow.id}`,
      );
    }
  },
  // No `projection` hook (spec §7.1/issue #60 boundary): Founder-Inbox
  // projection is P1.5, out of scope here.
};
