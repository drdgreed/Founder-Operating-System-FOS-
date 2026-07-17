import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import type { EventActor } from "@fos/contracts";
import {
  artifactRecord,
  artifactVersion,
  type ArtifactType,
  type ArtifactDomain,
} from "../schema/index.js";
import { writeEvent } from "./event-writer.js";
import { computeContentHash } from "./content-hash.js";
import {
  isLegalArtifactTransition,
  eventForArtifactTransition,
  type ArtifactStatus,
} from "./artifact-transitions.js";
import type { Db } from "./types.js";

export class ArtifactNotFoundError extends Error {
  constructor(artifactId: string) {
    super(`ArtifactRecord ${artifactId} not found`);
    this.name = "ArtifactNotFoundError";
  }
}

export class ArtifactVersionNotFoundError extends Error {
  constructor(versionId: string) {
    super(`ArtifactVersion ${versionId} not found`);
    this.name = "ArtifactVersionNotFoundError";
  }
}

export class IllegalArtifactTransitionError extends Error {
  constructor(
    public readonly from: ArtifactStatus,
    public readonly to: ArtifactStatus,
  ) {
    super(`Illegal artifact transition: ${from} -> ${to} (spec §12.2)`);
    this.name = "IllegalArtifactTransitionError";
  }
}

/**
 * Optimistic-concurrency failure. The version's authoritative lifecycle state
 * (`approval_status`, §E2) is used as the compare-and-swap token — there is no
 * separate numeric version counter on ArtifactVersion in the spec. A caller
 * acting on a stale view of the version's status is rejected.
 */
export class StaleArtifactVersionError extends Error {
  constructor(
    public readonly expectedStatus: ArtifactStatus,
    public readonly actualStatus: ArtifactStatus,
  ) {
    super(`Stale artifact version: expected status ${expectedStatus}, actual ${actualStatus}`);
    this.name = "StaleArtifactVersionError";
  }
}

/**
 * Raised when an in-place draft edit targets a version that is not `draft`
 * (PATCH-SET-02 §B: content is mutable only while a version is a draft). The
 * DB status-gated trigger is the backstop; this service check is the primary
 * guard.
 */
export class ArtifactNotDraftError extends Error {
  constructor(
    public readonly versionId: string,
    public readonly actualStatus: ArtifactStatus,
  ) {
    super(`ArtifactVersion ${versionId} is not a draft (status ${actualStatus}); edits are locked`);
    this.name = "ArtifactNotDraftError";
  }
}

export interface CreateArtifactInput {
  workspaceId: string;
  productId?: string | null;
  artifactType: ArtifactType;
  domain: ArtifactDomain;
  title: string;
  bodyMarkdown: string;
  claimsManifestJson?: unknown;
  actor: EventActor;
  source?: string;
  correlationId?: string;
  causationId?: string | null;
}

export interface CreateArtifactResult {
  artifactId: string;
  versionId: string;
  versionNumber: number;
  contentHash: string;
  status: ArtifactStatus;
  eventId: string;
  correlationId: string;
}

/**
 * Create-artifact (build step 4): inserts an ArtifactRecord + its v1
 * ArtifactVersion at `draft`, sets the content hash, points the record at v1,
 * and emits exactly one `artifact.created` event (S1-valid, via writeEvent).
 */
export async function createArtifact(
  db: Db,
  input: CreateArtifactInput,
): Promise<CreateArtifactResult> {
  return db.transaction(async (tx: Db) => {
    const correlationId = input.correlationId ?? randomUUID();
    const contentHash = computeContentHash(input.bodyMarkdown);

    const [record] = await tx
      .insert(artifactRecord)
      .values({
        workspaceId: input.workspaceId,
        productId: input.productId ?? null,
        artifactType: input.artifactType,
        domain: input.domain,
        title: input.title,
        status: "draft",
        currentVersionId: null,
      })
      .returning();

    const [version] = await tx
      .insert(artifactVersion)
      .values({
        workspaceId: input.workspaceId,
        artifactId: record.id,
        versionNumber: 1,
        bodyMarkdown: input.bodyMarkdown,
        contentHash,
        claimsManifestJson: input.claimsManifestJson ?? {},
        approvalStatus: "draft",
      })
      .returning();

    await tx
      .update(artifactRecord)
      .set({ currentVersionId: version.id, updatedAt: new Date() })
      .where(eq(artifactRecord.id, record.id));

    const event = await writeEvent(tx, {
      workspaceId: input.workspaceId,
      productId: input.productId ?? null,
      entityType: "ArtifactRecord",
      entityId: record.id,
      source: input.source ?? "api",
      correlationId,
      causationId: input.causationId ?? null,
      actor: input.actor,
      type: "artifact.created",
      // §C payload shape.
      payload: {
        artifactId: record.id,
        versionId: version.id,
        artifactType: input.artifactType,
      },
    });

    return {
      artifactId: record.id,
      versionId: version.id,
      versionNumber: 1,
      contentHash,
      status: "draft",
      eventId: event.id,
      correlationId,
    };
  });
}

export interface TransitionArtifactVersionInput {
  versionId: string;
  /** Compare-and-swap token: the status the caller believes the version is in. */
  expectedStatus: ArtifactStatus;
  toStatus: ArtifactStatus;
  actor: EventActor;
  source?: string;
  causationId?: string | null;
  /**
   * Optional correlation_id for the emitted event (PATCH-SET-03 §B). When a
   * caller drives this transition as part of a larger operation (e.g. an
   * approval decision), it passes the operation's correlation_id so all events
   * share one. Backward-compatible: minted per-call when absent, as 0.1b
   * callers rely on.
   */
  correlationId?: string;
}

export interface TransitionArtifactVersionResult {
  versionId: string;
  artifactId: string;
  fromStatus: ArtifactStatus;
  toStatus: ArtifactStatus;
  eventId: string;
}

/**
 * Transition-version-status (build step 4, PATCH-SET-02 §A/§B): applies a
 * §12.2 lifecycle edge to a version's `approval_status`. A legal edge:
 * - updates `approval_status`,
 * - sets `immutable_at = now()` on the FIRST transition out of `draft`
 *   (draft -> in_review / draft -> superseded), locking content thereafter,
 * - syncs the ArtifactRecord.status mirror when the version is the record's
 *   current version,
 * - emits exactly the ONE named event mapped to this edge (§A) — no generic
 *   `artifact.status_changed`.
 * An illegal edge, or a stale-status (optimistic-concurrency) request, throws
 * and writes/emits NOTHING.
 */
export async function transitionArtifactVersionStatus(
  db: Db,
  input: TransitionArtifactVersionInput,
): Promise<TransitionArtifactVersionResult> {
  return db.transaction(async (tx: Db) => {
    const [version] = await tx
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, input.versionId))
      .limit(1);

    if (!version) {
      throw new ArtifactVersionNotFoundError(input.versionId);
    }

    const current = version.approvalStatus as ArtifactStatus;
    if (current !== input.expectedStatus) {
      throw new StaleArtifactVersionError(input.expectedStatus, current);
    }

    if (!isLegalArtifactTransition(current, input.toStatus)) {
      throw new IllegalArtifactTransitionError(current, input.toStatus);
    }

    // §B (PATCH-SET-02, as amended): `immutable_at` reflects the CURRENT lock
    // state. Set it on leaving draft (content locks); clear it on a
    // revision-request re-open (in_review -> draft) where content is editable
    // again. Invariant: immutable_at non-null iff approval_status <> 'draft'.
    // The DB content trigger is gated on the row's current status; immutable_at
    // tracks that state rather than a one-time stamp.
    const versionUpdate: Record<string, unknown> = {
      approvalStatus: input.toStatus,
      updatedAt: new Date(),
    };
    if (current === "draft" && input.toStatus !== "draft") {
      versionUpdate.immutableAt = new Date();
    } else if (input.toStatus === "draft") {
      versionUpdate.immutableAt = null;
    }

    const updated = await tx
      .update(artifactVersion)
      .set(versionUpdate)
      .where(
        and(
          eq(artifactVersion.id, input.versionId),
          eq(artifactVersion.approvalStatus, input.expectedStatus),
        ),
      )
      .returning();

    if (updated.length === 0) {
      // Concurrent writer changed the status between our SELECT and UPDATE.
      throw new StaleArtifactVersionError(input.expectedStatus, current);
    }

    // Sync the derived record mirror (§E2) only when this version is current.
    const [record] = await tx
      .select()
      .from(artifactRecord)
      .where(eq(artifactRecord.id, version.artifactId))
      .limit(1);
    if (record && record.currentVersionId === input.versionId) {
      await tx
        .update(artifactRecord)
        .set({ status: input.toStatus, updatedAt: new Date() })
        .where(eq(artifactRecord.id, record.id));
    }

    const event = await writeEvent(tx, {
      workspaceId: version.workspaceId,
      productId: record?.productId ?? null,
      entityType: "ArtifactVersion",
      entityId: input.versionId,
      source: input.source ?? "api",
      correlationId: input.correlationId ?? randomUUID(),
      causationId: input.causationId ?? null,
      actor: input.actor,
      // §A: the single named event for this exact edge.
      type: eventForArtifactTransition(current, input.toStatus),
      // §C lifecycle payload shape.
      payload: {
        artifactId: version.artifactId,
        versionId: input.versionId,
        fromStatus: current,
        toStatus: input.toStatus,
      },
    });

    return {
      versionId: input.versionId,
      artifactId: version.artifactId,
      fromStatus: current,
      toStatus: input.toStatus,
      eventId: event.id,
    };
  });
}

export interface EditDraftContentInput {
  versionId: string;
  /** Optional compare-and-swap token: the status the caller expects. */
  expectedStatus?: ArtifactStatus;
  newBodyMarkdown: string;
  claimsManifestJson?: unknown;
  actor: EventActor;
  source?: string;
  causationId?: string | null;
}

export interface EditDraftContentResult {
  versionId: string;
  artifactId: string;
  previousContentHash: string;
  contentHash: string;
  eventId: string;
}

/**
 * In-place draft edit (PATCH-SET-02 §B): rewrites a `draft` version's
 * `body_markdown` in place, recomputes `content_hash` (§S3), and emits
 * `artifact.draft_edited`. Permitted ONLY while the version is `draft` — the
 * service rejects a non-draft target (ArtifactNotDraftError) and the DB
 * status-gated trigger is the backstop. The SAME version row is mutated; no
 * new version is created (post-approval content changes go through revision).
 */
export async function editDraftContent(
  db: Db,
  input: EditDraftContentInput,
): Promise<EditDraftContentResult> {
  return db.transaction(async (tx: Db) => {
    const [version] = await tx
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, input.versionId))
      .limit(1);

    if (!version) {
      throw new ArtifactVersionNotFoundError(input.versionId);
    }

    const current = version.approvalStatus as ArtifactStatus;
    if (input.expectedStatus !== undefined && current !== input.expectedStatus) {
      throw new StaleArtifactVersionError(input.expectedStatus, current);
    }
    if (current !== "draft") {
      throw new ArtifactNotDraftError(input.versionId, current);
    }

    // Resolve the artifact's product for the event envelope (§B0 scoping).
    const [record] = await tx
      .select({ productId: artifactRecord.productId })
      .from(artifactRecord)
      .where(eq(artifactRecord.id, version.artifactId))
      .limit(1);

    const previousContentHash = version.contentHash;
    const contentHash = computeContentHash(input.newBodyMarkdown);

    const versionUpdate: Record<string, unknown> = {
      bodyMarkdown: input.newBodyMarkdown,
      contentHash,
      updatedAt: new Date(),
    };
    if (input.claimsManifestJson !== undefined) {
      versionUpdate.claimsManifestJson = input.claimsManifestJson;
    }

    // CAS guard on `draft` closes the race with a concurrent transition out of
    // draft; the status-gated trigger also blocks any non-draft mutation.
    const updated = await tx
      .update(artifactVersion)
      .set(versionUpdate)
      .where(
        and(eq(artifactVersion.id, input.versionId), eq(artifactVersion.approvalStatus, "draft")),
      )
      .returning();

    if (updated.length === 0) {
      throw new StaleArtifactVersionError("draft", current);
    }

    const event = await writeEvent(tx, {
      workspaceId: version.workspaceId,
      productId: record?.productId ?? null,
      entityType: "ArtifactVersion",
      entityId: input.versionId,
      source: input.source ?? "api",
      correlationId: randomUUID(),
      causationId: input.causationId ?? null,
      actor: input.actor,
      type: "artifact.draft_edited",
      // §C payload shape.
      payload: {
        artifactId: version.artifactId,
        versionId: input.versionId,
        previousContentHash,
        contentHash,
      },
    });

    return {
      versionId: input.versionId,
      artifactId: version.artifactId,
      previousContentHash,
      contentHash,
      eventId: event.id,
    };
  });
}

export interface CreateRevisionInput {
  artifactId: string;
  bodyMarkdown: string;
  claimsManifestJson?: unknown;
  actor: EventActor;
  source?: string;
  correlationId?: string;
  causationId?: string | null;
}

export interface CreateRevisionResult {
  artifactId: string;
  versionId: string;
  versionNumber: number;
  contentHash: string;
  eventId: string;
}

/**
 * Create-revision (build step 4): produces a NEW ArtifactVersion
 * (version_number + 1) at `draft` and repoints the record's current version +
 * status mirror. The prior version row is left completely untouched (§12.2:
 * "revision creates a new version"). Emits one `artifact.version_created`.
 */
export async function createArtifactRevision(
  db: Db,
  input: CreateRevisionInput,
): Promise<CreateRevisionResult> {
  return db.transaction(async (tx: Db) => {
    const [record] = await tx
      .select()
      .from(artifactRecord)
      .where(eq(artifactRecord.id, input.artifactId))
      .limit(1);
    if (!record) {
      throw new ArtifactNotFoundError(input.artifactId);
    }

    const existing = await tx
      .select({ n: artifactVersion.versionNumber })
      .from(artifactVersion)
      .where(eq(artifactVersion.artifactId, input.artifactId));
    const nextNumber =
      existing.reduce((max: number, r: { n: number }) => Math.max(max, r.n), 0) + 1;

    const contentHash = computeContentHash(input.bodyMarkdown);

    const [version] = await tx
      .insert(artifactVersion)
      .values({
        workspaceId: record.workspaceId,
        artifactId: input.artifactId,
        versionNumber: nextNumber,
        bodyMarkdown: input.bodyMarkdown,
        contentHash,
        claimsManifestJson: input.claimsManifestJson ?? {},
        approvalStatus: "draft",
      })
      .returning();

    await tx
      .update(artifactRecord)
      .set({ currentVersionId: version.id, status: "draft", updatedAt: new Date() })
      .where(eq(artifactRecord.id, input.artifactId));

    const event = await writeEvent(tx, {
      workspaceId: record.workspaceId,
      productId: record.productId ?? null,
      entityType: "ArtifactRecord",
      entityId: input.artifactId,
      source: input.source ?? "api",
      correlationId: input.correlationId ?? randomUUID(),
      causationId: input.causationId ?? null,
      actor: input.actor,
      type: "artifact.version_created",
      // §C payload shape.
      payload: {
        artifactId: input.artifactId,
        versionId: version.id,
        versionNumber: nextNumber,
      },
    });

    return {
      artifactId: input.artifactId,
      versionId: version.id,
      versionNumber: nextNumber,
      contentHash,
      eventId: event.id,
    };
  });
}
