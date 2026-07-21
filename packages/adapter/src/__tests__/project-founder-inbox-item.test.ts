import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { NotionClient, type FetchLike } from "@fos/notion";
import { projection, artifactRecord } from "@fos/db/schema";
import { projectFounderInboxItem } from "../project-founder-inbox-item.js";
import { artifactFosVersion, type ArtifactRecordRow } from "../founder-inbox-mapper.js";
import { createTestDb, seedOpportunity } from "./test-db.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
}

function makeMockNotion(nextPageId = "notion-page-1") {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (path, init) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (method === "POST" && path.endsWith("/pages")) {
      return jsonResponse(200, { object: "page", id: nextPageId });
    }
    if (method === "PATCH" && path.includes("/pages/")) {
      return jsonResponse(200, { object: "page", id: path.split("/pages/")[1] });
    }
    throw new Error(`unexpected call in mock: ${method} ${path}`);
  };
  const client = new NotionClient({ fetchImpl, requestsPerSecond: 100 });
  return { client, calls };
}

/** Pull the `properties` object off the recorded POST /pages (createPage) call. */
function createdPageProperties(calls: RecordedCall[]): Record<string, unknown> {
  const create = calls.find((c) => c.method === "POST" && c.path.endsWith("/pages"));
  if (!create) throw new Error("no createPage (POST /pages) call was recorded");
  return (create.body as { properties: Record<string, unknown> }).properties;
}

/** Seed one founder-action ArtifactRecord in a fresh workspace. */
async function seedArtifact(
  db: Awaited<ReturnType<typeof createTestDb>>["db"],
  overrides: Partial<typeof artifactRecord.$inferInsert> = {},
): Promise<ArtifactRecordRow> {
  const { workspace, product } = await seedOpportunity(db);
  const [artifact] = await db
    .insert(artifactRecord)
    .values({
      workspaceId: workspace.id,
      productId: product.id,
      artifactType: "objection_response",
      domain: "enrollment",
      title: "Objection response draft",
      status: "in_review",
      updatedAt: new Date("2026-07-18T12:00:00Z"),
      ...overrides,
    })
    .returning();
  if (!artifact) throw new Error("seedArtifact: artifact_record insert returned no row");
  return artifact;
}

describe("projectFounderInboxItem (issue #90, P1.5c)", () => {
  const originalToken = process.env.FOS_NOTION_TOKEN;

  beforeEach(() => {
    process.env.FOS_NOTION_TOKEN = "test-token";
  });
  afterEach(() => {
    if (originalToken === undefined) delete process.env.FOS_NOTION_TOKEN;
    else process.env.FOS_NOTION_TOKEN = originalToken;
  });

  it("FOS1-INBOX-DB-01: first call creates a page, stores provider_page_id + epoch fos_version, sync_status in_sync", async () => {
    const { db, close } = await createTestDb();
    try {
      const artifact = await seedArtifact(db);
      const { client, calls } = makeMockNotion("notion-page-abc");

      const result = await projectFounderInboxItem(db, client, {
        artifact,
        dataSourceId: "data-source-1",
      });

      expect(result.created).toBe(true);
      expect(result.providerPageId).toBe("notion-page-abc");
      expect(result.syncStatus).toBe("in_sync");
      expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/pages"))).toHaveLength(1);
      expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);

      // The hidden FOS Version property equals the epoch-derived value.
      const props = createdPageProperties(calls);
      expect(props["FOS Version"]).toEqual({ number: artifactFosVersion(artifact.updatedAt) });
      expect(props["FOS Entity Type"]).toEqual({
        rich_text: [{ text: { content: "ArtifactRecord" } }],
      });

      const [row] = await db
        .select()
        .from(projection)
        .where(
          and(
            eq(projection.workspaceId, artifact.workspaceId),
            eq(projection.entityType, "ArtifactRecord"),
            eq(projection.entityId, artifact.id),
            eq(projection.provider, "notion"),
          ),
        );
      expect(row).toMatchObject({
        providerPageId: "notion-page-abc",
        syncStatus: "in_sync",
        fosVersion: artifactFosVersion(artifact.updatedAt),
      });
      expect(row!.lastSyncedAt).not.toBeNull();
    } finally {
      await close();
    }
  });

  it("FOS1-INBOX-DB-02: second call for the SAME artifact updates the same page, one projection row", async () => {
    const { db, close } = await createTestDb();
    try {
      const artifact = await seedArtifact(db);
      const { client, calls } = makeMockNotion("notion-page-xyz");

      const first = await projectFounderInboxItem(db, client, {
        artifact,
        dataSourceId: "data-source-1",
      });
      const second = await projectFounderInboxItem(db, client, {
        artifact,
        dataSourceId: "data-source-1",
      });

      expect(second.created).toBe(false);
      expect(second.providerPageId).toBe(first.providerPageId);
      expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/pages"))).toHaveLength(1);
      expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);

      const rows = await db
        .select()
        .from(projection)
        .where(
          and(
            eq(projection.workspaceId, artifact.workspaceId),
            eq(projection.entityType, "ArtifactRecord"),
            eq(projection.entityId, artifact.id),
            eq(projection.provider, "notion"),
          ),
        );
      // UNIQUE (workspace_id, entity_type, entity_id, provider) holds: exactly one row.
      expect(rows).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("FOS1-INBOX-DB-03: ready_for_action artifact projects Action Needed 'Ready to execute'", async () => {
    const { db, close } = await createTestDb();
    try {
      const artifact = await seedArtifact(db, { status: "ready_for_action" });
      const { client, calls } = makeMockNotion("notion-page-rfa");

      await projectFounderInboxItem(db, client, { artifact, dataSourceId: "ds-1" });

      const props = createdPageProperties(calls);
      expect(props.Status).toEqual({ select: { name: "ready_for_action" } });
      expect(props["Action Needed"]).toEqual({ select: { name: "Ready to execute" } });
    } finally {
      await close();
    }
  });

  it("FOS1-INBOX-DB-04: an updated_at bump advances the projection row's fos_version on re-sync", async () => {
    const { db, close } = await createTestDb();
    try {
      const artifact = await seedArtifact(db);
      const { client } = makeMockNotion("notion-page-v");

      const first = await projectFounderInboxItem(db, client, {
        artifact,
        dataSourceId: "ds-1",
      });

      const bumped = { ...artifact, updatedAt: new Date("2026-07-25T00:00:00Z") };
      const second = await projectFounderInboxItem(db, client, {
        artifact: bumped,
        dataSourceId: "ds-1",
      });

      expect(second.providerPageId).toBe(first.providerPageId);

      const [row] = await db
        .select()
        .from(projection)
        .where(
          and(
            eq(projection.workspaceId, artifact.workspaceId),
            eq(projection.entityType, "ArtifactRecord"),
            eq(projection.entityId, artifact.id),
            eq(projection.provider, "notion"),
          ),
        );
      expect(row!.fosVersion).toBe(artifactFosVersion(bumped.updatedAt));
    } finally {
      await close();
    }
  });

  it("FOS1-INBOX-DB-05: null productId projects a null-cleared FOS Product ID and a null projection.product_id", async () => {
    const { db, close } = await createTestDb();
    try {
      const artifact = await seedArtifact(db, { productId: null });
      const { client, calls } = makeMockNotion("notion-page-np");

      await projectFounderInboxItem(db, client, { artifact, dataSourceId: "ds-1" });

      const props = createdPageProperties(calls);
      expect(props["FOS Product ID"]).toEqual({ rich_text: [] });

      const [row] = await db
        .select()
        .from(projection)
        .where(
          and(
            eq(projection.workspaceId, artifact.workspaceId),
            eq(projection.entityType, "ArtifactRecord"),
            eq(projection.entityId, artifact.id),
          ),
        );
      expect(row!.productId).toBeNull();
    } finally {
      await close();
    }
  });

  it("FOS1-INBOX-DB-06: an out-of-contract artifact throws BEFORE any Notion write, leaving no page and no projection row", async () => {
    const { db, close } = await createTestDb();
    try {
      // `rejected` is a valid lifecycle status but NOT a founder-action state.
      const artifact = await seedArtifact(db, { status: "rejected" });
      const { client, calls } = makeMockNotion("notion-page-x");

      await expect(
        projectFounderInboxItem(db, client, { artifact, dataSourceId: "ds-1" }),
      ).rejects.toThrow(/not a founder-action state/);

      // The throw is raised while building properties, before createPage — so
      // NO Notion call happened and NO projection row was written (no orphan).
      expect(calls).toHaveLength(0);
      const rows = await db
        .select()
        .from(projection)
        .where(
          and(eq(projection.entityType, "ArtifactRecord"), eq(projection.entityId, artifact.id)),
        );
      expect(rows).toHaveLength(0);
    } finally {
      await close();
    }
  });
});
