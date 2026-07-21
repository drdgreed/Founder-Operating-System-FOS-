import type { ZodType } from "zod";
import type { EventActor } from "@fos/contracts";
import type { ArtifactDomain, ArtifactType } from "@fos/db/schema";
import type { CreateArtifactResult, Db } from "@fos/db/services";
import type { NotionClient } from "@fos/notion";
import type { Gate } from "./gates/gate.js";
import type { ModelClient } from "./model-client.js";
import type { FeatureMode } from "./mode.js";

/** Who/what triggered a run (stage 1, trigger validation). */
export interface RunTrigger {
  type: string;
  source: string;
}

/** Per-invocation context supplied by the caller (not part of the versioned definition). */
export interface RunAgentContext {
  workspaceId: string;
  productId?: string | null;
  actor: EventActor;
  trigger: RunTrigger;
  correlationId?: string;
  causationId?: string | null;
}

/**
 * Runtime dependencies (stage 5's #1 safety property lives here):
 * `modelClient` is REQUIRED with no default — constructing a call to
 * `runAgent` without one is a type error, so no hermetic test can ever reach
 * a real Anthropic call. `notionClient` is optional — only definitions that
 * declare a `projection` hook need it.
 */
export interface RunAgentDeps {
  db: Db;
  modelClient: ModelClient;
  notionClient?: NotionClient;
}

export interface ArtifactSpec<TInput, TOutput> {
  /**
   * The canonical artifact type. Either a single static value (the common
   * case) OR a function of the run's input/output for agents whose artifact
   * type is DRIVEN by their input — e.g. `fos.personalized_follow_up` (issue
   * #82), whose `followUpType` selects one of the six §7.1 follow-up types.
   * Backward-compatible: a plain `ArtifactType` still satisfies this. The
   * resolved value must always be a member of the canonical `artifact_type`
   * enum (a function cannot widen it — its return type is `ArtifactType`).
   */
  artifactType: ArtifactType | ((input: TInput, output: TOutput) => ArtifactType);
  domain: ArtifactDomain;
  buildTitle(input: TInput, output: TOutput): string;
  buildBodyMarkdown(input: TInput, output: TOutput): string;
  buildClaimsManifest?(input: TInput, output: TOutput): unknown;
}

export interface SecondaryEvalResult {
  passed: boolean;
  notes?: string;
}

export interface EvalPolicy<TInput, TOutput> {
  /** Advisory only (D2 stage 8 is "optional secondary quality eval") — recorded
   * in `agent_run.secondary_eval_json` but never blocks a run; only stages 6-7
   * enforce. */
  secondaryEval?: (
    input: TInput,
    output: TOutput,
  ) => SecondaryEvalResult | Promise<SecondaryEvalResult>;
}

export interface ProjectionHookContext {
  deps: RunAgentDeps;
  runContext: RunAgentContext;
  mode: FeatureMode;
}

export interface PersistDomainHookContext {
  /**
   * IMPORTANT (issue #63): `deps.db` here is a TRANSACTION handle — the hook
   * runs inside the stage-9 transaction, so all its DB writes commit/roll back
   * atomically with the artifact. A throw rolls the whole stage back. Corollary:
   * this hook is for CANONICAL DB writes ONLY. Do NOT perform non-idempotent
   * external side effects here (email/HTTP/Notion) — the tx cannot roll those
   * back, and they re-execute on retry. External effects belong in the isolated
   * stage-11 `projection` hook. (Other `deps` clients, e.g. `notionClient`,
   * remain reachable but must not be used for side effects in this hook.)
   */
  deps: RunAgentDeps;
  runContext: RunAgentContext;
  agentRunId: string;
}

/**
 * Agent-definition contract (ADR-07 D3): versioned CODE, not data. Definitions
 * live in `src/definitions/` and are registered by `key`.
 */
export interface AgentDefinition<TInput, TOutput> {
  key: string;
  version: string;
  objective: string;
  inputSchema: ZodType<TInput>;
  outputSchema: ZodType<TOutput>;
  /** Defaults to DEFAULT_MODEL (Sonnet) when omitted. */
  model?: string;
  permittedTools: readonly string[];
  permittedMemoryScopes: readonly string[];
  /** The highest mode this agent's code permits, regardless of the workspace
   * feature-flag's configured mode (see mode.ts effectiveMode). */
  autonomyCeiling: FeatureMode;
  deterministicGates: ReadonlyArray<Gate<TInput, TOutput>>;
  evalPolicy?: EvalPolicy<TInput, TOutput>;
  /** `feature_flag.key` this definition reads at stage 2. */
  featureFlagKey: string;
  artifact: ArtifactSpec<TInput, TOutput>;
  /**
   * Optional stage-9 domain-persistence hook (issue #53): writes the agent's
   * own domain-specific canonical record (e.g. `enrollment_assessment`) right
   * after `createArtifact`, INSIDE stage 9's try block. Unlike the isolated
   * stage-11 projection, a `persistDomain` failure IS a run failure — this is
   * canonical state, not a best-effort external side effect, so it must fail
   * closed like any other stage-9 write. Optional: omitted by definitions
   * with no domain record to persist (e.g. the `fos.smoke` stub), which keep
   * working unchanged. NOTE (issue #63): runs INSIDE the stage-9 transaction —
   * `ctx.deps.db` is a tx handle; canonical DB writes only, no external
   * side effects (see PersistDomainHookContext).
   */
  persistDomain?: (
    ctx: PersistDomainHookContext,
    input: TInput,
    output: TOutput,
    artifactResult: CreateArtifactResult,
  ) => Promise<void>;
  /**
   * Optional stage-11 projection hook (REUSE `projectOpportunity`-shaped
   * adapters). Omitted by definitions with nothing to project (e.g. the
   * `fos.smoke` stub) — the stage then no-ops. Never invoked in shadow mode
   * (shadow: persist, don't surface).
   */
  projection?: (ctx: ProjectionHookContext, input: TInput, output: TOutput) => Promise<void>;
}
