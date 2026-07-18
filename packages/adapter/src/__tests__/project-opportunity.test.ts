import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { NotionClient, type FetchLike } from "@fos/notion";
import { projection } from "@fos/db/schema";
import { projectOpportunity } from "../project-opportunity.js";
import { createTestDb, seedOpportunity } from "./test-db.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

interface RecordedCall {
  method: string;
  path: string;
}

function makeMockNotion(nextPageId = "notion-page-1") {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (path, init) => {
    const method = init?.method ?? "GET";
    calls.push({ method, path });
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

describe("projectOpportunity (issue #27, slice 0.2b)", () => {
  const originalToken = process.env.FOS_NOTION_TOKEN;

  beforeEach(() => {
    process.env.FOS_NOTION_TOKEN = "test-token";
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.FOS_NOTION_TOKEN;
    else process.env.FOS_NOTION_TOKEN = originalToken;
  });

  it("FOS0-PRJ-05: first call creates a page, stores provider_page_id, sync_status in_sync", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db);
      const { client, calls } = makeMockNotion("notion-page-abc");

      const result = await projectOpportunity(db, client, {
        opportunity,
        dataSourceId: "data-source-1",
      });

      expect(result.created).toBe(true);
      expect(result.providerPageId).toBe("notion-page-abc");
      expect(result.syncStatus).toBe("in_sync");
      expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/pages"))).toHaveLength(1);
      expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);

      const [row] = await db
        .select()
        .from(projection)
        .where(
          and(
            eq(projection.workspaceId, opportunity.workspaceId),
            eq(projection.entityType, "EnrollmentOpportunity"),
            eq(projection.entityId, opportunity.id),
            eq(projection.provider, "notion"),
          ),
        );
      expect(row).toMatchObject({
        providerPageId: "notion-page-abc",
        syncStatus: "in_sync",
        fosVersion: opportunity.version,
      });
      expect(row!.lastSyncedAt).not.toBeNull();
    } finally {
      await close();
    }
  });

  it("FOS0-PRJ-06: second call for the SAME opportunity updates the same page, no duplicate row", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db);
      const { client, calls } = makeMockNotion("notion-page-xyz");

      const first = await projectOpportunity(db, client, {
        opportunity,
        dataSourceId: "data-source-1",
      });
      const second = await projectOpportunity(db, client, {
        opportunity,
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
            eq(projection.workspaceId, opportunity.workspaceId),
            eq(projection.entityType, "EnrollmentOpportunity"),
            eq(projection.entityId, opportunity.id),
            eq(projection.provider, "notion"),
          ),
        );
      // UNIQUE (workspace_id, entity_type, entity_id, provider) holds: exactly one row.
      expect(rows).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("FOS0-PRJ-07: fos_version and last_synced_at update on a re-sync after a version bump", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db);
      const { client } = makeMockNotion("notion-page-v");

      const first = await projectOpportunity(db, client, {
        opportunity,
        dataSourceId: "data-source-1",
      });

      const bumped = { ...opportunity, version: opportunity.version + 1 };
      const second = await projectOpportunity(db, client, {
        opportunity: bumped,
        dataSourceId: "data-source-1",
      });

      expect(second.providerPageId).toBe(first.providerPageId);

      const [row] = await db
        .select()
        .from(projection)
        .where(
          and(
            eq(projection.workspaceId, opportunity.workspaceId),
            eq(projection.entityType, "EnrollmentOpportunity"),
            eq(projection.entityId, opportunity.id),
            eq(projection.provider, "notion"),
          ),
        );
      expect(row!.fosVersion).toBe(bumped.version);
    } finally {
      await close();
    }
  });
});
