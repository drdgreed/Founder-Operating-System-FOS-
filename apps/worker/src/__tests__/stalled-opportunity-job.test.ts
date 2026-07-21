import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  approval,
  artifactRecord,
  artifactVersion,
  enrollmentActionRecommendation,
  interaction,
} from "@fos/db/schema";
import {
  FOS_NEXT_BEST_ACTION_FEATURE_FLAG_KEY,
  type NextBestActionInput,
  type NextBestActionOutput,
} from "@fos/agents";
import { createActionRecommendation, createInteraction } from "@fos/db/services";
import { FakeModelClient, validResult } from "./fake-model-client.js";
import {
  runStalledOpportunityJob,
  type StalledOpportunityJobConfig,
} from "../stalled-opportunity-job.js";
import { createTestDb, seedStalledFixture, seedWorkspace, setFeatureFlag } from "./test-db.js";

// A deterministic "now"; every fixture's default last_interaction_at
// (2026-01-01) is 9 days behind this, well past the 3-day stalled thresholds
// below.
const NOW = "2026-01-10T00:00:00.000Z";
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

const ALLOWED_ACTIONS_BY_STAGE: NextBestActionInput["allowedActionsByStage"] = {
  new_lead: [],
  reviewing: [],
  contacted: ["send_follow_up_email", "send_follow_up_sms", "internal_task", "no_action"],
  conversation_scheduled: [],
  conversation_completed: [],
  offered: [],
  enrolled: ["no_action"],
  declined: [],
  deferred: [],
  unresponsive: ["send_follow_up_email", "internal_task", "no_action"],
  disqualified: [],
};

function buildConfig(
  overrides: Partial<StalledOpportunityJobConfig> = {},
): StalledOpportunityJobConfig {
  return {
    // A generous threshold for every non-terminal stage the tests use.
    stageAgeThresholdMs: {
      contacted: THREE_DAYS_MS,
      unresponsive: THREE_DAYS_MS,
      enrolled: THREE_DAYS_MS,
    },
    consentedChannels: ["email"],
    availableOffers: ["cohort-2026-a"],
    allowedActionsByStage: ALLOWED_ACTIONS_BY_STAGE,
    ...overrides,
  };
}

/** A valid, guarantee-free NBA output for the `contacted`-stage happy path. */
function buildNbaOutput(overrides: Partial<NextBestActionOutput> = {}): NextBestActionOutput {
  return {
    actionType: "send_follow_up_email",
    actionTarget: "person-target-1",
    channel: "email",
    offer: "cohort-2026-a",
    summary: "Ada has gone quiet since the last touch; a warm follow-up email is due.",
    rationale:
      "No contact in 9 days and no scheduled activity; a follow-up email keeps momentum without overreaching.",
    businessImpact: "medium",
    urgency: "medium",
    confidence: "high",
    recommendedDueAt: "2026-01-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("runStalledOpportunityJob (issue #84) — detect stalled opps + invoke Next-Best-Action, NEVER contacts", () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    ctx = await createTestDb();
  });
  afterEach(async () => {
    await ctx.close();
  });

  async function enableNba(workspaceId: string, mode: "shadow" | "review" = "review") {
    await setFeatureFlag(ctx.db, {
      workspaceId,
      key: FOS_NEXT_BEST_ACTION_FEATURE_FLAG_KEY,
      enabled: true,
      mode,
    });
  }

  it("FOS1-STALLED-detect: a genuinely stalled opportunity → one recommendation row + in_review artifact", async () => {
    const fx = await seedStalledFixture(ctx.db);
    await enableNba(fx.workspace.id);
    const modelClient = new FakeModelClient([validResult(buildNbaOutput())]);

    const result = await runStalledOpportunityJob(
      { db: ctx.db, modelClient },
      { workspaceId: fx.workspace.id, now: NOW, config: buildConfig() },
    );

    expect(result.stalledOpportunityIds).toEqual([fx.opportunity.id]);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.status).toBe("succeeded");

    const recs = await ctx.db
      .select()
      .from(enrollmentActionRecommendation)
      .where(eq(enrollmentActionRecommendation.opportunityId, fx.opportunity.id));
    expect(recs).toHaveLength(1);
    expect(recs[0]?.actionType).toBe("send_follow_up_email");
    expect(recs[0]?.status).toBe("proposed");

    // The recommendation carries the artifact; the artifact is the review item.
    const artifactId = recs[0]!.artifactRecordId!;
    const [record] = await ctx.db
      .select()
      .from(artifactRecord)
      .where(eq(artifactRecord.id, artifactId));
    expect(record?.artifactType).toBe("internal_note");
    const versions = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.artifactId, artifactId));
    expect(versions).toHaveLength(1);
    expect(versions[0]?.approvalStatus).toBe("in_review");
  });

  it("FOS1-STALLED-cooldown: an opportunity in an ACTIVE contact cooldown is NOT flagged", async () => {
    const fx = await seedStalledFixture(ctx.db);
    await enableNba(fx.workspace.id);
    const modelClient = new FakeModelClient([]); // must never be called

    const result = await runStalledOpportunityJob(
      { db: ctx.db, modelClient },
      {
        workspaceId: fx.workspace.id,
        now: NOW,
        config: buildConfig({
          cooldownUntilByOpportunityId: { [fx.opportunity.id]: "2026-01-15T00:00:00.000Z" },
        }),
      },
    );

    expect(result.stalledOpportunityIds).toEqual([]);
    expect(result.runs).toHaveLength(0);
    expect(await ctx.db.select().from(enrollmentActionRecommendation)).toHaveLength(0);
    expect(modelClient.calls).toHaveLength(0);
  });

  it("FOS1-STALLED-pending-rec: an opportunity with an OPEN recommendation is NOT flagged", async () => {
    const fx = await seedStalledFixture(ctx.db);
    await enableNba(fx.workspace.id);
    await createActionRecommendation(ctx.db, {
      workspaceId: fx.workspace.id,
      opportunityId: fx.opportunity.id,
      actionType: "send_follow_up_email",
      summary: "Already-open recommendation",
      status: "proposed",
    });
    const modelClient = new FakeModelClient([]);

    const result = await runStalledOpportunityJob(
      { db: ctx.db, modelClient },
      { workspaceId: fx.workspace.id, now: NOW, config: buildConfig() },
    );

    expect(result.stalledOpportunityIds).toEqual([]);
    expect(result.runs).toHaveLength(0);
    // Only the pre-seeded recommendation exists; the job created none.
    expect(await ctx.db.select().from(enrollmentActionRecommendation)).toHaveLength(1);
    expect(modelClient.calls).toHaveLength(0);
  });

  it("FOS1-STALLED-scheduled-interaction: an opportunity with a scheduled FUTURE interaction is NOT flagged", async () => {
    const fx = await seedStalledFixture(ctx.db);
    await enableNba(fx.workspace.id);
    await createInteraction(ctx.db, {
      workspaceId: fx.workspace.id,
      opportunityId: fx.opportunity.id,
      interactionType: "discovery_call",
      status: "scheduled",
      scheduledAt: new Date("2026-01-20T00:00:00.000Z"), // after NOW
    });
    const modelClient = new FakeModelClient([]);

    const result = await runStalledOpportunityJob(
      { db: ctx.db, modelClient },
      { workspaceId: fx.workspace.id, now: NOW, config: buildConfig() },
    );

    expect(result.stalledOpportunityIds).toEqual([]);
    expect(result.runs).toHaveLength(0);
    expect(await ctx.db.select().from(enrollmentActionRecommendation)).toHaveLength(0);
    expect(modelClient.calls).toHaveLength(0);
  });

  it("FOS1-STALLED-not-past-age: an opportunity within its stage-age threshold is NOT flagged", async () => {
    // last_interaction_at only 1 day before NOW < the 3-day threshold.
    const fx = await seedStalledFixture(ctx.db, {
      lastInteractionAt: new Date("2026-01-09T00:00:00.000Z"),
    });
    await enableNba(fx.workspace.id);
    const modelClient = new FakeModelClient([]);

    const result = await runStalledOpportunityJob(
      { db: ctx.db, modelClient },
      { workspaceId: fx.workspace.id, now: NOW, config: buildConfig() },
    );

    expect(result.stalledOpportunityIds).toEqual([]);
    expect(result.runs).toHaveLength(0);
    expect(await ctx.db.select().from(enrollmentActionRecommendation)).toHaveLength(0);
    expect(modelClient.calls).toHaveLength(0);
  });

  it("FOS1-STALLED-terminal: a terminal-stage opportunity is NOT flagged (even when stage-age would otherwise stall it)", async () => {
    const fx = await seedStalledFixture(ctx.db, { stage: "enrolled" });
    await enableNba(fx.workspace.id);
    const modelClient = new FakeModelClient([]);

    const result = await runStalledOpportunityJob(
      { db: ctx.db, modelClient },
      { workspaceId: fx.workspace.id, now: NOW, config: buildConfig() },
    );

    expect(result.stalledOpportunityIds).toEqual([]);
    expect(result.runs).toHaveLength(0);
    expect(await ctx.db.select().from(enrollmentActionRecommendation)).toHaveLength(0);
    expect(modelClient.calls).toHaveLength(0);
  });

  it("FOS1-STALLED-nevercontacts: a run produces ONLY recommendation rows + an in_review artifact — zero interactions, zero approval auto-decisions", async () => {
    const fx = await seedStalledFixture(ctx.db);
    await enableNba(fx.workspace.id);
    const modelClient = new FakeModelClient([validResult(buildNbaOutput())]);

    await runStalledOpportunityJob(
      { db: ctx.db, modelClient },
      { workspaceId: fx.workspace.id, now: NOW, config: buildConfig() },
    );

    // The ONLY side effects are canonical review artifacts + one recommendation.
    expect(await ctx.db.select().from(enrollmentActionRecommendation)).toHaveLength(1);
    const versions = await ctx.db.select().from(artifactVersion);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.approvalStatus).toBe("in_review");
    // NEVER CONTACTS: no interaction (a scheduled/sent contact) was created,
    // and no approval decision was auto-recorded (a founder action).
    expect(await ctx.db.select().from(interaction)).toHaveLength(0);
    expect(await ctx.db.select().from(approval)).toHaveLength(0);
  });

  it("FOS1-STALLED-idempotent: a second run over identical state creates ZERO new recommendation rows", async () => {
    const fx = await seedStalledFixture(ctx.db);
    await enableNba(fx.workspace.id);
    // Two scripted results in case the job were (incorrectly) to invoke the
    // agent twice — it must not, so the second stays unconsumed.
    const modelClient = new FakeModelClient([
      validResult(buildNbaOutput()),
      validResult(buildNbaOutput()),
    ]);
    const params = { workspaceId: fx.workspace.id, now: NOW, config: buildConfig() };

    const first = await runStalledOpportunityJob({ db: ctx.db, modelClient }, params);
    expect(first.stalledOpportunityIds).toEqual([fx.opportunity.id]);
    expect(await ctx.db.select().from(enrollmentActionRecommendation)).toHaveLength(1);

    const second = await runStalledOpportunityJob({ db: ctx.db, modelClient }, params);
    // The proposed recommendation from run 1 makes the opportunity no longer
    // stalled — run 2 detects nothing and writes nothing.
    expect(second.stalledOpportunityIds).toEqual([]);
    expect(second.runs).toHaveLength(0);
    expect(await ctx.db.select().from(enrollmentActionRecommendation)).toHaveLength(1);
    // The agent was invoked exactly once across both runs.
    expect(modelClient.calls).toHaveLength(1);
  });

  it("FOS1-STALLED-workspacescoped: a stalled opportunity in ANOTHER workspace is never touched", async () => {
    const mine = await seedStalledFixture(ctx.db);
    const theirsWorkspace = await seedWorkspace(ctx.db);
    const theirs = await seedStalledFixture(ctx.db, { existingWorkspace: theirsWorkspace });
    expect(theirs.workspace.id).not.toBe(mine.workspace.id);
    // Both workspaces have the agent enabled — proving scoping is the JOB's
    // detection, not a missing flag.
    await enableNba(mine.workspace.id);
    await enableNba(theirs.workspace.id);
    const modelClient = new FakeModelClient([validResult(buildNbaOutput())]);

    const result = await runStalledOpportunityJob(
      { db: ctx.db, modelClient },
      { workspaceId: mine.workspace.id, now: NOW, config: buildConfig() },
    );

    expect(result.workspaceId).toBe(mine.workspace.id);
    expect(result.evaluatedCount).toBe(1); // only mine.workspace's opportunity
    expect(result.stalledOpportunityIds).toEqual([mine.opportunity.id]);

    // The OTHER workspace's opportunity got no recommendation at all.
    expect(
      await ctx.db
        .select()
        .from(enrollmentActionRecommendation)
        .where(eq(enrollmentActionRecommendation.workspaceId, theirs.workspace.id)),
    ).toHaveLength(0);
    expect(
      await ctx.db
        .select()
        .from(enrollmentActionRecommendation)
        .where(eq(enrollmentActionRecommendation.workspaceId, mine.workspace.id)),
    ).toHaveLength(1);
  });

  it("FOS1-STALLED-shadow: in shadow mode the recommendation is still written but the artifact stays draft (no founder surfacing)", async () => {
    const fx = await seedStalledFixture(ctx.db);
    await enableNba(fx.workspace.id, "shadow");
    const modelClient = new FakeModelClient([validResult(buildNbaOutput())]);

    const result = await runStalledOpportunityJob(
      { db: ctx.db, modelClient },
      { workspaceId: fx.workspace.id, now: NOW, config: buildConfig() },
    );

    expect(result.runs[0]?.status).toBe("succeeded");
    expect(await ctx.db.select().from(enrollmentActionRecommendation)).toHaveLength(1);
    const versions = await ctx.db.select().from(artifactVersion);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.approvalStatus).toBe("draft");
    expect(await ctx.db.select().from(approval)).toHaveLength(0);
  });

  it("FOS1-STALLED-poison-isolation: one opportunity whose agent run THROWS does NOT abort the batch — a later stalled opp is still processed (issue #84 review)", async () => {
    // Two stalled opps in the SAME workspace. The model client's FIRST call
    // throws; the whole job must NOT abort — the other stalled opp still gets
    // its recommendation, and the failing opp is recorded as `job_error`. Pre-
    // fix, the throw propagated and starved every later stalled opportunity.
    const fx = await seedStalledFixture(ctx.db);
    await seedStalledFixture(ctx.db, { existingWorkspace: fx.workspace });
    await enableNba(fx.workspace.id);
    const modelClient = new FakeModelClient([
      () => {
        throw new Error("simulated model failure");
      },
      validResult(buildNbaOutput()),
    ]);

    const result = await runStalledOpportunityJob(
      { db: ctx.db, modelClient },
      { workspaceId: fx.workspace.id, now: NOW, config: buildConfig() },
    );

    // The job completed (did not propagate the throw) and evaluated BOTH opps.
    expect(result.stalledOpportunityIds).toHaveLength(2);
    expect(result.runs).toHaveLength(2);
    const errored = result.runs.filter((r) => r.status === "job_error");
    const succeeded = result.runs.filter((r) => r.status === "succeeded");
    expect(errored).toHaveLength(1);
    expect(errored[0]?.error).toMatch(/simulated model failure/);
    expect(succeeded).toHaveLength(1);

    // Exactly ONE recommendation was written — for the opp that did NOT throw;
    // the failing opp starved nothing.
    const recs = await ctx.db.select().from(enrollmentActionRecommendation);
    expect(recs).toHaveLength(1);
  });
});
