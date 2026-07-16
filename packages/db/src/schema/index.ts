/**
 * Canonical Drizzle schema barrel.
 *
 * Tables land with their owning slice. Slice 0.1a ("canonical spine") adds:
 *   product, fos_workspace, person, enrollment_opportunity,
 *   application_submission, operational_event
 * with append-only enforcement on operational_event (PATCH-SET-01 §S1, §B0).
 */
export * from "./fos_workspace.js";
export * from "./product.js";
export * from "./person.js";
export * from "./enrollment_opportunity.js";
export * from "./application_submission.js";
export * from "./operational_event.js";
