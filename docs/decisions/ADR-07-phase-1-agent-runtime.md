# ADR-07 — Phase 1: Bounded Agent Runtime & Domain Extensions

| | |
|---|---|
| **Status** | Proposed (design gate — awaiting founder approval before migrations) |
| **Date** | 2026-07-19 |
| **Depends on** | Phase 0 (canonical spine, artifacts, approvals, event audit) + the Notion adapter (ADR-06, slices 0.2a–0.2f, live-validated) |
| **Spec** | `FOS-TECH-PHASE-1` — Enrollment Revenue and Beta Launch Communications |
| **Supersedes** | nothing |

Per the Phase-1 spec's execution instruction, this ADR + the companion implementation map (`docs/planning/PHASE-1-IMPLEMENTATION-MAP.md`) are produced **before any migration**. It pins the reusable **agent runtime** (the spine all 8 Phase-1 agents share), the domain extensions, the Phase-0 reuse boundary, and the slice/activation sequence.

---

## 1. Context

Phase 1 adds 8 bounded AI agents (Enrollment Brief, Call Preparation, Post-Call Synthesis, Personalized Follow-Up, Objection Intelligence, Next-Best-Action, Beta Launch Editorial, Substack Cornerstone) plus their domain records, workflows, and dashboards. Every agent shares the same 12-stage execution contract (spec §"Agent runtime requirements") and the same non-negotiable invariants (canonical state owns intelligence; artifacts are generic + versioned; approvals interface-independent; evidence/claims/consent/availability are deterministic gates; no autonomous send/publish).

The decision that dominates the phase is **how the agent runtime is built**, because it is (a) reused by all 8 agents and (b) the single strongest demonstration of state-of-the-art agentic architecture for the portfolio. This ADR fixes that design.

## 2. Decisions

### D1 — A new `@fos/agents` package holds the runtime + agent definitions

The runtime is a distinct concern (LLM execution, structured-output validation, policy orchestration) and does not belong in `@fos/db`. New workspace package `packages/agents`, depending on `@fos/db` (canonical persistence + services), `@fos/contracts` (schemas), `@fos/adapter` (projection), and the Anthropic SDK (model execution). It exposes `runAgent(definition, input, ctx)` and an agent-definition **registry**.

**Trade-off:** a new package + a new external dependency (Anthropic SDK) vs. keeping everything in `@fos/db`. Chosen because agents are architecturally separate from persistence and because a clean `@fos/agents` boundary is the reusable spine. **New dependency `@anthropic-ai/sdk` requires founder approval** (per the unattended-run rule); model calls go **direct to Anthropic** (no gateway) per the locked stack decision.

### D2 — The 12-stage runtime is a pluggable pipeline; each stage is deterministic except stage 5

`runAgent` executes, in order: (1) trigger validation → (2) authorization + feature-flag/mode check → (3) context assembly + minimization (produces a **retrieved-context manifest**) → (4) prompt construction from the **versioned agent definition** → (5) **model execution** (the only non-deterministic stage) → (6) structured-output validation (Zod; **repair-retry-once**, else `evaluation_failed`) → (7) deterministic policy evaluation → (8) optional secondary quality evaluation → (9) canonical persistence (`agent_run` + the produced record/artifact) → (10) approval routing **(reuse 0.1c)** or reversible execution → (11) projection update **(reuse 0.2b/0.2e)** → (12) metrics + audit emission.

The model **recommends**; stages 6–7 **enforce**. A model can never waive a deterministic gate.

### D3 — Agent definitions are versioned code, not data

Each agent is a typed definition: `{ key, version, objective, inputSchema (Zod), outputSchema (Zod), permittedTools, permittedMemoryScopes, autonomyCeiling, deterministicGates[], evalPolicy, featureFlagKey }`. Definitions live in `packages/agents/src/definitions/` and are registered by key. Versioning a definition is a code change (reviewable, rollback-able), satisfying invariant §8 ("every agent is bounded") and the audit requirement to record `agent_version` + `prompt_version`.

### D4 — Structured output via Zod in `@fos/contracts`; repair-retry-once then fail closed

The model is prompted to emit JSON matching the definition's `outputSchema`. On validation failure: one repair attempt with a repair prompt; on a second failure the run is marked `evaluation_failed`, a **founder-visible operational item** is created, and **no approval-ready artifact is produced** (spec §536). Output schemas structurally separate `observed_facts` (each carrying a `source_ref`) from `inferences` — so "inferences are never written as facts" is enforced by the **type**, not by prompt discipline.

### D5 — `agent_run` is the append-only audit spine

New canonical entity `agent_run`: `id, workspace_id, agent_key, agent_version, prompt_version, trigger, actor, feature_mode (shadow|review|live), context_manifest_json, input_ref, status (queued|running|succeeded|evaluation_failed|policy_blocked|error), model, output_ref, deterministic_eval_json, secondary_eval_json, latency_ms, cost_json, retry_count, correlation_id, causation_id, created_at`. It lets the system reconstruct every consequential outcome (spec §553). The raw run row is immutable; superseding runs reference the prior via `causation_id`.

### D6 — Reuse Phase 0; never re-create it

| Concern | Reused Phase-0 mechanism |
|---|---|
| Documents/messages/posts | `ArtifactRecord` + `ArtifactVersion` (0.1b) — all 17 Phase-1 artifact types are generic artifacts |
| Approvals | `approval-service` (0.1c) — agents route to it; approval state stays canonical |
| Provider projection | `projectOpportunity` + the adapter (0.2b) + reconcile/capture/execute (0.2c–e) |
| Controlled commands | `workspace_command` + the 0.2d/0.2e capture→execute path |
| Events + audit | `operational_event` + `event-writer` (append-only) |
| Idempotency / concurrency | `idempotency` service + optimistic version guards |
| Agent evaluation (offline) | the `fos-evals` Python sidecar (fixtures + runner) |

Agents **must not** create parallel document, approval, consent, or workspace systems (spec execution instruction §610).

### D7 — Deterministic policy gates are a shared, code-only library

A `packages/agents/src/gates/` module implements: consent/cooldown, claims-approved-effective-allowed-for-channel-and-offer, planned-feature-not-available, offer availability, lifecycle/state-machine legality (reuse `opportunity-transitions`), terminal-status, duplicate-task, scheduled-activity. Each agent declares which gates apply. **Enrollment Brief Agent hard gates:** all observed facts resolve to a `source_ref`; the output type forbids inference-as-fact; a prohibited-claims check rejects any employment/recruiter/salary/interview guarantee; recommended pathway must exist for the current offer.

### D8 — Per-agent feature flags with a shadow→review→live mode ladder

Phase 0 has no flag mechanism; Phase 1 adds a minimal `feature_flag` table (`workspace_id, key, enabled, mode, updated_at`) read at stage 2. Each agent + workspace workflow has an **independent flag** and progresses shadow (runs, output not surfaced) → founder-review (surfaced for approval) → limited-live, with a version rollback path. **No autonomous send/publish** exists in any mode (invariant §9).

### D9 — Untrusted input is data, never instruction (prompt-injection posture)

Applications, resumes, transcripts, web/competitor pages, imported notes, and workspace page content are **untrusted data** and may not modify policy, tools, approval requirements, or data scope (spec §547). Context assembly labels + isolates untrusted content; the reader/actor quarantine holds (an agent that reads untrusted content runs read-only; write/execute happens only after deterministic gates + approval). Eval fixtures include a prompt-injection case; least-privilege context minimization is stage 3.

### D10 — Domain migrations (thin, mostly new entities)

Most Phase-1 `EnrollmentOpportunity` extension fields already exist from 0.1a (`fit_status, fit_score, estimated_value_cents, actual_value_cents, recommended_pathway, next_action_type, next_action_due_at, next_action_summary, version`, …). **Add only:** `campaign_id (FK, nullable)`, `first_touch_source`, `last_touch_source`, `attribution_confidence`. **New entities:** `agent_run`, `enrollment_assessment`, `objection_record`, `enrollment_action_recommendation`, `campaign`, `campaign_touch`. All product-scoped where the spec scopes them; all append-only where the spec says append-only (`campaign_touch`, `operational_event`, `agent_run`).

## 3. Consequences

- **Positive:** one runtime, eight agents; the crown-jewel spine is built + eval-tested once; every agent inherits audit, gates, approval, projection, and shadow-mode for free; the portfolio gains a clean "bounded-agent runtime" artifact.
- **Cost:** a new package + the Anthropic SDK dependency (needs approval); a `feature_flag` mechanism; the runtime is the highest-scrutiny slice (it will get the 3-layer gate — correctness + security + silent-failure — like the security-critical adapter slices).
- **Risk:** the model stage is the only non-deterministic one; the mitigation is that stages 6–7 fail closed and stage 10 never sends/publishes. Live agent quality is proven via `fos-evals` fixtures + shadow mode before any founder-review activation.

## 4. Open questions for founder sign-off

1. **Anthropic SDK dependency** + model tier per agent (default: Sonnet for extraction/synthesis agents, escalate to Opus for the long-form Substack Cornerstone). Approve?
2. **Model routing** stays direct-to-Anthropic (no gateway), per the locked decision — confirm.
3. Any Phase-1 capability you want **explicitly deprioritized** in the first passes (e.g., the launch-comms agents) so the enrollment vertical ships first.

Once ratified, implementation proceeds per `docs/planning/PHASE-1-IMPLEMENTATION-MAP.md`, slice **P1.0 → P1.1 (runtime) → P1.2 (Enrollment Brief Agent)** first.
