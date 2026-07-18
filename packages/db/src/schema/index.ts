/**
 * Canonical Drizzle schema barrel.
 *
 * Tables land with their owning slice. Slice 0.1a ("canonical spine") adds:
 *   product, fos_workspace, person, enrollment_opportunity,
 *   application_submission, operational_event
 * with append-only enforcement on operational_event (PATCH-SET-01 §S1, §B0).
 *
 * Slice 0.1b ("artifacts") adds:
 *   artifact_record, artifact_version
 * with content-immutability enforcement on artifact_version (§12.2, §S3).
 *
 * Slice 0.1c ("approvals") adds:
 *   approval (§9.14) — the human-gate decision on an ArtifactVersion.
 *
 * Slice 0.2a ("Notion adapter client + entity") adds:
 *   workspace_integration (§11.1) — a provider adapter connection.
 */
export * from "./fos_workspace.js";
export * from "./product.js";
export * from "./person.js";
export * from "./enrollment_opportunity.js";
export * from "./application_submission.js";
export * from "./operational_event.js";
export * from "./artifact_record.js";
export * from "./artifact_version.js";
export * from "./approval.js";
export * from "./workspace_integration.js";
