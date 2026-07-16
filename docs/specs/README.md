# FOS Specifications — canonical build target

These are the **canonical** implementation specifications for FOS (the revised Phase 0–6 set). They are the source of truth the build loop implements against.

## Contents
- `FOS_Phase_0_Founder_Workspace_and_Operating_Foundation.md` — Phase 0 (canonical core + Notion adapter foundation).
- `00_FOS_Next_Dependencies_and_Refactoring_Plan.md` — cross-phase dependency & gate authority.
- `01`–`06_FOS_Phase_*.md` — Phases 1 through 6.

## Provenance & authority
- Derived from the *Revised Implementation Set (Phases 0–6)*. Where the dependency plan and a phase spec disagree, the dependency plan's gate authority wins.
- The earlier 12k-line **`FOS_Complete_Specification_Set.md` is intentionally excluded** — it predates the FOS-canonical/Notion-adapter and multi-product decisions and silently contradicts them. It is archived outside this repo and must not be used as a build reference (review finding **H1 / CX-01**).

## Known open patches before code
The specs carry verified defects (2 blockers + ~10 more) and one architecture upgrade (multi-product, **B0**). These are applied via the **spec-patch PR** before any implementation slice touches the affected area. See [`../planning/BUILD_READINESS_AND_LOOP_PLAN.md`](../planning/BUILD_READINESS_AND_LOOP_PLAN.md) §2–§3.
