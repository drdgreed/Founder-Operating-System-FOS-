import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { NotionClient, type FetchLike } from "@fos/notion";
import { projection, workspaceCommand } from "@fos/db/schema";
import { reconcile } from "../reconcile.js";
import { createTestDb, seedOpportunity } from "./test-db.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

interface CannedPage {
  id: string;
  last_edited_time: string;
  properties: Record<string, unknown>;
}

function buildPage(input: {
  pageId: string;
  lastEditedTime: string;
  fosRecordId: string | null;
  fosVersion?: number;
  stage?: string;
  nextActionSummary?: string | null;
}): CannedPage {
  return {
    id: input.pageId,
    last_edited_time: input.lastEditedTime,
    properties: {
      "FOS Record ID":
        input.fosRecordId === null
          ? { rich_text: [] }
          : { rich_text: [{ plain_text: input.fosRecordId }] },
      "FOS Version": { number: input.fosVersion ?? 1 },
      Stage: { select: { name: input.stage ?? "new_lead" } },
      "Next Action Summary":
        input.nextActionSummary == null
          ? { rich_text: [] }
          : { rich_text: [{ plain_text: input.nextActionSummary }] },
    },
  };
}

/** Mock NotionClient whose `queryDataSource` returns a fixed, injected page list. */
function makeMockNotion(pages: CannedPage[]) {
  const fetchImpl: FetchLike = async (path, init) => {
    const method = init?.method ?? "GET";
    if (method === "POST" && path.includes("/query")) {
      return jsonResponse(200, { results: pages, has_more: false, next_cursor: null });
    }
    throw new Error(`unexpected call in mock: ${method} ${path}`);
  };
  return new NotionClient({ fetchImpl, requestsPerSecond: 100 });
}

async function seedProjection(
  db: Awaited<ReturnType<typeof createTestDb>>["db"],
  input: {
    workspaceId: string;
    productId: string | null;
    entityId: string;
    providerPageId: string;
    fosVersion: number;
    lastSyncedAt: Date | null;
    syncStatus?:
      "pending" | "in_sync" | "fos_ahead" | "provider_ahead" | "conflict" | "failed" | "disabled";
  },
) {
  const [row] = await db
    .insert(projection)
    .values({
      workspaceId: input.workspaceId,
      productId: input.productId,
      entityType: "EnrollmentOpportunity",
      entityId: input.entityId,
      provider: "notion",
      providerPageId: input.providerPageId,
      syncStatus: input.syncStatus ?? "in_sync",
      fosVersion: input.fosVersion,
      lastSyncedAt: input.lastSyncedAt,
    })
    .returning();
  if (!row) throw new Error("seedProjection: projection insert returned no row");
  return row;
}

describe("reconcile (issue #30, slice 0.2c)", () => {
  const originalToken = process.env.FOS_NOTION_TOKEN;

  beforeEach(() => {
    process.env.FOS_NOTION_TOKEN = "test-token";
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.FOS_NOTION_TOKEN;
    else process.env.FOS_NOTION_TOKEN = originalToken;
  });

  it("FOS0-RCN-05: unchanged page (last_edited_time <= last_synced_at) -> zero commands, projection stays in_sync", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { stage: "new_lead" });
      const syncedAt = new Date("2026-07-18T12:00:00Z");
      await seedProjection(db, {
        workspaceId: opportunity.workspaceId,
        productId: opportunity.productId,
        entityId: opportunity.id,
        providerPageId: "notion-page-1",
        fosVersion: opportunity.version,
        lastSyncedAt: syncedAt,
      });
      const page = buildPage({
        pageId: "notion-page-1",
        lastEditedTime: syncedAt.toISOString(),
        fosRecordId: opportunity.id,
        stage: "new_lead",
      });
      const client = makeMockNotion([page]);

      const result = await reconcile(db, client, {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
      });

      expect(result.unchanged).toBe(1);
      expect(result.commandsCreated).toBe(0);
      expect(await db.select().from(workspaceCommand)).toHaveLength(0);

      const [proj] = await db
        .select()
        .from(projection)
        .where(eq(projection.entityId, opportunity.id));
      expect(proj!.syncStatus).toBe("in_sync");
    } finally {
      await close();
    }
  });

  it("FOS0-RCN-06: founder edited a founder-editable field -> exactly ONE pending workspace_command with the correct diff; projection -> provider_ahead", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, {
        stage: "new_lead",
        nextActionSummary: null,
      });
      const syncedAt = new Date("2026-07-18T12:00:00Z");
      await seedProjection(db, {
        workspaceId: opportunity.workspaceId,
        productId: opportunity.productId,
        entityId: opportunity.id,
        providerPageId: "notion-page-1",
        fosVersion: opportunity.version,
        lastSyncedAt: syncedAt,
      });
      const page = buildPage({
        pageId: "notion-page-1",
        lastEditedTime: "2026-07-18T13:00:00Z",
        fosRecordId: opportunity.id,
        stage: "new_lead",
        nextActionSummary: "Call founder Tuesday",
      });
      const client = makeMockNotion([page]);

      const result = await reconcile(db, client, {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
      });

      expect(result.commandsCreated).toBe(1);

      const commands = await db.select().from(workspaceCommand);
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        entityType: "EnrollmentOpportunity",
        entityId: opportunity.id,
        provider: "notion",
        providerPageId: "notion-page-1",
        commandType: "propose_field_update",
        status: "pending",
        source: "notion_reconcile",
      });
      expect(commands[0]!.payloadJson).toMatchObject({
        changes: { nextActionSummary: { from: null, to: "Call founder Tuesday" } },
      });

      const [proj] = await db
        .select()
        .from(projection)
        .where(eq(projection.entityId, opportunity.id));
      expect(proj!.syncStatus).toBe("provider_ahead");
    } finally {
      await close();
    }
  });

  it("FOS0-RCN-07: founder edited a canonical_read_only field -> projection -> conflict, NO command emitted", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { stage: "new_lead" });
      const syncedAt = new Date("2026-07-18T12:00:00Z");
      await seedProjection(db, {
        workspaceId: opportunity.workspaceId,
        productId: opportunity.productId,
        entityId: opportunity.id,
        providerPageId: "notion-page-1",
        fosVersion: opportunity.version,
        lastSyncedAt: syncedAt,
      });
      const page = buildPage({
        pageId: "notion-page-1",
        lastEditedTime: "2026-07-18T13:00:00Z",
        fosRecordId: opportunity.id,
        stage: "contacted", // canonical_read_only field changed in Notion
      });
      const client = makeMockNotion([page]);

      const result = await reconcile(db, client, {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
      });

      expect(result.conflicts).toBe(1);
      expect(result.commandsCreated).toBe(0);
      expect(await db.select().from(workspaceCommand)).toHaveLength(0);

      const [proj] = await db
        .select()
        .from(projection)
        .where(eq(projection.entityId, opportunity.id));
      expect(proj!.syncStatus).toBe("conflict");
    } finally {
      await close();
    }
  });

  it("FOS0-RCN-08: idempotency — reconcile run twice with no new edit creates ZERO new commands the second time", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, {
        stage: "new_lead",
        nextActionSummary: null,
      });
      const syncedAt = new Date("2026-07-18T12:00:00Z");
      await seedProjection(db, {
        workspaceId: opportunity.workspaceId,
        productId: opportunity.productId,
        entityId: opportunity.id,
        providerPageId: "notion-page-1",
        fosVersion: opportunity.version,
        lastSyncedAt: syncedAt,
      });
      const page = buildPage({
        pageId: "notion-page-1",
        lastEditedTime: "2026-07-18T13:00:00Z",
        fosRecordId: opportunity.id,
        stage: "new_lead",
        nextActionSummary: "Call founder Tuesday",
      });
      const client = makeMockNotion([page]);
      const args = { workspaceId: opportunity.workspaceId, dataSourceId: "data-source-1" };

      const first = await reconcile(db, client, args);
      expect(first.commandsCreated).toBe(1);

      const second = await reconcile(db, client, args);
      expect(second.commandsCreated).toBe(0);

      expect(await db.select().from(workspaceCommand)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("FOS0-RCN-09: duplicate FOS Record ID across two pages -> detected/flagged, projection -> conflict", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { stage: "new_lead" });
      const syncedAt = new Date("2026-07-18T12:00:00Z");
      await seedProjection(db, {
        workspaceId: opportunity.workspaceId,
        productId: opportunity.productId,
        entityId: opportunity.id,
        providerPageId: "notion-page-1",
        fosVersion: opportunity.version,
        lastSyncedAt: syncedAt,
      });
      const pageA = buildPage({
        pageId: "notion-page-1",
        lastEditedTime: "2026-07-18T13:00:00Z",
        fosRecordId: opportunity.id,
        stage: "new_lead",
      });
      const pageB = buildPage({
        pageId: "notion-page-2", // a second, distinct Notion page
        lastEditedTime: "2026-07-18T13:05:00Z",
        fosRecordId: opportunity.id, // ...sharing the same FOS Record ID
        stage: "new_lead",
      });
      const client = makeMockNotion([pageA, pageB]);

      const result = await reconcile(db, client, {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
      });

      expect(result.duplicateEntityIds).toEqual([opportunity.id]);
      expect(result.conflicts).toBe(1);
      expect(result.commandsCreated).toBe(0);
      expect(await db.select().from(workspaceCommand)).toHaveLength(0);

      const [proj] = await db
        .select()
        .from(projection)
        .where(eq(projection.entityId, opportunity.id));
      expect(proj!.syncStatus).toBe("conflict");
    } finally {
      await close();
    }
  });

  it("FOS0-RCN-10: page with an unknown FOS Record ID (no projection) -> orphan flagged, no command, no crash", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { stage: "new_lead" });
      // No projection row is seeded for this opportunity at all.
      const page = buildPage({
        pageId: "notion-page-orphan",
        lastEditedTime: "2026-07-18T13:00:00Z",
        fosRecordId: opportunity.id,
        stage: "new_lead",
      });
      const client = makeMockNotion([page]);

      const result = await reconcile(db, client, {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
      });

      expect(result.orphans).toBe(1);
      expect(result.commandsCreated).toBe(0);
      expect(await db.select().from(workspaceCommand)).toHaveLength(0);
      expect(await db.select().from(projection)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("FOS0-RCN-11: a page with no parseable FOS Record ID is flagged as an orphan, not crashed on", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { stage: "new_lead" });
      const page = buildPage({
        pageId: "notion-page-blank",
        lastEditedTime: "2026-07-18T13:00:00Z",
        fosRecordId: null,
      });
      const client = makeMockNotion([page]);

      const result = await reconcile(db, client, {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
      });

      expect(result.orphans).toBe(1);
      expect(result.commandsCreated).toBe(0);
    } finally {
      await close();
    }
  });
});
