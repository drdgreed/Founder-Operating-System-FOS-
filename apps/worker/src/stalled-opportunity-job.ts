import { and, asc, eq, gt, inArray } from "drizzle-orm";
import {
  enrollmentActionRecommendation,
  enrollmentOpportunity,
  interaction,
  person,
} from "@fos/db/schema";
import { OPPORTUNITY_TRANSITIONS, type OpportunityStage } from "@fos/db/services";
import {
  fosNextBestActionAgentDefinition,
  runAgent,
  type NextBestActionInput,
  type RunAgentContext,
  type RunAgentDeps,
  type RunAgentResult,
} from "@fos/agents";

/**
 * `runStalledOpportunityJob` (P1.4e, spec §9.3 / §11 `detect-stalled-opportunities`)
 * — the FIRST `apps/worker` background job. A pure, dependency-injected
 * function a scheduler/cron invokes (the scheduling/cron wiring itself is
 * DEPLOYMENT and OUT OF SCOPE, FLAG). It:
 *
 *   1. DETECTS stalled opportunities in ONE workspace (deterministic, see
 *      `isStalled`), and
 *   2. for each, invokes the already-gated `fos.next_best_action` agent
 *      (`runAgent`) which writes ONE `EnrollmentActionRecommendation` +
 *      an `internal_note` artifact routed to founder review.
 *
 * FOUR hard properties (§9.3 invariant + the 3-layer gate):
 *
 * 1. NEVER CONTACTS AUTOMATICALLY. This job has NO send/execute/publish path
 *    — no email/SMS/HTTP/command anywhere. It only READS canonical rows and
 *    delegates to `runAgent`, whose own eight deterministic gates produce a
 *    review-routed recommendation, never a contact. Proven by absence + the
 *    `FOS1-STALLED-nevercontacts` test (only recommendation rows + in_review/
 *    draft artifacts; zero interaction rows; zero approval auto-decisions).
 *
 * 2. IDEMPOTENT re-run. `isStalled` excludes any opportunity that already has
 *    an OPEN recommendation (`OPEN_RECOMMENDATION_STATUSES`). The first run
 *    writes a `proposed` recommendation; the second run therefore no longer
 *    detects that opportunity and writes ZERO new rows (belt-and-suspenders
 *    with the agent's own `noDuplicateTaskGate`). Proven by the two-run
 *    `FOS1-STALLED-idempotent` test.
 *
 * 3. WORKSPACE-SCOPED / tenant-safe. Every read is filtered by `workspaceId`
 *    (opportunity, person, recommendation, interaction), and the agent's own
 *    `loadOwnedOpportunity` re-asserts ownership at the write seam. An
 *    opportunity in another workspace is never read or touched. Proven by
 *    `FOS1-STALLED-workspacescoped`.
 *
 * 4. DETERMINISTIC DETECTION. `isStalled` is a pure conjunction of five
 *    deterministic checks over caller-supplied `now` + config (the job never
 *    calls `Date.now()`/`new Date()` for the clock). One negative test per
 *    condition proves a non-stalled opportunity is not flagged.
 *
 * FLAG (mirrors the #60/#68/#78 least-privilege precedent): NO stage-age,
 * cooldown, consent, offer, or action-by-stage registry is seeded. The caller
 * supplies ALL of them as least-privilege `StalledOpportunityJobConfig` — the
 * job never performs a live registry/service lookup.
 *
 * FLAG (issue #84 step 3, DEFERRED): the §9.3 "where appropriate, a recovery
 * artifact" branch (invoke `fos.personalized_follow_up` for a no-show /
 * unresponsive opportunity → a recovery DRAFT) is a bounded follow-on — see
 * the PR body. Wiring it in cleanly requires a second least-privilege config
 * surface (approvedClaims, availableCTAs, evidenceRecords, capabilities) plus
 * a no-show/unresponsive detection signal; it is not shipped half-done here.
 */

/** A recommendation in one of these statuses is "open/pending" — the
 * opportunity already has an active recommended action, so re-recommending is
 * both redundant and the idempotency guard. `dismissed`/`actioned`/`expired`
 * are resolved and do NOT block a fresh recommendation. (Statuses are the
 * `enrollment_action_recommendation_status_valid` CHECK set.) */
export const OPEN_RECOMMENDATION_STATUSES = ["proposed", "accepted"] as const;

/** A stage with NO outgoing edges in the canonical state machine (§12.1) is
 * terminal — reused from `OPPORTUNITY_TRANSITIONS` rather than re-listed. */
function isTerminalStage(stage: OpportunityStage): boolean {
  return OPPORTUNITY_TRANSITIONS[stage].length === 0;
}

/** Caller-provided, least-privilege configuration (see the file-header FLAG).
 * Nothing here is looked up live inside the job. */
export interface StalledOpportunityJobConfig {
  /** Per-stage maximum age (milliseconds) before an opportunity is stage-age
   * stalled. The reference instant is `last_interaction_at ?? created_at`. A
   * stage ABSENT from this map has NO policy and is therefore NEVER
   * stage-age stalled (least-privilege: no policy → no action). */
  stageAgeThresholdMs: Partial<Record<OpportunityStage, number>>;
  /** OPTION-B consent allowlist forwarded to the agent's `consentGate`. */
  consentedChannels: NextBestActionInput["consentedChannels"];
  /** Currently-available offers/pathways forwarded to `offerAvailableGate`. */
  availableOffers: NextBestActionInput["availableOffers"];
  /** DERIVED action-type/stage-legality table forwarded to `lifecycleLegalGate`. */
  allowedActionsByStage: NextBestActionInput["allowedActionsByStage"];
  /** Active contact cooldown (ISO-8601), keyed by opportunity id. An entry
   * absent (or `null`) means no cooldown is in effect for that opportunity.
   * FLAG: cooldown timing is not looked up live — caller-provided. */
  cooldownUntilByOpportunityId?: Readonly<Record<string, string | null>>;
}

export interface RunStalledOpportunityJobParams {
  workspaceId: string;
  /** ISO-8601 "now" reference. Deterministic: the job never reads the wall
   * clock itself — the caller (scheduler) supplies the instant. */
  now: string;
  config: StalledOpportunityJobConfig;
}

/** Per-opportunity outcome of the agent invocation. */
export interface StalledOpportunityRunOutcome {
  opportunityId: string;
  runId: string;
  status: RunAgentResult["status"];
}

export interface RunStalledOpportunityJobResult {
  workspaceId: string;
  /** Every opportunity considered (the workspace's full opportunity set). */
  evaluatedCount: number;
  /** The opportunities detected as stalled, in deterministic order. */
  stalledOpportunityIds: string[];
  /** One entry per stalled opportunity the agent was invoked for. */
  runs: StalledOpportunityRunOutcome[];
}

/** Runtime dependencies — REUSES the agent runtime's `RunAgentDeps` (the #1
 * safety property: `modelClient` is REQUIRED and injected, so no worker run can
 * reach a real Anthropic call in a test). */
export type StalledOpportunityJobDeps = RunAgentDeps;

/** Identity recorded on the agent run / audit events this job triggers. A
 * scheduled system job — `type: "system"` per the `EventActor` vocabulary. */
const WORKER_ACTOR = { type: "system", id: "fos.stalled_opportunity_worker" } as const;

/** Trigger label — mirrors the §11 background-job name. */
const WORKER_TRIGGER = { type: "cron", source: "detect-stalled-opportunities" } as const;

type OpportunityRow = typeof enrollmentOpportunity.$inferSelect;

/**
 * Deterministic stall predicate (hard property #4). ALL five conditions must
 * hold. Every input is either the opportunity row, the caller-supplied `now`,
 * caller config, or a workspace-scoped existence query — never the wall clock.
 */
async function isStalled(
  db: StalledOpportunityJobDeps["db"],
  opp: OpportunityRow,
  nowMs: number,
  config: StalledOpportunityJobConfig,
): Promise<boolean> {
  const stage = opp.stage as OpportunityStage;

  // (e) NOT terminal.
  if (isTerminalStage(stage)) return false;

  // (a) stage-age past the caller's per-stage threshold. No policy → never
  // stalled (least-privilege).
  const thresholdMs = config.stageAgeThresholdMs[stage];
  if (thresholdMs === undefined) return false;
  const referenceAt = opp.lastInteractionAt ?? opp.createdAt;
  const ageMs = nowMs - referenceAt.getTime();
  if (ageMs <= thresholdMs) return false;

  // (b) NOT in an active contact cooldown.
  const cooldownUntil = config.cooldownUntilByOpportunityId?.[opp.id] ?? null;
  if (cooldownUntil !== null && new Date(cooldownUntil).getTime() > nowMs) return false;

  // (c) NO pending open recommendation (also the idempotency guard, prop #2).
  const [openRec] = await db
    .select({ id: enrollmentActionRecommendation.id })
    .from(enrollmentActionRecommendation)
    .where(
      and(
        eq(enrollmentActionRecommendation.workspaceId, opp.workspaceId),
        eq(enrollmentActionRecommendation.opportunityId, opp.id),
        inArray(enrollmentActionRecommendation.status, [...OPEN_RECOMMENDATION_STATUSES]),
      ),
    )
    .limit(1);
  if (openRec) return false;

  // (d) NO scheduled FUTURE interaction (scheduled_at > now).
  const [futureInteraction] = await db
    .select({ id: interaction.id })
    .from(interaction)
    .where(
      and(
        eq(interaction.workspaceId, opp.workspaceId),
        eq(interaction.opportunityId, opp.id),
        eq(interaction.status, "scheduled"),
        gt(interaction.scheduledAt, new Date(nowMs)),
      ),
    )
    .limit(1);
  if (futureInteraction) return false;

  return true;
}

/**
 * Assembles the least-privilege `fos.next_best_action` input from the
 * opportunity's canonical context + caller config. `existingOpenActions` and
 * `scheduledActivities` are empty by construction: `isStalled` already excludes
 * any opportunity with an open recommendation or a scheduled future interaction,
 * so the agent's own duplicate/conflict gates have nothing left to find here
 * (they remain the belt-and-suspenders enforcement layer).
 */
function buildNextBestActionInput(
  opp: OpportunityRow,
  personRow: typeof person.$inferSelect,
  params: RunStalledOpportunityJobParams,
): NextBestActionInput {
  return {
    opportunity: {
      id: opp.id,
      stage: opp.stage as NextBestActionInput["opportunity"]["stage"],
      primaryGoal: opp.primaryGoal ?? undefined,
      targetRole: opp.targetRole ?? undefined,
      targetTimeline: opp.targetTimeline ?? undefined,
    },
    person: {
      id: personRow.id,
      firstName: personRow.firstName,
      lastName: personRow.lastName,
      currentRole: personRow.currentRole ?? undefined,
      currentCompany: personRow.currentCompany ?? undefined,
      location: personRow.location ?? undefined,
    },
    consentedChannels: params.config.consentedChannels,
    now: params.now,
    cooldownUntil: params.config.cooldownUntilByOpportunityId?.[opp.id] ?? null,
    existingOpenActions: [],
    scheduledActivities: [],
    availableOffers: params.config.availableOffers,
    allowedActionsByStage: params.config.allowedActionsByStage,
  };
}

/**
 * See the file header for the four hard properties and the FLAGs. Detection is
 * workspace-scoped and deterministic; every stalled opportunity is handed to
 * `runAgent` (no contact, review-routed recommendation only).
 */
export async function runStalledOpportunityJob(
  deps: StalledOpportunityJobDeps,
  params: RunStalledOpportunityJobParams,
): Promise<RunStalledOpportunityJobResult> {
  const nowMs = new Date(params.now).getTime();
  if (Number.isNaN(nowMs)) {
    throw new Error(
      `runStalledOpportunityJob: params.now is not a valid ISO-8601 date: ${params.now}`,
    );
  }

  // Workspace-scoped, deterministically ordered (created_at, id) so a re-run
  // evaluates opportunities in a stable sequence.
  const opportunities = await deps.db
    .select()
    .from(enrollmentOpportunity)
    .where(eq(enrollmentOpportunity.workspaceId, params.workspaceId))
    .orderBy(asc(enrollmentOpportunity.createdAt), asc(enrollmentOpportunity.id));

  const stalledOpportunityIds: string[] = [];
  const runs: StalledOpportunityRunOutcome[] = [];

  for (const opp of opportunities) {
    if (!(await isStalled(deps.db, opp, nowMs, params.config))) continue;
    stalledOpportunityIds.push(opp.id);

    // Person is loaded workspace-scoped too (defense in depth): the FK
    // guarantees existence, but the extra workspace filter refuses to read a
    // person outside this tenant even under a corrupted FK.
    const [personRow] = await deps.db
      .select()
      .from(person)
      .where(and(eq(person.id, opp.personId), eq(person.workspaceId, params.workspaceId)))
      .limit(1);
    if (!personRow) {
      throw new Error(
        `runStalledOpportunityJob: person ${opp.personId} for opportunity ${opp.id} not found in workspace ${params.workspaceId}`,
      );
    }

    const runContext: RunAgentContext = {
      workspaceId: params.workspaceId,
      productId: opp.productId,
      actor: WORKER_ACTOR,
      trigger: WORKER_TRIGGER,
    };

    const result = await runAgent(
      deps,
      fosNextBestActionAgentDefinition,
      buildNextBestActionInput(opp, personRow, params),
      runContext,
    );
    runs.push({ opportunityId: opp.id, runId: result.runId, status: result.status });
  }

  return {
    workspaceId: params.workspaceId,
    evaluatedCount: opportunities.length,
    stalledOpportunityIds,
    runs,
  };
}
