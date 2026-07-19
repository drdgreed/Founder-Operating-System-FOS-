# Phase 1 — Repository-to-Requirement Implementation Map

Companion to `docs/decisions/ADR-07-phase-1-agent-runtime.md`. This is the live traceability matrix the Phase-1 spec mandates: every work package → the slice that builds it, the repo locations (new vs. reused Phase 0), migrations, tests, feature flags, and metrics. Kept updated as slices land.

## Slice sequence (dependency-ordered)

| Slice | Work pkg | Deliverable | Depends on |
|---|---|---|---|
| **P1.0** | WP1.0/1.1 | Domain migrations + Phase-0 contract verification | Phase 0 ✅ |
| **P1.1** ★ | WP1.2 | **Bounded agent runtime** (12-stage spine) + `agent_run` + feature flags | P1.0 |
| **P1.2** ★ | WP1.2 | **Enrollment Brief Agent** (first agent, eval-backed) | P1.1 |
| **P1.3** | WP1.3 | Call Preparation + Post-Call Synthesis agents + conversation workflow | P1.2 |
| **P1.4** | WP1.4 | Follow-Up + Objection Intelligence + Next-Best-Action agents + stalled-opportunity job | P1.2 |
| **P1.5** | WP1.5 | Enrollment Pipeline + Founder Inbox projections (extend 0.2b to new artifact/assessment types) | P1.2 |
| **P1.6** | WP1.6 | Campaign + CampaignTouch model + source-brief artifact | P1.1 |
| **P1.7** | WP1.7 | Beta Launch Editorial + Substack Cornerstone agents + channel derivatives | P1.6 |
| **P1.8** | WP1.8 | Claims / consent / platform-draft deterministic gates + Gmail-draft controlled command | P1.4, P1.7 |
| **P1.9** | WP1.9 | Funnel / campaign-attribution / founder-time dashboards | P1.4, P1.7 |
| **P1.10** | WP1.10 | Eval suite + shadow-mode + feature-flag production activation | all |

★ = highest-showcase, build first.

## Reuse map (do NOT re-create — spec §610)

| Phase-1 need | Reused Phase-0 asset | Location |
|---|---|---|
| Artifacts (all 17 types) | `ArtifactRecord`/`ArtifactVersion` + `artifact-service` (0.1b) | `packages/db/src/services/artifact-service.ts` |
| Approvals | `approval-service` (0.1c) | `packages/db/src/services/approval-service.ts` |
| Opportunity lifecycle | `transitionOpportunity` + `opportunity-transitions` (0.1a) | `packages/db/src/services/opportunity-transition*.ts` |
| Intake / dedup | `intake` + `idempotency` (0.1a) | `packages/db/src/services/intake.ts`, `idempotency.ts` |
| Events + audit | `operational_event` + `event-writer` | `packages/db/src/services/event-writer.ts` |
| Provider projection + commands | `projectOpportunity`, reconcile/capture/execute, `workspace_command` (0.2b–e) | `packages/adapter/src/*` |
| Notion client | `NotionClient` (0.2a, live-validated) | `packages/notion/src/client.ts` |
| Offline agent eval | `fos-evals` sidecar (fixtures + runner) | `fos-evals/` |
| Event/command schemas | Zod registry | `packages/contracts/src/` |

## New code (Phase 1)

| New | Location | Slice |
|---|---|---|
| `@fos/agents` package (runtime + registry + gates) | `packages/agents/` | P1.1 |
| `agent_run` entity + migration | `packages/db/src/schema/agent_run.ts` | P1.1 |
| `feature_flag` entity + read path | `packages/db/src/schema/feature_flag.ts` | P1.1 |
| New domain entities (assessment/objection/recommendation/campaign/campaign_touch) | `packages/db/src/schema/*` | P1.0, P1.6 |
| Opportunity extension migration (`campaign_id`, `*_touch_source`, `attribution_confidence`) | migration on `enrollment_opportunity` | P1.0 |
| Agent definitions (8) | `packages/agents/src/definitions/*` | P1.2–P1.7 |
| Agent I/O + gate schemas (Zod) | `packages/contracts/src/agents/*` | P1.1+ |
| Anthropic model client wrapper | `packages/agents/src/model/` | P1.1 |
| Enrollment/campaign dashboards + APIs | `apps/api/app/api/fos/dashboard/*`, `/enrollment-assessments/*`, `/campaigns/*` | P1.5, P1.9 |
| Background jobs (12, spec §11) | `apps/worker/*` (first worker slice) | per slice |

## Per-slice detail — the first two (the rest expand as we approach them)

### P1.0 — Domain migrations + contract verification (no AI)
- **Migrations:** opportunity extension (`campaign_id` FK nullable + `first_touch_source`, `last_touch_source`, `attribution_confidence`); new tables `enrollment_assessment`, `objection_record`, `enrollment_action_recommendation` (Campaign + CampaignTouch deferred to P1.6). Append-only enforcement where the spec requires it.
- **Verify:** Phase-0 services (artifacts, approvals, transitions, events, projection, adapter) resolve + are green — a fixture that exercises intake→artifact→approval→projection end-to-end.
- **Tests:** migration applies clean on PGlite; FK + append-only constraints; round-trips. `FOS1-MIG-*`.
- **No feature flag / no model.** Bounded, low-risk. **2-verifier gate.**

### P1.1 — Bounded agent runtime ★ (the spine)
- **Build:** `runAgent(definition, input, ctx)` executing the 12 stages (ADR-07 D2); `agent_run` persistence (D5); the versioned agent-definition registry (D3); Zod structured-output validation + repair-retry-once (D4); the shared deterministic-gate library skeleton (D7); `feature_flag` read + shadow/review/live mode (D8); the Anthropic model wrapper (D1); metrics/audit emission. Prove with ONE trivial/stub definition (no real business agent yet) so the harness is verified in isolation.
- **Reuses:** approval-service, projectOpportunity, event-writer, idempotency.
- **Tests:** each stage unit-tested; structured-output repair path; `evaluation_failed` fail-closed (no artifact); gate-blocks-model; feature-flag/mode gating; **prompt-injection fixture** (untrusted input can't change policy); audit reconstruction from `agent_run`. `FOS1-RT-*`.
- **Feature flag:** `agent_runtime` (infra).
- **SECURITY-CRITICAL** (model exec + untrusted input + new dependency) → **3-layer gate** (correctness + security + silent-failure), same as the webhook slice.
- **New dependency `@anthropic-ai/sdk`** — gated on ADR-07 founder approval.

### P1.2 — Enrollment Brief Agent ★ (first real agent)
- **Build:** `fos.enrollment_brief` definition on the runtime — input (opportunity + application + evidence), output (`EnrollmentAssessment` + `enrollment_brief` artifact: candidate summary, observed facts *with sources*, labeled inferences, readiness, fit, pathway, objections, discovery questions, risk flags, next action). Hard gates (ADR-07 D7): facts→sources, inference-as-fact forbidden by type, no employment/salary/interview guarantee, pathway-exists-for-offer. Routes the artifact to approval (0.1c) + projects to the Enrollment Pipeline (0.2b). Runs in **shadow mode** first.
- **Eval:** `fos-evals` fixtures — strong fit, incomplete information, contradictory history, price objection, out-of-scope target, **prompt injection**, revoked consent (spec §426).
- **Tests:** end-to-end application→brief→gates→approval→projection; each hard gate blocks; shadow-mode produces no founder-surfaced output. `FOS1-BRIEF-*` + eval fixtures.
- **Feature flag:** `enrollment_brief_agent`.
- **3-layer gate** (it's the first agent that writes canonical + projects from model output).

## Activation ladder (every agent + workflow, spec §590)
local dev → automated tests → staging w/ synthetic fixtures → prod (flag off) → **shadow mode** → founder-review mode → limited live → measured promotion/rollback. Independent feature flag + version rollback per agent.

## Deployment gates for Phase-1 live (spec §452)
Approved offer/capability/claim/audience/narrative/channel/CTA/voice records · application-intake idempotency · claims verification on founder edits · external send/autopublish disabled · funnel/campaign events reconciling · prompt-injection fixtures passing · Notion conflict/reconciliation tests passing.

## Open dependencies on the founder (not code)
Phase-1 *live activation* (not build) needs the seeded/approved Phase-0 records (spec §111): current beta offer + price, product capabilities/limitations, approved/prohibited claims, audience segments, launch narrative, content pillars, channel policies, CTA registry, voice policy, attribution rules, consent rules. These block activation, not the build — the build + shadow-mode validation proceed on fixtures.
