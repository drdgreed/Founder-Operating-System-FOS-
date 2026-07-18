# Canonical Patch Set 01 — Corrections & Multi-Product Upgrade

**Status:** AUTHORITATIVE. This document **supersedes** the specific spec sections cited below. Where this patch set and an original spec section conflict, this patch set wins.
**Date:** 2026-07-16 · **Provenance:** verified findings in [`../planning/BUILD_READINESS_AND_LOOP_PLAN.md`](../planning/BUILD_READINESS_AND_LOOP_PLAN.md) §2–§3 (3 reviewers → 2 adversarial verifiers) + ADR-09. **Rev 2** applies the two adversarial verifiers' merge-gate findings on Rev 1 (V-01…V-15).
**Reading rule:** every entity table below is the **complete** canonical field set for that entity (a full replacement, not a delta) unless it says "adds". Enum values marked *(proposed)* are conventions awaiting a rubber-stamp; nothing here invents business facts.

File key: **P0** = `FOS_Phase_0_...md` · **DEP** = `00_FOS_Next_Dependencies_...md` · **P1..P6** = `0N_FOS_Phase_*.md`.

---

## B0 — Multi-product tenancy & product hierarchy (ADR-09)
**Supersedes:** P0 §9 (adds entity), and adds a `product_id` column to the entities listed. **Adds** the founder-level vs product-scoped taxonomy.

### New entity: `Product` (self-referential tree)
| field | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` | uuid FK → FOSWorkspace | canonical FOS tenant |
| `parent_product_id` | uuid FK → Product, **nullable** | NULL = top-level peer product; set = sub-offering |
| `product_key` | text, unique per workspace | stable slug |
| `name` | text | |
| `product_type` | enum: `product` \| `sub_offering` | must equal `product` iff `parent_product_id` IS NULL |
| `status` | enum: `active` \| `paused` \| `retired` | |
| `created_at` / `updated_at` | timestamptz | |

**Invariant:** `parent_product_id` may reference only a Product in the same `workspace_id`. Depth is unbounded by schema; today only 2 levels are used.

### Scoping taxonomy
- **Founder-level (NO `product_id`):** `Person`, `EvidenceItem`, founder-voice records, `DecisionRecord`, `OperatingReview`, `FOSWorkspace`.
- **Product-scoped, `product_id` uuid FK → Product NOT NULL:** `Offer`, `Program`, `EnrollmentOpportunity`, `Campaign`, `AudienceSegment`, `ProductCapability`, `ProductClaim`, `ProductSignal`.
- **`ArtifactRecord`:** gains a **nullable** `product_id` — most artifacts are product-scoped, but founder-level artifacts (e.g. `operating_review`) have none.
- **`Cohort`:** **no** `product_id` column; its product is derived via `program_id → Program.product_id` (this is the one derived exception).
- **`ContentAsset`** (a P4 view over `ArtifactRecord`, see D2): inherits the artifact's nullable `product_id` — no independent column.
- **Event envelope:** `OperationalEvent` gains `product_id` uuid **nullable** (see S1).
- **Authorization:** every product-scoped read/command adds a `product_id` filter to the P0 §7.5 checks.
- **Deferred (YAGNI until a real sub-offering exists):** recursive roll-up queries across a product + its sub-offerings; product-switch UI; per-product dashboards.

---

## B1 — `Offer` / `Program` / `Cohort` entities (blocker; fixes dangling `offer_id`)
**Supersedes:** P0 §9 (adds entities); P0 §14.6 pricing-validation gate now has a data model.

### `Offer` (product-scoped)
| field | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `product_id` | uuid FK → Product NOT NULL | B0 |
| `offer_key` | text, unique per product | |
| `name` | text | |
| `program_id` | uuid FK → Program, nullable | |
| `cohort_id` | uuid FK → Cohort, nullable | |
| `price_amount` | integer (minor units) | e.g. cents |
| `currency` | text (ISO-4217) | |
| `billing_period` | enum: `one_time` \| `monthly` \| `annual` *(proposed)* | |
| `availability_start` / `availability_end` | timestamptz, nullable | |
| `status` | enum **lifecycle**: `draft` → `approved` → `active` → `retired` *(proposed)* | see gate rule below |
| `approved_by` | uuid FK → user, nullable | |
| `approved_at` | timestamptz, nullable | |
| `created_at` / `updated_at` | timestamptz | |

**Gate rule (fixes V-13/B1 ambiguity):** an Offer is **sellable iff `status = active`** (a value only reachable after `approved`). The P0 §14.6 pricing-validation step passes iff the referenced Offer has `status = active` and non-null `price_amount`/`currency`.

`Program` = `{id, product_id, program_key, name, status}`; `Cohort` = `{id, program_id, cohort_key, name, starts_at, ends_at, status}` (product via `program_id`, per B0).
**Wiring:** `EnrollmentOpportunity.offer_code` (P0 §9.4) is **replaced** by `offer_id` uuid FK → Offer (nullable until an offer is selected). `Campaign.offer_id` (B2) references the same.

---

## B2 — Single canonical `Campaign` (blocker; resolves the double definition)
**Supersedes:** P0 §10.7 **and** P1 §6.2. The table below is the **complete** canonical field set (P0 §10.7's original fields, preserved, + P1's additive fields, with unit/type reconciliations). No field from either prior definition is dropped.

| field | type | origin / note |
|---|---|---|
| `id` | uuid PK | P0 |
| `product_id` | uuid FK → Product NOT NULL | B0 (new) |
| `workspace_id` | uuid FK → FOSWorkspace | P0 (retained — tenant isolation) |
| `campaign_key` | text | P0 |
| `name` | text | P0 (retained) |
| `objective` | text | P0 / P1 |
| `offer_id` | uuid FK → Offer, nullable | reconciled (was P0 `offer_code` string) |
| `audience_segment_ids` | uuid[] | P0 / P1 |
| `start_at` / `end_at` | timestamptz, nullable | P0 (retained — P1 §7.2 planned dates depend on these) |
| `status` | enum: `draft` \| `active` \| `paused` \| `complete` *(proposed)* | P0 |
| `channel_ids` | uuid[] | reconciled (was P0 `channel_plan_json`) |
| `primary_cta_id` | uuid FK, nullable | P0 (retained) |
| `secondary_cta_ids` | uuid[] | P1 (additive) |
| `narrative_ids` / `content_pillar_ids` | uuid[] | P1 (additive) |
| `budget_amount` | integer (minor units), nullable | reconciled (was P1 `budget_cents`; unit-consistent with Offer) |
| `success_metrics_json` | jsonb | P0 (retained) |
| `created_at` / `updated_at` | timestamptz | P0 |

**P1 §6.2 is rewritten as a delta:** "Campaign is defined canonically in P0 §10.7 (as amended by Patch Set 01 B2). Phase 1 adds **no** new Campaign fields." This restores P0 §3.3 success condition 13.

---

## C1 — Notion projection hidden-property contract (fixes day-one template failure)
**Supersedes:** the P1–P6 shared "required hidden properties" block **and** P0 §13 templates. One reconciled set on **every** projected page:
- `FOS Record ID` (canonical entity id) — *standardized name; replaces per-entity `Opportunity ID`/`Content ID`/etc.*
- `FOS Entity Type` — **retained** (the Founder Inbox is a heterogeneous queue that routes by entity type; required by all 7 specs).
- `FOS Workspace ID`
- `FOS Product ID` *(new; nullable for founder-level projections — B0)*
- `Sync Status` — **canonical name; `Projection Status` is retired.**
- `FOS Version` (see C2)
- `Last Synced At`

P0 §13 database templates and the P1–P6 shared block are both updated to this exact list.

## C2 — `FOS Version` derivation (fixes the unspecified conflict-check target)
**Supersedes:** the P1–P6 conflict rule. Definition, per entity type:
- **Artifact projections:** `FOS Version` = `ArtifactVersion.version_number` of the record's `current_version_id`.
- **Versioned entities** (EnrollmentOpportunity, AgentDefinition, ProjectionPolicy): `FOS Version` = that entity's `version`.
- **Unversioned canonical entities projected with `FOS Version`** (`ProductSignal`, `OperatingReview`, `DecisionRecord`, `Campaign`, communications-config entities): `FOS Version` = `extract(epoch from updated_at)::bigint` — monotonic per record, no schema change, and the conflict check stays well-defined. *(Fixes V-02/V-08: the D1 entities are covered here.)*
- A controlled command executes only if the provider's `FOS Version` equals the current canonical value; otherwise → `conflict` (E1).

## C3 — Projection-policy example correction
**Supersedes:** P0 §8.2 worked example. The `ArtifactRecord` policy example must use real fields: `ArtifactRecord.status` (a `canonical_read_only`, derived mirror — E2) + `ArtifactVersion.body_markdown` / `.approval_status` / `.claims_manifest_json`, and policy keys `field_policy_json` + `requires_approval` (matching the §11.3 schema). State explicitly: **artifact projection policies span record-level and current-version fields.**

---

## D1 — Minimal canonical `ProductSignal` & `OperatingReview` in Phase 0
**Supersedes:** P0 §9 (adds two entities), satisfying P0 §13.6/§13.8 projections + the `register_product_signal` command (NEW-1).
- `ProductSignal` (product-scoped) = `{id, product_id, signal_key, source, summary, status, created_at, updated_at}` — P3 extends, does not redefine.
- `OperatingReview` (founder-level) = `{id, workspace_id, period_start, period_end, status, created_at, updated_at}` — P6 extends.
- Both are projected with `FOS Version`; per C2 that resolves to `updated_at` epoch (hence `updated_at` is included).

## D2 — `CampaignTouch.content_asset_id` forward-reference
**Supersedes:** P1 §6.3. Change the FK to **`artifact_record_id`** uuid FK → ArtifactRecord (which exists in P0). P4 layers `ContentAsset` as a specialized view over `ArtifactRecord` (inheriting its nullable `product_id`, B0) without changing this column.

---

## E1 — `WorkspaceCommand` status model (single source of truth)
**Supersedes:** P0 §11.5 fields + reconciles with §12.3. Replace the two fields (`validation_status`, `execution_status`) with a **single `status`** enum enumerating **every** §12.3 state:
`received`, `validating`, `validated`, `queued`, `executing`, `succeeded`, `failed_retryable`, `failed_terminal`, **`rejected`** (from `received`/`validating`; carries `rejection_reason`), `conflict` (from `validating`).
**Event mapping (fixes V-05 + vocabulary drift):** state `succeeded` emits the existing `workspace_command.executed`; `rejected` emits the existing `workspace_command.rejected`; add `workspace_command.queued` and `workspace_command.failed` (S1). No §12.3 state is left unmapped.

## E2 — Artifact status carrier (declare the one owner)
**Supersedes:** ambiguity across P0 §12.2 / §9.12 / §9.13 / §9.14. Declaration:
- `ArtifactVersion.approval_status` is the **authoritative lifecycle carrier** for a version, over the **full §12.2 state set**: `draft`, `in_review`, `approved`, `approved_with_edits`, `rejected`, `deferred`, `ready_for_action`, `executed`, `failed`, `superseded`.
- `ArtifactRecord.status` is a **derived** mirror of the current version's status (documented as derived / `canonical_read_only`; never written independently).
- `Approval.status` records a **decision** on a specific version. **Decision → lifecycle map:** `approved`→`approved`, `approved_with_edits`→`approved_with_edits`, `rejected`→`rejected`, `deferred`→`deferred`, `superseded`→`superseded`; the version's `approval_status` takes the decided value.

## E3 — Canonical command-type enum
**Supersedes:** DEP §3.2 naming. **P0 §11.5 names win.** Crosswalk (DEP → canonical): `approve_with_edits`→`approve_artifact_with_edits`; `propose_stage_transition`→`propose_opportunity_stage_change`; `create_external_draft`→`create_email_draft`; `run_agent`→`run_agent_when_enabled`; `resolve_conflict`→`resolve_sync_conflict`. `run_test_suite` / `create_issue` / `record_publication` are **Phase 3/4 enum extensions**, not Phase 0. *(P1 §7.3 prose commands — "Run claims verification", "Record webinar event", "Generate channel derivative" — are registered to canonical command-types at Phase-1 implementation, tracked, not Phase 0.)*

## E4 — Canonical artifact-type enum (fully enumerated — fixes V-09)
**Supersedes:** the divergent lists in P0 §9.12, P1 §7.1. **P0 §9.12 owns the enum**, amended to the complete set below. Phases must use these exact strings; no phase may introduce an unregistered value.

**Canonical set (Phase 0 base, P0 §9.12):** `internal_note` · `enrollment_message` · `call_brief` · `onboarding_plan` · `support_response` · `product_specification` · `research_brief` · `linkedin_post` · `linkedin_carousel_script` · `substack_paper` · `newsletter` · `landing_page_copy` · `email_sequence` · `release_report` · `operating_review`
**Additive canonical members (from P1 §7.1 — not aliases):** `post_call_recap` · `initial_response` · `information_request` · `objection_response` · `offer_follow_up` · `no_show_recovery` · `unresponsive_recovery` · `beta_launch_source_brief` · `webinar_package` · `referral_kit`
**Retired aliases → canonical:** `enrollment_brief`→`enrollment_message`; `call_preparation_brief`→`call_brief`. Migration maps legacy values through this table.
**Later phases (P2–P6):** register any new artifact type additively into this enum at that phase's implementation, resolving aliases the same way; no unregistered value ships.

## E5 — Gate identifier disambiguation
**Supersedes:** the clashing A–D letters. **P0 §22 rollout gates** are renamed `R-A`…`R-D` (Canonical / Projection / Edit / Command safety). **DEP §7 cross-phase gates** are renamed `G1`…`G6`. "Gate B" is no longer ambiguous.

## F1 — Founder-edit entity (resolve the duplicate)
**Supersedes:** P0 §9.15 + §11.7. Keep **one** entity, `FounderWorkspaceEdit` (§11.7 fields: `base_artifact_version_id`, `new_artifact_version_id`, `projection_id`, `provider_record_id`, `original_snapshot_json`, `edited_snapshot_json`, `diff_json`, `edit_categories_json`, `edit_distance`, `captured_at`). `source_interface`, `founder_reason`, **and `approval_id`** from §9.15 migrate onto it as nullable columns (preserving the edit→approval audit link, §17.8). **Delete `FounderEdit` (§9.15).** §14.5 already writes only `FounderWorkspaceEdit`.

---

## S1 — Event schema registry (envelope + per-type)
**Supersedes:** P0 §9.7 generic `payload_json` **only**. Adds a machine-readable registry (Zod schemas, one per event type, checked into `packages/contracts` at build time). Common envelope on every event:
```
{ id, workspace_id, product_id?, entity_type, entity_id, source, correlation_id, causation_id, occurred_at, actor: {type, id}, type, payload }
```
The envelope is a **subset of the persisted `OperationalEvent` row**, not a replacement: §9.7's `entity_type`, `entity_id`, and `source` columns **persist unchanged** (projection/audit consumers resolve by them). Only the untyped `payload_json` is superseded by the per-`type` schema. New types added by E1: `workspace_command.queued`, `workspace_command.failed`.

## S2 — Conventions addendum: open enum value sets *(proposed — approve once)*
**Supersedes:** the unspecified value sets in P0 §9. Proposed canonical values:
- `Person.privacy_classification`: `standard` \| `sensitive` \| `restricted`
- `EvidenceItem.confidence`: `low` \| `medium` \| `high`
- `EvidenceItem.verification_status`: `unverified` \| `founder_verified` \| `evidence_backed`
- `EvidenceItem.permitted_use`: `internal_only` \| `marketing_with_attribution` \| `public`
- `Approval.risk_level` & `WorkspaceCommand.risk_level`: `low` \| `medium` \| `high`
- `FounderTask.priority`: `low` \| `medium` \| `high` \| `urgent`; `.status`: `open` \| `in_progress` \| `blocked` \| `done`; `.task_type`: `review` \| `decision` \| `content` \| `ops`
- `DecisionRecord.status`: `open` \| `decided` \| `revisited`; `.decision_type`: `strategic` \| `product` \| `pricing` \| `ops`
- `AgentDefinition.max_autonomy_level`: `L1` \| `L2` \| `L3` \| `L4` (bound to the design-system autonomy ladder — see note)
- `ArtifactRecord.domain`: `enrollment` \| `editorial` \| `release` \| `marketing` \| `research`

*Not yet enumerated (add when the owning slice lands):* `ProductClaim.claim_type`, `EvidenceItem.evidence_type/source_type`, `AgentRun.status`. *Note:* the L1–L4 autonomy ladder is an external design-system reference; its definition must be imported into the repo before the first agent slice (Phase 1), not Phase 0.

## S3 — Idempotency / hashing / diff derivation rules
**Supersedes:** the underived fields in P0 §11.4/§11.5/§11.7. Canonical rules *(proposed — dedup/hash tests build against these exact rules)*:
- `idempotency_key` (workspace commands) = `SHA-256(integration_id + ':' + provider_event_id + ':' + command_type)`
- **`intake_idempotency_key`** (application intake — slice 0.1a done-condition) = `SHA-256(integration_id + ':' + external_application_ref)` when the provider supplies a stable ref; else `SHA-256(product_id + ':' + person_natural_key)`. A repeated intake with a matching key is a no-op. `person_natural_key` is not defined by this spec; slice 0.1a defines it as normalized (trimmed, lower-cased) email when present, else lower-cased `firstName|lastName|phone`. **Known limitation (documented, non-blocking — issue #6):** when a submission has neither email nor phone, the natural key degrades to `firstName|lastName`, so two *distinct* applicants sharing a name and lacking email/phone within the same product collide on `intake_idempotency_key` and the second is silently deduped (dropped, no error). Accepted for Phase 0; revisit if a stronger natural key or an explicit soft-conflict signal is needed.
- `content_hash` (text artifacts) = `SHA-256(normalized_markdown)`, normalization = trim trailing whitespace + LF line endings + single trailing newline. For **binary** assets (S4), `content_hash` = `SHA-256(raw_bytes)` — the markdown normalizer does not apply.
- `diff_json` = unified diff over normalized markdown
- `edit_distance` = token-level Levenshtein
- `edit_categories` taxonomy: `shorten` \| `expand` \| `claim_removal` \| `tone` \| `factual_correction` \| `restructure`

## S4 — `Asset` entity
**Supersedes:** the dangling `*_asset_id` fields (P0 §9.3/§9.5). Add `Asset` = `{id, workspace_id, product_id?, storage_ref, mime_type, byte_size, sensitivity, content_hash, created_at}` (`content_hash` per the binary rule in S3). `evidence_asset_id` / `resume_asset_id` / `linkedin_snapshot_asset_id` become FKs → Asset (nullable). Blob store per ADR-04 (host object storage); the entity is canonical, the bytes are external.

---

## Not changed (verified as consistent or intended)
Per the adversarial verification, these were **refuted** as issues and are deliberately left alone: authorization model (P0 §7.5 is specified), webhook capture mechanism (specified; Notion limits handled by ADR-06 spike), secret store (host reuse), `enrollment.*` events (intended additive per DEP §3.5), `ArtifactRecord.status` projected read-only (E2/C3 are consistent, not contradictory), and the master-vs-canonical "contradictions" (stale-by-design; **verified: `FOS_Complete_Specification_Set.md` is not present in this repo**, so H1 is moot here — the loop plan's "never read MASTER" boundary and the README reference point at no in-repo copy).
