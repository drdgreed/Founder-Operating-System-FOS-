# Founder Operating System

## Phase 2 - Beta Activation, Retention, Support, and Founder Editorial Cadence
### Complete Technical Specification and Implementation Plan

| Document control | Value |
|---|---|
| Document ID | `FOS-TECH-PHASE-2` |
| Version | 3.0 |
| Status | Revised implementation specification |
| Replaces | The earlier Beta Activation, Retention, and Referral Engine specification |
| Depends on | Revised Phase 0 - Founder Workspace and Operating Foundation |
| Product owner | Founder |
| Primary audience | Coding agents, founder, product architect, implementation reviewers |
| Current business stage | Beta enrollment and early beta operation |
| Updated | 2026-07-13 |

> This specification is written against the revised Phase 0 canonical-state, generic-artifact, controlled-command, and Founder Workspace Adapter contracts. Any implementation based on the earlier native-admin assumptions must be refactored as identified in the dependency plan.

---

# 0. Revision decision

Phase 2 now combines beta operations with the founder's recurring editorial cadence. These functions share the same raw material: beta questions, onboarding friction, support patterns, learning milestones, founder observations, and emerging outcomes.

The phase must protect private beta data while turning approved aggregate learning into useful LinkedIn and Substack communication. Beta operations remain canonical; editorial working copies live in Notion.

# 1. Implementation directive

Build the operating system that moves each enrolled beta user from enrollment to first value, detects risk, triages support, captures verified outcomes and referrals, and maintains a sustainable weekly founder publishing workflow.

# 2. Objectives and success metrics

## Beta objectives

- Every active beta user has an approved onboarding plan and first-value milestone.
- At-risk users are identified with explainable factors.
- Support is classified, answered, and converted into product signals.
- Outcomes and referral opportunities are captured with consent.

## Editorial objectives

- Maintain a reliable LinkedIn cadence and recurring Substack workflow.
- Produce build logs, learning reports, and educational posts from approved sources.
- Reduce founder blank-page writing while preserving voice and judgment.

## Metrics

- Onboarding completion
- Time to first value
- Week-one and cohort retention
- Support volume and resolution time
- Founder support minutes
- At-risk recovery
- Verified outcomes, referral invitations, referral enrollments
- Weekly content cadence
- Founder content-production minutes
- Content-assisted applications and enrollments

# 3. Scope

Included:

- Beta enrollment conversion
- Personalized onboarding
- Milestones and first-value detection
- Explainable beta-health snapshots
- Intervention recommendations
- Support cases and response drafts
- Outcome evidence and consent
- Referral opportunities
- Weekly editorial planning
- Recurring LinkedIn post generation
- Substack research/essay workflow
- Build-log generation
- Comment/question clustering for future content

Excluded:

- Autonomous support sending
- Psychological or protected-attribute scoring
- Public use of outcomes without consent
- Full campaign automation
- Product specification and release QA
- Autonomous social engagement

# 4. Domain model extensions

## 4.1 BetaEnrollment

Canonical fields include status, primary goal, pathway, start/end, onboarding status, first-value status, last activity, health status, risk level, founder owner, and version.

## 4.2 OnboardingPlan

References an `ArtifactRecord`. Canonical fields store objective, first-value milestone, status, approval, active version, and user-visible release state.

## 4.3 BetaMilestone

Stores type, success criteria, target date, completion evidence, status, blocking reason, and dependencies.

## 4.4 BetaActivityEvent

Append-only product and operational activity used for milestone and health calculations.

## 4.5 BetaHealthSnapshot

Stores score, status, risk, observed factors with source IDs, missing data, confidence, and recommended intervention. It is an operational indicator, not a factual characterization of the person.

## 4.6 SupportCase

Stores source interaction, case type, severity, product area, status, assigned owner, linked signals/defects, response artifact, and resolution.

## 4.7 InterventionRecommendation

Stores intervention type, rationale, urgency, confidence, due date, artifact, approval, status, and outcome.

## 4.8 OutcomeEvidence

Stores outcome type, statement, classification, source, verification, before/after measures where available, consent references, and permitted use.

## 4.9 ReferralOpportunity

Stores eligibility reason, request type, artifact, approval, request/result timestamps, referred person, and resulting opportunity.

## 4.10 EditorialCycle

- `id`, `workspace_id`, `period_start`, `period_end`
- `business_priority_ids`, `content_pillar_ids`
- `source_signal_ids`, `planned_asset_count`
- `status`, `review_artifact_id`, `created_at`, `updated_at`

## 4.11 AudienceQuestionCluster

Stores recurring questions from applications, support, calls, comments, and webinars, with privacy-safe summaries and content opportunity ranking.

# 5. Artifact types and Notion workspace

## Artifact types

- `onboarding_plan`
- `beta_check_in`
- `support_response`
- `intervention_plan`
- `testimonial_request`
- `referral_request`
- `weekly_editorial_plan`
- `linkedin_post`
- `linkedin_carousel_script`
- `substack_research_brief`
- `substack_paper`
- `build_log`
- `beta_learning_note`

## Notion collections

### Beta Operations

Projects goal, onboarding, first value, health summary, support status, intervention, outcome/referral candidates, and next founder action. Raw activity and sensitive source detail remain canonical.

### Support Queue

Projects case summary, severity, type, age, owner, response artifact, and resolution state.

### Editorial Calendar

Projects the weekly cycle, audience, pillar, source evidence, channel, status, planned publication, CTA, and performance summary.

### LinkedIn Pipeline and Substack Papers

Provide founder editing and approval. Canonical evidence and consent gates remain in FOS.

# 6. Agents

## Beta Onboarding Concierge - `fos.beta_onboarding_concierge`

Creates a feasible onboarding plan and observable first-value milestone using only available capabilities.

## Beta Health Agent - `fos.beta_health`

Synthesizes deterministic indicators into an explainable health recommendation. Missing telemetry lowers confidence.

## Support Triage Agent - `fos.support_triage`

Classifies issue, severity, product area, likely cause, owner, response brief, and product signals.

## Outcome Evidence Agent - `fos.outcome_evidence`

Identifies candidate outcomes and required consent without overstating causality.

## Referral Readiness Agent - `fos.referral_readiness`

Recommends referral timing only after a verified success or explicit positive signal.

## Weekly Editorial Strategist - `fos.weekly_editorial_strategist`

Creates a weekly content plan aligned to current enrollment goals, beta learning, founder time, content pillars, and channel policies.

## LinkedIn Drafting Agent - `fos.linkedin_drafting`

Creates evidence-led posts and carousel scripts in the approved founder voice; avoids generic influencer language.

## Substack Research and Essay Agent - `fos.substack_essay`

Creates research brief, evidence matrix, outline, counterarguments, draft, summary, and derivative plan.

## Engagement Intelligence Agent - `fos.engagement_intelligence`

Clusters privacy-safe audience questions and objections. It may draft responses but may not post as the founder.

# 7. Workflows

## 7.1 Enrollment to onboarding

Create BetaEnrollment, generate onboarding artifact, founder approves, create milestones, create welcome draft, and project safe summary to Notion.

## 7.2 Health and intervention

Calculate deterministic indicators daily and after key events, run health synthesis, compare with prior snapshot, create intervention only when threshold crossed, and require founder approval for communication.

## 7.3 Support to product signal

Record support interaction, triage, create response artifact, route approval, resolve case, and create linked Phase 3 product signal candidate.

## 7.4 Outcome and referral

Detect success evidence, verify source, check consent, create founder review, and generate testimonial/referral artifacts only after approval.

## 7.5 Weekly editorial cycle

1. Collect approved beta learning, product notes, audience questions, and business priorities.
2. Generate a bounded weekly plan.
3. Founder chooses topics in Notion.
4. Generate LinkedIn/Substack artifacts.
5. Verify claims, consent, and privacy.
6. Founder edits and approves.
7. Create platform drafts.
8. Record publication and results.

# 8. APIs and jobs

API families:

- `/api/fos/beta-enrollments/*`
- `/api/fos/onboarding-plans/*`
- `/api/fos/beta-milestones/*`
- `/api/fos/beta-health/*`
- `/api/fos/support-cases/*`
- `/api/fos/outcome-evidence/*`
- `/api/fos/referral-opportunities/*`
- `/api/fos/editorial-cycles/*`
- `/api/fos/audience-question-clusters/*`

Jobs:

- `generate-beta-onboarding-plan`
- `detect-first-value`
- `calculate-beta-health`
- `detect-beta-inactivity`
- `triage-support-case`
- `extract-outcome-evidence`
- `identify-referral-opportunities`
- `generate-weekly-editorial-plan`
- `generate-linkedin-artifact`
- `generate-substack-artifact`
- `cluster-audience-questions`
- `reconcile-beta-and-editorial-projections`

# 9. Deterministic safeguards

- Consent controls contact and public use.
- Health factors must be observable and source-linked.
- Low activity alone cannot be labeled dissatisfaction.
- Support response may not promise a product change.
- Editorial artifacts may use only anonymous aggregate learning unless stronger consent exists.
- Founder edits trigger claim and privacy revalidation.
- Platform adapters create drafts only.

# 10. Tests

Unit tests cover milestone dependencies, consent, health indicators, support severity, referral eligibility, privacy-safe aggregation, and editorial source eligibility.

Integration tests cover enrollment-to-onboarding, inactivity intervention, support-to-product-signal, consent revocation, outcome verification, weekly plan generation, and founder Notion edits.

Agent fixtures include engaged user, low activity with known absence, product-defect block, onboarding confusion, first-value success, unsupported outcome claim, testimonial without consent, and malicious imported text.

End-to-end tests cover enrollment to first value, at-risk recovery, support resolution, outcome/referral approval, and weekly editorial plan to approved publication draft.

# 11. Work packages

| Package | Deliverable |
|---|---|
| WP2.0 | Phase 1 enrollment-to-beta handoff |
| WP2.1 | Beta domain schema and migration |
| WP2.2 | Onboarding artifacts and milestones |
| WP2.3 | Product activity and first-value instrumentation |
| WP2.4 | Explainable health engine |
| WP2.5 | Support queue and triage |
| WP2.6 | Outcome, consent, testimonial, and referral workflows |
| WP2.7 | Weekly editorial-cycle model |
| WP2.8 | LinkedIn and Substack agents/workspaces |
| WP2.9 | Engagement intelligence and question clustering |
| WP2.10 | Metrics, evaluation, and activation |

# 12. Definition of done

- Every active beta user has an approved first-value path.
- Health and intervention recommendations are explainable.
- Support interactions create reusable product signals.
- Outcome and referral workflows respect consent.
- The founder can operate beta support and weekly publishing from Notion.
- Private beta detail is not exposed in editorial projections.
- No autonomous support sending, social posting, or testimonial use is possible.

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

    > Implement Phase 2 - Beta Activation, Retention, Support, and Founder Editorial Cadence according to this specification.
    >
    > Begin by verifying that revised Phase 0 is operational: canonical records, generic artifacts, approvals, workspace commands, projection policies, evidence, claims, consent, event audit, feature flags, and the Notion provider adapter.
    >
    > Produce an architecture decision record and a repository-to-requirement implementation map before migrations. Reuse Phase 0 services rather than creating parallel document, approval, consent, or workspace systems.
    >
    > Maintain a live traceability matrix linking every requirement to implementation files, migrations, automated tests, feature flags, and operational metrics.
    >
    > Preserve these phase-specific non-negotiable rules:
    >
    > 1. Reuse Phase 0 consent, artifact, approval, event, and workspace contracts.
> 2. Project beta summaries, not unrestricted private source data.
> 3. Health is explainable operational guidance, not a psychological assessment.
> 4. Recurring LinkedIn and Substack work must begin from approved evidence or editorial briefs.
> 5. All communication and public-use actions require founder approval.
    >
    > Implement work packages in dependency order. Activate each agent in shadow mode before founder-review mode. Treat Notion as a projection and controlled working surface, not as the source of canonical lifecycle, consent, claim, test, pricing, or deployment state.
