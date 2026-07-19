import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { enrollmentOpportunity, projection, workspaceCommand } from "@fos/db/schema";
import type { Db } from "@fos/db/services";
import type { NotionClient } from "@fos/notion";
import {
  enrollmentOpportunityReconcilableFields,
  type EnrollmentOpportunityRow,
} from "./enrollment-opportunity-mapper.js";
import { readNumberProperty, readRichTextProperty } from "./notion-properties.js";

/**
 * `payload_hash` (PR #31 review, ADR-06 line 19's "property-hash"): a
 * stable digest of the diff itself, independent of key order. Two
 * reconcile passes over the same page produce the same hash iff the
 * founder-editable diff is identical — so two DISTINCT edits that happen
 * to land in the same `last_edited_time` tick (a coarser clock than a
 * founder can realistically beat) still get two commands, instead of the
 * second (correct, larger) diff silently losing the
 * `onConflictDoNothing` race against the first.
 */
function computePayloadHash(changes: Record<string, { from: string | null; to: string | null }>) {
  const sortedEntries = Object.entries(changes).sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify(sortedEntries)).digest("hex");
}

export interface ReconcileInput {
  workspaceId: string;
  /** The Notion data source (database) id to poll — the Enrollment Pipeline. */
  dataSourceId: string;
}

export interface ReconcileResult {
  pagesProcessed: number;
  /** Pages whose `last_edited_time` <= their projection's `last_synced_at`. */
  unchanged: number;
  /** New `workspace_command` rows actually inserted (idempotency-deduped). */
  commandsCreated: number;
  /** Pages that flipped their projection to `sync_status = 'conflict'`
   * (a `canonical_read_only` property changed, or a duplicate `FOS Record ID`). */
  conflicts: number;
  /** Pages carrying a `FOS Record ID` with no matching `projection` row. */
  orphans: number;
  /** `FOS Record ID` values shared by 2+ pages in this run. */
  duplicateEntityIds: string[];
}

interface NotionPageResult {
  id?: unknown;
  last_edited_time?: unknown;
  properties?: Record<string, unknown>;
}

interface NotionQueryResponse {
  results?: unknown;
  has_more?: unknown;
  next_cursor?: unknown;
}

function isPageResult(value: unknown): value is NotionPageResult {
  return typeof value === "object" && value !== null;
}

/** Paginates `client.queryDataSource` to completion (ADR-06 §4 polling primitive). */
async function queryAllPages(
  client: NotionClient,
  dataSourceId: string,
): Promise<NotionPageResult[]> {
  const pages: NotionPageResult[] = [];
  let cursor: string | undefined;
  do {
    const body: Record<string, unknown> = cursor ? { start_cursor: cursor } : {};
    const response = (await client.queryDataSource(dataSourceId, body)) as NotionQueryResponse;
    const results = Array.isArray(response.results) ? response.results : [];
    for (const result of results) {
      if (isPageResult(result)) pages.push(result);
    }
    cursor =
      response.has_more === true && typeof response.next_cursor === "string"
        ? response.next_cursor
        : undefined;
  } while (cursor);
  return pages;
}

function extractPageId(page: NotionPageResult): string | null {
  return typeof page.id === "string" ? page.id : null;
}

function extractLastEditedTime(page: NotionPageResult): Date | null {
  if (typeof page.last_edited_time !== "string") return null;
  const date = new Date(page.last_edited_time);
  return Number.isNaN(date.getTime()) ? null : date;
}

function extractFosRecordId(page: NotionPageResult): string | null {
  return readRichTextProperty(page.properties?.["FOS Record ID"]);
}

/**
 * Diffs a page's `working_copy_editable`/`canonical_read_only` properties
 * (per `enrollmentOpportunityReconcilableFields`, §8.1/§8.2) against the
 * canonical opportunity row.
 */
function diffPage(
  page: NotionPageResult,
  opportunity: EnrollmentOpportunityRow,
): {
  readOnlyChanged: boolean;
  editableChanges: Record<string, { from: string | null; to: string | null }>;
} {
  const editableChanges: Record<string, { from: string | null; to: string | null }> = {};
  let readOnlyChanged = false;

  for (const [field, def] of Object.entries(enrollmentOpportunityReconcilableFields)) {
    const providerValue = def.readValue(page.properties?.[def.propertyName]);
    const canonicalValue = def.canonicalValue(opportunity);
    if (providerValue === canonicalValue) continue;

    if (def.ownership === "canonical_read_only") {
      readOnlyChanged = true;
    } else {
      editableChanges[field] = { from: canonicalValue, to: providerValue };
    }
  }

  return { readOnlyChanged, editableChanges };
}

/**
 * Polls Notion for `EnrollmentOpportunity` pages, detects founder edits
 * against the `projection` table's `last_synced_at` cursor, and turns them
 * into canonical `workspace_command` rows (issue #30, slice 0.2c — the
 * INBOUND mirror of 0.2b's `projectOpportunity`).
 *
 * Classification (spec §8.3 conflict policy, §12.4 projection state machine):
 * - `last_edited_time <= last_synced_at` -> no founder change -> leave `in_sync`.
 * - a `working_copy_editable` property differs from canonical -> founder
 *   edit -> exactly ONE pending `workspace_command` capturing the diff,
 *   projection -> `provider_ahead`.
 * - a `canonical_read_only` property differs from canonical -> FOS-owned
 *   field was edited in Notion -> projection -> `conflict`, NO command
 *   (canonical wins; flagged for the founder, per spec §8.3 "do not
 *   overwrite either side").
 * - 2+ pages sharing one `FOS Record ID` -> duplicate (issue #29 item 1's
 *   dual-write window, or external) -> the tracked projection ->
 *   `conflict`, flagged, no command; NEITHER page's diff is processed
 *   (which one is "real" is a founder decision, not this slice's).
 * - a `FOS Record ID` with no matching `projection` row -> orphan -> flagged,
 *   no command, no crash.
 *
 * Never mutates or deletes a Notion page (issue #30 constraint — detect and
 * flag only; 0.2d owns applying an approved command back to canonical
 * state, and neither slice writes to Notion from the inbound direction).
 */
export async function reconcile(
  db: Db,
  client: NotionClient,
  input: ReconcileInput,
): Promise<ReconcileResult> {
  const { workspaceId, dataSourceId } = input;
  const pages = await queryAllPages(client, dataSourceId);

  const result: ReconcileResult = {
    pagesProcessed: pages.length,
    unchanged: 0,
    commandsCreated: 0,
    conflicts: 0,
    orphans: 0,
    duplicateEntityIds: [],
  };

  // First pass: group pages by FOS Record ID so a duplicate is detected
  // (and excluded from per-page processing) BEFORE any diff/command work
  // runs for either copy — order of pages within a single query response
  // must not decide which copy "wins".
  const pagesByEntityId = new Map<string, NotionPageResult[]>();
  const untagged: NotionPageResult[] = [];
  for (const page of pages) {
    const entityId = extractFosRecordId(page);
    if (!entityId) {
      untagged.push(page);
      continue;
    }
    const group = pagesByEntityId.get(entityId);
    if (group) group.push(page);
    else pagesByEntityId.set(entityId, [page]);
  }

  // Pages with no parseable `FOS Record ID` at all can't be matched to any
  // projection — flag as orphans, no crash (issue #29 item 4/#30 constraint).
  result.orphans += untagged.length;

  for (const [entityId, group] of pagesByEntityId) {
    if (group.length > 1) {
      result.duplicateEntityIds.push(entityId);
      await db
        .update(projection)
        .set({ syncStatus: "conflict", updatedAt: new Date() })
        .where(
          and(
            eq(projection.workspaceId, workspaceId),
            eq(projection.entityType, "EnrollmentOpportunity"),
            eq(projection.entityId, entityId),
            eq(projection.provider, "notion"),
          ),
        );
      result.conflicts += 1;
      continue;
    }

    const page = group[0];
    if (!page) continue; // unreachable (group.length === 1), keeps TS satisfied
    await reconcilePage(db, workspaceId, entityId, page, result);
  }

  return result;
}

async function reconcilePage(
  db: Db,
  workspaceId: string,
  entityId: string,
  page: NotionPageResult,
  result: ReconcileResult,
): Promise<void> {
  const pageId = extractPageId(page);
  const lastEditedTime = extractLastEditedTime(page);
  if (!pageId || !lastEditedTime) {
    // Malformed page (missing id / unparseable last_edited_time) — flag,
    // never crash the run over one bad record (issue #29 item 4).
    result.orphans += 1;
    return;
  }

  const [proj] = await db
    .select()
    .from(projection)
    .where(
      and(
        eq(projection.workspaceId, workspaceId),
        eq(projection.entityType, "EnrollmentOpportunity"),
        eq(projection.entityId, entityId),
        eq(projection.provider, "notion"),
      ),
    )
    .limit(1);

  if (!proj) {
    // No projection row for this FOS Record ID — orphan (issue #29 item 1:
    // 0.2b's dual-write window, or a page created outside FOS). Flag only;
    // never delete/mutate the Notion page.
    result.orphans += 1;
    return;
  }

  if (!proj.lastSyncedAt || lastEditedTime.getTime() <= proj.lastSyncedAt.getTime()) {
    result.unchanged += 1;
    return;
  }

  const [opportunity] = await db
    .select()
    .from(enrollmentOpportunity)
    .where(eq(enrollmentOpportunity.id, entityId))
    .limit(1);
  if (!opportunity) {
    // Projection points at a canonical row that no longer exists — flag,
    // don't crash.
    result.orphans += 1;
    return;
  }

  const { readOnlyChanged, editableChanges } = diffPage(page, opportunity);

  if (readOnlyChanged) {
    await db
      .update(projection)
      .set({ syncStatus: "conflict", updatedAt: new Date() })
      .where(eq(projection.id, proj.id));
    result.conflicts += 1;
    return;
  }

  if (Object.keys(editableChanges).length === 0) {
    // `last_edited_time` advanced but nothing this slice tracks actually
    // differs (e.g. an edit to an unmapped property) — leave sync_status
    // untouched; nothing actionable to flag or queue.
    return;
  }

  const providerFosVersion = readNumberProperty(page.properties?.["FOS Version"]);
  const [inserted] = await db
    .insert(workspaceCommand)
    .values({
      workspaceId,
      entityType: "EnrollmentOpportunity",
      entityId,
      provider: "notion",
      providerPageId: pageId,
      commandType: "propose_field_update",
      payloadJson: { changes: editableChanges, providerFosVersion },
      payloadHash: computePayloadHash(editableChanges),
      providerLastEditedAt: lastEditedTime,
    })
    .onConflictDoNothing({
      target: [
        workspaceCommand.provider,
        workspaceCommand.providerPageId,
        workspaceCommand.providerLastEditedAt,
        workspaceCommand.payloadHash,
      ],
    })
    .returning();

  if (inserted) result.commandsCreated += 1;

  await db
    .update(projection)
    .set({ syncStatus: "provider_ahead", updatedAt: new Date() })
    .where(eq(projection.id, proj.id));
}
