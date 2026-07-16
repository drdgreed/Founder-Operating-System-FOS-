# Founder Operating System

## Phase 6 - Founder Chief of Staff, Command Center, and Automation Governance
### Complete Technical Specification and Implementation Plan

| Document control | Value |
|---|---|
| Document ID | `FOS-TECH-PHASE-6` |
| Version | 3.0 |
| Status | Revised implementation specification |
| Replaces | The earlier Full Specification Compiler and Founder Chief of Staff specification |
| Depends on | Revised Phase 0 - Founder Workspace and Operating Foundation |
| Product owner | Founder |
| Primary audience | Coding agents, founder, product architect, implementation reviewers |
| Current business stage | Beta enrollment and early beta operation |
| Updated | 2026-07-13 |

> This specification is written against the revised Phase 0 canonical-state, generic-artifact, controlled-command, and Founder Workspace Adapter contracts. Any implementation based on the earlier native-admin assumptions must be refactored as identified in the dependency plan.

---

# 0. Revision decision

Phase 6 becomes the coordination and governance layer over reliable outputs from Phases 1 through 5. Notion is the initial Founder Command Center. A native administrative dashboard is deferred until volume, privacy, latency, or productization justifies it.

The chief-of-staff agent does not operate the company autonomously. It reduces the founder's decision surface, identifies conflicts, produces operating reviews, and proposes safe automation opportunities.

# 1. Implementation directive

Build a single canonical decision queue and operating-review system that ranks consequential work, detects cross-domain conflicts, compiles full specifications, and identifies repeated founder work suitable for bounded automation.

# 2. Objectives and metrics

- Reduce founder cognitive load and decision latency.
- Limit daily review to consequential items.
- Detect conflicts before external impact.
- Produce daily and weekly operating reviews.
- Create implementation-grade specifications from approved problems.
- Identify time-consuming patterns suitable for automation.
- Preserve founder authority over strategy, pricing, publishing, deployment, and commitments.

Metrics include decision time, unresolved critical items, recommendation acceptance, duplicate rate, conflicts caught, founder hours saved, automation opportunities implemented, and agent-caused rework.

# 3. Scope

Included:

- Strategic priority registry
- Unified decision queue
- Founder recommendations
- Daily brief
- Weekly/monthly/cohort/release operating reviews
- Cross-domain conflict detection
- Full specification compiler and critic
- Automation opportunity detection
- Delegation/autonomy proposals
- Notion Founder Command Center

Excluded:

- Autonomous strategy changes
- Autonomous spending or purchasing
- Autonomous pricing, publication, deployment, or contractual commitments
- Unbounded task creation
- Hidden ranking or unexplained priority changes

# 4. Domain model

## StrategicPriority

Stores title, description, rank, effective dates, metrics, non-goals, status, and founder approval.

## DecisionQueueItem

Stores domain, type, source, title, summary, impact, urgency, confidence, estimated founder minutes, priority score, recommended action, risk of delay, status, and due date.

## FounderRecommendation

Stores recommendation, rationale, evidence, expected impact, effort, confidence, alternatives, risks, and decision linkage.

## OperatingReview

References an artifact and stores period, metrics snapshot, shipped work, enrollment drivers, user struggles, funnel changes, founder time, agent failures, market changes, work to stop, automation opportunities, and top decisions.

## ConflictRecord

Stores type, entities, description, severity, recommended resolution, status, and resolution audit.

## AutomationOpportunity

Stores task pattern, frequency, founder minutes, monthly hours, risk, required data, proposed agent/workflow, implementation effort, value, autonomy ceiling, and status.

## AutonomyPolicyProposal

Stores current/proposed autonomy, workflow, evidence, success thresholds, rollback, prohibited actions, founder decision, and effective dates.

# 5. Notion Founder Command Center

Required views:

- Decisions required today
- Enrollment and beta risks
- Release blockers
- Marketing approvals
- Strategic alerts
- Conflicts
- Deferred decisions
- Automation opportunities
- Weekly operating review
- Founder workload and time savings

Every item links to canonical records and exposes ranking factors. Notion commands approve, reject, defer, pin, request analysis, or open a decision; they do not directly mutate protected state.

# 6. Agents

## Founder Chief of Staff - `fos.founder_chief_of_staff`

Produces bounded daily and weekly decision summaries.

## Cross-Domain Conflict Detector - `fos.cross_domain_conflict_detector`

Detects enrollment promise versus capability, marketing claim versus release, pricing versus offer, consent versus content, requirement versus test, resource versus priority, and similar contradictions.

## Full Specification Compiler - `fos.full_specification_compiler`

Produces strategic context, evidence, alternatives, scope, requirements, agent contracts, data/API/security/observability/migration/testing/rollout/rollback, success metrics, risks, and open questions.

## Specification Critic - `fos.specification_critic`

Evaluates customer value, revenue, opportunity cost, architecture, security, privacy, complexity, testability, maintainability, and go-to-market consistency.

## Automation Opportunity Detector - `fos.automation_opportunity_detector`

Identifies repeated founder actions and estimates value, risk, data needs, implementation effort, and suitable autonomy ceiling.

## Autonomy Governance Evaluator - `fos.autonomy_governance`

Evaluates whether a workflow can move from observe to draft or reversible execution based on measured evidence. It cannot approve the increase.

# 7. Prioritization model

Default priority uses approved strategic alignment, business impact, urgency, confidence, risk of delay, enrollment value, founder-time saving, implementation effort, and reversibility risk.

Critical security, privacy, legal, or customer-harm items override economic ranking. The system must show ranking factors and permit founder pin, defer, or suppression.

# 8. Workflows

## Daily brief

Collect unresolved consequential items, exclude informational noise, deduplicate, detect conflicts, rank, limit default count, create decision artifacts, and project to Notion.

## Weekly operating review

Snapshot enrollment, beta, product, QA, content, market, agent, and founder-time metrics; summarize changes; identify work to stop; propose three highest-value decisions; and require founder review.

## Full specification

Start from approved problem, assemble evidence/constraints, generate artifact, run critic, revise, validate requirement/test plan, route approval, and create traceability records.

## Conflict scan

Run after product release, claim/price/offer update, content approval, specification approval, consent change, or strategic-priority update.

## Automation governance

Detect pattern, calculate founder cost, assess risk, propose bounded workflow, specify metrics and rollback, run shadow mode, and request founder decision before autonomy changes.

# 9. APIs and jobs

API families:

- `/api/fos/strategic-priorities/*`
- `/api/fos/decision-queue/*`
- `/api/fos/founder-recommendations/*`
- `/api/fos/operating-reviews/*`
- `/api/fos/conflicts/*`
- `/api/fos/automation-opportunities/*`
- `/api/fos/autonomy-policies/*`
- `/api/fos/specifications/full/*`

Jobs:

- `build-daily-founder-brief`
- `build-weekly-operating-review`
- `scan-cross-domain-conflicts`
- `generate-full-specification`
- `run-specification-critique`
- `detect-automation-opportunities`
- `evaluate-autonomy-policy`
- `reconcile-command-center-projections`

# 10. Deterministic safeguards

- Chief-of-staff recommendations cannot create or change strategic priorities.
- Informational activity is summarized rather than promoted to decisions.
- Daily queue is bounded and duplicate-suppressed.
- Ranking inputs are inspectable.
- Conflict records cannot be silently resolved.
- Autonomy changes require founder approval and rollback.
- Native command-center UI is deferred until evidence justifies it.

# 11. Tests

Decision tests cover revenue versus low-value tasks, security override, confidence demotion, deferral, duplication, ranking explanation, and stale item handling.

Conflict tests cover claim/capability, enrollment/scope, price/offer, requirement/test, consent/content, and release/publication contradictions.

Chief-of-staff tests verify bounded actionable output, no priority mutation, inspectable evidence, and audit of rejected recommendations.

Autonomy tests verify shadow-mode thresholds, rollback, prohibited actions, and founder approval.

# 12. Work packages

| Package | Deliverable |
|---|---|
| WP6.0 | Cross-phase data quality and metric readiness audit |
| WP6.1 | Strategic priority registry |
| WP6.2 | Unified canonical decision queue |
| WP6.3 | Notion Founder Command Center |
| WP6.4 | Cross-domain conflict detection |
| WP6.5 | Daily founder brief |
| WP6.6 | Weekly and monthly operating reviews |
| WP6.7 | Full specification compiler and critic |
| WP6.8 | Automation opportunity detection |
| WP6.9 | Autonomy governance and rollback |
| WP6.10 | Evaluation, tuning, and native-UI decision gate |

# 13. Definition of done

- Founder operates from one bounded decision queue.
- Recommendations are evidence-backed and explainable.
- Cross-domain conflicts are detected before protected actions.
- Operating reviews show business results, founder time, and agent quality.
- Full specifications use shared artifacts and canonical requirements/tests.
- Automation and autonomy changes remain founder-governed and reversible.
- FOS remains functional without Notion.

# Shared architectural invariants

The following rules are inherited from revised Phase 0 and are non-negotiable for this phase:

1. **FOS owns canonical state and intelligence.** Notion is a founder-facing working environment and projection surface.
2. **External workspace changes are commands, not direct mutations.** A Notion status change or button creates a validated `WorkspaceCommand`.
3. **Artifacts are generic and versioned.** Enrollment messages, specifications, LinkedIn posts, Substack papers, reports, and reviews use `ArtifactRecord` and `ArtifactVersion`.
4. **Approvals are interface-independent.** Approval state is canonical and may be requested from Notion, a native interface, or an API.
5. **Evidence, claims, consent, and product availability are deterministic gates.** Models may recommend; they may not waive these controls.
6. **Every projection has an ownership policy.** Fields are `canonical_read_only`, `working_copy_editable`, `controlled_command`, or `not_projectable`.
7. **Raw events are immutable.** Derived summaries may be superseded but not silently overwrite source history.
8. **Every agent is bounded.** Each agent has a versioned objective, input schema, output schema, permitted tools, permitted memory scopes, evaluation policy, and autonomy ceiling.
9. **No autonomous publishing, sending, pricing change, contractual commitment, or production deployment** is permitted unless a later founder-approved governance decision explicitly changes the rule.
10. **FOS must remain operational if Notion or another workspace provider is unavailable.**

## Founder Workspace integration contract

All founder-facing work for this phase must use the Phase 0 workspace adapter.

### Projection pattern

```text
Canonical record or artifact created
        -> operational event emitted
        -> projection policy evaluated
        -> safe working copy created or updated in Notion
        -> canonical ID and version stored on the provider page
        -> founder edits or commands captured
        -> FOS validates and executes canonical change
        -> projection is reconciled
```

### Required hidden projection properties

- `FOS Record ID`
- `FOS Entity Type`
- `FOS Version`
- `FOS Workspace ID`
- `Projection Status`
- `Last Synced At`

### Conflict rule

A controlled command may execute only when the provider's `FOS Version` matches the current canonical version. Otherwise the command is placed in `conflict` status and the founder receives a reconciliation item.

# Agent runtime requirements

Every agent run must execute the following stages:

1. Trigger validation
2. Authorization and feature-flag validation
3. Context assembly and minimization
4. Prompt construction from a versioned agent definition
5. Model execution
6. Structured-output validation
7. Deterministic policy evaluation
8. Secondary quality evaluation where configured
9. Canonical persistence
10. Approval routing or reversible execution
11. Projection update
12. Metrics and audit emission

If structured output fails, retry once with a repair prompt. If repair fails, mark the run `evaluation_failed`, create a founder-visible operational item, and do not create an approval-ready artifact.

# Security, privacy, and governance

## Least privilege

- Agents receive only the records required for the current run.
- Workspace projections contain summaries unless full working content is required.
- Private source documents, raw model prompts, credentials, payment details, and exploitable security findings are `not_projectable` by default.
- Marketing and research agents may not access unrestricted applicant or beta-user records.

## Prompt-injection defense

Applications, resumes, email, transcripts, web pages, competitor pages, imported notes, and workspace page content are untrusted data. They may not modify system policy, tool permissions, approval requirements, or data-access scope.

## Audit

The system must reconstruct every consequential outcome from:

- Trigger
- Actor
- Source records
- Retrieved context manifest
- Agent and prompt version
- Output
- Deterministic evaluation
- Founder edits
- Approval or rejection
- External action
- Resulting business outcome

## Failure posture

Failures must preserve canonical state, create a visible retry or manual-work item, and never imply that an external action succeeded when it did not.

# Observability and cost controls

Each workflow must emit structured logs and traces with:

- `workspace_id`
- Correlation and causation IDs
- Phase and workflow key
- Agent key and version
- Canonical entity IDs
- Provider projection IDs where applicable
- Latency
- Model and tool cost
- Validation and evaluation result
- Retry count
- Approval result
- External action result

Required phase dashboards must distinguish system activity from accepted business value. Agent-run volume is not itself a success metric.

# Deployment and activation model

Each major capability must progress through:

1. Local development
2. Automated tests
3. Staging with synthetic fixtures
4. Production with feature flag disabled
5. Production shadow mode
6. Founder-only review mode
7. Limited live activation
8. Measured promotion or rollback

Every agent and workspace workflow requires an independent feature flag and version rollback path.
    # Coding-agent execution instruction

    > Implement Phase 6 - Founder Chief of Staff, Command Center, and Automation Governance according to this specification.
    >
    > Begin by verifying that revised Phase 0 is operational: canonical records, generic artifacts, approvals, workspace commands, projection policies, evidence, claims, consent, event audit, feature flags, and the Notion provider adapter.
    >
    > Produce an architecture decision record and a repository-to-requirement implementation map before migrations. Reuse Phase 0 services rather than creating parallel document, approval, consent, or workspace systems.
    >
    > Maintain a live traceability matrix linking every requirement to implementation files, migrations, automated tests, feature flags, and operational metrics.
    >
    > Preserve these phase-specific non-negotiable rules:
    >
    > 1. Strategic priorities, consequential decisions, autonomy changes, and protected actions require founder approval.
> 2. Notion is the initial command center, but canonical decisions and audit remain in FOS.
> 3. The daily queue must be bounded, deduplicated, evidence-backed, and explainable.
> 4. Conflicts may be detected by agents but cannot be silently resolved.
> 5. Any autonomy increase requires shadow-mode evidence, explicit prohibited actions, and rollback.
    >
    > Implement work packages in dependency order. Activate each agent in shadow mode before founder-review mode. Treat Notion as a projection and controlled working surface, not as the source of canonical lifecycle, consent, claim, test, pricing, or deployment state.
