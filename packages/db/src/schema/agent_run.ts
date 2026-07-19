import { pgTable, uuid, text, timestamp, integer, jsonb, pgEnum, index } from "drizzle-orm/pg-core";
import { fosWorkspace } from "./fos_workspace.js";

/**
 * AgentRun (ADR-07 D5, issue #48 P1.0) — the audit spine every Phase-1 agent
 * run writes. A run row mutates through `status` during execution; treat the
 * raw row as immutable-by-convention (no append-only trigger — unlike
 * `operational_event`, a run legitimately transitions queued -> running ->
 * a terminal status). A superseding run references the prior via
 * `causation_id` (kept as a bare nullable uuid, no self-referential FK — the
 * same "polymorphic-shaped, not FK'd" treatment `operational_event.causation_id`
 * already uses in this codebase).
 *
 * `agent_key`/`agent_version`/`prompt_version` are the versioned-definition
 * coordinates (D3); the runtime + agent definitions themselves are P1.1 —
 * this slice is schema only.
 */
export const agentRunFeatureModeEnum = pgEnum("agent_run_feature_mode", [
  "shadow",
  "review",
  "live",
]);

export const agentRunStatusEnum = pgEnum("agent_run_status", [
  "queued",
  "running",
  "succeeded",
  "evaluation_failed",
  "policy_blocked",
  "error",
]);

export const agentRun = pgTable(
  "agent_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => fosWorkspace.id),
    agentKey: text("agent_key").notNull(),
    agentVersion: text("agent_version").notNull(),
    promptVersion: text("prompt_version").notNull(),
    trigger: text("trigger").notNull(),
    actorJson: jsonb("actor_json").notNull(),
    featureMode: agentRunFeatureModeEnum("feature_mode").notNull(),
    contextManifestJson: jsonb("context_manifest_json").notNull(),
    inputRef: text("input_ref"),
    status: agentRunStatusEnum("status").notNull().default("queued"),
    model: text("model"),
    outputRef: text("output_ref"),
    deterministicEvalJson: jsonb("deterministic_eval_json"),
    secondaryEvalJson: jsonb("secondary_eval_json"),
    latencyMs: integer("latency_ms"),
    costJson: jsonb("cost_json"),
    retryCount: integer("retry_count").notNull().default(0),
    correlationId: uuid("correlation_id").notNull(),
    // Points at the superseded agent_run row (D5); bare uuid, no self-FK — see
    // header note (mirrors operational_event.causation_id).
    causationId: uuid("causation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // P1.1 index migration (issue #50, folds in the P1.0 gate NIT): audit
    // reconstruction and dashboard reads both filter by correlation_id and by
    // (workspace_id, agent_key) — neither had an index until this slice.
    correlationIdIdx: index("agent_run_correlation_id_idx").on(table.correlationId),
    workspaceIdAgentKeyIdx: index("agent_run_workspace_id_agent_key_idx").on(
      table.workspaceId,
      table.agentKey,
    ),
  }),
);
