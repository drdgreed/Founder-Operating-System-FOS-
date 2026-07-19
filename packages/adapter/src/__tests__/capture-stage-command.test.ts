import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { NotionClient, type FetchLike } from "@fos/notion";
import { projection, workspaceCommand } from "@fos/db/schema";
import { captureStageCommands } from "../capture-stage-command.js";
import { createTestDb, seedOpportunity } from "./test-db.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

interface CannedPage {
  id: string;
  last_edited_time: string;
  properties: Record<string, unknown>;
}

/** Builds a canned Notion page for the Enrollment Pipeline. */
function buildPage(input: {
  pageId: string;
  fosRecordId: string | null;
  fosVersion?: number | null;
  stage?: string | null;
}): CannedPage {
  const properties: Record<string, unknown> = {
    "FOS Record ID":
      input.fosRecordId === null
        ? { rich_text: [] }
        : { rich_text: [{ plain_text: input.fosRecordId }] },
  };
  const version = input.fosVersion === undefined ? 1 : input.fosVersion;
  if (version !== null) properties["FOS Version"] = { number: version };
  if (input.stage !== undefined && input.stage !== null) {
    properties["Stage"] = { select: { name: input.stage } };
  }
  return {
    id: input.pageId,
    last_edited_time: "2026-07-19T13:00:00Z",
    properties,
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
      syncStatus: "in_sync",
      fosVersion: input.fosVersion,
      lastSyncedAt: new Date("2026-07-19T12:00:00Z"),
    })
    .returning();
  if (!row) throw new Error("seedProjection: projection insert returned no row");
  return row;
}

async function readCommands(db: Awaited<ReturnType<typeof createTestDb>>["db"], entityId: string) {
  return db.select().from(workspaceCommand).where(eq(workspaceCommand.targetEntityId, entityId));
}

describe("captureStageCommands (issue #33, slice 0.2d — controlled-command capture)", () => {
  const originalToken = process.env.FOS_NOTION_TOKEN;

  beforeEach(() => {
    process.env.FOS_NOTION_TOKEN = "test-token";
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.FOS_NOTION_TOKEN;
    else process.env.FOS_NOTION_TOKEN = originalToken;
  });

  it("FOS0-CMD-01: founder changed Stage, version matches -> exactly ONE propose_opportunity_stage_change, received, correct payload + target_version", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { version: 3, stage: "new_lead" });
      await seedProjection(db, {
        workspaceId: opportunity.workspaceId,
        productId: opportunity.productId,
        entityId: opportunity.id,
        providerPageId: "notion-page-1",
        fosVersion: 3,
      });
      const page = buildPage({
        pageId: "notion-page-1",
        fosRecordId: opportunity.id,
        fosVersion: 3,
        stage: "contacted",
      });
      const client = makeMockNotion([page]);

      const result = await captureStageCommands(db, client, {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
        workspaceIntegrationId: null,
      });

      expect(result.proposed).toBe(1);
      expect(result.rejectedIllegalStage).toBe(0);

      const commands = await readCommands(db, opportunity.id);
      expect(commands).toHaveLength(1);
      const command = commands[0]!;
      expect(command.commandType).toBe("propose_opportunity_stage_change");
      expect(command.status).toBe("received");
      expect(command.targetEntityType).toBe("EnrollmentOpportunity");
      expect(command.targetVersion).toBe(3);
      expect(command.payloadJson).toEqual({ from: "new_lead", to: "contacted" });
      expect(command.sourceProviderRecordId).toBe("notion-page-1");
      expect(command.rejectionReason).toBeNull();
    } finally {
      await close();
    }
  });

  it("FOS0-CMD-02: re-polling the SAME edit captures ZERO new commands (idempotency_key UNIQUE)", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { version: 1, stage: "new_lead" });
      await seedProjection(db, {
        workspaceId: opportunity.workspaceId,
        productId: opportunity.productId,
        entityId: opportunity.id,
        providerPageId: "notion-page-1",
        fosVersion: 1,
      });
      const page = buildPage({
        pageId: "notion-page-1",
        fosRecordId: opportunity.id,
        fosVersion: 1,
        stage: "contacted",
      });
      const client = makeMockNotion([page]);
      const args = {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
        workspaceIntegrationId: null,
      };

      const first = await captureStageCommands(db, client, args);
      const second = await captureStageCommands(db, client, args);

      expect(first.proposed).toBe(1);
      expect(second.proposed).toBe(0);
      expect(second.duplicatesDeduped).toBe(1);
      expect(await readCommands(db, opportunity.id)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("FOS0-CMD-03: page Stage equals canonical -> zero commands", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { version: 1, stage: "contacted" });
      await seedProjection(db, {
        workspaceId: opportunity.workspaceId,
        productId: opportunity.productId,
        entityId: opportunity.id,
        providerPageId: "notion-page-1",
        fosVersion: 1,
      });
      const page = buildPage({
        pageId: "notion-page-1",
        fosRecordId: opportunity.id,
        fosVersion: 1,
        stage: "contacted",
      });
      const client = makeMockNotion([page]);

      const result = await captureStageCommands(db, client, {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
        workspaceIntegrationId: null,
      });

      expect(result.unchanged).toBe(1);
      expect(result.proposed).toBe(0);
      expect(await readCommands(db, opportunity.id)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("FOS0-CMD-04: FOS Version mismatch (stale projection, §8.3) -> zero commands", async () => {
    const { db, close } = await createTestDb();
    try {
      // Canonical has advanced to v2; the page still stamps v1 (a stale projection).
      const { opportunity } = await seedOpportunity(db, { version: 2, stage: "new_lead" });
      await seedProjection(db, {
        workspaceId: opportunity.workspaceId,
        productId: opportunity.productId,
        entityId: opportunity.id,
        providerPageId: "notion-page-1",
        fosVersion: 1,
      });
      const page = buildPage({
        pageId: "notion-page-1",
        fosRecordId: opportunity.id,
        fosVersion: 1,
        stage: "contacted",
      });
      const client = makeMockNotion([page]);

      const result = await captureStageCommands(db, client, {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
        workspaceIntegrationId: null,
      });

      expect(result.versionConflicts).toBe(1);
      expect(result.proposed).toBe(0);
      expect(await readCommands(db, opportunity.id)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("FOS0-CMD-05: illegal Stage value -> status='rejected' with a reason, no proposal command", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { version: 1, stage: "new_lead" });
      await seedProjection(db, {
        workspaceId: opportunity.workspaceId,
        productId: opportunity.productId,
        entityId: opportunity.id,
        providerPageId: "notion-page-1",
        fosVersion: 1,
      });
      const page = buildPage({
        pageId: "notion-page-1",
        fosRecordId: opportunity.id,
        fosVersion: 1,
        // A hand-typed Notion select value that is not a legal opportunity_stage.
        stage: "Closed-Won (custom)",
      });
      const client = makeMockNotion([page]);

      const result = await captureStageCommands(db, client, {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
        workspaceIntegrationId: null,
      });

      expect(result.rejectedIllegalStage).toBe(1);
      expect(result.proposed).toBe(0);

      const commands = await readCommands(db, opportunity.id);
      expect(commands).toHaveLength(1);
      expect(commands[0]!.status).toBe("rejected");
      expect(commands[0]!.rejectionReason).toMatch(/not a legal opportunity stage/i);
    } finally {
      await close();
    }
  });

  it("FOS0-CMD-06: migration applies clean on PGlite; idempotency_key UNIQUE is enforced at the DB level", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { version: 1, stage: "new_lead" });
      await db.insert(workspaceCommand).values({
        workspaceId: opportunity.workspaceId,
        workspaceIntegrationId: null,
        sourceProviderRecordId: "notion-page-1",
        commandType: "propose_opportunity_stage_change",
        targetEntityType: "EnrollmentOpportunity",
        targetEntityId: opportunity.id,
        targetVersion: 1,
        payloadJson: { from: "new_lead", to: "contacted" },
        status: "received",
        idempotencyKey: "duplicate-key",
      });

      await expect(
        db.insert(workspaceCommand).values({
          workspaceId: opportunity.workspaceId,
          workspaceIntegrationId: null,
          sourceProviderRecordId: "notion-page-2",
          commandType: "propose_opportunity_stage_change",
          targetEntityType: "EnrollmentOpportunity",
          targetEntityId: opportunity.id,
          targetVersion: 2,
          payloadJson: { from: "contacted", to: "conversation_scheduled" },
          status: "received",
          idempotencyKey: "duplicate-key",
        }),
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it("FOS0-CMD-07: a SECOND distinct Stage edit at the SAME version is captured, not dropped (ADR-06 property-hash key)", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { version: 1, stage: "new_lead" });
      await seedProjection(db, {
        workspaceId: opportunity.workspaceId,
        productId: opportunity.productId,
        entityId: opportunity.id,
        providerPageId: "notion-page-1",
        fosVersion: 1,
      });
      const args = {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
        workspaceIntegrationId: null,
      };

      // First edit new_lead -> contacted, captured against version 1.
      const firstEdit = await captureStageCommands(
        db,
        makeMockNotion([
          buildPage({
            pageId: "notion-page-1",
            fosRecordId: opportunity.id,
            fosVersion: 1,
            stage: "contacted",
          }),
        ]),
        args,
      );
      // A DIFFERENT edit before 0.2e bumps the version: canonical is still
      // new_lead / v1, but the page now shows conversation_scheduled. Without
      // the payload in the idempotency key this would collide with the first
      // and be silently dropped.
      const secondEdit = await captureStageCommands(
        db,
        makeMockNotion([
          buildPage({
            pageId: "notion-page-1",
            fosRecordId: opportunity.id,
            fosVersion: 1,
            stage: "conversation_scheduled",
          }),
        ]),
        args,
      );

      expect(firstEdit.proposed).toBe(1);
      expect(secondEdit.proposed).toBe(1);
      expect(secondEdit.duplicatesDeduped).toBe(0);

      const commands = await readCommands(db, opportunity.id);
      expect(commands).toHaveLength(2);
      const tos = commands.map((c) => (c.payloadJson as { to: string }).to).sort();
      expect(tos).toEqual(["contacted", "conversation_scheduled"]);
    } finally {
      await close();
    }
  });

  it("FOS0-CMD-08: a legal correction after a rejected illegal edit at the same version is captured, not blocked", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { version: 1, stage: "new_lead" });
      await seedProjection(db, {
        workspaceId: opportunity.workspaceId,
        productId: opportunity.productId,
        entityId: opportunity.id,
        providerPageId: "notion-page-1",
        fosVersion: 1,
      });
      const args = {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
        workspaceIntegrationId: null,
      };

      // Founder first types garbage -> rejected.
      const bad = await captureStageCommands(
        db,
        makeMockNotion([
          buildPage({
            pageId: "notion-page-1",
            fosRecordId: opportunity.id,
            fosVersion: 1,
            stage: "Closed-Won (custom)",
          }),
        ]),
        args,
      );
      // Then corrects to a legal stage at the SAME version — must NOT be
      // blocked by the rejected row occupying the key.
      const fixed = await captureStageCommands(
        db,
        makeMockNotion([
          buildPage({
            pageId: "notion-page-1",
            fosRecordId: opportunity.id,
            fosVersion: 1,
            stage: "contacted",
          }),
        ]),
        args,
      );

      expect(bad.rejectedIllegalStage).toBe(1);
      expect(fixed.proposed).toBe(1);
      expect(fixed.duplicatesDeduped).toBe(0);

      const commands = await readCommands(db, opportunity.id);
      const received = commands.filter((c) => c.status === "received");
      expect(received).toHaveLength(1);
      expect((received[0]!.payloadJson as { to: string }).to).toBe("contacted");
    } finally {
      await close();
    }
  });
});
