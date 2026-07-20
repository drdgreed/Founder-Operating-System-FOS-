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
 *
 * Slice 0.2b ("Notion projection layer") adds:
 *   projection — the canonical<->provider page mapping record (§11.4-derived).
 *
 * Slice 0.2c ("Notion reconciliation") adds no new tables: it is the inbound
 *   INTEGRITY CHECK (detect §8.3 version-mismatch conflicts + orphan/duplicate
 *   pages) over the existing `projection` table. Command capture (the
 *   §11.5 workspace_command queue) lands with 0.2d.
 *
 * Slice 0.2d ("Stage-command capture") adds:
 *   workspace_command (§11.5, status model §E1) — the controlled-command
 *   CAPTURE path. Founder Stage edits become `propose_opportunity_stage_change`
 *   commands in `received` status; validate/execute/Approval routing is 0.2e.
 *
 * Slice P1.0 ("Phase-1 domain migrations", ADR-07 D5/D8/D10) adds:
 *   agent_run (D5, the agent audit spine), feature_flag (D8, per-agent
 *   shadow|review|live gating), enrollment_assessment (spec §6.4), and 4
 *   nullable attribution columns on enrollment_opportunity (campaign_id,
 *   first_touch_source, last_touch_source, attribution_confidence).
 *   Schema + migrations only — no runtime/agent code (that's P1.1/P1.2).
 *
 * Slice P1.3a ("conversation-workflow substrate", issue #56) adds:
 *   interaction — a derived entity (spec never fields it explicitly; see
 *   the file header for FLAGged type choices). Schema + service only —
 *   no agent/API/Notion wiring (that's P1.3b/P1.3c).
 *
 * Slice P1.4a ("P1.4 domain substrate", issue #70) adds:
 *   objection_record (spec §6.5), enrollment_action_recommendation (spec
 *   §6.6) — the two canonical tables the P1.4 agents attach to. Schema +
 *   service only — no agent/API/projection/gate/worker wiring.
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
export * from "./projection.js";
export * from "./workspace_command.js";
export * from "./agent_run.js";
export * from "./feature_flag.js";
export * from "./enrollment_assessment.js";
export * from "./interaction.js";
export * from "./objection_record.js";
export * from "./enrollment_action_recommendation.js";
