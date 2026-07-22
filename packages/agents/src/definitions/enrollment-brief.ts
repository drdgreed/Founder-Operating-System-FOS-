import { eq } from "drizzle-orm";
import { z } from "zod";
import { enrollmentOpportunity } from "@fos/db/schema";
import { recordEnrollmentAssessment } from "@fos/db/services";
import type { Db } from "@fos/db/services";
import { projectOpportunity } from "@fos/adapter";
import { factsResolveToSourcesGate } from "../gates/facts-resolve-to-sources.js";
import { featureModeAllowedGate } from "../gates/feature-mode-allowed.js";
import { recommendedPathwayAvailableGate } from "../gates/recommended-pathway-available.js";
import type { AgentDefinition } from "../types.js";

/**
 * Re-reads the target opportunity and asserts it belongs to this run's
 * workspace before ANY canonical write against it (issue #53 security review):
 * never trust a caller-supplied `opportunity.id` across the workspace boundary
 * — a confused-deputy caller must not be able to write an assessment or project
 * against another workspace's opportunity. Returns the canonical row for reuse.
 */
async function loadOwnedOpportunity(db: Db, opportunityId: string, workspaceId: string) {
  const [row] = await db
    .select()
    .from(enrollmentOpportunity)
    .where(eq(enrollmentOpportunity.id, opportunityId))
    .limit(1);
  if (!row) {
    throw new Error(`fos.enrollment_brief: enrollment_opportunity ${opportunityId} not found`);
  }
  if (row.workspaceId !== workspaceId) {
    throw new Error(
      `fos.enrollment_brief: opportunity ${opportunityId} is not in workspace ${workspaceId}`,
    );
  }
  return row;
}

/**
 * `fos.enrollment_brief` (issue #53, spec §8.1) — the first real business
 * agent on the P1.1 runtime. Reads an application + its opportunity/person
 * context + the evidence/source records the founder has on file, and
 * produces the founder's three-minute enrollment review: candidate summary,
 * observed facts (each with a source), labeled inferences, readiness, fit,
 * pathway, objections, discovery questions, risk flags, and next action.
 *
 * SECURITY-SENSITIVE (ADR-07 D7/D9): the model recommends; the deterministic
 * gates below enforce. Nothing here lets untrusted application content (a
 * prompt-injection vector) change a gate outcome, mode, or approval routing —
 * gates only ever see the Zod-validated `input`/`output`, never raw text.
 */

// ---- Input (stage 1/3): least-privilege context the agent reasons over ---

export const enrollmentBriefSourceRecordSchema = z.object({
  /** Stable identifier an observedFact can cite via its own sourceRef. */
  sourceRef: z.string().min(1),
  sourceType: z.enum([
    "application_field",
    "person_field",
    "opportunity_field",
    "interaction_note",
    "prior_assessment",
  ]),
  /** The actual source content/excerpt the model may summarize or quote. */
  content: z.string().min(1),
});

export const enrollmentBriefInputSchema = z.object({
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
  application: z.object({
    id: z.string().uuid(),
    formVersion: z.string().min(1),
    sourceReference: z.string().min(1),
  }),
  /** Evidence/source records (spec §8.1's "observed facts resolve to source
   * records") — the ONLY sourceRefs an observedFact may cite. Not a canonical
   * Evidence table (none is seeded yet, FLAG — see PR description); this is
   * the least-privilege slice of application/person/opportunity content the
   * agent is given for this run. */
  evidenceRecords: z.array(enrollmentBriefSourceRecordSchema),
  /** The pathway set available for the opportunity's current offer. FLAG:
   * a provided/known set, not a live offer-registry lookup — the Offer
   * table (spec §111 precondition) is not seeded yet; see
   * recommended-pathway-available.ts. */
  availablePathways: z.array(z.string().min(1)),
});

export type EnrollmentBriefInput = z.infer<typeof enrollmentBriefInputSchema>;

// ---- Output (stage 6, D4): observedFacts/inferences separated BY TYPE -----

export const ENROLLMENT_BRIEF_CONFIDENCE_VALUES = ["low", "medium", "high"] as const;
export const ENROLLMENT_BRIEF_FIT_STATUS_VALUES = [
  "strong_fit",
  "possible_fit",
  "weak_fit",
  "not_a_fit",
] as const;
export const ENROLLMENT_BRIEF_READINESS_VALUES = [
  "ready_now",
  "ready_soon",
  "not_ready",
  "insufficient_information",
] as const;
/** Sentinel `recommendedPathway` value meaning "not enough information to
 * recommend a pathway yet" — never a fabricated guess (see the incomplete-
 * information eval scenario). */
export const ENROLLMENT_BRIEF_UNDETERMINED_PATHWAY = "undetermined";

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
  confidence: z.enum(ENROLLMENT_BRIEF_CONFIDENCE_VALUES),
});

export const enrollmentBriefOutputSchema = z.object({
  candidateSummary: z.string().min(1),
  /** D4: every entry MUST carry a sourceRef — an inference can never be
   * placed here because it lacks one. */
  observedFacts: z.array(observedFactSchema),
  /** D4: inferences are LABELED with a confidence and structurally kept out
   * of `observedFacts` — the type itself forbids inference-as-fact. */
  inferences: z.array(inferenceSchema),
  readiness: z.enum(ENROLLMENT_BRIEF_READINESS_VALUES),
  fitStatus: z.enum(ENROLLMENT_BRIEF_FIT_STATUS_VALUES),
  fitConfidence: z.enum(ENROLLMENT_BRIEF_CONFIDENCE_VALUES),
  fitRationale: z.string().min(1),
  recommendedPathway: z.string().min(1),
  objections: z.array(z.string()),
  discoveryQuestions: z.array(z.string()),
  riskFlags: z.array(z.string()),
  unknowns: z.array(z.string()),
  nextAction: z.string().min(1),
});

export type EnrollmentBriefOutput = z.infer<typeof enrollmentBriefOutputSchema>;

// ---- Definition ------------------------------------------------------------

export const FOS_ENROLLMENT_BRIEF_AGENT_KEY = "fos.enrollment_brief";
export const FOS_ENROLLMENT_BRIEF_FEATURE_FLAG_KEY = "fos.enrollment_brief";

export const fosEnrollmentBriefAgentDefinition: AgentDefinition<
  EnrollmentBriefInput,
  EnrollmentBriefOutput
> = {
  key: FOS_ENROLLMENT_BRIEF_AGENT_KEY,
  version: "1.0.0",
  objective:
    "Produce the founder's three-minute enrollment review of an applicant: a candidate " +
    "summary, source-grounded observed facts, clearly-labeled inferences, readiness, fit, " +
    "recommended pathway, objections, discovery questions, risk flags, and next action. " +
    "Never state a fact without a source, never guarantee an outcome, and never invent a " +
    "pathway that is not currently offered.",
  inputSchema: enrollmentBriefInputSchema,
  outputSchema: enrollmentBriefOutputSchema,
  permittedTools: [],
  permittedMemoryScopes: [
    "enrollment_opportunity",
    "person",
    "application_submission",
    "evidence_records",
  ],
  autonomyCeiling: "review",
  featureFlagKey: FOS_ENROLLMENT_BRIEF_FEATURE_FLAG_KEY,
  deterministicGates: [
    featureModeAllowedGate({
      key: "fos.enrollment_brief.mode-allowed",
      allowedModes: ["shadow", "review"],
    }),
    factsResolveToSourcesGate<EnrollmentBriefInput, EnrollmentBriefOutput>({
      key: "fos.enrollment_brief.facts-resolve-to-sources",
      selectObservedFacts: (output) => output.observedFacts,
      selectValidSourceRefs: (input) => input.evidenceRecords.map((r) => r.sourceRef),
    }),
    recommendedPathwayAvailableGate<EnrollmentBriefInput, EnrollmentBriefOutput>({
      key: "fos.enrollment_brief.recommended-pathway-available",
      selectRecommendedPathway: (output) => output.recommendedPathway,
      selectAvailablePathways: (input) => input.availablePathways,
      undeterminedValue: ENROLLMENT_BRIEF_UNDETERMINED_PATHWAY,
    }),
  ],
  // Stage-7b semantic compliance review (Option C slice 2, issue #109) — the
  // eval-validated guarantee classifier replaces the removed keyword gate. It
  // must scan EVERY field that `buildBodyMarkdown` renders into the canonical
  // founder-facing brief (issue #53 security review): a prohibited guarantee
  // otherwise reaches canonical state via an observedFact/inference/riskFlag/
  // unknown statement. Same fields the old gate's `selectText` scanned — keep
  // this list in sync with `buildBodyMarkdown` below.
  complianceReviewText: (output) => [
    output.candidateSummary,
    output.fitRationale,
    output.nextAction,
    ...output.objections,
    ...output.discoveryQuestions,
    ...output.observedFacts.map((f) => f.statement),
    ...output.inferences.map((i) => i.statement),
    ...output.riskFlags,
    ...output.unknowns,
  ],
  artifact: {
    // FLAG: spec §7.1 names a dedicated `enrollment_brief` artifact_type, but
    // it was never added to the canonical `artifact_type` enum (migration
    // 0002) — only 10 of the 12 new P1 types landed there; `enrollment_brief`
    // and `call_preparation_brief` are absent. Rather than invent a new enum
    // member out of scope for this slice (mirrors the `fos.smoke` precedent),
    // `call_brief` (the closest-fit existing P0 base member — a founder
    // review document) is used. `domain: "enrollment"` is an exact fit.
    artifactType: "call_brief",
    domain: "enrollment",
    buildTitle: (input) => `Enrollment Brief: ${input.person.firstName} ${input.person.lastName}`,
    buildBodyMarkdown: (input, output) =>
      [
        `# Enrollment Brief: ${input.person.firstName} ${input.person.lastName}`,
        "",
        `**Readiness:** ${output.readiness} | **Fit:** ${output.fitStatus} (${output.fitConfidence} confidence)`,
        `**Recommended pathway:** ${output.recommendedPathway}`,
        "",
        "## Candidate summary",
        output.candidateSummary,
        "",
        "## Observed facts",
        ...output.observedFacts.map((f) => `- ${f.statement} _(source: ${f.sourceRef})_`),
        "",
        "## Inferences (labeled, not facts)",
        ...output.inferences.map((i) => `- ${i.statement} _(confidence: ${i.confidence})_`),
        "",
        "## Fit rationale",
        output.fitRationale,
        "",
        "## Objections",
        ...(output.objections.length ? output.objections.map((o) => `- ${o}`) : ["- none noted"]),
        "",
        "## Discovery questions",
        ...(output.discoveryQuestions.length
          ? output.discoveryQuestions.map((q) => `- ${q}`)
          : ["- none noted"]),
        "",
        "## Risk flags",
        ...(output.riskFlags.length ? output.riskFlags.map((r) => `- ${r}`) : ["- none noted"]),
        "",
        "## Unknowns",
        ...(output.unknowns.length ? output.unknowns.map((u) => `- ${u}`) : ["- none noted"]),
        "",
        "## Next action",
        output.nextAction,
      ].join("\n"),
    buildClaimsManifest: (_input, output) => ({
      // Internal evidence-audit aid: every sourceRef this brief actually
      // cited, so a reviewer can spot-check grounding without re-deriving it.
      observedFactSourceRefs: output.observedFacts.map((f) => f.sourceRef),
    }),
  },
  // Stage 9b (canonical): persists the versioned EnrollmentAssessment (spec
  // §6.4). A failure here fails the run — this is the agent's own domain
  // record, not a best-effort external side effect.
  persistDomain: async ({ deps, runContext, agentRunId }, input, output) => {
    // Defense-in-depth: the assessment is canonical state — verify the target
    // opportunity belongs to this run's workspace before writing it.
    await loadOwnedOpportunity(deps.db, input.opportunity.id, runContext.workspaceId);
    await recordEnrollmentAssessment(deps.db, {
      opportunityId: input.opportunity.id,
      agentRunId,
      observedFactsJson: output.observedFacts,
      inferencesJson: output.inferences,
      fitStatus: output.fitStatus,
      fitConfidence: output.fitConfidence,
      fitRationale: output.fitRationale,
      recommendedPathway: output.recommendedPathway,
      unknownsJson: output.unknowns,
      riskFlagsJson: output.riskFlags,
    });
  },
  // Stage 11 (isolated, non-canonical): the FIRST real `projectOpportunity`
  // use (issue #50's stage-11 seam, previously only exercised by test-only
  // definitions). Re-reads the FULL canonical opportunity row from `deps.db`
  // rather than trusting `input.opportunity` (which is deliberately
  // least-privilege / model-visible only) — the projection never depends on
  // anything the model saw or produced.
  projection: async ({ deps, runContext }, input) => {
    if (!deps.notionClient) {
      throw new Error("fos.enrollment_brief projection requires a notionClient dependency");
    }
    // Re-read the FULL canonical opportunity + assert workspace ownership
    // (never trust the least-privilege `input.opportunity` across tenants).
    const opportunityRow = await loadOwnedOpportunity(
      deps.db,
      input.opportunity.id,
      runContext.workspaceId,
    );
    // FLAG: env var read directly here (mirrors apps/api's notion webhook
    // route) rather than threaded through RunAgentDeps/RunAgentContext — no
    // per-agent config-injection seam exists on the runtime yet.
    const dataSourceId = process.env.FOS_NOTION_ENROLLMENT_DATA_SOURCE_ID ?? "";
    await projectOpportunity(deps.db, deps.notionClient, {
      opportunity: opportunityRow,
      dataSourceId,
    });
  },
};
