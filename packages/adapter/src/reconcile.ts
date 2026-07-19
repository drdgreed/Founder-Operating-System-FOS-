import { and, eq } from "drizzle-orm";
import { enrollmentOpportunity, projection } from "@fos/db/schema";
import type { Db } from "@fos/db/services";
import type { NotionClient } from "@fos/notion";
import { readNumberProperty, readRichTextProperty } from "./notion-properties.js";

export interface ReconcileInput {
  workspaceId: string;
  /** The Notion data source (database) id to poll — the Enrollment Pipeline. */
  dataSourceId: string;
}

export interface ReconcileResult {
  pagesProcessed: number;
  /** Pages whose page `FOS Version` matches canonical — projection is current. */
  inSync: number;
  /** Pages flipped to `sync_status = 'conflict'`: a page `FOS Version` that
   * differs from canonical (§8.3 — the founder edited a stale projection, or
   * canonical advanced underneath), an unreadable `FOS Version`, or a
   * duplicate `FOS Record ID` across 2+ pages. */
  conflicts: number;
  /** Pages carrying a `FOS Record ID` with no matching `projection` row (or no
   * canonical opportunity), or no parseable `FOS Record ID` at all. */
  orphans: number;
  /** `FOS Record ID` values shared by 2+ pages in this run. */
  duplicateEntityIds: string[];
}

export interface NotionPageResult {
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

/**
 * Paginates `client.queryDataSource` to completion (ADR-06 §4 polling
 * primitive). Exported so 0.2d's `captureStageCommands` reuses the same poll
 * (per the issue's instruction to reuse 0.2c's poll/grouping/version logic).
 */
export async function queryAllPages(
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

/** Exported for reuse by 0.2d's `captureStageCommands`. */
export function extractFosRecordId(page: NotionPageResult): string | null {
  return readRichTextProperty(page.properties?.["FOS Record ID"]);
}

/**
 * Groups pages by `FOS Record ID`, separating out pages with no parseable id.
 * Exported so 0.2d's `captureStageCommands` applies the SAME duplicate/orphan
 * classification before ever version-checking a page (order of pages within
 * a query response must not decide which copy "wins" — see `reconcile`'s use
 * below).
 */
export function groupPagesByEntityId(pages: NotionPageResult[]): {
  pagesByEntityId: Map<string, NotionPageResult[]>;
  untagged: NotionPageResult[];
} {
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
  return { pagesByEntityId, untagged };
}

/**
 * Polls Notion for `EnrollmentOpportunity` pages and performs the INBOUND
 * INTEGRITY CHECK half of the adapter (issue #30, slice 0.2c — the mirror of
 * 0.2b's outbound `projectOpportunity`). It detects when a projected page has
 * drifted out of agreement with canonical and flags it; it never mutates
 * Notion, and it does not capture founder edits into commands (that is 0.2d,
 * which will define a founder-editable field, a provider-clock cursor, and the
 * ADR-06 property-hash command-dedup key together).
 *
 * The drift signal is the §C1 hidden **`FOS Version`** property, which is exact
 * and clock-skew-free (unlike `last_edited_time`, whose coarse granularity and
 * our-own-write asymmetry made it unsafe for this direction). Per spec §8.3:
 *
 *   "Notion projected version equals canonical version?
 *      yes -> validate and apply command / create artifact version
 *      no  -> create sync conflict; do not overwrite either side"
 *
 * Classification:
 * - page `FOS Version` === canonical `version` -> `inSync` (projection is
 *   current; capturing any founder edit on it is 0.2d's job). Not written.
 * - page `FOS Version` !== canonical `version`, OR an unreadable `FOS Version`
 *   -> §8.3 sync conflict -> projection `sync_status = 'conflict'`, do not
 *   overwrite either side.
 * - 2+ pages sharing one `FOS Record ID` -> duplicate (issue #29 item 1's
 *   dual-write window, or external) -> the tracked projection -> `conflict`,
 *   flagged; NEITHER copy is version-checked (which one is "real" is a founder
 *   decision, not this slice's).
 * - a `FOS Record ID` with no matching `projection` row / no canonical row, or
 *   no parseable `FOS Record ID` at all -> orphan -> flagged, no crash.
 *
 * Conflict is the only state this slice WRITES — a version-matched projection
 * is left untouched, so reconcile can never clobber a state another flow set.
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
    inSync: 0,
    conflicts: 0,
    orphans: 0,
    duplicateEntityIds: [],
  };

  // First pass: group pages by FOS Record ID so a duplicate is detected (and
  // excluded from per-page processing) BEFORE either copy is version-checked —
  // order of pages within a query response must not decide which copy "wins".
  const { pagesByEntityId, untagged } = groupPagesByEntityId(pages);

  // Pages with no parseable `FOS Record ID` at all can't be matched to any
  // projection — flag as orphans, no crash (issue #29 item 4 / #30 constraint).
  result.orphans += untagged.length;

  for (const [entityId, group] of pagesByEntityId) {
    if (group.length > 1) {
      result.duplicateEntityIds.push(entityId);
      await flagConflict(db, workspaceId, entityId);
      result.conflicts += 1;
      continue;
    }
    await reconcilePage(db, workspaceId, entityId, group[0]!, result);
  }

  return result;
}

async function flagConflict(db: Db, workspaceId: string, entityId: string): Promise<void> {
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
}

async function reconcilePage(
  db: Db,
  workspaceId: string,
  entityId: string,
  page: NotionPageResult,
  result: ReconcileResult,
): Promise<void> {
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

  // §8.3 version check — the skew-free drift signal. An unreadable version is
  // treated as "not equal": never assume in-sync when the stamp can't be read.
  const providerVersion = readNumberProperty(page.properties?.["FOS Version"]);
  if (providerVersion === null || providerVersion !== opportunity.version) {
    await db
      .update(projection)
      .set({ syncStatus: "conflict", updatedAt: new Date() })
      .where(eq(projection.id, proj.id));
    result.conflicts += 1;
    return;
  }

  // Versions agree — the projection reflects current canonical. Leave its
  // sync_status untouched (no clobber); just count it.
  result.inSync += 1;
}
