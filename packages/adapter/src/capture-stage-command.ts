import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  enrollmentOpportunity,
  opportunityStageEnum,
  projection,
  workspaceCommand,
} from "@fos/db/schema";
import type { Db } from "@fos/db/services";
import type { NotionClient } from "@fos/notion";
import { readNumberProperty, readSelectProperty } from "./notion-properties.js";
import { groupPagesByEntityId, queryAllPages, type NotionPageResult } from "./reconcile.js";

const COMMAND_TYPE = "propose_opportunity_stage_change";
const LEGAL_STAGES = new Set<string>(opportunityStageEnum.enumValues);

export interface CaptureStageCommandsInput {
  workspaceId: string;
  /** The Notion data source (database) id to poll — the Enrollment Pipeline. */
  dataSourceId: string;
  /**
   * The Notion workspace_integration this poll ran against. Nullable per the
   * issue (§11.5 `workspace_integration_id` FK is "nullable acceptable if
   * integration wiring isn't present in tests"). FLAG (PATCH-SET candidate):
   * the spec's §S3 `idempotency_key` formula assumes an `integration_id` is
   * always available; when this is null, `dataSourceId` stands in for it in
   * the hash so the key stays deterministic per Notion connection.
   */
  workspaceIntegrationId: string | null;
}

export interface CaptureStageCommandsResult {
  pagesProcessed: number;
  /** New `propose_opportunity_stage_change` commands inserted in `received` status. */
  proposed: number;
  /** New commands inserted in `rejected` status — the page's Stage value isn't a legal opportunity stage. */
  rejectedIllegalStage: number;
  /** Pages whose Stage matches canonical — no command needed. */
  unchanged: number;
  /** Pages whose `FOS Version` doesn't match canonical (§8.3) — not captured; 0.2c already flags the projection. */
  versionConflicts: number;
  /** Pages with no matching `projection` row, no canonical row, a duplicate `FOS Record ID`, or no parseable `FOS Record ID` — not captured. */
  skipped: number;
  /** A candidate command whose `idempotency_key` already exists — re-poll of an already-captured edit, correctly deduped. */
  duplicatesDeduped: number;
}

function emptyResult(pagesProcessed: number): CaptureStageCommandsResult {
  return {
    pagesProcessed,
    proposed: 0,
    rejectedIllegalStage: 0,
    unchanged: 0,
    versionConflicts: 0,
    skipped: 0,
    duplicatesDeduped: 0,
  };
}

/** PATCH-SET-01 §S3: `SHA-256(integration_id + ':' + provider_event_id + ':' + command_type)`. */
function deriveCommandIdempotencyKey(integrationId: string, providerEventId: string): string {
  return createHash("sha256")
    .update(`${integrationId}:${providerEventId}:${COMMAND_TYPE}`)
    .digest("hex");
}

/**
 * Polls Notion for `EnrollmentOpportunity` pages and CAPTURES a founder's
 * `Stage` edit as a persisted `propose_opportunity_stage_change`
 * `WorkspaceCommand` (issue #33, slice 0.2d). Reuses 0.2c's poll
 * (`queryAllPages`) and `FOS Record ID` grouping (`groupPagesByEntityId`)
 * so duplicate/orphan pages are classified identically to `reconcile`.
 *
 * This function never validates or executes a command against canonical and
 * never routes to Approval (0.2e) — it only inserts `workspace_command` rows.
 * It never writes to `projection` (that stays `reconcile`'s job).
 *
 * Per §8.3 / the issue's Build spec:
 * - page `FOS Version` !== canonical `opportunity.version` (or unreadable) ->
 *   §8.3 conflict -> no command captured.
 * - page `FOS Version` === canonical, and page `Stage` === canonical
 *   `opportunity.stage` -> no edit -> no command.
 * - page `FOS Version` === canonical, page `Stage` differs, and the value is
 *   a legal opportunity stage -> INSERT `status='received'`.
 * - page `FOS Version` === canonical, page `Stage` differs, and the value is
 *   NOT a legal opportunity stage -> INSERT `status='rejected'` with a
 *   `rejection_reason` — never let an invalid provider value become an
 *   actionable command.
 *
 * `idempotency_key` derives from the page id + captured `target_version` + a
 * hash of the proposed `{from,to}` Stage transition (ADR-06's `page_id +
 * property-hash`), so re-polling the SAME edit dedups via `onConflictDoNothing`
 * on the UNIQUE `idempotency_key`, while a DIFFERENT edit — whether at a later
 * version (post-0.2e execution) or a second edit at the same version before
 * execution — is captured distinctly.
 */
export async function captureStageCommands(
  db: Db,
  client: NotionClient,
  input: CaptureStageCommandsInput,
): Promise<CaptureStageCommandsResult> {
  const { workspaceId, dataSourceId, workspaceIntegrationId } = input;
  const pages = await queryAllPages(client, dataSourceId);
  const result = emptyResult(pages.length);

  const { pagesByEntityId, untagged } = groupPagesByEntityId(pages);
  result.skipped += untagged.length;

  for (const [entityId, group] of pagesByEntityId) {
    if (group.length > 1) {
      // Duplicate FOS Record ID across pages — 0.2c already flags this as a
      // projection conflict; which copy is "real" is a founder decision, not
      // this slice's, so neither is captured.
      result.skipped += 1;
      continue;
    }
    await captureForPage(
      db,
      workspaceId,
      dataSourceId,
      workspaceIntegrationId,
      entityId,
      group[0]!,
      result,
    );
  }

  return result;
}

async function captureForPage(
  db: Db,
  workspaceId: string,
  dataSourceId: string,
  workspaceIntegrationId: string | null,
  entityId: string,
  page: NotionPageResult,
  result: CaptureStageCommandsResult,
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
    result.skipped += 1;
    return;
  }

  const [opportunity] = await db
    .select()
    .from(enrollmentOpportunity)
    .where(eq(enrollmentOpportunity.id, entityId))
    .limit(1);
  if (!opportunity) {
    result.skipped += 1;
    return;
  }

  // §8.3 — a controlled command validates only if the provider `FOS Version`
  // equals canonical; an unreadable version is never assumed in-sync.
  const providerVersion = readNumberProperty(page.properties?.["FOS Version"]);
  if (providerVersion === null || providerVersion !== opportunity.version) {
    result.versionConflicts += 1;
    return;
  }

  const pageStage = readSelectProperty(page.properties?.["Stage"]);
  if (pageStage === null || pageStage === opportunity.stage) {
    result.unchanged += 1;
    return;
  }

  const isLegalStage = LEGAL_STAGES.has(pageStage);
  const pageId = typeof page.id === "string" ? page.id : entityId;
  // ADR-06 (line 19): captured commands dedup on `page_id + property-hash +
  // nonce`. The property-hash — here a hash of the proposed `{from,to}` Stage
  // transition — is load-bearing: capture never bumps the version (only 0.2e
  // does, after approval), so WITHOUT the payload in the key a second, DIFFERENT
  // edit made before execution would share `pageId:version` with the first and
  // be silently dropped by onConflictDoNothing, leaving a stale command queued.
  // With it: a true re-poll of one edit (same from/to) still dedups, while a
  // genuinely different edit at the same version is captured distinctly (0.2e's
  // §8.3 version guard resolves multiple pending commands at execution time).
  const payloadHash = createHash("sha256")
    .update(`${opportunity.stage}:${pageStage}`)
    .digest("hex");
  const providerEventId = `${pageId}:${opportunity.version}:${payloadHash}`;
  const integrationIdForHash = workspaceIntegrationId ?? dataSourceId;
  const idempotencyKey = deriveCommandIdempotencyKey(integrationIdForHash, providerEventId);

  const [inserted] = await db
    .insert(workspaceCommand)
    .values({
      workspaceId,
      workspaceIntegrationId,
      sourceProviderRecordId: pageId,
      commandType: COMMAND_TYPE,
      targetEntityType: "EnrollmentOpportunity",
      targetEntityId: opportunity.id,
      targetVersion: opportunity.version,
      payloadJson: { from: opportunity.stage, to: pageStage },
      status: isLegalStage ? "received" : "rejected",
      rejectionReason: isLegalStage
        ? null
        : `Illegal Stage value "${pageStage}": not a legal opportunity stage`,
      idempotencyKey,
    })
    .onConflictDoNothing({ target: workspaceCommand.idempotencyKey })
    .returning();

  if (!inserted) {
    result.duplicatesDeduped += 1;
    return;
  }
  if (isLegalStage) result.proposed += 1;
  else result.rejectedIllegalStage += 1;
}
