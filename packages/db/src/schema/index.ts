/**
 * Canonical Drizzle schema barrel.
 *
 * Tables land with their owning slice. Slice 0.1a ("canonical spine") adds:
 *   product, fos_workspace, person, enrollment_opportunity,
 *   application_submission, operational_event
 * with append-only enforcement on operational_event (PATCH-SET-01 §S1, §B0).
 *
 * Empty for now so `drizzle-kit generate` produces no migration until the
 * first tables exist.
 */
export {};
