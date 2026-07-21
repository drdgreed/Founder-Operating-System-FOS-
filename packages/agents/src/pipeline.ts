import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agentRun, featureFlag } from "@fos/db/schema";
import { createArtifact, transitionArtifactVersionStatus, writeEvent } from "@fos/db/services";
import { assembleContext } from "./context.js";
import type { GateEvaluation } from "./gates/gate.js";
import { evaluateGates } from "./gates/gate.js";
import { effectiveMode, type FeatureMode } from "./mode.js";
import { DEFAULT_MODEL, type ModelUsage } from "./model-client.js";
import { buildPrompt, buildRepairPrompt } from "./prompt.js";
import { zodToJsonSchema } from "./schema-to-json.js";
import type { AgentDefinition, RunAgentContext, RunAgentDeps } from "./types.js";

export type AgentRunStatus = "succeeded" | "evaluation_failed" | "policy_blocked" | "error";

export interface RunAgentResult {
  runId: string;
  status: AgentRunStatus;
  mode: FeatureMode;
  retryCount: number;
  artifact?: { artifactId: string; versionId: string };
  gateEvaluations?: GateEvaluation[];
  reason?: string;
  /** True when the run succeeded (canonical committed) but the isolated
   * stage-11 projection (a non-canonical Notion write) failed and was
   * deferred to a later reconcile — the run is NOT failed for this. */
  projectionDeferred?: boolean;
}

function triggerLabel(trigger: RunAgentContext["trigger"]): string {
  return `${trigger.type}:${trigger.source}`;
}

function formatIssues(
  issues: ReadonlyArray<{ path: (string | number)[]; message: string }>,
): string[] {
  return issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

/**
 * Executes the 12-stage bounded-agent pipeline (ADR-07 D2, issue #50). The
 * model (stage 5) is the ONLY non-deterministic stage; stages 6-7 fail
 * closed and ENFORCE over whatever the model recommends. `deps.modelClient`
 * is REQUIRED (the #1 safety property) — there is no default/real client, so
 * a caller (or test) that wants a real Anthropic call must construct and
 * inject an `AnthropicModelClient` itself; nothing here ever does so
 * implicitly.
 */
export async function runAgent<TInput, TOutput>(
  deps: RunAgentDeps,
  definition: AgentDefinition<TInput, TOutput>,
  rawInput: unknown,
  runContext: RunAgentContext,
): Promise<RunAgentResult> {
  const correlationId = runContext.correlationId ?? randomUUID();
  const causationId = runContext.causationId ?? null;

  // ---- Stage 1: trigger validation -----------------------------------
  if (!runContext.trigger.type || !runContext.trigger.source) {
    throw new Error(`runAgent("${definition.key}"): trigger requires both type and source`);
  }
  const inputParse = definition.inputSchema.safeParse(rawInput);
  if (!inputParse.success) {
    throw new Error(
      `runAgent("${definition.key}"): input failed inputSchema validation: ${formatIssues(inputParse.error.issues).join("; ")}`,
    );
  }
  const input = inputParse.data;

  // ---- Stage 2: authorization + feature-flag/mode --------------------
  const [flag] = await deps.db
    .select()
    .from(featureFlag)
    .where(
      and(
        eq(featureFlag.workspaceId, runContext.workspaceId),
        eq(featureFlag.key, definition.featureFlagKey),
      ),
    )
    .limit(1);

  // Fail closed: an unconfigured flag behaves as disabled, and defaults to
  // the least-privileged mode if it were ever (incorrectly) read further.
  const flagEnabled = flag?.enabled ?? false;
  const mode = effectiveMode(
    (flag?.mode as FeatureMode | undefined) ?? "shadow",
    definition.autonomyCeiling,
  );

  if (!flagEnabled) {
    const [blockedRun] = await deps.db
      .insert(agentRun)
      .values({
        workspaceId: runContext.workspaceId,
        agentKey: definition.key,
        agentVersion: definition.version,
        promptVersion: definition.version,
        trigger: triggerLabel(runContext.trigger),
        actorJson: runContext.actor,
        featureMode: mode,
        contextManifestJson: { flagKey: definition.featureFlagKey, flagEnabled: false },
        status: "policy_blocked",
        deterministicEvalJson: {
          evaluations: [{ key: "feature_flag", allowed: false, reason: "feature flag disabled" }],
        },
        retryCount: 0,
        correlationId,
        causationId,
      })
      .returning();
    if (!blockedRun) throw new Error("runAgent: agent_run insert returned no row");

    await writeEvent(deps.db, {
      workspaceId: runContext.workspaceId,
      productId: runContext.productId ?? null,
      entityType: "AgentRun",
      entityId: blockedRun.id,
      source: "agent-runtime",
      correlationId,
      causationId,
      actor: runContext.actor,
      type: "agent_run.policy_blocked",
      payload: {
        agentKey: definition.key,
        agentVersion: definition.version,
        reason: "feature_flag_disabled",
      },
    });

    return {
      runId: blockedRun.id,
      status: "policy_blocked",
      mode,
      retryCount: 0,
      reason: "feature_flag_disabled",
    };
  }

  // ---- Stage 3: context assembly + minimization -----------------------
  const assembled = assembleContext(definition, input, runContext);

  const [runRow] = await deps.db
    .insert(agentRun)
    .values({
      workspaceId: runContext.workspaceId,
      agentKey: definition.key,
      agentVersion: definition.version,
      promptVersion: definition.version,
      trigger: triggerLabel(runContext.trigger),
      actorJson: runContext.actor,
      featureMode: mode,
      contextManifestJson: assembled.manifest,
      status: "queued",
      retryCount: 0,
      correlationId,
      causationId,
    })
    .returning();
  if (!runRow) throw new Error("runAgent: agent_run insert returned no row");
  const runId = runRow.id;

  // Hoisted above the try so the outer catch (any stage from here on) can
  // persist whatever cost/timing/retry state was actually observed before
  // the failure, instead of silently dropping it (issue #52 item 1).
  let startedAt: number | undefined;
  let usage: ModelUsage | undefined;
  let retryCount = 0;

  try {
    // ---- Stage 4: prompt construction ---------------------------------
    const model = definition.model ?? DEFAULT_MODEL;
    const outputJsonSchema = zodToJsonSchema(definition.outputSchema);
    const prompt = buildPrompt(definition, assembled);

    await deps.db
      .update(agentRun)
      .set({ status: "running", model, updatedAt: new Date() })
      .where(eq(agentRun.id, runId));

    // ---- Stage 5: model execution (the only non-deterministic stage) --
    startedAt = Date.now();
    const firstAttempt = await deps.modelClient.generateStructured({
      ...prompt,
      outputJsonSchema,
      model,
    });
    usage = firstAttempt.usage;

    // ---- Stage 6: structured-output validation, repair-retry-once -----
    let parsed = definition.outputSchema.safeParse(firstAttempt.output);
    if (!parsed.success) {
      retryCount = 1;
      const repairPrompt = buildRepairPrompt(prompt, formatIssues(parsed.error.issues));
      const secondAttempt = await deps.modelClient.generateStructured({
        ...repairPrompt,
        outputJsonSchema,
        model,
      });
      usage = secondAttempt.usage;
      parsed = definition.outputSchema.safeParse(secondAttempt.output);
    }
    const latencyMs = Date.now() - startedAt;

    if (!parsed.success) {
      // Fail closed (D4): NO approval-ready artifact; a founder-visible
      // operational item is the audit event below (REUSE event-writer — no
      // parallel "founder item" system is created, per D6).
      const issues = formatIssues(parsed.error.issues);
      await deps.db
        .update(agentRun)
        .set({
          status: "evaluation_failed",
          retryCount,
          latencyMs,
          costJson: usage,
          deterministicEvalJson: { structuredOutputValid: false, issues },
          updatedAt: new Date(),
        })
        .where(eq(agentRun.id, runId));

      await writeEvent(deps.db, {
        workspaceId: runContext.workspaceId,
        productId: runContext.productId ?? null,
        entityType: "AgentRun",
        entityId: runId,
        source: "agent-runtime",
        correlationId,
        causationId,
        actor: runContext.actor,
        type: "agent_run.evaluation_failed",
        payload: { agentKey: definition.key, agentVersion: definition.version, issues },
      });

      return {
        runId,
        status: "evaluation_failed",
        mode,
        retryCount,
        reason: "structured_output_invalid",
      };
    }

    const output = parsed.data;

    // ---- Stage 7: deterministic policy evaluation — gates ENFORCE -----
    const gateOutcome = await evaluateGates(definition.deterministicGates, {
      workspaceId: runContext.workspaceId,
      agentKey: definition.key,
      mode,
      input,
      output,
    });

    if (!gateOutcome.allowed) {
      await deps.db
        .update(agentRun)
        .set({
          status: "policy_blocked",
          retryCount,
          latencyMs,
          costJson: usage,
          deterministicEvalJson: {
            evaluations: gateOutcome.evaluations,
            blockedBy: gateOutcome.blockedBy,
          },
          updatedAt: new Date(),
        })
        .where(eq(agentRun.id, runId));

      await writeEvent(deps.db, {
        workspaceId: runContext.workspaceId,
        productId: runContext.productId ?? null,
        entityType: "AgentRun",
        entityId: runId,
        source: "agent-runtime",
        correlationId,
        causationId,
        actor: runContext.actor,
        type: "agent_run.policy_blocked",
        payload: {
          agentKey: definition.key,
          agentVersion: definition.version,
          blockedBy: gateOutcome.blockedBy,
        },
      });

      return {
        runId,
        status: "policy_blocked",
        mode,
        retryCount,
        gateEvaluations: gateOutcome.evaluations,
        reason: gateOutcome.blockedBy?.reason,
      };
    }

    // ---- Stage 8: optional secondary quality eval (advisory only) -----
    const secondaryEval = definition.evalPolicy?.secondaryEval
      ? await definition.evalPolicy.secondaryEval(input, output)
      : null;

    // ---- Stage 9: canonical persistence (REUSE createArtifact, 0.1b), plus
    // Stage 9b: domain-specific canonical persistence (issue #53) ----------
    // Both run inside ONE transaction (issue #63): createArtifact opens its
    // own nested `db.transaction` (a Postgres SAVEPOINT when passed `tx`), so
    // a persistDomain throw rolls back the artifact + version + the
    // `artifact.created` event together with it. Unlike stage 11's isolated
    // projection, a persistDomain failure is NOT caught here — it propagates
    // to the outer catch below and fails the run closed, since this is the
    // agent's own canonical record, not a best-effort external side effect.
    const artifactResult = await deps.db.transaction(async (tx) => {
      const result = await createArtifact(tx, {
        workspaceId: runContext.workspaceId,
        productId: runContext.productId ?? null,
        artifactType:
          typeof definition.artifact.artifactType === "function"
            ? definition.artifact.artifactType(input, output)
            : definition.artifact.artifactType,
        domain: definition.artifact.domain,
        title: definition.artifact.buildTitle(input, output),
        bodyMarkdown: definition.artifact.buildBodyMarkdown(input, output),
        claimsManifestJson: definition.artifact.buildClaimsManifest?.(input, output) ?? {},
        actor: runContext.actor,
        source: "agent-runtime",
        correlationId,
        causationId,
      });

      if (definition.persistDomain) {
        await definition.persistDomain(
          { deps: { ...deps, db: tx }, runContext, agentRunId: runId },
          input,
          output,
          result,
        );
      }

      return result;
    });

    // ---- Stage 10: approval routing per mode ---------------------------
    // shadow: persist run + output but do NOT surface/route to approval —
    // the artifact stays `draft`. review: route to approval by advancing the
    // artifact to the decidable `in_review` state (REUSE the 0.1b
    // transition that the approval-service's `recordApprovalDecision` itself
    // drives) — that decision call is deliberately NOT made here: recording
    // an approval decision is a FOUNDER action, and the runtime autonomously
    // calling it would be exactly the autonomous-approval the invariants
    // forbid. live is reserved (no execution path wired in this slice).
    if (mode === "review") {
      await transitionArtifactVersionStatus(deps.db, {
        versionId: artifactResult.versionId,
        expectedStatus: "draft",
        toStatus: "in_review",
        actor: runContext.actor,
        correlationId,
        causationId: artifactResult.eventId,
      });
    }

    // ---- Stage 11: projection update (REUSE projectOpportunity-shaped
    // hooks), per mode — never surfaced in shadow mode. ISOLATED (issue #50
    // review / the 0.2e lesson): projection is a NON-CANONICAL external
    // (Notion) side effect. Stages 9-10 already committed the canonical
    // artifact and routed it to approval, so a projection failure must NOT
    // fail the run — that would orphan an approvable artifact on an `error`
    // run and duplicate it on retry. Catch it, record `projectionDeferred`,
    // and still complete the run `succeeded`; a later reconcile re-projects.
    let projectionDeferred = false;
    if (definition.projection && mode !== "shadow") {
      try {
        await definition.projection({ deps, runContext, mode }, input, output);
      } catch (projectionErr) {
        projectionDeferred = true;
        console.error(
          `[agent-runtime] projection failed for run ${runId} (canonical committed; run still succeeds):`,
          projectionErr instanceof Error ? projectionErr.message : String(projectionErr),
        );
      }
    }

    // ---- Stage 12: metrics + audit --------------------------------------
    await deps.db
      .update(agentRun)
      .set({
        status: "succeeded",
        retryCount,
        latencyMs,
        costJson: usage,
        outputRef: artifactResult.versionId,
        deterministicEvalJson: { evaluations: gateOutcome.evaluations, projectionDeferred },
        secondaryEvalJson: secondaryEval,
        updatedAt: new Date(),
      })
      .where(eq(agentRun.id, runId));

    await writeEvent(deps.db, {
      workspaceId: runContext.workspaceId,
      productId: runContext.productId ?? null,
      entityType: "AgentRun",
      entityId: runId,
      source: "agent-runtime",
      correlationId,
      causationId,
      actor: runContext.actor,
      type: "agent_run.succeeded",
      payload: {
        agentKey: definition.key,
        agentVersion: definition.version,
        artifactId: artifactResult.artifactId,
        versionId: artifactResult.versionId,
        mode,
        projectionDeferred,
      },
    });

    return {
      runId,
      status: "succeeded",
      mode,
      retryCount,
      artifact: { artifactId: artifactResult.artifactId, versionId: artifactResult.versionId },
      gateEvaluations: gateOutcome.evaluations,
      projectionDeferred,
    };
  } catch (err) {
    // Fail closed on ANY unexpected error: the run row must never be left
    // silently "running" (this slice is explicitly reviewed for silent
    // failure). The recorded message is the error's own text only — neither
    // ModelClient nor NotionClient ever throws credential material (see
    // model-client.ts / packages/notion/src/client.ts), so nothing here can
    // leak ANTHROPIC_API_KEY.
    const message = err instanceof Error ? err.message : String(err);
    const latencyMs = startedAt !== undefined ? Date.now() - startedAt : null;
    await deps.db
      .update(agentRun)
      .set({
        status: "error",
        retryCount,
        latencyMs,
        costJson: usage ?? null,
        deterministicEvalJson: { error: message },
        updatedAt: new Date(),
      })
      .where(eq(agentRun.id, runId));

    // Every other terminal (succeeded/evaluation_failed/policy_blocked)
    // emits an audit event; the error path previously did not, leaving an
    // errored run invisible to event/projection consumers (issue #52 item 1).
    // ISOLATED: the true failure cause is already durably persisted above
    // (agent_run.status + deterministicEvalJson.error). A failure to emit the
    // audit event must NOT mask the original `err` — otherwise the caller
    // would reject with the writeEvent error instead of the real cause. Log
    // and continue so `throw err` below always wins the rejection.
    try {
      await writeEvent(deps.db, {
        workspaceId: runContext.workspaceId,
        productId: runContext.productId ?? null,
        entityType: "AgentRun",
        entityId: runId,
        source: "agent-runtime",
        correlationId,
        causationId,
        actor: runContext.actor,
        type: "agent_run.error",
        payload: { agentKey: definition.key, agentVersion: definition.version, error: message },
      });
    } catch (eventErr) {
      console.error(
        `[agent-runtime] failed to emit agent_run.error event for run ${runId} ` +
          `(original cause preserved in agent_run.deterministicEvalJson):`,
        eventErr instanceof Error ? eventErr.message : String(eventErr),
      );
    }

    throw err;
  }
}
