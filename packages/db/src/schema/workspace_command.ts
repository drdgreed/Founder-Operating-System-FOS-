import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  pgEnum,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { fosWorkspace } from "./fos_workspace.js";
import { workspaceIntegration } from "./workspace_integration.js";

/**
 * WorkspaceCommand (spec §11.5, status model per PATCH-SET-01 §E1) — a
 * founder action captured from a workspace provider (issue #33, slice 0.2d).
 * This slice's writer is `captureStageCommands` in `@fos/adapter`: it CAPTURES
 * a Notion `Stage` edit as a command in `received` status. It does not
 * validate/execute the command against canonical and does not route it to
 * Approval — that is 0.2e (§9.14).
 *
 * §E1 replaces P0 §11.5's `validation_status` + `execution_status` pair with a
 * single `status` enum enumerating every §12.3 state. Both original columns
 * are kept nullable per the issue's Build spec (deferred detail carriers for
 * the 0.2e validate/execute slice), alongside the authoritative `status`.
 */
export const workspaceCommandStatusEnum = pgEnum("workspace_command_status", [
  "received",
  "validating",
  "validated",
  "queued",
  "executing",
  "succeeded",
  "failed_retryable",
  "failed_terminal",
  "rejected",
  "conflict",
]);

// PATCH-SET-01 §S2: Approval.risk_level & WorkspaceCommand.risk_level share this set.
export const workspaceCommandRiskLevelEnum = pgEnum("workspace_command_risk_level", [
  "low",
  "medium",
  "high",
]);

export const workspaceCommand = pgTable(
  "workspace_command",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => fosWorkspace.id),
    // Nullable per the issue: integration wiring is not present in every test
    // context this slice runs against.
    workspaceIntegrationId: uuid("workspace_integration_id").references(
      () => workspaceIntegration.id,
    ),
    // The Notion page id the command was captured from.
    sourceProviderRecordId: text("source_provider_record_id").notNull(),
    // No true webhook event exists yet in this poll-based capture (0.2f adds
    // webhooks) — left nullable, unset by this slice's writer.
    sourceEventId: text("source_event_id"),
    // §11.5 "Initial command types" / PATCH-SET-01 §E3 canonical enum — text,
    // not a pgEnum, per the issue's explicit Build spec (value is the single
    // existing `propose_opportunity_stage_change` this slice writes).
    commandType: text("command_type").notNull(),
    targetEntityType: text("target_entity_type").notNull(),
    targetEntityId: text("target_entity_id").notNull(),
    // The canonical `version` (§C2) the command was proposed against.
    targetVersion: integer("target_version").notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    // §E1 single source of truth for command lifecycle. Default `received`
    // per §E1 (NOT `pending` — PR #31/issue #29 deferred this; resolved here).
    status: workspaceCommandStatusEnum("status").notNull().default("received"),
    // Original P0 §11.5 fields, superseded as the lifecycle carrier by
    // `status` (§E1) but kept as nullable detail carriers for 0.2e.
    validationStatus: text("validation_status"),
    executionStatus: text("execution_status"),
    riskLevel: workspaceCommandRiskLevelEnum("risk_level"),
    rejectionReason: text("rejection_reason"),
    // No upstream event to correlate against in this poll-based capture path;
    // each captured command gets its own correlation id. FLAG (PATCH-SET
    // candidate): the spec does not define correlation_id derivation for a
    // capture (as opposed to command-issued-via-event) path.
    correlationId: uuid("correlation_id").notNull().defaultRandom(),
    // PATCH-SET-01 §S3: SHA-256(integration_id + ':' + provider_event_id + ':' + command_type).
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idempotencyKeyUnique: uniqueIndex("workspace_command_idempotency_key_unique").on(
      table.idempotencyKey,
    ),
  }),
);
