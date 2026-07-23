import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  artifactRecord,
  artifactVersion,
  fosWorkspace,
  operationalEvent,
  workspaceCommand,
} from "@fos/db/schema";
import {
  executeGmailDraftCommands,
  COMMAND_TYPE as GMAIL_DRAFT_COMMAND_TYPE,
} from "../create-gmail-draft-command.js";
import type { GmailDraftClient, GmailDraftInput } from "../gmail-draft-client.js";
import { createTestDb } from "./test-db.js";

type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];

/**
 * Fake GmailDraftClient — records every call and returns a canned draft id.
 * NO real Gmail API, NO credential, NO network. This is the ONLY client the
 * command is exercised against in this slice; the live OAuth/API integration is
 * a deferred activation concern.
 */
function makeFakeGmail(draftId = "draft-1") {
  const calls: GmailDraftInput[] = [];
  const client: GmailDraftClient = {
    createDraft: async (input) => {
      calls.push(input);
      return { draftId };
    },
  };
  return { client, calls };
}

/** A fake whose createDraft throws — proves fail-closed behavior. */
function makeThrowingGmail(message = "gmail unavailable") {
  const calls: GmailDraftInput[] = [];
  const client: GmailDraftClient = {
    createDraft: async (input) => {
      calls.push(input);
      throw new Error(message);
    },
  };
  return { client, calls };
}

async function seedWorkspace(db: TestDb, name = "Test Workspace") {
  const [workspace] = await db
    .insert(fosWorkspace)
    .values({ name, ownerUserId: "founder-1" })
    .returning();
  if (!workspace) throw new Error("seedWorkspace: fos_workspace insert returned no row");
  return workspace;
}

/**
 * Seeds an ArtifactRecord + its current ArtifactVersion at a given lifecycle
 * status and version number, wiring `current_version_id`. Inserts rows directly
 * (the status-gated immutability trigger only guards UPDATEs to body/hash).
 */
async function seedArtifact(
  db: TestDb,
  input: {
    workspaceId: string;
    approvalStatus: string;
    versionNumber: number;
    bodyMarkdown?: string;
  },
) {
  const [record] = await db
    .insert(artifactRecord)
    .values({
      workspaceId: input.workspaceId,
      artifactType: "enrollment_message",
      domain: "enrollment",
      title: "Welcome email",
      status: input.approvalStatus as never,
    })
    .returning();
  if (!record) throw new Error("seedArtifact: artifact_record insert returned no row");

  const [version] = await db
    .insert(artifactVersion)
    .values({
      workspaceId: input.workspaceId,
      artifactId: record.id,
      versionNumber: input.versionNumber,
      bodyMarkdown: input.bodyMarkdown ?? "Hi Ada,\n\nWelcome to Career Foundry.",
      contentHash: `hash-${record.id}-${input.versionNumber}`,
      approvalStatus: input.approvalStatus as never,
      immutableAt: input.approvalStatus === "draft" ? null : new Date("2026-07-20T00:00:00Z"),
    })
    .returning();
  if (!version) throw new Error("seedArtifact: artifact_version insert returned no row");

  await db
    .update(artifactRecord)
    .set({ currentVersionId: version.id, updatedAt: new Date() })
    .where(eq(artifactRecord.id, record.id));

  return { record, version };
}

async function insertGmailCommand(
  db: TestDb,
  input: {
    workspaceId: string;
    artifactId: string;
    targetVersion: number;
    to?: string;
    subject?: string;
    idempotencyKey: string;
  },
) {
  const [row] = await db
    .insert(workspaceCommand)
    .values({
      workspaceId: input.workspaceId,
      workspaceIntegrationId: null,
      sourceProviderRecordId: "notion-inbox-page-1",
      commandType: GMAIL_DRAFT_COMMAND_TYPE,
      targetEntityType: "ArtifactRecord",
      targetEntityId: input.artifactId,
      targetVersion: input.targetVersion,
      payloadJson: { to: input.to ?? "ada@example.com", subject: input.subject ?? "Welcome" },
      status: "received",
      idempotencyKey: input.idempotencyKey,
    })
    .returning();
  if (!row) throw new Error("insertGmailCommand: workspace_command insert returned no row");
  return row;
}

async function readCommand(db: TestDb, id: string) {
  const [row] = await db.select().from(workspaceCommand).where(eq(workspaceCommand.id, id));
  if (!row) throw new Error(`readCommand: no workspace_command row for ${id}`);
  return row;
}

async function readCommandEvents(db: TestDb, commandId: string) {
  return db
    .select()
    .from(operationalEvent)
    .where(
      and(
        eq(operationalEvent.entityId, commandId),
        eq(operationalEvent.entityType, "WorkspaceCommand"),
      ),
    );
}

describe("executeGmailDraftCommands (issue #117, slice P1.8b — Create Gmail draft controlled command)", () => {
  const originalActor = process.env.FOS_SERVICE_ACTOR_ID;

  beforeEach(() => {
    delete process.env.FOS_SERVICE_ACTOR_ID;
  });

  afterEach(() => {
    if (originalActor === undefined) delete process.env.FOS_SERVICE_ACTOR_ID;
    else process.env.FOS_SERVICE_ACTOR_ID = originalActor;
  });

  it("FOS1-GMAIL-01: approved artifact + matching version -> createDraft called ONCE, command succeeded, draft id + executed event recorded", async () => {
    const { db, close } = await createTestDb();
    try {
      const workspace = await seedWorkspace(db);
      const { record, version } = await seedArtifact(db, {
        workspaceId: workspace.id,
        approvalStatus: "approved",
        versionNumber: 2,
        bodyMarkdown: "Approved body text.",
      });
      const command = await insertGmailCommand(db, {
        workspaceId: workspace.id,
        artifactId: record.id,
        targetVersion: 2,
        to: "ada@example.com",
        subject: "Your application",
        idempotencyKey: "gmail-key-1",
      });
      const { client, calls } = makeFakeGmail("draft-xyz");

      const result = await executeGmailDraftCommands(db, client, { workspaceId: workspace.id });

      expect(result.commandsLoaded).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(result.conflicts).toBe(0);
      expect(result.rejectedNotApproved).toBe(0);

      // createDraft called exactly once, body built from the artifact version.
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        to: "ada@example.com",
        subject: "Your application",
        body: "Approved body text.",
      });

      const updated = await readCommand(db, command.id);
      expect(updated.status).toBe("succeeded");
      expect(updated.executionStatus).toBe("succeeded");
      expect(updated.executedAt).not.toBeNull();

      const events = await readCommandEvents(db, command.id);
      const executed = events.find((e) => e.type === "workspace_command.executed");
      expect(executed).toBeDefined();
      expect((executed!.payload as { draftId: string }).draftId).toBe("draft-xyz");
      expect((executed!.payload as { versionId: string }).versionId).toBe(version.id);
    } finally {
      await close();
    }
  });

  it("FOS1-GMAIL-02: non-approved (draft) artifact -> command REJECTED, createDraft NOT called", async () => {
    const { db, close } = await createTestDb();
    try {
      const workspace = await seedWorkspace(db);
      const { record } = await seedArtifact(db, {
        workspaceId: workspace.id,
        approvalStatus: "draft",
        versionNumber: 1,
      });
      const command = await insertGmailCommand(db, {
        workspaceId: workspace.id,
        artifactId: record.id,
        targetVersion: 1,
        idempotencyKey: "gmail-key-draft",
      });
      const { client, calls } = makeFakeGmail();

      const result = await executeGmailDraftCommands(db, client, { workspaceId: workspace.id });

      expect(result.rejectedNotApproved).toBe(1);
      expect(result.succeeded).toBe(0);
      expect(calls).toHaveLength(0); // fail-closed: no draft from an unapproved artifact

      const updated = await readCommand(db, command.id);
      expect(updated.status).toBe("rejected");
      expect(updated.rejectionReason).toMatch(/not approved/i);

      const events = await readCommandEvents(db, command.id);
      const rejected = events.find((e) => e.type === "workspace_command.rejected");
      expect(rejected).toBeDefined();
      expect((rejected!.payload as { reason: string }).reason).toBe("artifact_not_approved");
    } finally {
      await close();
    }
  });

  it("FOS1-GMAIL-02b: an explicitly REJECTED artifact is also refused (never draft/rejected states)", async () => {
    const { db, close } = await createTestDb();
    try {
      const workspace = await seedWorkspace(db);
      const { record } = await seedArtifact(db, {
        workspaceId: workspace.id,
        approvalStatus: "rejected",
        versionNumber: 1,
      });
      const command = await insertGmailCommand(db, {
        workspaceId: workspace.id,
        artifactId: record.id,
        targetVersion: 1,
        idempotencyKey: "gmail-key-rejected",
      });
      const { client, calls } = makeFakeGmail();

      const result = await executeGmailDraftCommands(db, client, { workspaceId: workspace.id });

      expect(result.rejectedNotApproved).toBe(1);
      expect(calls).toHaveLength(0);
      expect((await readCommand(db, command.id)).status).toBe("rejected");
    } finally {
      await close();
    }
  });

  it("FOS1-GMAIL-03: version mismatch (§519 / §C2) -> command CONFLICT, createDraft NOT called", async () => {
    const { db, close } = await createTestDb();
    try {
      const workspace = await seedWorkspace(db);
      // Current version is 3; the command was captured against the now-stale 2.
      const { record } = await seedArtifact(db, {
        workspaceId: workspace.id,
        approvalStatus: "approved",
        versionNumber: 3,
      });
      const command = await insertGmailCommand(db, {
        workspaceId: workspace.id,
        artifactId: record.id,
        targetVersion: 2,
        idempotencyKey: "gmail-key-stale",
      });
      const { client, calls } = makeFakeGmail();

      const result = await executeGmailDraftCommands(db, client, { workspaceId: workspace.id });

      expect(result.conflicts).toBe(1);
      expect(result.succeeded).toBe(0);
      expect(calls).toHaveLength(0); // no external side-effect on a conflict

      const updated = await readCommand(db, command.id);
      expect(updated.status).toBe("conflict");
      expect(updated.executedAt).toBeNull();

      const events = await readCommandEvents(db, command.id);
      const failed = events.find((e) => e.type === "workspace_command.failed");
      expect(failed).toBeDefined();
      expect((failed!.payload as { reason: string }).reason).toBe("stale_version");
    } finally {
      await close();
    }
  });

  it("FOS1-GMAIL-04: idempotent re-execution -> no second createDraft, no double success", async () => {
    const { db, close } = await createTestDb();
    try {
      const workspace = await seedWorkspace(db);
      const { record } = await seedArtifact(db, {
        workspaceId: workspace.id,
        approvalStatus: "approved",
        versionNumber: 1,
      });
      const command = await insertGmailCommand(db, {
        workspaceId: workspace.id,
        artifactId: record.id,
        targetVersion: 1,
        idempotencyKey: "gmail-key-idem",
      });
      const { client, calls } = makeFakeGmail();

      const first = await executeGmailDraftCommands(db, client, { workspaceId: workspace.id });
      const second = await executeGmailDraftCommands(db, client, { workspaceId: workspace.id });

      expect(first.succeeded).toBe(1);
      expect(second.commandsLoaded).toBe(0);
      expect(second.succeeded).toBe(0);
      // The SAME command never creates a second draft.
      expect(calls).toHaveLength(1);
      expect((await readCommand(db, command.id)).status).toBe("succeeded");

      // Exactly one executed event across both runs.
      const events = await readCommandEvents(db, command.id);
      expect(events.filter((e) => e.type === "workspace_command.executed")).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("FOS1-GMAIL-05: fake client throws -> command records FAILURE, fail-closed (not succeeded, no partial state)", async () => {
    const { db, close } = await createTestDb();
    try {
      const workspace = await seedWorkspace(db);
      const { record } = await seedArtifact(db, {
        workspaceId: workspace.id,
        approvalStatus: "approved_with_edits",
        versionNumber: 1,
      });
      const command = await insertGmailCommand(db, {
        workspaceId: workspace.id,
        artifactId: record.id,
        targetVersion: 1,
        idempotencyKey: "gmail-key-throws",
      });
      const { client, calls } = makeThrowingGmail("gmail 503");

      const result = await executeGmailDraftCommands(db, client, { workspaceId: workspace.id });

      expect(result.failed).toBe(1);
      expect(result.succeeded).toBe(0);
      expect(calls).toHaveLength(1); // it was attempted, but it threw

      const updated = await readCommand(db, command.id);
      expect(updated.status).toBe("failed_retryable");
      expect(updated.executedAt).toBeNull(); // no partial success

      const events = await readCommandEvents(db, command.id);
      const failed = events.find((e) => e.type === "workspace_command.failed");
      expect(failed).toBeDefined();
      expect((failed!.payload as { reason: string }).reason).toBe("gmail_draft_error");
      // No success event was written.
      expect(events.some((e) => e.type === "workspace_command.executed")).toBe(false);
    } finally {
      await close();
    }
  });

  it("FOS1-GMAIL-06: workspace-scoping -> only the target workspace's commands are loaded; another workspace's stays received", async () => {
    const { db, close } = await createTestDb();
    try {
      const wsA = await seedWorkspace(db, "Workspace A");
      const wsB = await seedWorkspace(db, "Workspace B");
      const artA = await seedArtifact(db, {
        workspaceId: wsA.id,
        approvalStatus: "approved",
        versionNumber: 1,
        bodyMarkdown: "A body",
      });
      const artB = await seedArtifact(db, {
        workspaceId: wsB.id,
        approvalStatus: "approved",
        versionNumber: 1,
        bodyMarkdown: "B body",
      });
      const cmdA = await insertGmailCommand(db, {
        workspaceId: wsA.id,
        artifactId: artA.record.id,
        targetVersion: 1,
        idempotencyKey: "gmail-key-a",
      });
      const cmdB = await insertGmailCommand(db, {
        workspaceId: wsB.id,
        artifactId: artB.record.id,
        targetVersion: 1,
        idempotencyKey: "gmail-key-b",
      });
      const { client, calls } = makeFakeGmail();

      // Execute ONLY workspace A.
      const result = await executeGmailDraftCommands(db, client, { workspaceId: wsA.id });

      expect(result.commandsLoaded).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.body).toBe("A body"); // A's content only

      expect((await readCommand(db, cmdA.id)).status).toBe("succeeded");
      // B's command is untouched by A's run.
      expect((await readCommand(db, cmdB.id)).status).toBe("received");
    } finally {
      await close();
    }
  });

  it("FOS1-GMAIL-07: a command targeting ANOTHER workspace's artifact is rejected (cross-tenant guard), no draft", async () => {
    const { db, close } = await createTestDb();
    try {
      const wsA = await seedWorkspace(db, "Workspace A");
      const wsB = await seedWorkspace(db, "Workspace B");
      // An approved artifact that belongs to B.
      const artB = await seedArtifact(db, {
        workspaceId: wsB.id,
        approvalStatus: "approved",
        versionNumber: 1,
      });
      // A command in A that (via a tampered/orphaned row) targets B's artifact.
      const command = await insertGmailCommand(db, {
        workspaceId: wsA.id,
        artifactId: artB.record.id,
        targetVersion: 1,
        idempotencyKey: "gmail-key-cross",
      });
      const { client, calls } = makeFakeGmail();

      const result = await executeGmailDraftCommands(db, client, { workspaceId: wsA.id });

      expect(result.rejectedInvalid).toBe(1);
      expect(result.succeeded).toBe(0);
      expect(calls).toHaveLength(0);
      expect((await readCommand(db, command.id)).status).toBe("rejected");
    } finally {
      await close();
    }
  });
});
