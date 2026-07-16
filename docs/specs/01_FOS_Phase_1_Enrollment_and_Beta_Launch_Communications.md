# Founder Operating System

## Phase 1 - Enrollment Revenue and Beta Launch Communications
### Complete Technical Specification and Implementation Plan

| Document control | Value |
|---|---|
| Document ID | `FOS-TECH-PHASE-1` |
| Version | 3.0 |
| Status | Revised implementation specification |
| Replaces | The Phase 1 portions of the earlier combined Phase 0/Phase 1 specification |
| Depends on | Revised Phase 0 - Founder Workspace and Operating Foundation |
| Product owner | Founder |
| Primary audience | Coding agents, founder, product architect, implementation reviewers |
| Current business stage | Beta enrollment and early beta operation |
| Updated | 2026-07-13 |

> This specification is written against the revised Phase 0 canonical-state, generic-artifact, controlled-command, and Founder Workspace Adapter contracts. Any implementation based on the earlier native-admin assumptions must be refactored as identified in the dependency plan.

---

# 0. Revision decision

Phase 1 remains the highest-dollar-impact build, but it now combines two tightly linked revenue functions:

1. **Enrollment operations:** qualify, prepare, follow up, recover, and convert opportunities.
2. **Beta launch communications:** create the LinkedIn, Substack, email, webinar, landing-page, and referral communications that generate those opportunities.

The earlier design treated marketing as a later downstream capability. That is rejected for beta launch. Phase 1 must create demand and convert demand using the same claims, evidence, audience, narrative, channel, CTA, artifact, approval, and attribution contracts established in Phase 0.

# 1. Implementation directive

Build a founder-operated enrollment revenue system that:

- Converts applications and interactions into evidence-backed opportunity briefs.
- Produces founder-reviewable responses and next actions.
- Detects and helps resolve objections and inactivity.
- Executes a coordinated beta-launch communications sequence.
- Attributes applications, calls, and enrollments to source communications where evidence exists.
- Captures founder edits to improve later communication agents.
- Uses Notion as the founder working surface without surrendering canonical opportunity state.

# 2. Objectives and success metrics

## 2.1 Revenue objectives

- Increase qualified application volume.
- Increase application-to-call conversion.
- Increase call show rate.
- Increase offer-to-enrollment conversion.
- Recover suitable stalled and no-show opportunities.
- Reduce founder minutes per qualified lead and per enrollment.

## 2.2 Launch communications objectives

- Publish a coherent beta-launch narrative across LinkedIn, Substack, email, webinar, and landing-page surfaces.
- Use one approved source brief to create multiple channel-appropriate assets.
- Ensure every factual claim is approved and current.
- Track source, campaign, CTA, application, call, and enrollment relationships.

## 2.3 Required metrics

| Domain | Metrics |
|---|---|
| Demand | impressions where available, subscribers, clicks, applications, qualified applications |
| Conversion | application-to-call, show rate, call-to-offer, offer-to-enrollment, lead-to-enrollment |
| Speed | time to first response, post-call follow-up time, age by opportunity stage |
| Founder leverage | review minutes, preparation minutes, follow-up minutes, approved-draft edit distance |
| Communications | assets published, source-brief reuse, CTA conversion, campaign-assisted enrollments |
| Agent quality | source coverage, unsupported-claim blocks, approval rate, rejection rate, escalation accuracy |

# 3. Scope

## 3.1 Included enrollment capabilities

- Application intake integration
- Enrollment Brief Agent
- Call Preparation Agent
- Post-Call Synthesis Agent
- Personalized Follow-Up Agent
- Objection Intelligence Agent
- Next-Best-Action Agent
- Stalled-opportunity detection
- Opportunity funnel and founder-time instrumentation

## 3.2 Included launch communications

- Beta campaign record
- Beta announcement LinkedIn sequence
- Founder-story post
- Problem-awareness and objection posts
- Product demonstration post
- LinkedIn carousel scripts
- Substack cornerstone paper and promotion package
- Beta landing-page working copy
- Enrollment email sequence
- Webinar invitation, reminder, and follow-up package
- Referral communication kit
- Campaign attribution events

## 3.3 Out of scope

- Autonomous sending or publishing
- Paid media buying
- Full marketing automation
- Customer onboarding after enrollment
- Beta health and support operations
- Production social engagement automation
- Pricing changes without founder decision

# 4. Preconditions and required Phase 0 records

Before enabling Phase 1, seed and approve:

- Current beta offer and price
- Product capabilities and limitations
- Approved and prohibited claims
- Target audience segments
- Core beta launch narrative
- Content pillars
- Channel policies for LinkedIn, Substack, email, webinar, and website
- CTA registry
- Founder voice policy
- Campaign source and attribution rules
- Operational-contact and marketing-contact consent rules

# 5. Architecture and module boundaries

```text
Public and founder-created demand signals
  LinkedIn | Substack | Website | Webinar | Email | Referral
                          |
                          v
                Campaign and attribution events
                          |
                          v
Application intake -> EnrollmentOpportunity -> Agent workflows
                          |
          +---------------+----------------+
          |                                |
          v                                v
Canonical FOS state                Notion founder workspace
opportunity, evidence,             Enrollment Pipeline,
claims, approvals, metrics         Founder Inbox, Launch Campaign
          |                                |
          +---------------+----------------+
                          |
                          v
               Founder-approved external drafts
```

Enrollment state and attribution remain canonical. Notion displays and edits working artifacts and creates controlled commands.

# 6. Domain model extensions

## 6.1 EnrollmentOpportunity extensions

Add or confirm:

- `campaign_id`
- `first_touch_source`
- `last_touch_source`
- `attribution_confidence`
- `estimated_value_cents`
- `actual_value_cents`
- `recommended_pathway`
- `fit_status`
- `next_action_type`
- `next_action_due_at`
- `version`

## 6.2 Campaign

Fields:

- `id`, `workspace_id`, `campaign_key`, `name`
- `objective`, `offer_id`, `audience_segment_ids`
- `narrative_ids`, `content_pillar_ids`, `channel_ids`
- `primary_cta_id`, `secondary_cta_ids`
- `start_at`, `end_at`, `status`
- `success_metrics_json`, `budget_cents`, `created_at`, `updated_at`

## 6.3 CampaignTouch

Append-only touchpoint record:

- `id`, `campaign_id`, `person_id`, `opportunity_id`
- `content_asset_id`, `publication_reference`
- `channel`, `cta_id`, `touch_type`, `occurred_at`
- `utm_json`, `referrer`, `confidence`, `created_at`

## 6.4 EnrollmentAssessment

- `id`, `opportunity_id`, `agent_run_id`, `version`
- `observed_facts_json`, `inferences_json`
- `fit_status`, `fit_confidence`, `fit_rationale`
- `recommended_pathway`, `unknowns_json`, `risk_flags_json`
- `created_at`

## 6.5 ObjectionRecord

- `id`, `opportunity_id`, `category`, `statement`
- `classification`, `confidence`, `severity`
- `source_interaction_id`, `resolution_status`
- `resolution_summary`, `created_at`, `updated_at`

## 6.6 EnrollmentActionRecommendation

- `id`, `opportunity_id`, `agent_run_id`
- `action_type`, `summary`, `rationale`
- `business_impact`, `urgency`, `confidence`
- `recommended_due_at`, `artifact_record_id`
- `status`, `outcome`, `created_at`, `updated_at`

# 7. Artifact types and workspace projections

## 7.1 Phase 1 artifact types

- `enrollment_brief`
- `call_preparation_brief`
- `post_call_recap`
- `initial_response`
- `information_request`
- `objection_response`
- `offer_follow_up`
- `no_show_recovery`
- `unresponsive_recovery`
- `beta_launch_source_brief`
- `linkedin_post`
- `linkedin_carousel_script`
- `substack_paper`
- `email_sequence`
- `webinar_package`
- `landing_page_copy`
- `referral_kit`

## 7.2 Notion collections

### Enrollment Pipeline

Projects opportunity summary, stage, fit, value, last interaction, next action, objections, pending artifact, and canonical links.

### Founder Inbox

Projects decisions and drafts requiring founder action.

### Beta Launch Campaign

Contains campaign strategy, source brief, linked assets, planned dates, claims status, approval, publication references, applications, calls, and enrollments.

### LinkedIn Pipeline and Substack Papers

Use the Phase 0 editorial workspace with Phase 1 campaign filters.

## 7.3 Controlled commands

- Approve or reject enrollment artifact
- Request revision
- Propose stage transition
- Defer opportunity
- Create Gmail draft
- Mark artifact published
- Generate channel derivative
- Run claims verification
- Record webinar event

# 8. Agent specifications

## 8.1 Enrollment Brief Agent

**Key:** `fos.enrollment_brief`

Produces a three-minute founder review containing candidate summary, observed facts with sources, labeled inferences, readiness, fit, pathway, objections, discovery questions, risk flags, and next action.

Hard gates:

- All observed facts resolve to source records.
- Inferences are never written as facts.
- Recommended pathway is available for the current offer.
- No employment, recruiter, salary, or interview guarantee.

## 8.2 Call Preparation Agent

**Key:** `fos.call_preparation`

Produces meeting objective, three-sentence summary, critical unknowns, top questions, likely objections, permitted claims, claims to avoid, and recommended close.

## 8.3 Post-Call Synthesis Agent

**Key:** `fos.post_call_synthesis`

Extracts confirmed goals, constraints, objections, commitments, open questions, fit update, stage proposal, next action, and follow-up brief. It may not apply the stage change.

## 8.4 Personalized Follow-Up Agent

**Key:** `fos.personalized_follow_up`

Produces concise channel-specific communication with one primary CTA, a claims manifest, capabilities manifest, personalization sources, and risk flags.

## 8.5 Objection Intelligence Agent

**Key:** `fos.objection_intelligence`

Classifies observed and inferred objections. Aggregate dashboards use reviewed observed objections by default.

## 8.6 Next-Best-Action Agent

**Key:** `fos.next_best_action`

Recommends a valid action after deterministic checks for consent, cooldown, lifecycle, duplicate tasks, scheduled activity, terminal status, and offer availability.

## 8.7 Beta Launch Editorial Agent

**Key:** `fos.beta_launch_editorial`

Given an approved campaign source brief, produces an ordered asset plan across LinkedIn, Substack, email, webinar, and landing page. It may create artifacts but may not publish.

## 8.8 Substack Cornerstone Agent

**Key:** `fos.substack_cornerstone`

Produces thesis, research questions, evidence matrix, counterarguments, outline, full draft, summary, promotion assets, and claims manifest.

# 9. Core workflows

## 9.1 Application to approved response

1. Intake and deduplicate application.
2. Create or update Person and EnrollmentOpportunity.
3. Emit attribution touch where available.
4. Queue Enrollment Brief Agent.
5. Persist assessment and artifact.
6. Project to Enrollment Pipeline.
7. Generate response draft.
8. Founder edits and approves in Notion.
9. Revalidate claims and consent.
10. Create external email draft only after approval.

## 9.2 Conversation workflow

1. Record scheduled conversation.
2. Generate call preparation artifact.
3. Capture founder notes or transcript reference.
4. Run Post-Call Synthesis and Objection Intelligence.
5. Create follow-up artifact and stage proposal.
6. Founder approves artifact and transition separately.
7. Update canonical next action and metrics.

## 9.3 Stalled opportunity workflow

A scheduled job evaluates stage-age policy, contact cooldown, pending tasks, and future events. It creates one recommendation and, where appropriate, a recovery artifact. It never contacts the person automatically.

## 9.4 Beta launch campaign workflow

1. Founder approves campaign source brief.
2. Editorial Agent creates channel plan.
3. Substack Cornerstone Agent generates long-form anchor.
4. Derivative artifacts are generated and independently verified.
5. Founder edits and approves in Notion.
6. Approved platform drafts are created.
7. Publication is recorded manually or through an explicit command.
8. Campaign touches and funnel outcomes are joined.

# 10. APIs and commands

Required API families:

- `/api/fos/applications/*`
- `/api/fos/opportunities/*`
- `/api/fos/interactions/*`
- `/api/fos/enrollment-assessments/*`
- `/api/fos/objections/*`
- `/api/fos/campaigns/*`
- `/api/fos/campaign-touches/*`
- `/api/fos/artifacts/*`
- `/api/fos/approvals/*`
- `/api/fos/workspace-commands/*`
- `/api/fos/dashboard/enrollment`
- `/api/fos/dashboard/campaigns`

All create/update endpoints require workspace authorization, idempotency for intake/external actions, and optimistic concurrency for controlled edits.

# 11. Background jobs

- `process-application-intake`
- `generate-enrollment-brief`
- `generate-call-preparation`
- `analyze-post-call`
- `generate-enrollment-follow-up`
- `detect-stalled-opportunities`
- `generate-beta-launch-plan`
- `generate-substack-cornerstone`
- `generate-launch-derivatives`
- `revalidate-launch-claims`
- `rollup-enrollment-and-campaign-metrics`
- `reconcile-enrollment-projections`

# 12. Deterministic policy gates

- Opportunity transitions follow the canonical state machine.
- Consequential stages require founder approval.
- Contact is blocked when consent is revoked or cooldown is active.
- Claims must be approved, effective, and allowed for the channel and offer.
- Planned features cannot be described as available.
- Founder edits trigger claims revalidation.
- Attribution must expose confidence and method.
- External send and publication remain separate explicit actions.

# 13. Testing

## Unit

State transitions, consent, cooldown, claim validation, attribution parsing, artifact versioning, command version checks, stale detection, and CTA mapping.

## Integration

- Application creates canonical records, brief, projection, and approval item.
- Founder Notion edit creates a new artifact version.
- Unsupported claim blocks approval.
- Duplicate webhook does not duplicate a command.
- Approved communication can create a provider draft but cannot send.
- Published asset creates attribution touch without inventing identity.

## Agent contracts

Fixtures must include strong fit, incomplete information, contradictory history, price objection, time objection, competitor comparison, out-of-scope target, prompt injection, and revoked consent.

## End-to-end

- Launch content to application to enrollment
- Application to call to offer
- Stalled opportunity recovery
- Substack anchor to LinkedIn derivatives
- Unsupported capability block

# 14. Work packages

| Package | Deliverable |
|---|---|
| WP1.0 | Phase 0 contract verification and migration |
| WP1.1 | Opportunity and attribution extensions |
| WP1.2 | Enrollment agent runtime and assessments |
| WP1.3 | Call and post-call workflows |
| WP1.4 | Follow-up, objections, and next actions |
| WP1.5 | Enrollment Pipeline and Founder Inbox projections |
| WP1.6 | Beta launch campaign model and source brief |
| WP1.7 | LinkedIn, Substack, email, webinar, and landing-page artifacts |
| WP1.8 | Claims, consent, and platform-draft gates |
| WP1.9 | Funnel, campaign attribution, founder-time dashboards |
| WP1.10 | Evaluation, shadow mode, and production activation |

# 15. Deployment gates

Phase 1 live activation requires:

- Approved offer, capability, claim, audience, narrative, channel, CTA, and voice records
- Application intake idempotency
- Claims verification on founder-edited content
- External send/autopublish disabled
- Funnel and campaign events reconciling
- Prompt-injection fixtures passing
- Notion conflict and reconciliation tests passing

# 16. Definition of done

- Every active opportunity has a canonical stage and next action.
- Enrollment and launch artifacts are versioned and projected.
- Founder approvals can originate in Notion but execute canonically.
- Beta launch communications are linked to evidence and campaign records.
- Applications, calls, offers, and enrollments can be attributed with explicit confidence.
- No unsupported claim, autonomous send, or autonomous publish is possible.
- Founder time and agent quality are measurable.

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

    > Implement Phase 1 - Enrollment Revenue and Beta Launch Communications according to this specification.
    >
    > Begin by verifying that revised Phase 0 is operational: canonical records, generic artifacts, approvals, workspace commands, projection policies, evidence, claims, consent, event audit, feature flags, and the Notion provider adapter.
    >
    > Produce an architecture decision record and a repository-to-requirement implementation map before migrations. Reuse Phase 0 services rather than creating parallel document, approval, consent, or workspace systems.
    >
    > Maintain a live traceability matrix linking every requirement to implementation files, migrations, automated tests, feature flags, and operational metrics.
    >
    > Preserve these phase-specific non-negotiable rules:
    >
    > 1. Opportunity lifecycle, consent, claims, attribution, and approval remain canonical.
> 2. Notion edits create versioned artifacts and validated commands; they do not directly change opportunity state.
> 3. Launch content begins with an approved source brief and uses only approved claims and capabilities.
> 4. Agents may create provider drafts but may not send or publish.
> 5. Every requirement must have linked tests and a phase feature flag.
    >
    > Implement work packages in dependency order. Activate each agent in shadow mode before founder-review mode. Treat Notion as a projection and controlled working surface, not as the source of canonical lifecycle, consent, claim, test, pricing, or deployment state.
