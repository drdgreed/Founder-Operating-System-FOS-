import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import {
  agentRun,
  approval,
  artifactRecord,
  artifactVersion,
  enrollmentActionRecommendation,
  enrollmentOpportunity,
} from "@fos/db/schema";
import type { Db } from "@fos/db/services";
import type { RunAgentContext } from "../types.js";
import { runAgent } from "../pipeline.js";
import {
  fosNextBestActionAgentDefinition,
  FOS_NEXT_BEST_ACTION_AGENT_KEY,
  FOS_NEXT_BEST_ACTION_FEATURE_FLAG_KEY,
  type NextBestActionInput,
  type NextBestActionOutput,
} from "../definitions/next-best-action.js";
import { createTestDb, seedNextBestActionFixture, setFeatureFlag } from "./test-db.js";
import { FakeModelClient, validResult } from "./fake-model-client.js";

const ACTOR = { type: "agent" as const, id: FOS_NEXT_BEST_ACTION_AGENT_KEY };
const TRIGGER = { type: "cron", source: "stalled-opportunity-workflow" };

type Fixture = Awaited<ReturnType<typeof seedNextBestActionFixture>>;

const ALLOWED_ACTIONS_BY_STAGE = {
  new_lead: [],
  reviewing: [],
  contacted: ["send_follow_up_email", "send_follow_up_sms", "internal_task", "no_action"],
  conversation_scheduled: [],
  conversation_completed: [],
  offered: [],
  enrolled: [],
  declined: [],
  deferred: [],
  unresponsive: [],
  disqualified: [],
};

function buildInput(
  fixture: Fixture,
  overrides: Partial<NextBestActionInput> = {},
): NextBestActionInput {
  return {
    opportunity: {
      id: fixture.opportunity.id,
      stage: fixture.opportunity.stage as NextBestActionInput["opportunity"]["stage"],
      primaryGoal: "Break into data analytics",
      targetRole: "Senior Data Analyst",
      targetTimeline: "3 months",
    },
    person: {
      id: fixture.person.id,
      firstName: fixture.person.firstName,
      lastName: fixture.person.lastName,
      currentRole: fixture.person.currentRole ?? undefined,
      currentCompany: fixture.person.currentCompany ?? undefined,
      location: fixture.person.location ?? undefined,
    },
    consentedChannels: ["email"],
    now: "2026-01-10T00:00:00.000Z",
    cooldownUntil: null,
    existingOpenActions: [],
    scheduledActivities: [],
    availableOffers: ["cohort-2026-a"],
    allowedActionsByStage: ALLOWED_ACTIONS_BY_STAGE,
    ...overrides,
  };
}

function buildOutput(overrides: Partial<NextBestActionOutput> = {}): NextBestActionOutput {
  return {
    actionType: "send_follow_up_email",
    actionTarget: "person-target-1",
    channel: "email",
    offer: "cohort-2026-a",
    summary: "Ada has gone quiet since the last touch; a warm follow-up email is due.",
    rationale:
      "No contact in 5 days and no scheduled activity; a follow-up email keeps momentum without overreaching.",
    businessImpact: "medium",
    urgency: "medium",
    confidence: "high",
    recommendedDueAt: "2026-01-12T00:00:00.000Z",
    ...overrides,
  };
}

async function readOpportunity(db: Db, id: string) {
  const [row] = await db
    .select()
    .from(enrollmentOpportunity)
    .where(eq(enrollmentOpportunity.id, id));
  if (!row) throw new Error(`readOpportunity: opportunity ${id} not found`);
  return row;
}

describe("fos.next_best_action (issue #78) — 8-gated recommendation, atomic single-row write", () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    ctx = await createTestDb();
  });
  afterEach(async () => {
    await ctx.close();
  });

  async function enableFlag(workspaceId: string, mode: "shadow" | "review" = "review") {
    await setFeatureFlag(ctx.db, {
      workspaceId,
      key: FOS_NEXT_BEST_ACTION_FEATURE_FLAG_KEY,
      enabled: true,
      mode,
    });
  }

  it("FOS1-NBA-01: happy path — all 8 gates pass, EnrollmentActionRecommendation row written + internal_note artifact in_review", async () => {
    const fixture = await seedNextBestActionFixture(ctx.db);
    await enableFlag(fixture.workspace.id);
    const modelClient = new FakeModelClient([validResult(buildOutput())]);
    const runContext: RunAgentContext = {
      workspaceId: fixture.workspace.id,
      actor: ACTOR,
      trigger: TRIGGER,
    };

    const result = await runAgent(
      { db: ctx.db, modelClient },
      fosNextBestActionAgentDefinition,
      buildInput(fixture),
      runContext,
    );

    expect(result.status).toBe("succeeded");

    const [version] = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, result.artifact!.versionId));
    expect(version!.approvalStatus).toBe("in_review");

    const [record] = await ctx.db
      .select()
      .from(artifactRecord)
      .where(eq(artifactRecord.id, result.artifact!.artifactId));
    expect(record!.artifactType).toBe("internal_note");
    expect(record!.domain).toBe("enrollment");

    const rows = await ctx.db
      .select()
      .from(enrollmentActionRecommendation)
      .where(eq(enrollmentActionRecommendation.opportunityId, fixture.opportunity.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actionType).toBe("send_follow_up_email");
    expect(rows[0]?.businessImpact).toBe("medium");
    expect(rows[0]?.urgency).toBe("medium");
    expect(rows[0]?.confidence).toBe("high");
    expect(rows[0]?.agentRunId).toBe(result.runId);
    expect(rows[0]?.artifactRecordId).toBe(result.artifact!.artifactId);
    expect(rows[0]?.recommendedDueAt?.toISOString()).toBe("2026-01-12T00:00:00.000Z");
  });

  it("FOS1-NBA-02: consent-not-in-allowlist block — a channel absent from consentedChannels → policy_blocked, ZERO recommendation rows, no artifact", async () => {
    const fixture = await seedNextBestActionFixture(ctx.db);
    await enableFlag(fixture.workspace.id);
    const modelClient = new FakeModelClient([validResult(buildOutput({ channel: "sms" }))]);
    const runContext: RunAgentContext = {
      workspaceId: fixture.workspace.id,
      actor: ACTOR,
      trigger: TRIGGER,
    };

    const result = await runAgent(
      { db: ctx.db, modelClient },
      fosNextBestActionAgentDefinition,
      buildInput(fixture, { consentedChannels: ["email"] }),
      runContext,
    );

    expect(result.status).toBe("policy_blocked");
    expect(result.artifact).toBeUndefined();
    expect(result.gateEvaluations?.some((g) => g.key.endsWith(".consent") && !g.allowed)).toBe(
      true,
    );
    expect(await ctx.db.select().from(enrollmentActionRecommendation)).toHaveLength(0);
    expect(await ctx.db.select().from(artifactRecord)).toHaveLength(0);
  });

  it("FOS1-NBA-03: DECISIVE (option B, fail-closed) — unknown/absent consent BLOCKS a contact action, ZERO recommendation rows, no artifact", async () => {
    const fixture = await seedNextBestActionFixture(ctx.db);
    await enableFlag(fixture.workspace.id);
    const modelClient = new FakeModelClient([validResult(buildOutput({ channel: "email" }))]);
    const runContext: RunAgentContext = {
      workspaceId: fixture.workspace.id,
      actor: ACTOR,
      trigger: TRIGGER,
    };

    // NO consent recorded at all for this run — an empty allowlist must
    // BLOCK the contact, never silently allow it (the headline property of
    // the option-B founder decision).
    const result = await runAgent(
      { db: ctx.db, modelClient },
      fosNextBestActionAgentDefinition,
      buildInput(fixture, { consentedChannels: [] }),
      runContext,
    );

    expect(result.status).toBe("policy_blocked");
    expect(result.artifact).toBeUndefined();
    expect(result.gateEvaluations?.find((g) => g.key.endsWith(".consent"))?.allowed).toBe(false);
    expect(result.gateEvaluations?.find((g) => g.key.endsWith(".consent"))?.reason).toMatch(
      /no recorded consent/,
    );
    expect(await ctx.db.select().from(enrollmentActionRecommendation)).toHaveLength(0);
    expect(await ctx.db.select().from(artifactRecord)).toHaveLength(0);
  });

  it("FOS1-NBA-04: cooldown-active block — a contact proposed before cooldownUntil → policy_blocked, ZERO recommendation rows, no artifact", async () => {
    const fixture = await seedNextBestActionFixture(ctx.db);
    await enableFlag(fixture.workspace.id);
    const modelClient = new FakeModelClient([validResult(buildOutput())]);
    const runContext: RunAgentContext = {
      workspaceId: fixture.workspace.id,
      actor: ACTOR,
      trigger: TRIGGER,
    };

    const result = await runAgent(
      { db: ctx.db, modelClient },
      fosNextBestActionAgentDefinition,
      buildInput(fixture, {
        now: "2026-01-01T00:00:00.000Z",
        cooldownUntil: "2026-01-05T00:00:00.000Z",
      }),
      runContext,
    );

    expect(result.status).toBe("policy_blocked");
    expect(result.artifact).toBeUndefined();
    expect(result.gateEvaluations?.some((g) => g.key.endsWith(".cooldown") && !g.allowed)).toBe(
      true,
    );
    expect(await ctx.db.select().from(enrollmentActionRecommendation)).toHaveLength(0);
    expect(await ctx.db.select().from(artifactRecord)).toHaveLength(0);
  });

  it("FOS1-NBA-05: illegal-lifecycle block — action type not permitted at the current stage → policy_blocked, ZERO recommendation rows, no artifact", async () => {
    const fixture = await seedNextBestActionFixture(ctx.db);
    await enableFlag(fixture.workspace.id);
    // "contacted" only permits send_follow_up_email/send_follow_up_sms/
    // internal_task/no_action in ALLOWED_ACTIONS_BY_STAGE — propose_offer
    // has no implied stage here, so it falls through to the table lookup
    // and is blocked. propose_offer is a DERIVED contact action (issue #78),
    // so it is given a consented channel ("email" is in the default
    // consentedChannels) to pass consent+cooldown and reach the INTENDED
    // lifecycle-legal gate.
    const modelClient = new FakeModelClient([
      validResult(buildOutput({ actionType: "propose_offer", channel: "email" })),
    ]);
    const runContext: RunAgentContext = {
      workspaceId: fixture.workspace.id,
      actor: ACTOR,
      trigger: TRIGGER,
    };

    const result = await runAgent(
      { db: ctx.db, modelClient },
      fosNextBestActionAgentDefinition,
      buildInput(fixture),
      runContext,
    );

    expect(result.status).toBe("policy_blocked");
    expect(result.artifact).toBeUndefined();
    expect(
      result.gateEvaluations?.some((g) => g.key.endsWith(".lifecycle-legal") && !g.allowed),
    ).toBe(true);
    expect(await ctx.db.select().from(enrollmentActionRecommendation)).toHaveLength(0);
    expect(await ctx.db.select().from(artifactRecord)).toHaveLength(0);
  });

  it("FOS1-NBA-06: duplicate-task block — an exact type+target match already exists as an open action → policy_blocked, ZERO recommendation rows, no artifact", async () => {
    const fixture = await seedNextBestActionFixture(ctx.db);
    await enableFlag(fixture.workspace.id);
    const modelClient = new FakeModelClient([
      validResult(buildOutput({ actionTarget: "person-target-1" })),
    ]);
    const runContext: RunAgentContext = {
      workspaceId: fixture.workspace.id,
      actor: ACTOR,
      trigger: TRIGGER,
    };

    const result = await runAgent(
      { db: ctx.db, modelClient },
      fosNextBestActionAgentDefinition,
      buildInput(fixture, {
        existingOpenActions: [{ type: "send_follow_up_email", target: "person-target-1" }],
      }),
      runContext,
    );

    expect(result.status).toBe("policy_blocked");
    expect(result.artifact).toBeUndefined();
    expect(
      result.gateEvaluations?.some((g) => g.key.endsWith(".no-duplicate-task") && !g.allowed),
    ).toBe(true);
    expect(await ctx.db.select().from(enrollmentActionRecommendation)).toHaveLength(0);
    expect(await ctx.db.select().from(artifactRecord)).toHaveLength(0);
  });

  it("FOS1-NBA-07: scheduled-conflict block — proposed action already covered by a scheduled future activity → policy_blocked, ZERO recommendation rows, no artifact", async () => {
    const fixture = await seedNextBestActionFixture(ctx.db);
    await enableFlag(fixture.workspace.id);
    const modelClient = new FakeModelClient([
      validResult(
        buildOutput({
          actionType: "internal_task",
          actionTarget: "person-target-1",
          channel: undefined,
        }),
      ),
    ]);
    const runContext: RunAgentContext = {
      workspaceId: fixture.workspace.id,
      actor: ACTOR,
      trigger: TRIGGER,
    };

    const result = await runAgent(
      { db: ctx.db, modelClient },
      fosNextBestActionAgentDefinition,
      buildInput(fixture, {
        scheduledActivities: [{ type: "internal_task", target: "person-target-1" }],
      }),
      runContext,
    );

    expect(result.status).toBe("policy_blocked");
    expect(result.artifact).toBeUndefined();
    expect(
      result.gateEvaluations?.some(
        (g) => g.key.endsWith(".no-scheduled-activity-conflict") && !g.allowed,
      ),
    ).toBe(true);
    expect(await ctx.db.select().from(enrollmentActionRecommendation)).toHaveLength(0);
    expect(await ctx.db.select().from(artifactRecord)).toHaveLength(0);
  });

  it("FOS1-NBA-08: terminal-status block — opportunity already in a terminal stage → policy_blocked, ZERO recommendation rows, no artifact", async () => {
    const fixture = await seedNextBestActionFixture(ctx.db);
    await enableFlag(fixture.workspace.id);
    await ctx.db
      .update(enrollmentOpportunity)
      .set({ stage: "enrolled" })
      .where(eq(enrollmentOpportunity.id, fixture.opportunity.id));
    const modelClient = new FakeModelClient([
      validResult(buildOutput({ actionType: "no_action", channel: undefined })),
    ]);
    const runContext: RunAgentContext = {
      workspaceId: fixture.workspace.id,
      actor: ACTOR,
      trigger: TRIGGER,
    };

    const result = await runAgent(
      { db: ctx.db, modelClient },
      fosNextBestActionAgentDefinition,
      buildInput(fixture, {
        opportunity: { ...buildInput(fixture).opportunity, stage: "enrolled" },
        // Permit "no_action" at "enrolled" in the derived table so this run
        // is blocked by not-terminal-status specifically, not by an
        // earlier-ordered lifecycle-legal mismatch (the gates run in
        // sequence and stop at the FIRST block — see evaluateGates).
        allowedActionsByStage: { ...ALLOWED_ACTIONS_BY_STAGE, enrolled: ["no_action"] },
      }),
      runContext,
    );

    expect(result.status).toBe("policy_blocked");
    expect(result.artifact).toBeUndefined();
    expect(
      result.gateEvaluations?.some((g) => g.key.endsWith(".not-terminal-status") && !g.allowed),
    ).toBe(true);
    expect(await ctx.db.select().from(enrollmentActionRecommendation)).toHaveLength(0);
    expect(await ctx.db.select().from(artifactRecord)).toHaveLength(0);
  });

  it("FOS1-NBA-09: offer-unavailable block — proposed offer not in the available-offer set → policy_blocked, ZERO recommendation rows, no artifact", async () => {
    const fixture = await seedNextBestActionFixture(ctx.db);
    await enableFlag(fixture.workspace.id);
    const modelClient = new FakeModelClient([validResult(buildOutput({ offer: "cohort-2026-z" }))]);
    const runContext: RunAgentContext = {
      workspaceId: fixture.workspace.id,
      actor: ACTOR,
      trigger: TRIGGER,
    };

    const result = await runAgent(
      { db: ctx.db, modelClient },
      fosNextBestActionAgentDefinition,
      buildInput(fixture, { availableOffers: ["cohort-2026-a"] }),
      runContext,
    );

    expect(result.status).toBe("policy_blocked");
    expect(result.artifact).toBeUndefined();
    expect(
      result.gateEvaluations?.some((g) => g.key.endsWith(".offer-available") && !g.allowed),
    ).toBe(true);
    expect(await ctx.db.select().from(enrollmentActionRecommendation)).toHaveLength(0);
    expect(await ctx.db.select().from(artifactRecord)).toHaveLength(0);
  });

  it("FOS1-NBA-10: prohibited-guarantee block — a guarantee smuggled into rationale → policy_blocked, ZERO recommendation rows, no artifact", async () => {
    const fixture = await seedNextBestActionFixture(ctx.db);
    await enableFlag(fixture.workspace.id);
    const modelClient = new FakeModelClient([
      validResult(
        buildOutput({
          rationale: "We guarantee Ada a job offer within 30 days if she enrolls now.",
        }),
      ),
    ]);
    const runContext: RunAgentContext = {
      workspaceId: fixture.workspace.id,
      actor: ACTOR,
      trigger: TRIGGER,
    };

    const result = await runAgent(
      { db: ctx.db, modelClient },
      fosNextBestActionAgentDefinition,
      buildInput(fixture),
      runContext,
    );

    expect(result.status).toBe("policy_blocked");
    expect(result.artifact).toBeUndefined();
    expect(
      result.gateEvaluations?.some((g) => g.key.endsWith(".no-prohibited-guarantee") && !g.allowed),
    ).toBe(true);
    expect(await ctx.db.select().from(enrollmentActionRecommendation)).toHaveLength(0);
    expect(await ctx.db.select().from(artifactRecord)).toHaveLength(0);
  });

  it("FOS1-NBA-17: prohibited-guarantee block via a NON-CONTACT action's channel — a guarantee in `channel` (consent-exempt, rendered) is STILL scanned → policy_blocked, ZERO rows", async () => {
    const fixture = await seedNextBestActionFixture(ctx.db);
    await enableFlag(fixture.workspace.id);
    // A non-contact action (internal_task) is exempt from consent, so its
    // `channel` is never checked against the allowlist — but it IS rendered
    // into the artifact, so the guarantee gate must scan it (issue #78
    // re-verify: FIX 2 removed the incidental consent check on non-contact
    // channels). The guarantee lives in `channel`, not summary/rationale.
    const modelClient = new FakeModelClient([
      validResult(
        buildOutput({
          actionType: "internal_task",
          channel: "we guarantee Ada a job offer within 30 days",
        }),
      ),
    ]);
    const runContext: RunAgentContext = {
      workspaceId: fixture.workspace.id,
      actor: ACTOR,
      trigger: TRIGGER,
    };

    const result = await runAgent(
      { db: ctx.db, modelClient },
      fosNextBestActionAgentDefinition,
      buildInput(fixture),
      runContext,
    );

    expect(result.status).toBe("policy_blocked");
    expect(result.artifact).toBeUndefined();
    expect(
      result.gateEvaluations?.some((g) => g.key.endsWith(".no-prohibited-guarantee") && !g.allowed),
    ).toBe(true);
    expect(await ctx.db.select().from(enrollmentActionRecommendation)).toHaveLength(0);
    expect(await ctx.db.select().from(artifactRecord)).toHaveLength(0);
  });

  it("FOS1-NBA-11: ATOMIC — a cross-workspace opportunity id is rejected; ZERO recommendation rows AND zero artifactRecord", async () => {
    const mine = await seedNextBestActionFixture(ctx.db);
    const theirs = await seedNextBestActionFixture(ctx.db);
    expect(theirs.workspace.id).not.toBe(mine.workspace.id);
    await enableFlag(mine.workspace.id);
    const modelClient = new FakeModelClient([validResult(buildOutput())]);
    const runContext: RunAgentContext = {
      workspaceId: mine.workspace.id,
      actor: ACTOR,
      trigger: TRIGGER,
    };

    await expect(
      runAgent(
        { db: ctx.db, modelClient },
        fosNextBestActionAgentDefinition,
        buildInput(theirs),
        runContext,
      ),
    ).rejects.toThrow(/not in workspace/);

    const [runRow] = await ctx.db
      .select()
      .from(agentRun)
      .where(
        and(
          eq(agentRun.workspaceId, mine.workspace.id),
          eq(agentRun.agentKey, FOS_NEXT_BEST_ACTION_AGENT_KEY),
        ),
      )
      .orderBy(desc(agentRun.createdAt))
      .limit(1);
    expect(runRow?.status).toBe("error");

    expect(await ctx.db.select().from(enrollmentActionRecommendation)).toHaveLength(0);
    expect(await ctx.db.select().from(artifactRecord)).toHaveLength(0);
    expect(await ctx.db.select().from(artifactVersion)).toHaveLength(0);

    const theirsAfter = await readOpportunity(ctx.db, theirs.opportunity.id);
    expect(theirsAfter.stage).toBe(theirs.opportunity.stage);
    expect(theirsAfter.version).toBe(theirs.opportunity.version);
  });

  it("FOS1-NBA-12: shadow mode — no founder-surfaced output, artifact stays draft, canonical write still happens", async () => {
    const fixture = await seedNextBestActionFixture(ctx.db);
    await enableFlag(fixture.workspace.id, "shadow");
    const modelClient = new FakeModelClient([validResult(buildOutput())]);
    const runContext: RunAgentContext = {
      workspaceId: fixture.workspace.id,
      actor: ACTOR,
      trigger: TRIGGER,
    };

    const result = await runAgent(
      { db: ctx.db, modelClient },
      fosNextBestActionAgentDefinition,
      buildInput(fixture),
      runContext,
    );

    expect(result.status).toBe("succeeded");
    expect(result.mode).toBe("shadow");

    const [version] = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, result.artifact!.versionId));
    expect(version!.approvalStatus).toBe("draft");

    const approvals = await ctx.db.select().from(approval);
    expect(approvals).toHaveLength(0);

    const rows = await ctx.db
      .select()
      .from(enrollmentActionRecommendation)
      .where(eq(enrollmentActionRecommendation.opportunityId, fixture.opportunity.id));
    expect(rows).toHaveLength(1);
  });

  it("FOS1-NBA-13: no-channel internal task is exempt from consent/cooldown — succeeds even with no consent recorded and an active cooldown", async () => {
    const fixture = await seedNextBestActionFixture(ctx.db);
    await enableFlag(fixture.workspace.id);
    const modelClient = new FakeModelClient([
      validResult(
        buildOutput({
          actionType: "internal_task",
          channel: undefined,
        }),
      ),
    ]);
    const runContext: RunAgentContext = {
      workspaceId: fixture.workspace.id,
      actor: ACTOR,
      trigger: TRIGGER,
    };

    const result = await runAgent(
      { db: ctx.db, modelClient },
      fosNextBestActionAgentDefinition,
      buildInput(fixture, {
        consentedChannels: [],
        now: "2026-01-01T00:00:00.000Z",
        cooldownUntil: "2026-01-05T00:00:00.000Z",
      }),
      runContext,
    );

    expect(result.status).toBe("succeeded");
    const rows = await ctx.db
      .select()
      .from(enrollmentActionRecommendation)
      .where(eq(enrollmentActionRecommendation.opportunityId, fixture.opportunity.id));
    expect(rows).toHaveLength(1);
  });

  it("FOS1-NBA-14: non-datetime recommendedDueAt is rejected at output validation — evaluation_failed, ZERO recommendation rows, no artifact (guarantee-leak field is now .datetime()-constrained)", async () => {
    const fixture = await seedNextBestActionFixture(ctx.db);
    await enableFlag(fixture.workspace.id);
    // A guarantee phrase smuggled into the (previously unconstrained,
    // unscanned) recommendedDueAt free-text field. It is now
    // `.datetime()`-constrained, so it fails Zod output validation (which
    // also prevents an Invalid-Date reaching the timestamptz insert) BEFORE
    // any founder-facing recommendation can be produced. The pipeline
    // repair-retries once, so two scripted results are queued.
    const badOutput = buildOutput({
      recommendedDueAt: "guaranteed placement within 30 days",
    });
    const modelClient = new FakeModelClient([validResult(badOutput), validResult(badOutput)]);
    const runContext: RunAgentContext = {
      workspaceId: fixture.workspace.id,
      actor: ACTOR,
      trigger: TRIGGER,
    };

    const result = await runAgent(
      { db: ctx.db, modelClient },
      fosNextBestActionAgentDefinition,
      buildInput(fixture),
      runContext,
    );

    expect(result.status).toBe("evaluation_failed");
    expect(result.artifact).toBeUndefined();
    expect(await ctx.db.select().from(enrollmentActionRecommendation)).toHaveLength(0);
    expect(await ctx.db.select().from(artifactRecord)).toHaveLength(0);
  });

  it("FOS1-NBA-15: consent bypass closed — a DERIVED contact action with channel OMITTED cannot skip consent → policy_blocked at consent, ZERO recommendation rows, no artifact", async () => {
    const fixture = await seedNextBestActionFixture(ctx.db);
    await enableFlag(fixture.workspace.id);
    // Pre-fix, a contact action could omit `channel` to make the consent
    // selector return undefined (exempt). Now contact-ness is derived from
    // actionType, so an omitted channel yields the fail-closed sentinel that
    // can never be in the allowlist → BLOCKED.
    const modelClient = new FakeModelClient([
      validResult(buildOutput({ actionType: "send_follow_up_email", channel: undefined })),
    ]);
    const runContext: RunAgentContext = {
      workspaceId: fixture.workspace.id,
      actor: ACTOR,
      trigger: TRIGGER,
    };

    const result = await runAgent(
      { db: ctx.db, modelClient },
      fosNextBestActionAgentDefinition,
      buildInput(fixture, { consentedChannels: ["email"] }),
      runContext,
    );

    expect(result.status).toBe("policy_blocked");
    expect(result.artifact).toBeUndefined();
    expect(result.gateEvaluations?.find((g) => g.key.endsWith(".consent"))?.allowed).toBe(false);
    expect(await ctx.db.select().from(enrollmentActionRecommendation)).toHaveLength(0);
    expect(await ctx.db.select().from(artifactRecord)).toHaveLength(0);
  });

  it("FOS1-NBA-16: cooldown bypass closed — a DERIVED contact action cannot escape an active cooldown (no model-authored isContact:false) → policy_blocked at cooldown, ZERO recommendation rows, no artifact", async () => {
    const fixture = await seedNextBestActionFixture(ctx.db);
    await enableFlag(fixture.workspace.id);
    // Pre-fix, a contact could set isContact:false to skip cooldown. That
    // field is gone; contact-ness is derived from actionType. A genuine
    // contact action (send_follow_up_email, consented channel) with an
    // active cooldown is now blocked at cooldown regardless.
    const modelClient = new FakeModelClient([
      validResult(buildOutput({ actionType: "send_follow_up_email", channel: "email" })),
    ]);
    const runContext: RunAgentContext = {
      workspaceId: fixture.workspace.id,
      actor: ACTOR,
      trigger: TRIGGER,
    };

    const result = await runAgent(
      { db: ctx.db, modelClient },
      fosNextBestActionAgentDefinition,
      buildInput(fixture, {
        consentedChannels: ["email"],
        now: "2026-01-01T00:00:00.000Z",
        cooldownUntil: "2026-01-05T00:00:00.000Z",
      }),
      runContext,
    );

    expect(result.status).toBe("policy_blocked");
    expect(result.artifact).toBeUndefined();
    expect(result.gateEvaluations?.find((g) => g.key.endsWith(".cooldown"))?.allowed).toBe(false);
    expect(await ctx.db.select().from(enrollmentActionRecommendation)).toHaveLength(0);
    expect(await ctx.db.select().from(artifactRecord)).toHaveLength(0);
  });
});
