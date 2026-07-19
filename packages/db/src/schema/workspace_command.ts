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
    // SHA-256(JSON.stringify(payloadJson.changes, sorted keys)) — see
    // `computePayloadHash` in adapter's reconcile.ts. Added after PR #31
    // review (Verifier B): ADR-06 line 19 dedupes captured commands on
    // "page_id + property-hash + button nonce", not `last_edited_time`
    // alone. Notion's `last_edited_time` granularity can coarsen two
    // distinct founder edits into one tick; without this column, the
    // SECOND edit's (larger, correct) diff silently loses the
    // `onConflictDoNothing` race against the first edit's (stale, partial)
    // diff already occupying the (page, tick) slot — a real command loss,
    // not just a duplicate. Included in the unique index below.
    payloadHash: text("payload_hash").notNull(),
    status: workspaceCommandStatusEnum("status").notNull().default("pending"),
    source: workspaceCommandSourceEnum("source").notNull().default("notion_reconcile"),
    providerLastEditedAt: timestamp("provider_last_edited_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Idempotency (issue #30 build step 1 + #29 fold-in, tightened per PR #31
    // review): a reconcile run with no NEW founder edit on a page must
    // create ZERO new commands, but two edits landing in the same
    // `last_edited_time` tick must NOT collapse into one (see
    // `payloadHash` above / ADR-06 line 19). `(provider, provider_page_id,
    // provider_last_edited_at, payload_hash)` is stable across repeated
    // reconcile runs over the same unedited page, and distinct for any
    // pair of runs whose diff actually differs — `reconcile()` inserts
    // with `onConflictDoNothing` against this exact index.
    pageEditUnique: uniqueIndex("workspace_command_page_edit_unique").on(
      table.provider,
      table.providerPageId,
      table.providerLastEditedAt,
      table.payloadHash,
    ),
  }),
);
