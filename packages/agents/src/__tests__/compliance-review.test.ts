import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { agentRun, artifactRecord, artifactVersion } from "@fos/db/schema";
import { runAgent } from "../pipeline.js";
import { featureModeAllowedGate } from "../gates/feature-mode-allowed.js";
import { GUARANTEE_CLASSIFIER_SYSTEM_PROMPT } from "../gates/guarantee-classifier.js";
import type { AgentDefinition, RunAgentContext } from "../types.js";
import type { FeatureMode } from "../mode.js";
import { createTestDb, seedWorkspace, setFeatureFlag } from "./test-db.js";
import {
  FakeModelClient,
  validResult,
  allowAllReviewer,
  blockAllReviewer,
  throwingReviewer,
} from "./fake-model-client.js";

// ===========================================================================
// Stage-7b semantic compliance-review tests (Option C slice 2, issue #109).
//
// These exercise the NEW pipeline stage in isolation with a minimal test agent,
// independent of any one business agent's schema. The per-agent tests
// (enrollment-brief, call-preparation, ...) prove each agent's OWN fields are
// reviewed and its guarantee-injection scenarios still terminate policy_blocked.
// ===========================================================================

const CR_FLAG = "fos.cr_test";
const CR_AGENT_KEY = "fos.cr_test";
const CR_NOREVIEW_FLAG = "fos.cr_noreview";
const CR_NOREVIEW_AGENT_KEY = "fos.cr_noreview";

const ACTOR = { type: "agent" as const, id: CR_AGENT_KEY };
const TRIGGER = { type: "manual", source: "compliance-review-test" };

type CrInput = { note: string };
type CrOutput = { message: string };

/** Minimal agent WITH a compliance-review selector (scans `message`). */
const crTestDefinition: AgentDefinition<CrInput, CrOutput> = {
  key: CR_AGENT_KEY,
  version: "1.0.0",
  objective: "Compliance-review stage test agent.",
  inputSchema: z.object({ note: z.string() }),
  outputSchema: z.object({ message: z.string() }),
  permittedTools: [],
  permittedMemoryScopes: ["none"],
  autonomyCeiling: "review",
  featureFlagKey: CR_FLAG,
  deterministicGates: [
    featureModeAllowedGate({
      key: "fos.cr_test.mode-allowed",
      allowedModes: ["shadow", "review"],
    }),
  ],
  complianceReviewText: (output) => [output.message],
  artifact: {
    artifactType: "internal_note",
    domain: "research",
    buildTitle: () => "CR test",
    buildBodyMarkdown: (_input, output) => output.message,
  },
};

/** Same agent but WITHOUT a compliance-review selector — the stage must skip. */
const crNoReviewDefinition: AgentDefinition<CrInput, CrOutput> = {
  ...crTestDefinition,
  key: CR_NOREVIEW_AGENT_KEY,
  featureFlagKey: CR_NOREVIEW_FLAG,
  deterministicGates: [
    featureModeAllowedGate({
      key: "fos.cr_noreview.mode-allowed",
      allowedModes: ["shadow", "review"],
    }),
  ],
  complianceReviewText: undefined,
};

describe("stage-7b semantic compliance review (issue #109)", () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    ctx = await createTestDb();
  });
  afterEach(async () => {
    await ctx.close();
  });

  async function setup(mode: FeatureMode, key = CR_FLAG) {
    const workspace = await seedWorkspace(ctx.db);
    await setFeatureFlag(ctx.db, { workspaceId: workspace.id, key, enabled: true, mode });
    const runContext: RunAgentContext = {
      workspaceId: workspace.id,
      actor: ACTOR,
      trigger: TRIGGER,
    };
    return { workspace, runContext };
  }

  it("FOS1-CR-01: a prohibited output → stage blocks (policy_blocked, no artifact)", async () => {
    const { runContext } = await setup("review");
    const result = await runAgent(
      {
        db: ctx.db,
        modelClient: new FakeModelClient([validResult({ message: "we guarantee you a job" })]),
        complianceReviewer: blockAllReviewer,
      },
      crTestDefinition,
      { note: "x" },
      runContext,
    );

    expect(result.status).toBe("policy_blocked");
    expect(result.artifact).toBeUndefined();
    expect(result.complianceReview?.blocked).toBe(true);
    expect(result.reason).toBe("test stub: block");
    // Gates all passed — the block came from the compliance stage, not a gate.
    expect(result.gateEvaluations?.every((g) => g.allowed)).toBe(true);

    // No canonical artifact reached the DB, and the run row records the block.
    expect(await ctx.db.select().from(artifactRecord)).toHaveLength(0);
    const [runRow] = await ctx.db.select().from(agentRun).where(eq(agentRun.id, result.runId));
    expect(runRow!.status).toBe("policy_blocked");
    expect(
      (runRow!.deterministicEvalJson as { complianceReview?: { blocked: boolean } })
        .complianceReview?.blocked,
    ).toBe(true);
  });

  it("FOS1-CR-02: a benign/readiness output → passes (succeeded, artifact created)", async () => {
    const { runContext } = await setup("review");
    const result = await runAgent(
      {
        db: ctx.db,
        modelClient: new FakeModelClient([
          validResult({
            message: "You will graduate job-ready and well-practiced at interviewing.",
          }),
        ]),
        complianceReviewer: allowAllReviewer,
      },
      crTestDefinition,
      { note: "x" },
      runContext,
    );

    expect(result.status).toBe("succeeded");
    expect(result.artifact).toBeDefined();
    expect(result.complianceReview).toBeUndefined();
    const [version] = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, result.artifact!.versionId));
    expect(version!.approvalStatus).toBe("in_review");
  });

  it("FOS1-CR-03: fail-closed — the reviewer THROWS → block (exception never bypasses the review)", async () => {
    const { runContext } = await setup("review");
    const result = await runAgent(
      {
        db: ctx.db,
        modelClient: new FakeModelClient([validResult({ message: "anything" })]),
        complianceReviewer: throwingReviewer,
      },
      crTestDefinition,
      { note: "x" },
      runContext,
    );

    expect(result.status).toBe("policy_blocked");
    expect(result.artifact).toBeUndefined();
    expect(result.complianceReview?.blocked).toBe(true);
    expect(result.reason).toContain("fail-closed");
    expect(await ctx.db.select().from(artifactRecord)).toHaveLength(0);
  });

  it("FOS1-CR-04a: the review runs in SHADOW mode (a block in shadow still terminates the run)", async () => {
    const { runContext } = await setup("shadow");
    const result = await runAgent(
      {
        db: ctx.db,
        modelClient: new FakeModelClient([validResult({ message: "we guarantee you a job" })]),
        complianceReviewer: blockAllReviewer,
      },
      crTestDefinition,
      { note: "x" },
      runContext,
    );

    expect(result.mode).toBe("shadow");
    expect(result.status).toBe("policy_blocked");
    expect(result.complianceReview?.blocked).toBe(true);
    expect(await ctx.db.select().from(artifactRecord)).toHaveLength(0);
  });

  it("FOS1-CR-04b: the review runs in REVIEW mode", async () => {
    const { runContext } = await setup("review");
    const result = await runAgent(
      {
        db: ctx.db,
        modelClient: new FakeModelClient([validResult({ message: "we guarantee you a job" })]),
        complianceReviewer: blockAllReviewer,
      },
      crTestDefinition,
      { note: "x" },
      runContext,
    );

    expect(result.mode).toBe("review");
    expect(result.status).toBe("policy_blocked");
    expect(result.complianceReview?.blocked).toBe(true);
  });

  it("FOS1-CR-05: an agent WITHOUT complianceReviewText skips the stage cleanly", async () => {
    const { runContext } = await setup("review", CR_NOREVIEW_FLAG);
    // A THROWING reviewer is injected: if the stage were NOT skipped it would
    // fail closed and block. The run succeeding proves the stage was skipped
    // (the reviewer was never invoked).
    const result = await runAgent(
      {
        db: ctx.db,
        modelClient: new FakeModelClient([validResult({ message: "anything at all" })]),
        complianceReviewer: throwingReviewer,
      },
      crNoReviewDefinition,
      { note: "x" },
      runContext,
    );

    expect(result.status).toBe("succeeded");
    expect(result.complianceReview).toBeUndefined();
    expect(result.artifact).toBeDefined();
  });

  it("FOS1-CR-06: the DEFAULT reviewer wires to evaluateGuaranteeText with the model client (no stub injected)", async () => {
    const { runContext } = await setup("review");
    // No `complianceReviewer` injected → the pipeline default fires:
    // evaluateGuaranteeText(text, { model: deps.modelClient }). The benign
    // message does not trip the Tier-1 regex floor, so it escalates to the
    // Tier-2 model classifier — a SECOND generateStructured call, on the SAME
    // injected model client, carrying the classifier system prompt. Scripting
    // its allow verdict proves the default is wired to the classifier.
    const modelClient = new FakeModelClient([
      validResult({ message: "Our program builds market-ready analytics skills." }),
      validResult({ verdict: "allow", confidence: "high", reason: "readiness copy" }),
    ]);
    const result = await runAgent(
      { db: ctx.db, modelClient },
      crTestDefinition,
      { note: "x" },
      runContext,
    );

    expect(result.status).toBe("succeeded");
    // Exactly two model calls: (1) generation, (2) the default compliance
    // classifier — proving the default reviewer reached evaluateGuaranteeText.
    expect(modelClient.calls).toHaveLength(2);
    expect(modelClient.calls[1]!.systemPrompt).toBe(GUARANTEE_CLASSIFIER_SYSTEM_PROMPT);
  });

  it("FOS1-CR-07: the DEFAULT reviewer fails closed via the classifier when the Tier-2 call errors", async () => {
    const { runContext } = await setup("review");
    // Benign message (escapes Tier-1) → Tier-2 model call. That call THROWS;
    // evaluateGuaranteeText catches it and returns block → the run is blocked
    // WITHOUT any stub, proving the default path itself fails closed.
    const modelClient = new FakeModelClient([
      validResult({ message: "Our program builds market-ready analytics skills." }),
      () => {
        throw new Error("simulated classifier outage");
      },
    ]);
    const result = await runAgent(
      { db: ctx.db, modelClient },
      crTestDefinition,
      { note: "x" },
      runContext,
    );

    expect(result.status).toBe("policy_blocked");
    expect(result.complianceReview?.blocked).toBe(true);
    expect(await ctx.db.select().from(artifactRecord)).toHaveLength(0);
  });
});
