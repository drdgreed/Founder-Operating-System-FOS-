import { createHash } from "node:crypto";

/**
 * `intake_idempotency_key` derivation (PATCH-SET-01 §S3):
 *
 *   SHA-256(integration_id + ':' + external_application_ref)
 *     when the provider supplies a stable ref;
 *   else SHA-256(product_id + ':' + person_natural_key)
 *
 * §S3 does not define `person_natural_key`. This slice defines it as the
 * normalized (trimmed, lower-cased) email when present, else a lower-cased
 * `firstName|lastName|phone` composite. DEVIATION — see slice report.
 *
 * KNOWN LIMITATION (documented, non-blocking — issue #6): when both email
 * and phone are absent, the natural key degrades to `firstName|lastName`.
 * Two distinct applicants sharing a name with no email/phone, applying to
 * the same product, collide on `intake_idempotency_key` — the second is
 * silently deduped (dropped, no error) by `intakeApplication`. See
 * `intake.test.ts` FOS0-CORE-08/09 for the proving/contrast tests.
 */
export interface DeriveIntakeIdempotencyKeyInput {
  integrationId?: string | null;
  externalApplicationRef?: string | null;
  productId: string;
  personNaturalKey: string;
}

export function deriveIntakeIdempotencyKey(input: DeriveIntakeIdempotencyKeyInput): string {
  const basis =
    input.integrationId && input.externalApplicationRef
      ? `${input.integrationId}:${input.externalApplicationRef}`
      : `${input.productId}:${input.personNaturalKey}`;
  return createHash("sha256").update(basis).digest("hex");
}

export function normalizePersonNaturalKey(person: {
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
}): string {
  if (person.email) {
    return person.email.trim().toLowerCase();
  }
  return `${person.firstName}|${person.lastName}|${person.phone ?? ""}`.trim().toLowerCase();
}
