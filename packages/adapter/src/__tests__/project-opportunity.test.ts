import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { NotionClient, type FetchLike } from "@fos/notion";
import {
  projection,
  objectionRecord,
  enrollmentActionRecommendation,
  artifactRecord,
} from "@fos/db/schema";
import { projectOpportunity } from "../project-opportunity.js";
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

describe("projectOpportunity §7.2 join-backed fields (issue #88, P1.5b)", () => {
  const originalToken = process.env.FOS_NOTION_TOKEN;
  beforeEach(() => {
    process.env.FOS_NOTION_TOKEN = "test-token";
  });
  afterEach(() => {
    if (originalToken === undefined) delete process.env.FOS_NOTION_TOKEN;
    else process.env.FOS_NOTION_TOKEN = originalToken;
  });

  it("FOS1-PRJ-DB-08: projects only OPEN, correctly-scoped objections (excludes resolved + other-workspace)", async () => {
    const { db, close } = await createTestDb();
    try {
      const { workspace, opportunity } = await seedOpportunity(db);

      // Target opportunity: one OPEN objection (included) + one ADDRESSED (excluded by status).
      await db.insert(objectionRecord).values([
        {
          workspaceId: workspace.id,
          opportunityId: opportunity.id,
          category: "budget",
          classification: "price",
          statement: "Too expensive right now.",
          severity: "high",
          resolutionStatus: "open",
        },
        {
          workspaceId: workspace.id,
          opportunityId: opportunity.id,
          category: "timing",
          classification: "schedule",
          statement: "Was worried about timing (now resolved).",
          resolutionStatus: "addressed",
        },
      ]);

      // A DIFFERENT workspace + opportunity with its own OPEN objection — must be excluded by scoping.
      const other = await seedOpportunity(db);
      await db.insert(objectionRecord).values({
        workspaceId: other.workspace.id,
        opportunityId: other.opportunity.id,
        category: "authority",
        classification: "decision",
        statement: "Need spouse buy-in.",
        resolutionStatus: "open",
      });

      const { client, calls } = makeMockNotion("notion-page-obj");
      await projectOpportunity(db, client, { opportunity, dataSourceId: "ds-1" });

      const props = createdPageProperties(calls);
      expect(props["Open Objections"]).toEqual({ number: 1 });
      expect(props.Objections).toEqual({
        rich_text: [{ text: { content: "[price/budget] Too expensive right now." } }],
      });
    } finally {
      await close();
    }
  });

  it("FOS1-PRJ-DB-09: pending artifact = most-recent in_review via recommendation; dedupes, excludes non-in_review, tolerates NULL artifact", async () => {
    const { db, close } = await createTestDb();
    try {
      const { workspace, opportunity } = await seedOpportunity(db);

      // Two in_review artifacts (IN2 more recently updated -> the "Pending Artifact")
      // plus one draft artifact that must be excluded.
      const [in1] = await db
        .insert(artifactRecord)
        .values({
          workspaceId: workspace.id,
          artifactType: "no_show_recovery",
          domain: "enrollment",
          title: "No-show recovery brief",
          status: "in_review",
          updatedAt: new Date("2026-07-10T00:00:00Z"),
        })
        .returning();
      const [in2] = await db
        .insert(artifactRecord)
        .values({
          workspaceId: workspace.id,
          artifactType: "objection_response",
          domain: "enrollment",
          title: "Objection response",
          status: "in_review",
          updatedAt: new Date("2026-07-18T00:00:00Z"),
        })
        .returning();
      const [draft] = await db
        .insert(artifactRecord)
        .values({
          workspaceId: workspace.id,
          artifactType: "call_brief",
          domain: "enrollment",
          title: "Draft note",
          status: "draft",
          updatedAt: new Date("2026-07-20T00:00:00Z"),
        })
        .returning();

      // Recommendations: TWO point at in1 (dedupe -> one artifact), one at in2,
      // one at the draft (excluded), one with NULL artifact (must not crash).
      await db.insert(enrollmentActionRecommendation).values([
        {
          workspaceId: workspace.id,
          opportunityId: opportunity.id,
          actionType: "send_recovery",
          summary: "rec a",
          artifactRecordId: in1!.id,
          status: "proposed",
        },
        {
          workspaceId: workspace.id,
          opportunityId: opportunity.id,
          actionType: "send_recovery",
          summary: "rec a-dup",
          artifactRecordId: in1!.id,
          status: "accepted",
        },
        {
          workspaceId: workspace.id,
          opportunityId: opportunity.id,
          actionType: "send_objection_response",
          summary: "rec b",
          artifactRecordId: in2!.id,
          status: "proposed",
        },
        {
          workspaceId: workspace.id,
          opportunityId: opportunity.id,
          actionType: "review_draft",
          summary: "rec c (draft artifact, excluded)",
          artifactRecordId: draft!.id,
          status: "proposed",
        },
        {
          workspaceId: workspace.id,
          opportunityId: opportunity.id,
          actionType: "call",
          summary: "rec d (no artifact)",
          artifactRecordId: null,
          status: "proposed",
        },
      ]);

      const { client, calls } = makeMockNotion("notion-page-art");
      await projectOpportunity(db, client, { opportunity, dataSourceId: "ds-1" });

      const props = createdPageProperties(calls);
      // Two DISTINCT in_review artifacts (in1, in2); in2 is most-recent -> shown, +1 more.
      expect(props["Pending Artifact"]).toEqual({
        rich_text: [
          {
            text: {
              content: "Objection response [objection_response] (+1 more awaiting approval)",
            },
          },
        ],
      });
      expect(props["Pending Artifact Link"]).toEqual({
        rich_text: [{ text: { content: in2!.id } }],
      });
    } finally {
      await close();
    }
  });

  it("FOS1-PRJ-DB-10: no objections and no pending artifact -> zero/empty projected shapes", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db);
      const { client, calls } = makeMockNotion("notion-page-empty");

      await projectOpportunity(db, client, { opportunity, dataSourceId: "ds-1" });

      const props = createdPageProperties(calls);
      expect(props["Open Objections"]).toEqual({ number: 0 });
      expect(props.Objections).toEqual({ rich_text: [] });
      expect(props["Pending Artifact"]).toEqual({ rich_text: [] });
      expect(props["Pending Artifact Link"]).toEqual({ rich_text: [] });
    } finally {
      await close();
    }
  });
});
