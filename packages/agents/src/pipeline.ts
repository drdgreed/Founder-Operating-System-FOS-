import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agentRun, featureFlag } from "@fos/db/schema";
import { createArtifact, transitionArtifactVersionStatus, writeEvent } from "@fos/db/services";
import { assembleContext } from "./context.js";
import type { GateEvaluation } from "./gates/gate.js";
import { evaluateGates } from "./gates/gate.js";
import { effectiveMode, type FeatureMode } from "./mode.js";
import { DEFAULT_MODEL } from "./model-client.js";
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
    const startedAt = Date.now();
    const firstAttempt = await deps.modelClient.generateStructured({
      ...prompt,
      outputJsonSchema,
      model,
    });
    let usage = firstAttempt.usage;
    let retryCount = 0;

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

    // ---- Stage 9: canonical persistence (REUSE createArtifact, 0.1b) ---
    const artifactResult = await createArtifact(deps.db, {
      workspaceId: runContext.workspaceId,
      productId: runContext.productId ?? null,
      artifactType: definition.artifact.artifactType,
      domain: definition.artifact.domain,
      title: definition.artifact.buildTitle(input, output),
      bodyMarkdown: definition.artifact.buildBodyMarkdown(input, output),
      claimsManifestJson: definition.artifact.buildClaimsManifest?.(input, output) ?? {},
      actor: runContext.actor,
      source: "agent-runtime",
      correlationId,
      causationId,
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
    // hooks), per mode — never surfaced in shadow mode. ------------------
    if (definition.projection && mode !== "shadow") {
      await definition.projection({ deps, runContext, mode }, input, output);
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
        deterministicEvalJson: { evaluations: gateOutcome.evaluations },
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
      },
    });

    return {
      runId,
      status: "succeeded",
      mode,
      retryCount,
      artifact: { artifactId: artifactResult.artifactId, versionId: artifactResult.versionId },
      gateEvaluations: gateOutcome.evaluations,
    };
  } catch (err) {
    // Fail closed on ANY unexpected error: the run row must never be left
    // silently "running" (this slice is explicitly reviewed for silent
    // failure). The recorded message is the error's own text only — neither
    // ModelClient nor NotionClient ever throws credential material (see
    // model-client.ts / packages/notion/src/client.ts), so nothing here can
    // leak ANTHROPIC_API_KEY.
    const message = err instanceof Error ? err.message : String(err);
    await deps.db
      .update(agentRun)
      .set({ status: "error", deterministicEvalJson: { error: message }, updatedAt: new Date() })
      .where(eq(agentRun.id, runId));
    throw err;
  }
}
