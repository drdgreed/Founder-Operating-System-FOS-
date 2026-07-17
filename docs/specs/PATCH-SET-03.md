# Canonical Patch Set 03 — Approval Event & Audit-Lineage Convention

**Status:** AUTHORITATIVE. Supersedes/extends the cited sections.
**Date:** 2026-07-17 · **Provenance:** Slice 0.1c adversarial verification (both verifiers ruled `approval.recorded` the correct model — an Approval is a distinct §9.14 entity whose recording is not guaranteed by an artifact event, since `transitionArtifactVersionStatus` is independently callable; owner ratifies the taxonomy addition).
**Depends on:** PATCH-SET-01 (§E2, §S1, §S2), PATCH-SET-02 (artifact events + registry).

---

## A — `approval.recorded` event (extends §9.7)

§9.7 names no `approval.*` event (its `decision.recorded` belongs to the separate §9.11 `DecisionRecord` entity). Add:
- **`approval.recorded`** — emitted when a §9.14 `Approval` decision is recorded. Payload `{ approvalId, artifactVersionId, decision, riskLevel }` (`.strict()`), registered in `@fos/contracts` and validated on the write path (§S1 discipline). `entity_type = "Approval"`, `entity_id = approvalId`.

A human/agent decision therefore emits **two** events in one operation: `approval.recorded` (the decision fact) **and** the granular `artifact.<decision>` from the driven lifecycle transition (§E2 → PATCH-SET-02 §A). They are distinct facts (different `entity_type`, different semantics); metrics count approvals off `approval.recorded`/Approval rows, never off `artifact.approved`.

## B — Audit-lineage convention (formalizes the pattern 0.1a's intake already follows)

For any single logical operation that emits multiple events:
- **Correlation:** all events of the operation share **ONE** `correlation_id`. (An approval decision + its driven artifact transition are one operation → one `correlation_id`.)
- **Causation:** `causation_id` flows **cause → effect**. The recorded decision **causes** the lifecycle transition, so `approval.recorded` is the causation parent of the `artifact.<decision>` event (the transition's `causation_id` = the `approval.recorded` event id; `approval.recorded.causation_id` = null unless itself caused by a prior event).

To support this, `transitionArtifactVersionStatus` accepts an **optional `correlationId`** (backward-compatible: mints its own when absent, as 0.1b callers rely on) and its existing optional `causationId`.

## C — §9.14 decision-only scope (ratifies the 0.1c narrowing; names the forward migration)

For Phase-0 slice 0.1c, `Approval` records **only decided** approvals:
- `decided_by` / `decided_at` are **NOT NULL** (a recorded decision always has a decider + time).
- Target is a single typed FK `artifact_version_id` (approvals are on ArtifactVersions here), not the §9.14 polymorphic `target_entity_type/_id`.
- The `approval_status` enum carries the full §9.14 set, but only the 4 in_review-reachable decisions (`approved`, `approved_with_edits`, `rejected`, `deferred`) are written. `superseded` is excluded because `in_review → superseded` is not a legal §12.2 edge; `pending`/`expired` are unused.

**Forward migration (known, disclosed):** the later *approval-request* slice (§14.6/§15.7 "request approval", `pending` state) must relax `decided_by`/`decided_at` to nullable and generalize the target — a deliberate future migration, not a loss for the decision-only slice.

---

## Not changed
§E2 decision→lifecycle map, §S2 risk_level, the §12.2 artifact matrix, PATCH-SET-02 artifact events/registry.
