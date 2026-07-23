import { and, asc, eq } from "drizzle-orm";
import { artifactRecord, artifactVersion, workspaceCommand } from "@fos/db/schema";
import { writeEvent, type Db } from "@fos/db/services";
import type { GmailDraftClient } from "./gmail-draft-client.js";

/**
 * "Create Gmail draft" controlled command (spec §7.3; §9.1 step 10 / §9.4 step
 * 6 — an external email draft is created ONLY after founder approval). Slice
 * P1.8b (issue #117). This is the EXECUTION half: it drives a captured
 * `create_gmail_draft` `WorkspaceCommand` — which references an APPROVED
 * `ArtifactRecord` plus recipient context — to an external Gmail DRAFT via a
 * mockable `GmailDraftClient`. It NEVER sends mail, and (per the interface's
 * contract) never handles a credential or makes a real Gmail call — the live
 * OAuth/API integration is a deferred activation slice.
 *
 * Models on `executeStageCommands` (issue #36): workspace_command capture then
 * version-checked execution, per-command isolation, event-per-outcome, and
 * status-guarded idempotency.
 */
export const COMMAND_TYPE = "create_gmail_draft";
const TARGET_ENTITY_TYPE = "ArtifactRecord";

/**
 * The §12.2 artifact states from which an external draft may be created. §9.1
 * step 10 / §9.4 gate this on founder approval, so ONLY the approved family
 * qualifies — never `draft`/`in_review` (not yet approved), `rejected`/
 * `deferred`, or the terminal `executed`/`failed`/`superseded`.
 */
const APPROVED_STATES = new Set<string>(["approved", "approved_with_edits", "ready_for_action"]);

type WorkspaceCommandRow = typeof workspaceCommand.$inferSelect;

/** Recipient context captured on the command (the body comes from the artifact). */
interface GmailDraftCommandPayload {
  to: string;
  subject: string;
}

export interface ExecuteGmailDraftCommandsInput {
  workspaceId: string;
}

export interface ExecuteGmailDraftCommandsResult {
  /** `received` `create_gmail_draft` commands loaded this run. */
  commandsLoaded: number;
  /** Draft created via `createDraft`, command `succeeded`, draft id + event recorded. */
  succeeded: number;
  /**
   * §519 version guard tripped: the artifact's current `FOS Version`
   * (`ArtifactVersion.version_number` of `current_version_id`, per PATCH-SET-01
   * §C2) no longer matches the version the command was captured against —
   * command set to `conflict`, NO draft created.
   */
  conflicts: number;
  /**
   * The referenced artifact is not in an approved state (§9.1 step 10) — command
   * `rejected`, NO draft created.
   */
  rejectedNotApproved: number;
  /**
   * The `target_entity_id` names no artifact in this workspace (missing, or —
   * defense-in-depth vs a tampered/cross-workspace command row — another
   * tenant's), or the record has no current version — command `rejected`, NO
   * draft created.
   */
  rejectedInvalid: number;
  /**
   * `createDraft` (or a surrounding write) threw — command recorded as
   * `failed_retryable`, fail-closed: it did NOT succeed and created no partial
   * state. Isolated so one failure cannot abort the batch.
   */
  failed: number;
}

function emptyResult(): ExecuteGmailDraftCommandsResult {
  return {
    commandsLoaded: 0,
    succeeded: 0,
    conflicts: 0,
    rejectedNotApproved: 0,
    rejectedInvalid: 0,
    failed: 0,
  };
}

/**
 * ADR-01 service-account actor shim (mirrors `executeStageCommands`): this
 * executor runs as a background poller, not behind an authenticated request, so
 * every event it writes is attributed to a stable `system` actor. Read at call
 * time so tests can vary/omit the env var.
 */
function serviceActor() {
  return {
    type: "system" as const,
    // `||` (not `??`) so an empty-string env var also falls back to the stable default.
    id: process.env.FOS_SERVICE_ACTOR_ID || "gmail-draft-command-executor",
  };
}

/**
 * Applies received `create_gmail_draft` commands for one workspace. Per command,
 * fail-closed at every gate — a command only reaches `succeeded` when the
 * artifact is approved, the version matches, AND `createDraft` returns:
 * 1. **Invalid target** (missing / cross-workspace / no current version) ->
 *    `rejected` (`rejectedInvalid`), no draft.
 * 2. **Version mismatch** (§519 / §C2) -> `conflict`, no draft.
 * 3. **Not approved** (§9.1 step 10) -> `rejected` (`rejectedNotApproved`), no draft.
 * 4. **Approved + matching version** -> claim the command `executing`
 *    (compare-and-swap from `received`), call `createDraft`, then mark
 *    `succeeded` (+ `executed` event carrying the draft id). The `executing`
 *    claim is the idempotency/no-duplicate guard: a re-run (or concurrent
 *    runner) never re-loads a non-`received` command, so the SAME command never
 *    creates a second draft, and a crash after the external call leaves the row
 *    `executing` (never silently re-submitted) rather than duplicating a draft.
 * 5. **`createDraft` throws** -> `failed_retryable` (+ `failed` event),
 *    fail-closed, isolated from the rest of the batch.
 *
 * Workspace-scoped: only this workspace's `received` commands are loaded, and
 * the artifact is re-checked to belong to the command's workspace before any
 * external call.
 */
export async function executeGmailDraftCommands(
  db: Db,
  gmailClient: GmailDraftClient,
  input: ExecuteGmailDraftCommandsInput,
): Promise<ExecuteGmailDraftCommandsResult> {
  const { workspaceId } = input;
  const result = emptyResult();

  const received = await db
    .select()
    .from(workspaceCommand)
    .where(
      and(
        eq(workspaceCommand.workspaceId, workspaceId),
        eq(workspaceCommand.commandType, COMMAND_TYPE),
        eq(workspaceCommand.targetEntityType, TARGET_ENTITY_TYPE),
        eq(workspaceCommand.status, "received"),
      ),
    )
    // Deterministic, audit-reproducible processing order.
    .orderBy(asc(workspaceCommand.createdAt), asc(workspaceCommand.id));
  result.commandsLoaded = received.length;

  for (const command of received) {
    // Per-command isolation: one command's unexpected fault (a DB error, a
    // thrown `createDraft`) must not abort the batch and starve the rest.
    try {
      await executeOne(db, gmailClient, command, result);
    } catch (err) {
      console.error(
        `[executeGmailDraftCommands] command execution failed for command_id=${command.id}:`,
        err instanceof Error ? err.message : String(err),
      );
      result.failed += 1;
    }
  }

  return result;
}

async function executeOne(
  db: Db,
  gmailClient: GmailDraftClient,
  command: WorkspaceCommandRow,
  result: ExecuteGmailDraftCommandsResult,
): Promise<void> {
  // Defense-in-depth (the command row can originate from untrusted provider
  // input): the target artifact must exist AND belong to the command's
  // workspace. A missing/cross-workspace target is rejected, never acted on.
  const [record] = await db
    .select()
    .from(artifactRecord)
    .where(eq(artifactRecord.id, command.targetEntityId))
    .limit(1);
  if (!record || record.workspaceId !== command.workspaceId || !record.currentVersionId) {
    await rejectCommand(db, command, {
      reason: !record
        ? "Target artifact does not exist"
        : record.workspaceId !== command.workspaceId
          ? "Target artifact belongs to a different workspace"
          : "Target artifact has no current version",
      eventReason: "invalid_target",
      eventPayload: { targetEntityId: command.targetEntityId },
      counter: "rejectedInvalid",
      result,
    });
    return;
  }

  const [version] = await db
    .select()
    .from(artifactVersion)
    .where(eq(artifactVersion.id, record.currentVersionId))
    .limit(1);
  if (!version) {
    await rejectCommand(db, command, {
      reason: "Target artifact's current version row is missing",
      eventReason: "invalid_target",
      eventPayload: { targetEntityId: command.targetEntityId },
      counter: "rejectedInvalid",
      result,
    });
    return;
  }

  // §519 / §C2: a controlled command executes only when the provider `FOS
  // Version` (for an artifact projection, `current_version.version_number`)
  // still matches what the command was captured against. Checked BEFORE the
  // approval gate: a newer revision advances the current version, and a stale
  // command against the old version is a reconciliation `conflict`, not a plain
  // rejection.
  if (version.versionNumber !== command.targetVersion) {
    const updated = await claim(db, command.id, "conflict");
    if (!updated) return; // already resolved by a concurrent/prior run
    await writeCommandEvent(db, command, "workspace_command.failed", {
      commandId: command.id,
      reason: "stale_version",
      expectedVersion: command.targetVersion,
      actualVersion: version.versionNumber,
    });
    result.conflicts += 1;
    return;
  }

  // §9.1 step 10 / §9.4: an external draft is created ONLY from an approved
  // artifact. Read the authoritative lifecycle carrier (the version's
  // `approval_status`, §E2), never the derived record mirror.
  if (!APPROVED_STATES.has(version.approvalStatus)) {
    await rejectCommand(db, command, {
      reason:
        `Artifact is not approved (status "${version.approvalStatus}"): an external draft ` +
        "is created only from an approved artifact (§9.1 step 10)",
      eventReason: "artifact_not_approved",
      eventPayload: { artifactId: record.id, artifactStatus: version.approvalStatus },
      counter: "rejectedNotApproved",
      result,
    });
    return;
  }

  const payload = command.payloadJson as GmailDraftCommandPayload;

  // Idempotency / no-duplicate guard: claim the command `executing` (CAS from
  // `received`) BEFORE the external call. If the claim finds no `received` row,
  // another run already took it — do nothing (no second draft). After this
  // point the command is never re-loaded as `received`, so the SAME command
  // can never create a second draft.
  const claimed = await claim(db, command.id, "executing");
  if (!claimed) return;

  let draft: { draftId: string };
  try {
    draft = await gmailClient.createDraft({
      to: payload.to,
      subject: payload.subject,
      body: version.bodyMarkdown,
    });
  } catch (err) {
    // Fail-closed: no draft was created (or its creation is unconfirmed), so the
    // command does NOT succeed. Record the failure; leave `failed_retryable` for
    // a future retry sweep (deferred — this executor only loads `received`).
    await db
      .update(workspaceCommand)
      .set({ status: "failed_retryable", executionStatus: "failed", updatedAt: new Date() })
      .where(and(eq(workspaceCommand.id, command.id), eq(workspaceCommand.status, "executing")));
    await writeCommandEvent(db, command, "workspace_command.failed", {
      commandId: command.id,
      reason: "gmail_draft_error",
      message: err instanceof Error ? err.message : String(err),
    });
    result.failed += 1;
    return;
  }

  const now = new Date();
  await db
    .update(workspaceCommand)
    .set({
      status: "succeeded",
      executionStatus: "succeeded",
      executedAt: now,
      updatedAt: now,
    })
    .where(and(eq(workspaceCommand.id, command.id), eq(workspaceCommand.status, "executing")));

  await writeCommandEvent(db, command, "workspace_command.executed", {
    commandId: command.id,
    artifactId: record.id,
    versionId: version.id,
    versionNumber: version.versionNumber,
    // The external provider draft id — the durable record of the created draft.
    draftId: draft.draftId,
  });
  result.succeeded += 1;
}

/** Compare-and-swap a command from `received` to `next`; returns whether we won it. */
async function claim(db: Db, commandId: string, next: "executing" | "conflict"): Promise<boolean> {
  const updated = await db
    .update(workspaceCommand)
    .set({ status: next, updatedAt: new Date() })
    .where(and(eq(workspaceCommand.id, commandId), eq(workspaceCommand.status, "received")))
    .returning({ id: workspaceCommand.id });
  return updated.length > 0;
}

async function rejectCommand(
  db: Db,
  command: WorkspaceCommandRow,
  opts: {
    reason: string;
    eventReason: string;
    eventPayload: Record<string, unknown>;
    counter: "rejectedInvalid" | "rejectedNotApproved";
    result: ExecuteGmailDraftCommandsResult;
  },
): Promise<void> {
  const updated = await db
    .update(workspaceCommand)
    .set({ status: "rejected", rejectionReason: opts.reason, updatedAt: new Date() })
    .where(and(eq(workspaceCommand.id, command.id), eq(workspaceCommand.status, "received")))
    .returning({ id: workspaceCommand.id });
  if (updated.length === 0) return; // already resolved by a concurrent/prior run

  await writeCommandEvent(db, command, "workspace_command.rejected", {
    commandId: command.id,
    reason: opts.eventReason,
    ...opts.eventPayload,
  });
  opts.result[opts.counter] += 1;
}

async function writeCommandEvent(
  db: Db,
  command: WorkspaceCommandRow,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await writeEvent(db, {
    workspaceId: command.workspaceId,
    entityType: "WorkspaceCommand",
    entityId: command.id,
    source: "gmail_command",
    correlationId: command.correlationId,
    causationId: null,
    actor: serviceActor(),
    type,
    payload,
  });
}
