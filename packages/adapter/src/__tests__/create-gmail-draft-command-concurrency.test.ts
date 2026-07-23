import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
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
import { createRealPgTestDb } from "./postgres-test-db.js";

type RealDb = Awaited<ReturnType<typeof createRealPgTestDb>>["db"];

/**
 * A fake GmailDraftClient shared across all racers in one iteration. `calls` is
 * a plain array push — safe under this test's concurrency because the racers
 * share ONE Node event loop (only their DB round-trips are genuinely parallel,
 * over separate pooled Postgres connections). Still NO real Gmail API, NO
 * credential, NO network. `delayMs` holds the winner inside `createDraft` so its
 * post-claim window overlaps the losers' attempts — makes the race wall-clock
 * real, not just logically possible.
 */
function makeConcurrentGmail(delayMs = 5) {
  const calls: GmailDraftInput[] = [];
  const client: GmailDraftClient = {
    createDraft: async (input) => {
      calls.push(input);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return { draftId: `draft-${calls.length}` };
    },
  };
  return { client, calls };
}

/**
 * FOS1-GMAIL-10 (validates the P1.8b CAS under REAL contention): the Gmail-draft
 * command's no-duplicate-draft guarantee rests on a compare-and-swap —
 * `UPDATE workspace_command SET status='executing' WHERE id=? AND
 * status='received'` claimed before the external `createDraft`. The unit suite
 * (FOS1-GMAIL-09) proves the LOGIC by pre-setting a row to `executing`, but
 * PGlite is single-connection, so two genuinely concurrent executors can never
 * actually contend for the row lock there. This suite runs against a REAL
 * multi-connection Postgres (`DATABASE_URL`) and fires N genuinely concurrent
 * `executeGmailDraftCommands` runs at the SAME received command — the row-level
 * lock is what must serialize the claim so EXACTLY ONE draft is ever created.
 * Skipped when no real Postgres is reachable, so `npm test` needs no DB server.
 *
 * Unlike the FOS0-EXE-11 stage-commands race (issue #47), this command has NO
 * second independent guarded write for a loser: a racer that loses the
 * `received`->`executing` CAS simply `return`s without touching any counter or
 * writing an event. So the invariant is exact and free of the #47 bookkeeping
 * ambiguity: across all racers, succeeded === 1, drafts created === 1.
 */
describe.skipIf(!process.env.DATABASE_URL)(
  "executeGmailDraftCommands under real concurrency (real Postgres)",
  () => {
    let ctx: Awaited<ReturnType<typeof createRealPgTestDb>>;
    let workspaceId: string;

    beforeAll(async () => {
      ctx = await createRealPgTestDb();
      const [workspace] = await ctx.db
        .insert(fosWorkspace)
        .values({ name: "Gmail Concurrency Workspace", ownerUserId: "founder-1" })
        .returning();
      workspaceId = workspace!.id;
    });

    afterAll(async () => {
      // operational_event is append-only (DB trigger blocks DELETE) and
      // FK-references the workspace, so it (and the workspace) can't be cleaned
      // up here — harmless for a throwaway test DB, mirroring the sibling
      // real-Postgres concurrency suites.
      await ctx.db.delete(workspaceCommand).where(eq(workspaceCommand.workspaceId, workspaceId));
      await ctx.db.delete(artifactVersion).where(eq(artifactVersion.workspaceId, workspaceId));
      await ctx.db.delete(artifactRecord).where(eq(artifactRecord.workspaceId, workspaceId));
      await ctx.close();
    });

    async function seedApprovedCommand(db: RealDb, iteration: number) {
      const [record] = await db
        .insert(artifactRecord)
        .values({
          workspaceId,
          artifactType: "enrollment_message",
          domain: "enrollment",
          title: `Welcome email ${iteration}`,
          status: "approved" as never,
        })
        .returning();
      const [version] = await db
        .insert(artifactVersion)
        .values({
          workspaceId,
          artifactId: record!.id,
          versionNumber: 1,
          bodyMarkdown: `Hi Ada,\n\nWelcome (iteration ${iteration}).`,
          contentHash: `hash-${record!.id}-1`,
          approvalStatus: "approved" as never,
          immutableAt: new Date("2026-07-20T00:00:00Z"),
        })
        .returning();
      await db
        .update(artifactRecord)
        .set({ currentVersionId: version!.id, updatedAt: new Date() })
        .where(eq(artifactRecord.id, record!.id));
      const [command] = await db
        .insert(workspaceCommand)
        .values({
          workspaceId,
          workspaceIntegrationId: null,
          sourceProviderRecordId: `notion-inbox-${iteration}`,
          commandType: GMAIL_DRAFT_COMMAND_TYPE,
          targetEntityType: "ArtifactRecord",
          targetEntityId: record!.id,
          targetVersion: 1,
          payloadJson: { to: "ada@example.com", subject: `Welcome ${iteration}` },
          status: "received",
          idempotencyKey: `gmail-conc-${iteration}-${record!.id}`,
        })
        .returning();
      return command!;
    }

    it("FOS1-GMAIL-10: N genuinely concurrent runs against the SAME received command — exactly ONE draft, across many races", async () => {
      const ITERATIONS = 20;
      const RACERS = 8;

      for (let i = 0; i < ITERATIONS; i++) {
        const command = await seedApprovedCommand(ctx.db, i);
        const { client, calls } = makeConcurrentGmail();

        // N genuinely concurrent runs, each over its own pooled connection,
        // racing to claim + draft the SAME received command.
        const results = await Promise.all(
          Array.from({ length: RACERS }, () =>
            executeGmailDraftCommands(ctx.db, client, { workspaceId }),
          ),
        );

        // THE guarantee: the row-level CAS serialized the claim, so exactly one
        // racer won and exactly one external draft was created — unconditional,
        // for every race.
        expect(calls).toHaveLength(1);
        const totalSucceeded = results.reduce((sum, r) => sum + r.succeeded, 0);
        expect(totalSucceeded).toBe(1);

        // No racer double-drafts, none records a spurious failure/conflict.
        const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);
        const totalConflicts = results.reduce((sum, r) => sum + r.conflicts, 0);
        expect(totalFailed).toBe(0);
        expect(totalConflicts).toBe(0);

        // The command row lands `succeeded` exactly once, with exactly one
        // executed event carrying the single draft id.
        const [finalCommand] = await ctx.db
          .select()
          .from(workspaceCommand)
          .where(eq(workspaceCommand.id, command.id));
        expect(finalCommand!.status).toBe("succeeded");

        const executedEvents = await ctx.db
          .select()
          .from(operationalEvent)
          .where(eq(operationalEvent.entityId, command.id));
        expect(executedEvents.filter((e) => e.type === "workspace_command.executed")).toHaveLength(
          1,
        );
      }
    });
  },
);
