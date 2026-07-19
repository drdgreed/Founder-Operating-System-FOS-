import { pgTable, uuid, text, timestamp, jsonb, pgEnum, uniqueIndex } from "drizzle-orm/pg-core";
import { fosWorkspace } from "./fos_workspace.js";

/**
 * WorkspaceCommand (issue #30, slice 0.2c) — the persisted founder-intent
 * queue. Notion reconciliation writes one PENDING row per page where a
 * founder edited a `working_copy_editable` property (spec §8.1); 0.2d will
 * later validate + route these rows into the 0.1c Approval service.
 *
 * This is a MINIMAL slice of the full spec §11.5 `WorkspaceCommand` — that
 * record also carries `workspace_integration_id`, `actor_user_id`,
 * `target_version`, `risk_level`, `correlation_id`, `idempotency_key`, and
 * (pre-PATCH-SET-01) separate `validation_status`/`execution_status`
 * fields. Those belong to the validation + execution machinery 0.2d builds;
 * this slice only needs to durably capture "what changed, on which record,
 * from which page" for 0.2d to pick up. Field set matches issue #30's own
 * spec literally.
 *
 * FLAG (PATCH-SET candidate — WorkspaceCommand `status` underspecified):
 * `status` here is a single-value enum (`pending`) rather than
 * PATCH-SET-01 §E1's canonical
 * received/validating/validated/queued/executing/succeeded/
 * failed_retryable/failed_terminal/rejected/conflict set — §E1 has no
 * `pending` state; its initial state is `received`. Issue #30's own field
 * list specifies `status (enum, default 'pending')` literally, and this
 * slice never transitions the row after insert (0.2d owns the full
 * lifecycle), so the enum is deliberately reduced to the one value this
 * slice ever writes — the same reduce-then-extend pattern
 * `workspace_integration_status` used (issue #24), pending the sub-slice
 * that drives the rest. 0.2d should reconcile `pending` against §E1
 * `received` when it implements the full lifecycle (either extend this
 * enum via a later migration, or rename `pending` -> `received` there).
 */
export const workspaceCommandStatusEnum = pgEnum("workspace_command_status", ["pending"]);

export const workspaceCommandProviderEnum = pgEnum("workspace_command_provider", ["notion"]);

export const workspaceCommandSourceEnum = pgEnum("workspace_command_source", ["notion_reconcile"]);

export const workspaceCommand = pgTable(
  "workspace_command",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => fosWorkspace.id),
    // Text, not uuid — mirrors `projection.entity_id`: not every future
    // entity_type is guaranteed to key on a uuid column.
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    provider: workspaceCommandProviderEnum("provider").notNull(),
    providerPageId: text("provider_page_id").notNull(),
    // FLAG (PATCH-SET candidate — command-type underspecified): free text,
    // not a pgEnum. None of spec §11.5's "Initial command types"
    // (approve_artifact, defer_item, propose_opportunity_stage_change, ...)
    // represent a generic "founder edited working-copy fields on a
    // provider record" — this slice's `propose_field_update` (see
    // adapter's reconcile.ts) is a new value not yet in §11.5/PATCH-SET-01
    // §E3's canonical command-type enum. Left as text so the schema
    // doesn't lock in an unratified value.
    commandType: text("command_type").notNull(),
    // The changed founder-editable fields (issue #30 build step 1):
    // `{ changes: { [field]: { from, to } }, providerFosVersion }`.
    payloadJson: jsonb("payload_json").notNull(),
    status: workspaceCommandStatusEnum("status").notNull().default("pending"),
    source: workspaceCommandSourceEnum("source").notNull().default("notion_reconcile"),
    providerLastEditedAt: timestamp("provider_last_edited_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Idempotency (issue #30 build step 1 + #29 fold-in): a reconcile run
    // with no NEW founder edit on a page must create ZERO new commands.
    // `provider_last_edited_at` only advances when the founder edits again,
    // so this tuple is stable across repeated reconcile runs over the same
    // unedited page — `reconcile()` inserts with `onConflictDoNothing`
    // against this exact index.
    pageEditUnique: uniqueIndex("workspace_command_page_edit_unique").on(
      table.provider,
      table.providerPageId,
      table.providerLastEditedAt,
    ),
  }),
);
