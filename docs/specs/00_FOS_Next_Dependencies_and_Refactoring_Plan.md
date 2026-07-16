# Founder Operating System

## Next Dependencies and Cross-Phase Refactoring Plan
### Required before and during revised Phases 1 through 6

| Document control | Value |
|---|---|
| Document ID | `FOS-DEPENDENCIES-1-6` |
| Version | 3.0 |
| Status | Implementation dependency authority |
| Depends on | Revised Phase 0 - Founder Workspace and Operating Foundation |
| Product owner | Founder |
| Updated | 2026-07-13 |

> This document defines the implementation order and compatibility work required after revised Phase 0. It is the dependency authority for the revised Phase 1 through Phase 6 specifications included in this package.

---

# 1. Executive decision

Do not begin Phase 1 feature implementation until the Phase 0 compatibility gate passes. Later phases may be designed in parallel, but their production code must not recreate or bypass Phase 0 services.

The revised sequence is:

```text
Phase 0A compatibility refactor
    -> Phase 0 foundation and Notion workspace adapter
    -> Phase 1 enrollment revenue and beta-launch communications
    -> Phase 2 beta activation, support, retention, and recurring editorial cadence
    -> Phase 3 product learning, QA, releases, and customer proof
    -> Phase 4 scaled marketing and communications operations
    -> Phase 5 competitive, pricing, and market intelligence
    -> Phase 6 founder chief of staff, command center, and automation governance
```

Marketing is no longer deferred to Phase 4. Its foundation is Phase 0, launch communications are Phase 1, recurring founder publishing begins in Phase 2, product proof and release communications mature in Phase 3, and scaled campaign operations arrive in Phase 4.

# 2. Mandatory Phase 0 exit dependencies

The following capabilities must exist before Phase 1 live activation:

| Dependency | Required state | Blocking reason |
|---|---|---|
| Canonical `FOSWorkspace` and authorization | Production-ready | All later records and projections require tenant isolation |
| `ArtifactRecord` and `ArtifactVersion` | Production-ready | Every later phase produces editable versioned work |
| Interface-independent `Approval` | Production-ready | Notion and native interfaces must share the same authority |
| `WorkspaceCommand` validation | Production-ready | Founder actions in Notion must not directly mutate state |
| Provider-neutral workspace adapter | Production-ready | Later phases must not embed Notion types in domain services |
| Notion projection and reconciliation | Production-ready | Founder operations depend on safe working views |
| Evidence and ProductClaim ledgers | Production-ready | Enrollment and marketing claims require deterministic validation |
| Consent ledger | Production-ready | Beta, testimonial, referral, and marketing use depend on it |
| Audience, channel, narrative, CTA, and voice policies | Seeded and founder-approved | Phase 1 launch communications require them |
| Operational event and audit model | Production-ready | Funnel, beta, QA, content, and chief-of-staff metrics depend on it |
| Feature flags and shadow-mode support | Production-ready | All agents require staged activation |
| External-send and autopublish disabled | Verified | No agent may bypass founder control |

# 3. Compatibility refactors by shared contract

## 3.1 Generic artifact migration

Replace phase-specific mutable text records with a shared artifact contract.

Required artifact categories by phase:

| Phase | Artifact categories |
|---|---|
| 1 | enrollment brief, call brief, follow-up, beta launch post, launch email, webinar invitation |
| 2 | onboarding plan, support response, intervention, LinkedIn post, Substack paper, editorial plan |
| 3 | product specification, test plan, release report, case study, release note, technical paper |
| 4 | campaign brief, content series, landing page, email sequence, carousel script, performance review |
| 5 | market brief, competitor comparison, pricing review, strategic alert |
| 6 | decision brief, operating review, strategic memo, automation proposal |

Every artifact must support canonical metadata, version history, founder edits, evidence/claims/consent manifests, approval, projection, and supersession.

## 3.2 Workspace-command migration

No provider status value may be treated as canonical by itself. Required commands include:

- `approve_artifact`
- `approve_with_edits`
- `reject_artifact`
- `defer_item`
- `request_revision`
- `propose_stage_transition`
- `create_external_draft`
- `run_agent`
- `run_test_suite`
- `create_issue`
- `record_publication`
- `resolve_conflict`

Each command must validate actor, workspace, target version, permissions, phase policy, evidence, claims, consent, and feature flags.

## 3.3 Consent consolidation

Phase 2 and Phase 4 must reuse the Phase 0 `ConsentGrant` model. Do not create separate testimonial, referral, marketing, or case-study consent tables unless they extend the same canonical grant.

## 3.4 Founder workspace projections

Each phase must define:

- Canonical entities projected
- Fields projected
- Ownership class for each field
- Notion collection and view
- Commands exposed to the founder
- Sensitive fields excluded
- Reconciliation behavior

## 3.5 Event taxonomy extension

Add phase events without replacing Phase 0 events. Required families:

- `enrollment.*`
- `beta.*`
- `support.*`
- `product_signal.*`
- `specification.*`
- `test.*`
- `release.*`
- `content.*`
- `publication.*`
- `market.*`
- `decision.*`
- `automation.*`

# 4. Phase dependency graph

| Phase | Hard prerequisites | Produces prerequisites for |
|---|---|---|
| 1 | Phase 0 contracts, approved offer/capability/claim data, communications foundation | Phase 2 active beta users; Phase 4 conversion attribution |
| 2 | Phase 1 enrollments; product telemetry; consent and artifact services | Phase 3 product signals and outcome proof; Phase 4 recurring editorial source material |
| 3 | Phase 2 support/outcome signals; repository/test integration | Phase 4 verified release and customer proof; Phase 6 conflict and release decisions |
| 4 | Phase 0 communications registries; Phase 1 funnel; Phase 2/3 evidence | Phase 6 campaign decisions and founder workload metrics |
| 5 | Phase 0 evidence/workspace; current offers and positioning | Phase 6 strategic alerts and pricing decisions |
| 6 | Reliable outputs and metrics from Phases 1-5 | Future autonomy and native command-center decisions |

# 5. Parallelization rules

The following may be developed in parallel after Phase 0:

- Phase 1 enrollment agents and Phase 1 launch-content agents, sharing the same claim/evidence service.
- Phase 2 onboarding telemetry and Phase 2 editorial workspace, provided both use generic artifacts.
- Phase 3 test-registry infrastructure and Phase 3 product-signal clustering.
- Phase 4 platform draft adapters and attribution ingestion, provided autopublish remains disabled.
- Phase 5 source registry and baseline competitor backfill.

The following must not be parallelized without a stable shared contract:

- Separate approval implementations
- Separate consent models
- Native and Notion-specific artifact editors with different version semantics
- Multiple claim-verification services
- Multiple opportunity or beta-user lifecycle engines
- Separate decision queues for each phase

# 6. Refactor-first decision matrix

| Existing implementation condition | Required action |
|---|---|
| Earlier Phase 1 not implemented | Implement revised Phase 1 directly |
| Earlier Phase 1 partially implemented | Migrate drafts to generic artifacts and UI actions to workspace commands before live use |
| Phase 2 beta tables already exist | Preserve data; map consent and onboarding documents to revised shared contracts |
| Phase 3 specs stored only as Markdown files | Import as artifact versions, then create canonical requirements/test records |
| Phase 4 content database exists in Notion only | Backfill canonical `ContentAsset`/artifact records and treat Notion pages as projections |
| Phase 6 native dashboard has begun | Retain reusable components, but route all decisions through canonical queue and commands |

# 7. Cross-phase implementation gates

## Gate A - Phase 0 compatibility

- Generic artifact migration complete
- Provider adapter operational
- Controlled commands validated
- Claims and consent seeded
- Projection conflict tests pass

## Gate B - Revenue workflows

- Phase 1 funnel events reconcile
- Launch content claims pass verification
- External send remains founder-controlled
- Content-to-application attribution exists

## Gate C - Beta operations

- Active beta users have first-value definitions
- Support and health summaries exclude sensitive details from Notion
- Outcome evidence cannot become public without consent

## Gate D - Product and release

- Requirements link to tests
- Security/memory isolation suites run
- Release agents cannot waive blockers
- Release changes revalidate claims

## Gate E - Scaled communications

- Source brief and evidence required for content
- Platform adapters create drafts only
- Attribution confidence is visible
- Founder voice changes require approval

## Gate F - Chief of staff

- Cross-domain metrics are stable
- Decision queue has acceptable duplicate rate
- Conflicts are explainable
- Strategic priorities are founder-approved

# 8. Required repository deliverables before Phase 1

1. Updated architecture map
2. Contract migration ADR
3. Artifact migration script
4. Workspace-command policy registry
5. Projection field-ownership registry
6. Consent and claim seed data
7. Phase feature-flag registry
8. Event taxonomy document
9. Cross-phase traceability file
10. Rollback and reconciliation runbook

# 9. Recommended implementation order

1. Complete Phase 0A compatibility refactor.
2. Activate Phase 0 read-only Notion projections.
3. Activate Phase 0 controlled editing and approval commands.
4. Implement revised Phase 1 enrollment core.
5. Implement Phase 1 beta-launch communications and attribution.
6. Implement Phase 2 onboarding, support, health, and recurring editorial cadence.
7. Implement Phase 3 product learning and QA before expanding product claims.
8. Implement Phase 3 customer proof and release communications.
9. Implement Phase 4 scaled campaign operations.
10. Implement Phase 5 intelligence.
11. Implement Phase 6 only after decision inputs are reliable.

# 10. Definition of dependency readiness

The revised phase program is ready when:

- Every later-phase entity has a declared canonical owner.
- Every founder-editable document type maps to generic artifacts.
- Every Notion action maps to a validated command.
- Every external claim maps to approved evidence.
- Every customer story maps to consent.
- Every phase has independent feature flags and shadow mode.
- No later phase requires a second approval, consent, evidence, artifact, or workspace-integration subsystem.
