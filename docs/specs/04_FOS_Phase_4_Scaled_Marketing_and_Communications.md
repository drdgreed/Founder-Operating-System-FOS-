# Founder Operating System

## Phase 4 - Scaled Marketing and Communications Operations
### Complete Technical Specification and Implementation Plan

| Document control | Value |
|---|---|
| Document ID | `FOS-TECH-PHASE-4` |
| Version | 3.0 |
| Status | Revised implementation specification |
| Replaces | The earlier Evidence-Based Marketing and Demand Engine and separate Marketing and Communications specification |
| Depends on | Revised Phase 0 - Founder Workspace and Operating Foundation |
| Product owner | Founder |
| Primary audience | Coding agents, founder, product architect, implementation reviewers |
| Current business stage | Beta enrollment and early beta operation |
| Updated | 2026-07-13 |

> This specification is written against the revised Phase 0 canonical-state, generic-artifact, controlled-command, and Founder Workspace Adapter contracts. Any implementation based on the earlier native-admin assumptions must be refactored as identified in the dependency plan.

---

# 0. Revision decision

Phase 4 is no longer the beginning of marketing. It is the scale and optimization phase built on:

- Phase 0 audience, narrative, channel, CTA, voice, claims, and workspace foundations
- Phase 1 launch campaign and enrollment attribution
- Phase 2 recurring founder editorial cadence and beta learning
- Phase 3 verified releases and customer proof

Phase 4 adds campaign orchestration, multi-channel repurposing, content operations, distribution drafts, performance attribution, experimentation, and founder-voice learning.

# 1. Implementation directive

Build an evidence-led communications operating system that plans, produces, reviews, distributes as drafts, measures, and improves LinkedIn, Substack, email, webinar, website, release, and case-study communications.

# 2. Objectives and metrics

- Increase qualified applications and enrollments attributable or assistable by communications.
- Reduce founder production time per approved asset.
- Reuse approved source evidence across channels without changing factual meaning.
- Maintain consistent founder voice and product positioning.
- Identify content that attracts the wrong audience or creates unsupported expectations.

Metrics:

- Qualified leads and enrollments by source/campaign
- Content-assisted conversion
- Source-brief reuse ratio
- Draft approval/edit/rejection rates
- Founder minutes per asset
- Subscriber and audience growth
- CTA conversion
- Campaign velocity and asset throughput
- Unsupported-claim and consent blocks
- Attribution confidence

# 3. Scope

Included:

- Marketing source briefs
- Positioning maps
- Campaign orchestration
- LinkedIn post and carousel systems
- Substack paper/newsletter systems
- Email sequences
- Landing pages and webinar packages
- Case studies and release communications
- Repurposing plans
- Editorial calendar
- Platform draft adapters
- Publication records
- Performance ingestion and attribution
- Founder voice learning
- A/B or message experiments where data supports them

Excluded:

- Autonomous publication or comment engagement
- Paid media purchasing
- Fabricated attribution
- Unapproved competitive claims
- Automatic pricing changes

# 4. Domain model

## ContentSourceBrief

Stores source entities, evidence, claims, audience, problem, insight, proof, implication, prohibited angles, and approval.

## PositioningMap

Stores audience, pain, transformation, objection, differentiator, buying stage, channel, CTA, confidence, and founder choice.

## ContentAsset

A specialized reference to `ArtifactRecord` with channel, asset type, source brief, campaign, audience, claims/evidence/consent manifests, status, planned/published timestamps, and publication references.

## Campaign

Extends Phase 1 campaign records with channel plan, asset dependencies, sequence, experiment, target metrics, and budget where applicable.

## PublicationRecord

Stores platform, external ID/URL, final artifact version, published time, publisher, and content hash.

## ContentPerformance

Stores dated impressions, engagements, clicks, subscribers, applications, qualified leads, calls, enrollments, revenue, attribution method, and confidence.

## FounderVoicePreference

Stores proposed preference, edit evidence, confidence, status, and founder approval. Preferences may not be promoted solely by an agent.

## ContentExperiment

Stores hypothesis, variants, audience, channel, primary metric, guardrails, start/end, allocation, result, and confidence.

# 5. Notion workspace

## Communications Calendar

Master view of campaign, asset, audience, channel, status, evidence, claims, consent, planned publication, CTA, publication link, and performance.

## LinkedIn Pipeline

Views by post type, pillar, campaign, draft/review/published, carousel, and performance.

## Substack Papers

Research brief, thesis, evidence matrix, outline, draft, technical review, claims review, founder review, derivatives, and performance.

## Campaign Center

Sequences, dependencies, launch windows, target metrics, and attribution.

## Founder Voice Review

Proposed voice preferences with supporting edit examples and approve/reject controls.

# 6. Agents

- `fos.product_evidence_miner`
- `fos.positioning_mapper`
- `fos.campaign_planner`
- `fos.linkedin_drafting`
- `fos.linkedin_carousel`
- `fos.substack_essay`
- `fos.email_sequence`
- `fos.webinar_package`
- `fos.landing_page_copy`
- `fos.content_repurposer`
- `fos.marketing_claims_verifier`
- `fos.founder_voice_evaluator`
- `fos.performance_interpreter`

The Performance Interpreter must distinguish observation, correlation, and causal inference.

# 7. Workflows

## Source to campaign

Approved evidence -> source brief -> positioning alternatives -> founder choice -> campaign plan -> asset dependency graph -> generation and review.

## Long-form to derivatives

Approved Substack paper -> launch post -> technical summary -> carousel -> short follow-ups -> email excerpt -> webinar segment. Each derivative receives independent claims and consent validation.

## Founder editing and approval

Notion edit -> new artifact version -> edit diff -> revalidate claims/consent -> canonical approval -> optional platform draft.

## Publication and attribution

Founder publishes -> publication record -> performance ingestion -> touch attribution -> campaign review -> approved learning records.

## Voice learning

Compare generated and final versions, classify edits, propose preferences, require founder approval, and test against future drafts.

# 8. APIs and jobs

API families:

- `/api/fos/content-source-briefs/*`
- `/api/fos/positioning-maps/*`
- `/api/fos/content-assets/*`
- `/api/fos/campaigns/*`
- `/api/fos/publications/*`
- `/api/fos/content-performance/*`
- `/api/fos/founder-voice/*`
- `/api/fos/content-experiments/*`

Jobs:

- `mine-marketing-evidence`
- `generate-positioning-options`
- `generate-campaign-plan`
- `generate-content-asset`
- `generate-channel-derivatives`
- `verify-marketing-claims`
- `verify-content-consent`
- `create-platform-draft`
- `import-content-performance`
- `attribute-content-outcomes`
- `evaluate-founder-voice`
- `generate-campaign-review`

# 9. Deterministic safeguards

- No content without a source brief, except explicitly labeled founder opinion drafts.
- Factual product claims resolve to approved claims/evidence.
- Customer outcomes resolve to consent.
- Pricing comes from current approved offer records.
- Derivatives may not introduce new claims absent from the source.
- Expired or invalidated claims block approval or publication-ready state.
- Anonymous stories undergo re-identification risk review.
- Platform adapters create drafts, not publication actions.
- Attribution exposes method and confidence.

# 10. Tests

Fixtures cover release-to-build-log, named consent, anonymous consent, no consent, unsupported quantitative claim, planned feature, derivative adding a claim, generic influencer language, founder tone edits, and conflicting pricing.

End-to-end tests cover approved evidence to LinkedIn/Substack campaign, consent revocation, founder edit revalidation, publication record, performance ingestion, and content-assisted enrollment.

# 11. Work packages

| Package | Deliverable |
|---|---|
| WP4.0 | Phase 1-3 source and attribution migration |
| WP4.1 | Source brief and evidence eligibility |
| WP4.2 | Positioning and campaign planning |
| WP4.3 | LinkedIn production and carousel workflow |
| WP4.4 | Substack research and publishing workflow |
| WP4.5 | Email, webinar, landing page, and release packages |
| WP4.6 | Multi-channel repurposing |
| WP4.7 | Claims, consent, and pricing verification |
| WP4.8 | Platform draft adapters and publication records |
| WP4.9 | Performance ingestion and attribution |
| WP4.10 | Founder voice learning and experiments |
| WP4.11 | Communications Calendar and Campaign Center |

# 12. Definition of done

- Marketing operates from verified sources and approved strategy.
- LinkedIn, Substack, email, webinar, and website artifacts share canonical evidence and attribution.
- Founder can edit and approve in Notion.
- Platform actions stop at draft creation unless explicitly changed later.
- Performance and founder time are measurable.
- Voice learning remains founder-approved.

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

    > Implement Phase 4 - Scaled Marketing and Communications Operations according to this specification.
    >
    > Begin by verifying that revised Phase 0 is operational: canonical records, generic artifacts, approvals, workspace commands, projection policies, evidence, claims, consent, event audit, feature flags, and the Notion provider adapter.
    >
    > Produce an architecture decision record and a repository-to-requirement implementation map before migrations. Reuse Phase 0 services rather than creating parallel document, approval, consent, or workspace systems.
    >
    > Maintain a live traceability matrix linking every requirement to implementation files, migrations, automated tests, feature flags, and operational metrics.
    >
    > Preserve these phase-specific non-negotiable rules:
    >
    > 1. Marketing begins from approved evidence, strategy, or clearly labeled founder opinion.
> 2. Every derivative is independently checked for claims, consent, pricing, and product availability.
> 3. Notion is the editorial workspace; canonical artifact versions, approvals, publication records, and attribution remain in FOS.
> 4. Platform integrations create drafts only; autonomous publication and engagement remain disabled.
> 5. Attribution must expose method, confidence, and uncertainty.
    >
    > Implement work packages in dependency order. Activate each agent in shadow mode before founder-review mode. Treat Notion as a projection and controlled working surface, not as the source of canonical lifecycle, consent, claim, test, pricing, or deployment state.
