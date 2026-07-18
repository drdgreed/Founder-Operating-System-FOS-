import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { EventActor } from "@fos/contracts";
import { person, type personSourceEnum, type personLifecycleEnum } from "../schema/person.js";
import { enrollmentOpportunity } from "../schema/enrollment_opportunity.js";
import { applicationSubmission } from "../schema/application_submission.js";
import { writeEvent } from "./event-writer.js";
import {
  deriveIntakeIdempotencyKey,
  isDuplicateIntakeIdempotencyKeyError,
  normalizePersonNaturalKey,
} from "./idempotency.js";
import type { Db } from "./types.js";

type PersonSource = (typeof personSourceEnum.enumValues)[number];
type PersonLifecycle = (typeof personLifecycleEnum.enumValues)[number];

export interface IntakeInput {
  workspaceId: string;
  productId: string;
  integrationId?: string | null;
  externalApplicationRef?: string | null;
  actor: EventActor;
  person: {
    firstName: string;
    lastName: string;
    preferredName?: string | null;
    email?: string | null;
    phone?: string | null;
    currentRole?: string | null;
    currentCompany?: string | null;
    location?: string | null;
    linkedinUrl?: string | null;
    portfolioUrl?: string | null;
    source: PersonSource;
    sourceDetail?: string | null;
    lifecycleType?: PersonLifecycle;
  };
  application: {
    formVersion: string;
    rawPayloadJson: unknown;
    normalizedPayloadJson?: unknown;
    resumeAssetId?: string | null;
    linkedinSnapshotAssetId?: string | null;
    sourceReference: string;
  };
}

export interface IntakeResult {
  deduped: boolean;
  personId: string;
  opportunityId: string;
  submissionId: string;
  eventIds: string[];
  correlationId: string | null;
}

/**
 * Application intake service (spec §15.8 `POST /api/fos/applications/intake`).
 *
 * Creates Person + EnrollmentOpportunity + ApplicationSubmission and emits
 * `person.created`, `opportunity.created`, `application.received` sharing
 * ONE `correlation_id`. Insert order (person -> opportunity -> submission)
 * follows the real FK dependency (`ApplicationSubmission.opportunity_id` is
 * NOT NULL); event emission mirrors that same causal order. The build
 * instructions list the event set as "person.created, application.received,
 * opportunity.created" (a set, not a mandated sequence) — the done-condition
 * (3 events, 1 shared correlation_id) does not depend on order. DEVIATION —
 * see slice report.
 *
 * Idempotent on `intake_idempotency_key` (PATCH-SET-01 §S3): a duplicate
 * intake with a matching key creates zero new rows and zero new events.
 *
 * The sequential duplicate path (SELECT finds the existing row) dedupes
 * within the transaction. A *concurrent* duplicate can race past that SELECT
 * (both transactions miss it before either commits); the loser's INSERT then
 * hits the DB-level unique index instead. That is caught below and turned
 * into the same graceful `deduped: true` result rather than propagating as
 * an error (issue #5 / SF-4) — data-safe either way, since the failed
 * transaction rolls back its person/opportunity/submission inserts.
 */
export async function intakeApplication(db: Db, input: IntakeInput): Promise<IntakeResult> {
  const personNaturalKey = normalizePersonNaturalKey(input.person);
  const idempotencyKey = deriveIntakeIdempotencyKey({
    integrationId: input.integrationId,
    externalApplicationRef: input.externalApplicationRef,
    productId: input.productId,
    personNaturalKey,
  });

  try {
    return await runIntakeTransaction(db, input, idempotencyKey);
  } catch (error) {
    if (!isDuplicateIntakeIdempotencyKeyError(error)) throw error;

    const [existing] = await db
      .select()
      .from(applicationSubmission)
      .where(eq(applicationSubmission.intakeIdempotencyKey, idempotencyKey))
      .limit(1);
    if (!existing) throw error; // constraint says a row exists; if we can't see it, surface the original error.

    return {
      deduped: true,
      personId: existing.personId,
      opportunityId: existing.opportunityId,
      submissionId: existing.id,
      eventIds: [],
      correlationId: null,
    } satisfies IntakeResult;
  }
}

async function runIntakeTransaction(
  db: Db,
  input: IntakeInput,
  idempotencyKey: string,
): Promise<IntakeResult> {
  return db.transaction(async (tx: Db) => {
    const [existing] = await tx
      .select()
      .from(applicationSubmission)
      .where(eq(applicationSubmission.intakeIdempotencyKey, idempotencyKey))
      .limit(1);

    if (existing) {
      return {
        deduped: true,
        personId: existing.personId,
        opportunityId: existing.opportunityId,
        submissionId: existing.id,
        eventIds: [],
        correlationId: null,
      } satisfies IntakeResult;
    }

    const correlationId = randomUUID();

    const [personRow] = await tx
      .insert(person)
      .values({
        workspaceId: input.workspaceId,
        firstName: input.person.firstName,
        lastName: input.person.lastName,
        preferredName: input.person.preferredName ?? null,
        email: input.person.email ?? null,
        phone: input.person.phone ?? null,
        currentRole: input.person.currentRole ?? null,
        currentCompany: input.person.currentCompany ?? null,
        location: input.person.location ?? null,
        linkedinUrl: input.person.linkedinUrl ?? null,
        portfolioUrl: input.person.portfolioUrl ?? null,
        source: input.person.source,
        sourceDetail: input.person.sourceDetail ?? null,
        lifecycleType: input.person.lifecycleType ?? "applicant",
      })
      .returning();
    if (!personRow) throw new Error("intake: person insert returned no row");

    const personCreatedEvent = await writeEvent(tx, {
      workspaceId: input.workspaceId,
      productId: null, // Person is founder-level (§B0) — no product on this event.
      entityType: "Person",
      entityId: personRow.id,
      source: "api",
      correlationId,
      causationId: null,
      actor: input.actor,
      type: "person.created",
      payload: { personId: personRow.id },
    });

    const [opportunityRow] = await tx
      .insert(enrollmentOpportunity)
      .values({
        workspaceId: input.workspaceId,
        productId: input.productId,
        personId: personRow.id,
        stage: "new_lead",
        currency: "USD",
        version: 1,
      })
      .returning();
    if (!opportunityRow) throw new Error("intake: opportunity insert returned no row");

    const opportunityCreatedEvent = await writeEvent(tx, {
      workspaceId: input.workspaceId,
      productId: input.productId,
      entityType: "EnrollmentOpportunity",
      entityId: opportunityRow.id,
      source: "api",
      correlationId,
      causationId: personCreatedEvent.id,
      actor: input.actor,
      type: "opportunity.created",
      payload: { opportunityId: opportunityRow.id, personId: personRow.id },
    });

    const [submissionRow] = await tx
      .insert(applicationSubmission)
      .values({
        workspaceId: input.workspaceId,
        productId: input.productId,
        personId: personRow.id,
        opportunityId: opportunityRow.id,
        formVersion: input.application.formVersion,
        rawPayloadJson: input.application.rawPayloadJson,
        normalizedPayloadJson: input.application.normalizedPayloadJson ?? null,
        resumeAssetId: input.application.resumeAssetId ?? null,
        linkedinSnapshotAssetId: input.application.linkedinSnapshotAssetId ?? null,
        sourceReference: input.application.sourceReference,
        ingestionStatus: "received",
        intakeIdempotencyKey: idempotencyKey,
      })
      .returning();
    if (!submissionRow) throw new Error("intake: submission insert returned no row");

    const applicationReceivedEvent = await writeEvent(tx, {
      workspaceId: input.workspaceId,
      productId: input.productId,
      entityType: "ApplicationSubmission",
      entityId: submissionRow.id,
      source: "api",
      correlationId,
      causationId: opportunityCreatedEvent.id,
      actor: input.actor,
      type: "application.received",
      payload: { submissionId: submissionRow.id, opportunityId: opportunityRow.id },
    });

    return {
      deduped: false,
      personId: personRow.id,
      opportunityId: opportunityRow.id,
      submissionId: submissionRow.id,
      eventIds: [personCreatedEvent.id, opportunityCreatedEvent.id, applicationReceivedEvent.id],
      correlationId,
    } satisfies IntakeResult;
  });
}
