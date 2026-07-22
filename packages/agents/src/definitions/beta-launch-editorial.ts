import { z } from "zod";
import type { ArtifactType } from "@fos/db/schema";
import { claimsInApprovedSetGate } from "../gates/claims-in-approved-set.js";
import { featureModeAllowedGate } from "../gates/feature-mode-allowed.js";
import type { Gate } from "../gates/gate.js";
import type { AgentDefinition } from "../types.js";

/**
 * `fos.beta_launch_editorial` (issue #97, spec §8.7) — the Beta Launch
 * Editorial Agent, and the FIRST campaign-scoped agent on the P1 runtime
 * (every prior agent was enrollment/opportunity-scoped). Spec §8.7: "Given an
 * approved campaign source brief, produces an ordered asset plan across
 * LinkedIn, Substack, email, webinar, and landing page. It may create
 * artifacts but may not publish." Workflow §9.4 step 2 ("Editorial Agent
 * creates channel plan").
 *
 * SCOPE (mirrors the P1.4 agent slices' boundary): this builds ONLY the agent
 * definition on the existing 12-stage runtime — the ordered-asset-PLAN
 * artifact. It does NOT build the campaign workflow orchestration/queueing,
 * the Substack Cornerstone agent (§8.8 / §9.4 step 3), the derivative-asset
 * generation (§9.4 step 4), or the per-channel asset artifacts themselves
 * (linkedin_post, substack_paper, …) — those are later slices. The plan
 * ENUMERATES the assets to create; it does not create them.
 *
 * MAY-NOT-PUBLISH INVARIANT (spec §8.7, §12 "External send and publication
 * remain separate explicit actions"). Enforced by construction, defense in
 * depth:
 *   1. `permittedTools: []` — no publish/HTTP/command capability exists.
 *   2. `autonomyCeiling: "review"` + `featureModeAllowedGate` allow ONLY
 *      `shadow`/`review` — `live` (the reserved would-be-execution mode) is
 *      blocked both by the ceiling (mode.ts `effectiveMode` caps it) AND by
 *      the gate re-check. There is no publish path in ANY mode regardless.
 *   3. NO `projection` hook — the ONLY external-side-effect seam the runtime
 *      offers (stage 11) is absent, so nothing external is ever invoked.
 *   4. The created plan artifact is routed to a PRE-PUBLICATION approval state
 *      ONLY: `draft` in shadow mode, `in_review` in review mode (stage 10) —
 *      NEVER `approved`/`ready_for_action`/`executed`, and the runtime never
 *      auto-decides an approval (that is a founder action). Publication is a
 *      later, separate, explicit `Mark artifact published` command (§7.3).
 *
 * ARTIFACT-ONLY, NO OWNERSHIP SEAM (unlike the opportunity-scoped agents):
 * there is no `persistDomain`. Spec §6 defines no AssetPlan/Campaign domain
 * entity, so there is no domain record to write, and there is no
 * caller-supplied opportunity id to re-assert. The approved source brief is
 * taken as least-privilege INLINE content (`sourceBrief.content`, UNTRUSTED —
 * §12 posture) that the model reasons over; its `artifactRef` is carried for
 * provenance but is NOT dereferenced from the DB in this slice, so there is no
 * confused-deputy cross-workspace read to guard here. The plan artifact is
 * created under `runContext.workspaceId` by the runtime.
 *
 * FLAG (issue #97, §6 gap): no seeded Campaign entity, no source-brief
 * dereference, and no ownership assertion — dereferencing the source-brief
 * artifact (+ its workspace-ownership check) and joining the plan to a
 * canonical Campaign row belong to the campaign-workflow slice (§9.4), not
 * this agent-definition slice. `sourceBrief.content` and `authorizedChannels`
 * are least-privilege caller-provided input (the same convention every prior
 * P1 agent used for its un-seeded registries), never live lookups.
 *
 * FLAG (issue #97, §7.1 gap): spec §7.1 names no dedicated asset-plan /
 * channel-plan artifact type, and the slice boundary forbids adding an
 * `artifact_type` enum value. `internal_note` (the same closest-fit founder-
 * review stopgap `next-best-action.ts`/`objection-intelligence.ts` use) is the
 * plan artifact's type; `domain: "marketing"` (the "Beta Launch Campaign"
 * §7.2 collection) is an exact fit. The per-channel asset TYPES the plan
 * ENUMERATES (`CAMPAIGN_ASSET_TYPES` below) are all already-canonical enum
 * members — but this slice does not create those artifacts.
 *
 * SECURITY-SENSITIVE (ADR-07 D7/D9): the model plans; the deterministic gates
 * enforce. Untrusted source-brief content reaches the model ONLY via
 * `sourceBrief.content` (opaque data) — the gates only ever see the Zod-
 * validated `input`/`output`, never raw text, so injected content can change
 * what the model PLANS but never what the GATES, MODE, or APPROVAL routing
 * decide.
 */

// ---- Channels & asset types (closed enums) ---------------------------------

/** The five launch channels spec §8.7 fixes, as a CLOSED enum. The model can
 * never plan an asset on a channel outside this set. */
export const CAMPAIGN_CHANNELS = [
  "linkedin",
  "substack",
  "email",
  "webinar",
  "landing_page",
] as const;

export type CampaignChannel = (typeof CAMPAIGN_CHANNELS)[number];

/** The downstream per-channel asset types a plan entry may target — ALL
 * already in the canonical `artifact_type` enum (no migration; this slice
 * creates none of them). Declared `satisfies ArtifactType[]` so a typo can
 * never diverge from the DB enum. A closed enum, NOT free text — the plan
 * grounds each asset to a concrete downstream artifact type the founder will
 * later approve and generate. */
export const CAMPAIGN_ASSET_TYPES = [
  "linkedin_post",
  "linkedin_carousel_script",
  "substack_paper",
  "email_sequence",
  "newsletter",
  "webinar_package",
  "landing_page_copy",
] as const satisfies ArtifactType[];

export type CampaignAssetType = (typeof CAMPAIGN_ASSET_TYPES)[number];

// ---- Input (stage 1/3): least-privilege campaign context -------------------

export const betaLaunchEditorialInputSchema = z.object({
  campaign: z.object({
    /** Provenance id for the campaign this plan belongs to (NOT dereferenced
     * in this slice — see file header FLAG). */
    id: z.string().uuid(),
    /** The campaign's objective (context the model plans toward). */
    objective: z.string().min(1),
    /** The target audience description. */
    audience: z.string().min(1),
    /** The offer being launched. */
    offer: z.string().min(1),
  }),
  /** The APPROVED campaign source brief this plan is derived from. */
  sourceBrief: z.object({
    /** Provenance ref to the `beta_launch_source_brief` artifact (§7.1). Carried
     * for audit; NOT dereferenced from the DB in this slice (file header FLAG). */
    artifactRef: z.string().min(1),
    /** The approved brief content the model reasons over. UNTRUSTED (spec §12
     * posture): passed as data, NEVER interpreted as instructions. */
    content: z.string().min(1),
  }),
  /** The channels the founder has AUTHORIZED for this campaign — a
   * caller-provided allowlist (a campaign need not use all five). Every
   * planned asset's channel MUST be in this set (`channels-authorized` gate).
   * FLAG: least-privilege caller input, not a live campaign-config lookup. */
  authorizedChannels: z.array(z.enum(CAMPAIGN_CHANNELS)).min(1),
});

export type BetaLaunchEditorialInput = z.infer<typeof betaLaunchEditorialInputSchema>;

// ---- Output (stage 6): the ORDERED asset plan ------------------------------

const plannedAssetSchema = z.object({
  /** 1-based position in the launch sequence. Ordering invariant (the
   * `contiguous-asset-order` deterministic gate below): across all assets the
   * `order` values MUST be exactly `1..N` — a true total order with no gaps or
   * duplicates. Enforced by a gate rather than a Zod `superRefine` because the
   * runtime's minimal Zod->JSON-Schema converter (schema-to-json.ts) does not
   * support `ZodEffects`; keeping the output schema a plain object also keeps
   * stage-6 validation and the JSON schema the model sees in lockstep. A
   * model-authored NUMBER, not free text, so it carries no guarantee prose. */
  order: z.number().int().min(1),
  /** CLOSED enum — one of the five launch channels. */
  channel: z.enum(CAMPAIGN_CHANNELS),
  /** CLOSED enum — the downstream artifact type this asset will become. */
  assetType: z.enum(CAMPAIGN_ASSET_TYPES),
  /** The working title of the planned asset. Model free text — SCANNED. */
  title: z.string().min(1),
  /** Why this asset exists / what it must accomplish (its brief). Model free
   * text — SCANNED. */
  purpose: z.string().min(1),
});

export type PlannedAsset = z.infer<typeof plannedAssetSchema>;

export const betaLaunchEditorialOutputSchema = z.object({
  /** One-paragraph overview of the campaign plan for founder review. Model
   * free text — SCANNED. */
  planSummary: z.string().min(1),
  /** Why the assets are ordered as they are (the launch narrative). Model
   * free text — SCANNED. */
  sequencingRationale: z.string().min(1),
  /** The ordered list of planned assets (at least one). The `order` values are
   * a contiguous 1..N permutation — enforced by `contiguousAssetOrderGate`. */
  assets: z.array(plannedAssetSchema).min(1),
});

export type BetaLaunchEditorialOutput = z.infer<typeof betaLaunchEditorialOutputSchema>;

/** Deterministic ordering gate: the assets' `order` values MUST form a
 * contiguous `1..N` sequence (no gaps, no duplicates) — a true total order.
 * Local to this agent (a one-off invariant, not a reusable library gate), so
 * it is a plain `Gate` object rather than a gate factory. Reads only the
 * Zod-validated output (D9): not steerable by untrusted brief content. */
export const contiguousAssetOrderGate: Gate<BetaLaunchEditorialInput, BetaLaunchEditorialOutput> = {
  key: "fos.beta_launch_editorial.contiguous-asset-order",
  evaluate: ({ output }) => {
    const orders = [...output.assets.map((a) => a.order)].sort((a, b) => a - b);
    const isContiguous = orders.every((o, i) => o === i + 1);
    return isContiguous
      ? { allowed: true }
      : {
          allowed: false,
          reason: `asset "order" values must be a contiguous 1..${orders.length} sequence with no gaps or duplicates`,
        };
  },
};

/** Returns the plan's assets sorted by their 1-based `order`. `contiguousAssetOrderGate`
 * (stage 7) guarantees a total 1..N order before any renderer/manifest (stage 9/10)
 * calls this, so the founder-facing surfaces always present the true launch sequence. */
function orderedAssets(output: BetaLaunchEditorialOutput): PlannedAsset[] {
  return [...output.assets].sort((a, b) => a.order - b.order);
}

// ---- Definition ------------------------------------------------------------

export const FOS_BETA_LAUNCH_EDITORIAL_AGENT_KEY = "fos.beta_launch_editorial";
export const FOS_BETA_LAUNCH_EDITORIAL_FEATURE_FLAG_KEY = "fos.beta_launch_editorial";

export const fosBetaLaunchEditorialAgentDefinition: AgentDefinition<
  BetaLaunchEditorialInput,
  BetaLaunchEditorialOutput
> = {
  key: FOS_BETA_LAUNCH_EDITORIAL_AGENT_KEY,
  version: "1.0.0",
  objective:
    "Given an approved beta-launch campaign source brief, produce an ORDERED asset plan across " +
    "the authorized launch channels (LinkedIn, Substack, email, webinar, landing page): for each " +
    "planned asset a channel, a downstream asset type, a working title, and its purpose, plus a " +
    "plan summary and a sequencing rationale. Plan only on channels the founder authorized. This " +
    "CREATES a plan artifact for founder review — it NEVER publishes — and NEVER guarantees an " +
    "employment, recruiter, salary, or interview outcome.",
  inputSchema: betaLaunchEditorialInputSchema,
  outputSchema: betaLaunchEditorialOutputSchema,
  // NO tools: this agent has no publish/command/HTTP capability by construction
  // (may-not-publish invariant, file header point 1).
  permittedTools: [],
  permittedMemoryScopes: ["campaign", "beta_launch_source_brief"],
  autonomyCeiling: "review",
  featureFlagKey: FOS_BETA_LAUNCH_EDITORIAL_FEATURE_FLAG_KEY,
  deterministicGates: [
    featureModeAllowedGate({
      key: "fos.beta_launch_editorial.mode-allowed",
      // shadow/review ONLY — `live` (would-be execution) is never permitted
      // (may-not-publish invariant, file header point 2).
      allowedModes: ["shadow", "review"],
    }),
    // Every planned asset's channel must be in the founder-authorized set — the
    // SAME subset-membership shape as claims-in-approved-set (REUSE, not a new
    // gate): a model can never plan an asset on a channel the founder excluded
    // from this campaign (§12 "planned features cannot be described as
    // available" spirit — a plan cannot reach into an unauthorized channel).
    claimsInApprovedSetGate<BetaLaunchEditorialInput, BetaLaunchEditorialOutput>({
      key: "fos.beta_launch_editorial.channels-authorized",
      selectClaims: (output) => output.assets.map((a) => a.channel),
      selectApprovedClaims: (input) => input.authorizedChannels,
    }),
    // The plan is ORDERED: the assets' `order` values must be a contiguous
    // 1..N permutation (see `contiguousAssetOrderGate`).
    contiguousAssetOrderGate,
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
    // guarantee leak.
    //
    //   input.campaign.objective/audience/offer → (i) input-derived
    //   input.sourceBrief.*                      → (i) input-derived (untrusted
    //                                              data; not rendered raw)
    //   output.planSummary                       → (iv) SCANNED
    //   output.sequencingRationale               → (iv) SCANNED
    //   output.assets[].order                    → model NUMBER, not free text;
    //                                              STRUCTURAL (Zod int +
    //                                              contiguousAssetOrderGate 1..N
    //                                              permutation) — no prose smuggled in
    //   output.assets[].channel                  → (ii) closed enum
    //                                              CAMPAIGN_CHANNELS + (iii)
    //                                              channels-authorized gate
    //   output.assets[].assetType                → (ii) closed enum
    //                                              CAMPAIGN_ASSET_TYPES
    //   output.assets[].title                    → (iv) SCANNED
    //   output.assets[].purpose                  → (iv) SCANNED
    // `buildClaimsManifest` persists ONLY closed-enum values (channels,
    // assetTypes) + counts — no NEW model free-text sink beyond what is
    // already scanned above.
    // ============================================================
  ],
  // Stage-7b semantic compliance review (Option C slice 2, issue #109) — the
  // eval-validated guarantee classifier replaces the removed keyword gate. Same
  // fields the old gate's `selectText` scanned (see the mechanical enumeration
  // above) — keep in sync with `buildBodyMarkdown`.
  complianceReviewText: (output) => [
    output.planSummary,
    output.sequencingRationale,
    ...output.assets.map((a) => a.title),
    ...output.assets.map((a) => a.purpose),
  ],
  artifact: {
    // FLAG (§7.1 gap): no dedicated asset-plan artifact type; `internal_note`
    // is the closest-fit founder-review stopgap (next-best-action.ts /
    // objection-intelligence.ts precedent). `domain: "marketing"` = the "Beta
    // Launch Campaign" §7.2 collection. NO enum value added (slice boundary).
    artifactType: "internal_note",
    domain: "marketing",
    buildTitle: (input) => `Beta Launch Plan: ${input.campaign.objective}`,
    buildBodyMarkdown: (input, output) =>
      [
        `# Beta Launch Plan: ${input.campaign.objective}`,
        "",
        `**Audience:** ${input.campaign.audience}`,
        `**Offer:** ${input.campaign.offer}`,
        `**Authorized channels:** ${input.authorizedChannels.join(", ")}`,
        `**Source brief:** ${input.sourceBrief.artifactRef}`,
        "",
        "## Plan summary",
        output.planSummary,
        "",
        "## Sequencing rationale",
        output.sequencingRationale,
        "",
        "## Ordered asset plan",
        ...orderedAssets(output).map(
          (a) => `${a.order}. **[${a.channel} / ${a.assetType}]** ${a.title} — ${a.purpose}`,
        ),
      ].join("\n"),
    buildClaimsManifest: (_input, output) => {
      // Internal audit aid: the distinct channels/asset types this plan spans
      // and how many assets it enumerates — so a reviewer can spot-check the
      // plan's coverage without re-deriving it. ONLY closed-enum values +
      // counts are persisted here (no new model free-text scan surface).
      const ordered = orderedAssets(output);
      return {
        channels: [...new Set(ordered.map((a) => a.channel))],
        assetTypes: [...new Set(ordered.map((a) => a.assetType))],
        assetCount: ordered.length,
      };
    },
  },
  // NO `persistDomain` (no domain entity, no opportunity to own — file header)
  // and NO `projection` (no external side effect / no publish path — may-not-
  // publish invariant, file header point 3).
};
