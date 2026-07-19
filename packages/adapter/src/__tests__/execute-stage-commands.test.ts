import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { NotionClient, type FetchLike } from "@fos/notion";
import {
  enrollmentOpportunity,
  operationalEvent,
  projection,
  workspaceCommand,
} from "@fos/db/schema";
import * as services from "@fos/db/services";
import { executeStageCommands } from "../execute-stage-commands.js";
import { createTestDb, seedOpportunity } from "./test-db.js";

// Pass-through mock so individual tests can vi.spyOn a named export (ESM
// live-binding) — used by FOS0-EXE-10 to force one unexpected transition
// failure and prove batch isolation.
vi.mock("@fos/db/services", async (importOriginal) => {
  return await importOriginal<typeof import("@fos/db/services")>();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

interface RecordedCall {
  method: string;
  path: string;
}

/** Mock NotionClient supporting createPage + updatePageProperties (the re-projection write). */
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

type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];

async function seedProjectionRow(
  db: TestDb,
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
  if (!row) throw new Error("seedProjectionRow: projection insert returned no row");
  return row;
}

async function insertCommand(
  db: TestDb,
  input: {
    workspaceId: string;
    targetEntityId: string;
    targetVersion: number;
    from: string;
    to: string;
    createdAt?: Date;
    idempotencyKey: string;
  },
) {
  const [row] = await db
    .insert(workspaceCommand)
    .values({
      workspaceId: input.workspaceId,
      workspaceIntegrationId: null,
      sourceProviderRecordId: "notion-page-1",
      commandType: "propose_opportunity_stage_change",
      targetEntityType: "EnrollmentOpportunity",
      targetEntityId: input.targetEntityId,
      targetVersion: input.targetVersion,
      payloadJson: { from: input.from, to: input.to },
      status: "received",
      idempotencyKey: input.idempotencyKey,
      ...(input.createdAt ? { createdAt: input.createdAt, updatedAt: input.createdAt } : {}),
    })
    .returning();
  if (!row) throw new Error("insertCommand: workspace_command insert returned no row");
  return row;
}

async function readCommand(db: TestDb, id: string) {
  const [row] = await db.select().from(workspaceCommand).where(eq(workspaceCommand.id, id));
  if (!row) throw new Error(`readCommand: no workspace_command row for ${id}`);
  return row;
}

async function readOpportunity(db: TestDb, id: string) {
  const [row] = await db
    .select()
    .from(enrollmentOpportunity)
    .where(eq(enrollmentOpportunity.id, id));
  if (!row) throw new Error(`readOpportunity: no enrollment_opportunity row for ${id}`);
  return row;
}

async function readEvents(db: TestDb, entityId: string, entityType: string) {
  return db
    .select()
    .from(operationalEvent)
    .where(
      and(eq(operationalEvent.entityId, entityId), eq(operationalEvent.entityType, entityType)),
    );
}

describe("executeStageCommands (issue #36, slice 0.2e — controlled-command execution)", () => {
  const originalToken = process.env.FOS_NOTION_TOKEN;

  beforeEach(() => {
    process.env.FOS_NOTION_TOKEN = "test-token";
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.FOS_NOTION_TOKEN;
    else process.env.FOS_NOTION_TOKEN = originalToken;
  });

  it("FOS0-EXE-01: valid received command -> canonical stage CHANGED, version bumped, command succeeded, both events emitted, page re-projected", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { version: 3, stage: "new_lead" });
      await seedProjectionRow(db, {
        workspaceId: opportunity.workspaceId,
        productId: opportunity.productId,
        entityId: opportunity.id,
        providerPageId: "notion-page-1",
        fosVersion: 3,
      });
      const command = await insertCommand(db, {
        workspaceId: opportunity.workspaceId,
        targetEntityId: opportunity.id,
        targetVersion: 3,
        from: "new_lead",
        to: "reviewing",
        idempotencyKey: "key-1",
      });
      const { client, calls } = makeMockNotion("notion-page-1");

      const result = await executeStageCommands(db, client, {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
      });

      expect(result.commandsLoaded).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(result.conflicts).toBe(0);
      expect(result.rejectedIllegal).toBe(0);
      expect(result.supersededStale).toBe(0);

      const updatedOpportunity = await readOpportunity(db, opportunity.id);
      expect(updatedOpportunity.stage).toBe("reviewing");
      expect(updatedOpportunity.version).toBe(4);

      const updatedCommand = await readCommand(db, command.id);
      expect(updatedCommand.status).toBe("succeeded");
      expect(updatedCommand.executionStatus).toBe("succeeded");
      expect(updatedCommand.executedAt).not.toBeNull();

      const stageEvents = await readEvents(db, opportunity.id, "EnrollmentOpportunity");
      expect(stageEvents.map((e) => e.type)).toContain("opportunity.stage_changed");

      const commandEvents = await readEvents(db, command.id, "WorkspaceCommand");
      expect(commandEvents.map((e) => e.type)).toContain("workspace_command.executed");

      // Re-projected: the SAME page updated (PATCH), never a duplicate created.
      expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
      expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/pages"))).toHaveLength(0);

      const [projRow] = await db
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
      expect(projRow!.fosVersion).toBe(4);
      expect(projRow!.syncStatus).toBe("in_sync");
    } finally {
      await close();
    }
  });

  it("FOS0-EXE-02: target_version stale vs canonical (§8.3) -> command conflict, canonical UNCHANGED, no stage_changed event", async () => {
    const { db, close } = await createTestDb();
    try {
      // Canonical has advanced to v2 (e.g. via a prior 0.2e run); the command
      // was captured against the now-stale v1.
      const { opportunity } = await seedOpportunity(db, { version: 2, stage: "reviewing" });
      const command = await insertCommand(db, {
        workspaceId: opportunity.workspaceId,
        targetEntityId: opportunity.id,
        targetVersion: 1,
        from: "new_lead",
        to: "reviewing",
        idempotencyKey: "key-2",
      });
      const { client, calls } = makeMockNotion();

      const result = await executeStageCommands(db, client, {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
      });

      expect(result.conflicts).toBe(1);
      expect(result.succeeded).toBe(0);

      const updatedOpportunity = await readOpportunity(db, opportunity.id);
      expect(updatedOpportunity.stage).toBe("reviewing");
      expect(updatedOpportunity.version).toBe(2); // unchanged

      const updatedCommand = await readCommand(db, command.id);
      expect(updatedCommand.status).toBe("conflict");
      expect(updatedCommand.executedAt).toBeNull();

      const stageEvents = await readEvents(db, opportunity.id, "EnrollmentOpportunity");
      expect(stageEvents).toHaveLength(0);

      const commandEvents = await readEvents(db, command.id, "WorkspaceCommand");
      expect(commandEvents.map((e) => e.type)).toContain("workspace_command.failed");

      // No re-projection on a conflict — no Notion mutation at all.
      expect(calls).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("FOS0-EXE-03: illegal transition (enrolled -> new_lead) -> command rejected + reason, canonical UNCHANGED", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { version: 1, stage: "enrolled" });
      const command = await insertCommand(db, {
        workspaceId: opportunity.workspaceId,
        targetEntityId: opportunity.id,
        targetVersion: 1,
        from: "enrolled",
        to: "new_lead",
        idempotencyKey: "key-3",
      });
      const { client, calls } = makeMockNotion();

      const result = await executeStageCommands(db, client, {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
      });

      expect(result.rejectedIllegal).toBe(1);
      expect(result.succeeded).toBe(0);

      const updatedOpportunity = await readOpportunity(db, opportunity.id);
      expect(updatedOpportunity.stage).toBe("enrolled");
      expect(updatedOpportunity.version).toBe(1);

      const updatedCommand = await readCommand(db, command.id);
      expect(updatedCommand.status).toBe("rejected");
      expect(updatedCommand.rejectionReason).toMatch(/illegal opportunity transition/i);

      const commandEvents = await readEvents(db, command.id, "WorkspaceCommand");
      expect(commandEvents.map((e) => e.type)).toContain("workspace_command.rejected");

      expect(calls).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("FOS0-EXE-04 (#35): two received commands at one entity/version -> newest succeeds, older is rejected (superseded); canonical reflects the newest intent only", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { version: 1, stage: "new_lead" });
      await seedProjectionRow(db, {
        workspaceId: opportunity.workspaceId,
        productId: opportunity.productId,
        entityId: opportunity.id,
        providerPageId: "notion-page-1",
        fosVersion: 1,
      });
      // Founder first proposes new_lead -> reviewing, then (before execution)
      // corrects to new_lead -> disqualified. Both captured at version 1.
      const older = await insertCommand(db, {
        workspaceId: opportunity.workspaceId,
        targetEntityId: opportunity.id,
        targetVersion: 1,
        from: "new_lead",
        to: "reviewing",
        createdAt: new Date("2026-07-19T10:00:00Z"),
        idempotencyKey: "key-older",
      });
      const newer = await insertCommand(db, {
        workspaceId: opportunity.workspaceId,
        targetEntityId: opportunity.id,
        targetVersion: 1,
        from: "new_lead",
        to: "disqualified",
        createdAt: new Date("2026-07-19T10:05:00Z"),
        idempotencyKey: "key-newer",
      });
      const { client } = makeMockNotion("notion-page-1");

      const result = await executeStageCommands(db, client, {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
      });

      expect(result.commandsLoaded).toBe(2);
      expect(result.succeeded).toBe(1);
      expect(result.supersededStale).toBe(1);

      const updatedOpportunity = await readOpportunity(db, opportunity.id);
      expect(updatedOpportunity.stage).toBe("disqualified"); // the NEWEST intent only
      expect(updatedOpportunity.version).toBe(2);

      const olderCommand = await readCommand(db, older.id);
      expect(olderCommand.status).toBe("rejected");
      expect(olderCommand.rejectionReason).toMatch(/superseded/i);

      const newerCommand = await readCommand(db, newer.id);
      expect(newerCommand.status).toBe("succeeded");
    } finally {
      await close();
    }
  });

  it("FOS0-EXE-05: idempotency — running twice does not re-execute an already-succeeded command (no double version bump)", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { version: 1, stage: "new_lead" });
      await seedProjectionRow(db, {
        workspaceId: opportunity.workspaceId,
        productId: opportunity.productId,
        entityId: opportunity.id,
        providerPageId: "notion-page-1",
        fosVersion: 1,
      });
      await insertCommand(db, {
        workspaceId: opportunity.workspaceId,
        targetEntityId: opportunity.id,
        targetVersion: 1,
        from: "new_lead",
        to: "reviewing",
        idempotencyKey: "key-idem",
      });
      const { client } = makeMockNotion("notion-page-1");
      const args = { workspaceId: opportunity.workspaceId, dataSourceId: "data-source-1" };

      const first = await executeStageCommands(db, client, args);
      const second = await executeStageCommands(db, client, args);

      expect(first.succeeded).toBe(1);
      expect(second.commandsLoaded).toBe(0);
      expect(second.succeeded).toBe(0);

      const updatedOpportunity = await readOpportunity(db, opportunity.id);
      expect(updatedOpportunity.version).toBe(2); // NOT double-bumped to 3

      const commandEvents = await readEvents(db, opportunity.id, "EnrollmentOpportunity");
      expect(commandEvents.filter((e) => e.type === "opportunity.stage_changed")).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("FOS0-EXE-06: a command whose target opportunity is missing is rejected, and does NOT abort the batch (poison-pill isolation)", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { version: 1, stage: "new_lead" });
      await seedProjectionRow(db, {
        workspaceId: opportunity.workspaceId,
        productId: opportunity.productId,
        entityId: opportunity.id,
        providerPageId: "notion-page-1",
        fosVersion: 1,
      });
      // A command whose target does not exist (0.2c can leave orphaned commands).
      const orphan = await insertCommand(db, {
        workspaceId: opportunity.workspaceId,
        targetEntityId: "00000000-0000-0000-0000-0000000000ff",
        targetVersion: 1,
        from: "new_lead",
        to: "reviewing",
        idempotencyKey: "key-orphan",
      });
      // ...alongside a perfectly good command in the same run.
      const good = await insertCommand(db, {
        workspaceId: opportunity.workspaceId,
        targetEntityId: opportunity.id,
        targetVersion: 1,
        from: "new_lead",
        to: "reviewing",
        idempotencyKey: "key-good",
      });
      const { client } = makeMockNotion("notion-page-1");

      const result = await executeStageCommands(db, client, {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
      });

      // The orphan is rejected, the good command STILL executes — one bad
      // command cannot starve the queue.
      expect(result.rejectedInvalid).toBe(1);
      expect(result.succeeded).toBe(1);
      expect((await readCommand(db, orphan.id)).status).toBe("rejected");
      expect((await readCommand(db, good.id)).status).toBe("succeeded");
      expect((await readOpportunity(db, opportunity.id)).stage).toBe("reviewing");
    } finally {
      await close();
    }
  });

  it("FOS0-EXE-07: a command whose target opportunity is in a DIFFERENT workspace is rejected, canonical UNCHANGED (cross-tenant guard)", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity: mine } = await seedOpportunity(db, { version: 1, stage: "new_lead" });
      // A second, independent workspace + opportunity.
      const { opportunity: theirs } = await seedOpportunity(db, { version: 1, stage: "new_lead" });
      expect(theirs.workspaceId).not.toBe(mine.workspaceId);

      // A command in MY workspace that (via a tampered/orphaned row) targets
      // THEIR opportunity, with a version that would otherwise match.
      const command = await insertCommand(db, {
        workspaceId: mine.workspaceId,
        targetEntityId: theirs.id,
        targetVersion: 1,
        from: "new_lead",
        to: "reviewing",
        idempotencyKey: "key-cross",
      });
      const { client } = makeMockNotion("notion-page-1");

      const result = await executeStageCommands(db, client, {
        workspaceId: mine.workspaceId,
        dataSourceId: "data-source-1",
      });

      expect(result.rejectedInvalid).toBe(1);
      expect(result.succeeded).toBe(0);
      expect((await readCommand(db, command.id)).status).toBe("rejected");
      // Their opportunity is untouched — no cross-tenant mutation.
      expect((await readOpportunity(db, theirs.id)).stage).toBe("new_lead");
      expect((await readOpportunity(db, theirs.id)).version).toBe(1);
    } finally {
      await close();
    }
  });

  it("FOS0-EXE-08: a re-projection (Notion write) failure leaves the command succeeded (canonical correct) and does not abort the batch", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { version: 1, stage: "new_lead" });
      await seedProjectionRow(db, {
        workspaceId: opportunity.workspaceId,
        productId: opportunity.productId,
        entityId: opportunity.id,
        providerPageId: "notion-page-1",
        fosVersion: 1,
      });
      const command = await insertCommand(db, {
        workspaceId: opportunity.workspaceId,
        targetEntityId: opportunity.id,
        targetVersion: 1,
        from: "new_lead",
        to: "reviewing",
        idempotencyKey: "key-1",
      });
      // Notion write (the re-projection PATCH) fails hard.
      const fetchImpl: FetchLike = async (path, init) => {
        const method = init?.method ?? "GET";
        if (method === "PATCH") throw new Error("notion unavailable");
        throw new Error(`unexpected call in mock: ${method} ${path}`);
      };
      const client = new NotionClient({ fetchImpl, requestsPerSecond: 100 });

      const result = await executeStageCommands(db, client, {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
      });

      // Transition committed: canonical is correct and the command is succeeded.
      expect(result.succeeded).toBe(1);
      expect(result.reprojectionDeferred).toBe(1);
      expect(result.failed).toBe(0); // NOT counted as a batch failure
      expect((await readCommand(db, command.id)).status).toBe("succeeded");
      const updated = await readOpportunity(db, opportunity.id);
      expect(updated.stage).toBe("reviewing");
      expect(updated.version).toBe(2);
    } finally {
      await close();
    }
  });

  it("FOS0-EXE-09: two commands with an identical created_at resolve deterministically (highest id wins) — #35 tie-break", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { version: 1, stage: "new_lead" });
      await seedProjectionRow(db, {
        workspaceId: opportunity.workspaceId,
        productId: opportunity.productId,
        entityId: opportunity.id,
        providerPageId: "notion-page-1",
        fosVersion: 1,
      });
      const sameInstant = new Date("2026-07-19T13:00:00Z");
      const a = await insertCommand(db, {
        workspaceId: opportunity.workspaceId,
        targetEntityId: opportunity.id,
        targetVersion: 1,
        from: "new_lead",
        to: "reviewing",
        createdAt: sameInstant,
        idempotencyKey: "key-a",
      });
      const b = await insertCommand(db, {
        workspaceId: opportunity.workspaceId,
        targetEntityId: opportunity.id,
        targetVersion: 1,
        from: "new_lead",
        to: "disqualified",
        createdAt: sameInstant,
        idempotencyKey: "key-b",
      });
      const { client } = makeMockNotion("notion-page-1");

      const result = await executeStageCommands(db, client, {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
      });

      // Exactly one executes, one superseded — #35 invariant.
      expect(result.succeeded).toBe(1);
      expect(result.supersededStale).toBe(1);

      // Deterministic: the lexically-greater id is the candidate (asc(id) sort +
      // last-seen-max), so the winner is stable across runs.
      const winnerId = a.id > b.id ? a.id : b.id;
      const loserId = a.id > b.id ? b.id : a.id;
      expect((await readCommand(db, winnerId)).status).toBe("succeeded");
      expect((await readCommand(db, loserId)).status).toBe("rejected");
      const expectedStage = winnerId === a.id ? "reviewing" : "disqualified";
      expect((await readOpportunity(db, opportunity.id)).stage).toBe(expectedStage);
    } finally {
      await close();
    }
  });

  it("FOS0-EXE-10: an UNEXPECTED error on one command is isolated (result.failed) and does NOT abort the batch (poison-pill)", async () => {
    const { db, close } = await createTestDb();
    const realTransition = services.transitionOpportunity;
    let bad: { id: string } | undefined;
    const spy = vi
      .spyOn(services, "transitionOpportunity")
      .mockImplementation(async (dbArg, input) => {
        // Simulate an unexpected infra fault (not Stale/Illegal) for one target.
        if (bad && input.opportunityId === bad.id) throw new Error("simulated unexpected DB fault");
        return realTransition(dbArg, input);
      });
    try {
      // Two opportunities in the SAME workspace so both are processed in one run.
      const {
        workspace,
        product,
        person,
        opportunity: good,
      } = await seedOpportunity(db, {
        version: 1,
        stage: "new_lead",
      });
      const [badOpp] = await db
        .insert(enrollmentOpportunity)
        .values({
          workspaceId: workspace.id,
          productId: product.id,
          personId: person.id,
          stage: "new_lead",
          currency: "USD",
          version: 1,
        })
        .returning();
      bad = badOpp!;

      const badCommand = await insertCommand(db, {
        workspaceId: workspace.id,
        targetEntityId: bad.id,
        targetVersion: 1,
        from: "new_lead",
        to: "reviewing",
        idempotencyKey: "key-bad",
      });
      const goodCommand = await insertCommand(db, {
        workspaceId: workspace.id,
        targetEntityId: good.id,
        targetVersion: 1,
        from: "new_lead",
        to: "reviewing",
        idempotencyKey: "key-good",
      });
      const { client } = makeMockNotion("notion-page-1");

      const result = await executeStageCommands(db, client, {
        workspaceId: workspace.id,
        dataSourceId: "data-source-1",
      });

      // The bad command's group threw an unexpected error → isolated + counted;
      // the good command STILL executed. One bad command cannot starve the queue.
      expect(result.failed).toBe(1);
      expect(result.succeeded).toBe(1);
      // Bad command left `received` (retried next run); its canonical untouched.
      expect((await readCommand(db, badCommand.id)).status).toBe("received");
      expect((await readOpportunity(db, bad.id)).stage).toBe("new_lead");
      // Good command applied.
      expect((await readCommand(db, goodCommand.id)).status).toBe("succeeded");
      expect((await readOpportunity(db, good.id)).stage).toBe("reviewing");
    } finally {
      spy.mockRestore();
      await close();
    }
  });
});
