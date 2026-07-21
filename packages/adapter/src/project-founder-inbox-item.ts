import { and, eq } from "drizzle-orm";
import { projection } from "@fos/db/schema";
import type { Db } from "@fos/db/services";
import type { NotionClient } from "@fos/notion";
import {
  artifactToFounderInboxProperties,
  artifactFosVersion,
  type ArtifactRecordRow,
  type ProjectionSyncStatus,
} from "./founder-inbox-mapper.js";

export interface ProjectFounderInboxItemInput {
  /** An ArtifactRecord in a founder-action state (`in_review` | `ready_for_action`). */
  artifact: ArtifactRecordRow;
  /** Target Notion data source (database) id for the Founder Inbox. */
  dataSourceId: string;
}

export interface ProjectFounderInboxItemResult {
  projectionId: string;
  providerPageId: string;
  syncStatus: ProjectionSyncStatus;
  /** true if this call created the Notion page; false if it updated an existing one. */
  created: boolean;
}

function extractPageId(page: unknown): string {
  if (
    typeof page === "object" &&
    page !== null &&
    "id" in page &&
    typeof (page as { id: unknown }).id === "string"
  ) {
    return (page as { id: string }).id;
  }
  throw new Error("projectFounderInboxItem: Notion createPage response missing a string id");
}

/**
 * Projects one founder-action ArtifactRecord to its Notion Founder Inbox page
 * (issue #90, slice P1.5c). Modeled on `projectOpportunity`: upserts on the
 * `projection` table's (workspace_id, entity_type, entity_id, provider) unique
 * index with `entity_type = "ArtifactRecord"`.
 * - no existing row (or one with no `provider_page_id` yet) -> `createPage`,
 *   store the returned page id.
 * - existing row with a `provider_page_id` -> `updatePageProperties` on that
 *   SAME page (no duplicate page is ever created).
 *
 * Idempotent on (workspace, ArtifactRecord, artifact.id): calling this twice
 * for the same artifact always resolves to the same `provider_page_id` and a
 * single projection row.
 *
 * The projection row's `fos_version` is the §C2 epoch-derived value (epoch
 * seconds of `updated_at`), IDENTICAL to the hidden "FOS Version" property, so
 * the row and the page agree on the staleness key for an unversioned entity.
 */
export async function projectFounderInboxItem(
  db: Db,
  client: NotionClient,
  input: ProjectFounderInboxItemInput,
): Promise<ProjectFounderInboxItemResult> {
  const { artifact, dataSourceId } = input;

  const [existing] = await db
    .select()
    .from(projection)
    .where(
      and(
        eq(projection.workspaceId, artifact.workspaceId),
        eq(projection.entityType, "ArtifactRecord"),
        eq(projection.entityId, artifact.id),
        eq(projection.provider, "notion"),
      ),
    )
    .limit(1);

  const now = new Date();
  const fosVersion = artifactFosVersion(artifact.updatedAt);
  const properties = artifactToFounderInboxProperties(artifact, {
    workspaceId: artifact.workspaceId,
    productId: artifact.productId,
    syncStatus: "in_sync",
    lastSyncedAt: now,
  });

  let providerPageId: string;
  let created: boolean;
  if (existing?.providerPageId) {
    await client.updatePageProperties(existing.providerPageId, properties);
    providerPageId = existing.providerPageId;
    created = false;
  } else {
    const page = await client.createPage({
      parent: { data_source_id: dataSourceId },
      properties,
    });
    providerPageId = extractPageId(page);
    created = true;
  }

  const [row] = await db
    .insert(projection)
    .values({
      workspaceId: artifact.workspaceId,
      productId: artifact.productId,
      entityType: "ArtifactRecord",
      entityId: artifact.id,
      provider: "notion",
      providerPageId,
      syncStatus: "in_sync",
      fosVersion,
      lastSyncedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        projection.workspaceId,
        projection.entityType,
        projection.entityId,
        projection.provider,
      ],
      set: {
        providerPageId,
        syncStatus: "in_sync",
        fosVersion,
        lastSyncedAt: now,
        updatedAt: now,
      },
    })
    .returning();
  if (!row) throw new Error("projectFounderInboxItem: projection upsert returned no row");

  return {
    projectionId: row.id,
    providerPageId,
    syncStatus: row.syncStatus,
    created,
  };
}
