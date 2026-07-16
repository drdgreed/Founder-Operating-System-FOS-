# FOS — Build-Readiness Review & Autonomous Loop Plan

**Date:** 2026-07-16
**Author:** Staff-eng review (Claude Opus 4.8), produced via 3 Fable-5 reviewers → 2 fresh-context Opus adversarial verifiers.
**Scope:** Canonical set = `FOS_Revised_Implementation_Set_Phases_0-6/`. Master `FOS_Complete_Specification_Set.md` treated as superseded.

---

## 0. Verdict (answer to "say so if you have no further edits")

**I have edits.** The specs are unusually strong on *behavior* (entities, state machines, API/job inventories, test matrices, work packages with acceptance criteria). They are **not build-ready for an unattended loop as-is**, for two reasons, both cheap to fix and both spec-only (no code):

1. **~12 verified internal-consistency defects** (2 blocker-class) that would force a coding agent to invent conventions — which this shop's rules define as a failure.
2. A **standalone-vs-host-repo decision** that flips a whole class of "reuse the existing X" clauses from *specified* into *decisions you must make* (the Greenfield Decision Pack).

**Sequencing:** Decision Pack + spec patches (human-gated) → *then* the build loop writes code. Do not point the loop at the phase specs until §2 and §3 are closed.

---

## 1. How this review was produced (and why the method is itself the portfolio artifact)

- **3 Fable-5 reviewers** (makers), one each for: cross-set consistency, internal-contract consistency, implementation-readiness. ~57 raw findings, all cited.
- **2 Opus verifiers** (fresh context, refute-first, told to default to REFUTED). They opened every cited line and graded each finding CONFIRMED / REFUTED / PARTIAL, then ran a false-negative sweep.
- **Result:** the adversarial pass refuted or downgraded ~half the maker findings and surfaced 2 misses. Measured elsewhere: fresh-context verifiers catch ~73% of seeded issues vs 7–33% for self-critique. This maker→adversarial-grader loop is the same structure that gates every code slice below.

---

## 2. Spec defects to PATCH BEFORE any code (verified; spec-only edits)

File key: **P0** = `FOS_Revised_Implementation_Set_Phases_0-6/Phase_0_Reference/FOS_Phase_0_Founder_Workspace_and_Operating_Foundation.md` · **DEP** = `.../Revised_Phases_1-6/00_FOS_Next_Dependencies_and_Refactoring_Plan.md` · **P1..P6** = `.../Revised_Phases_1-6/0N_...md`

### BLOCKERS (both verifiers CONFIRMED; B0 added from David's multi-product constraint)

| ID | Location | Defect | Fix |
|---|---|---|---|
| **B0** (multi-product, ADR-09) | cross-cutting — P0 §9/§10 | Specs are implicitly **single-product**; David runs a portfolio of **peer products with sub-offerings coming**. No `Product` entity, no scoping, no hierarchy. Retrofitting post-data = migration nightmare. | Add a **self-referential `Product`** entity (`parent_product_id` nullable, `product_type` product\|sub_offering) to P0 §9 + a single `product_id` FK on product-scoped entities (`Offer`/`Program`/`Cohort`, `EnrollmentOpportunity`, `Campaign`, `AudienceSegment`, `ProductCapability`, `ProductClaim`, `ContentAsset`, `ProductSignal`); nullable `product_id` on the event envelope. Founder-level entities (`Person`, evidence, voice, decisions, operating reviews) stay unscoped. Ship tree+scoping from commit 1; defer recursive rollups + product-management UI. |
| **B1** (IN-02 / RD-04) | P0 §9.4 L923, §10.7 L1524; P1 §6.2 L177; §14.6 L2159; DEP L132 | `offer_id` is a foreign key and pricing-validation is a mandatory approval gate, but **no `Offer`/`Program`/`Cohort`/`Price` entity is defined in any phase.** Dangling FK + ungateable gate. | Add a canonical `Offer` (+ minimal `Program`/`Cohort`) entity to P0 §9 with price, currency, availability window, approval fields. Reference it from `EnrollmentOpportunity`, `Campaign`, and the pricing gates. |
| **B2** (IN-01) | P0 §10.7 L1514–1532 vs P1 §6.2 L174–181 | **`Campaign` is defined twice with incompatible schemas** (`offer_code` string + `channel_plan_json` vs `offer_id` FK + `channel_ids` + `budget_cents`), violating P0 §3.3 cond. 13 ("Phase 1 adds no new comms-config foundations"). | Make P0 §10.7 the single canonical `Campaign`. Rewrite P1 §6.2 as an additive delta only. Pick `offer_id` (see B1) and one channel representation. |

### PROJECTION-CONTRACT DEFECTS (break the Notion adapter on day one; CONFIRMED)

| ID | Location | Defect | Fix |
|---|---|---|---|
| **C1** (IN-06) | P1 L511–512 vs P0 §13 (L1907…) | Shared contract requires hidden props `FOS Workspace ID` + `Projection Status`; P0 templates use neither — they use `Sync Status` + entity-specific IDs. Templates fail the contract immediately. | Reconcile to ONE hidden-prop set: add `FOS Workspace ID`, pick `Sync Status` **or** `Projection Status`, standardize a single `FOS Record ID`. Update P0 §13 + the P1–P6 shared block. |
| **C2** (IN-11) | P1 L517 vs P0 §9.12 L1162–1178 | Conflict rule compares `FOS Version` to "current canonical version," but `ArtifactRecord` (the most-edited projected entity) has no `version` field — only `current_version_id`. | State explicitly: `FOS Version` = `ArtifactVersion.version_number` of `current_version_id`; define the rule per entity type. |
| **C3** (IN-05) | P0 §8.2 L776–784 vs §9.12/§9.13 | The canonical projection-policy *example* names fields (`current_body`, `approval_status`, `claims_manifest`) that live on `ArtifactVersion`, not on the `ArtifactRecord` it's keyed to. The reference for the core governance mechanism is wrong. | Rewrite the §8.2 example with real field names; state that artifact policies span record + current-version fields. |

### UNDEFINED-ENTITY PROJECTIONS (P0 projects/commands entities it never models; CONFIRMED)

| ID | Location | Defect | Fix |
|---|---|---|---|
| **D1** (IN-08 + NEW-1) | P0 §13.6 L2007, §13.8 L2044, §11.5 L1685 | P0 builds projections **and a `register_product_signal` command** for `ProductSignal` / `OperatingReview`, but those entities are first defined in P3/P6. P0 success cond. 2 ("every projected page has a canonical FOS ID") is unsatisfiable for them. | Add minimal canonical `ProductSignal` + `OperatingReview` to P0 §9 (or declare them `ArtifactRecord` subtypes); P3/P6 extend rather than introduce. |
| **D2** (IN-07) | P1 §6.3 L188 vs P4 L96 | `CampaignTouch.content_asset_id` FKs `ContentAsset`, defined two phases later (P4). P1 can't create the column. | Move a minimal `ContentAsset` to P0/P1, **or** change the FK to `artifact_record_id` and let P4 layer `ContentAsset` on top. |

### STATE-MACHINE & ENUM DRIFT (CONFIRMED)

| ID | Location | Defect | Fix |
|---|---|---|---|
| **E1** (IN-10) | P0 §11.5 L1665–1666 vs §12.3 L1829–1851 | `WorkspaceCommand` has two status fields (`validation_status`, `execution_status`); the state machine is one linear set incl. `queued`/`conflict`. Idempotent-retry logic depends on which field holds what. | Collapse to one `status` field matching §12.3, or partition the machine and declare where `conflict`/`queued` live. |
| **E2** (NEW-2) | P0 §12.2 L1803–1823 vs §9.12 L1167 / §9.13 L1216 / §9.14 L1246 | Artifact lifecycle states are split across `ArtifactRecord.status`, `ArtifactVersion.approval_status`, and the `Approval.status` enum with no mapping. (Same class as E1; reviewer missed it.) | Declare one authoritative status carrier per state; document the mapping. |
| **E3** (IN-03) | P0 §11.5 L1677–1688 vs DEP §3.2 L80–91 | 5 command-type names differ (`approve_artifact_with_edits`↔`approve_with_edits`, etc.); 3 DEP commands absent from P0. | Adopt P0 §11.5 as the canonical enum; fix DEP; mark `run_test_suite`/`create_issue`/`record_publication` as P3/P4 extensions. |
| **E4** (IN-12) | P0 §9.12 L1183–1188 vs P1 L219–220, P2 L149 | Same artifact concepts, different enum strings (`call_brief`↔`call_preparation_brief`, etc.). Forks artifact history on migration. | Publish one canonical artifact-type enum in P0 + a crosswalk; make all phases use those keys. |
| **E5** (IN-13) | P0 §22 L3024–3045 vs DEP §7 L171–206 | Gate identifiers A–D reused for disjoint gate sets. "Gate C passed" is ambiguous. | Rename one set (e.g. P0 rollout → R-A…R-D; DEP cross-phase → G1–G6). |
| **F1** (IN-04) | P0 §9.15 L1256 vs §11.7 L1710 | Two near-duplicate founder-edit entities (`FounderEdit` vs `FounderWorkspaceEdit`); §14.5 only writes the latter. *Caveat: could be an intended provider-capture→canonical-audit pipeline — the spec just never says so.* | Merge into one (keep `FounderWorkspaceEdit` with nullable provider fields) **or** explicitly declare the two-stage relationship. |

### MISSING MACHINE-READABLE SCHEMAS (CONFIRMED; these are what let a verifier grade code)

| ID | Location | Defect | Fix |
|---|---|---|---|
| **S1** (RD-06) | P0 §9.7 L1007–1068 | 34 event types, one generic `payload_json`, no per-event schema. | Author an event-schema registry (JSON Schema/Zod per type + common envelope: id, workspace_id, correlation_id, causation_id, occurred_at, actor). DEP §8 item 8 already asks for this — make it machine-readable. |
| **S2** (RD-07) | P0 §9 throughout | Gating fields lack value sets: `risk_level`, `verification_status`, `permitted_use`, `privacy_classification`, `priority`, `max_autonomy_level`, `domain`, etc. | One "conventions addendum" enumerating every open enum; wire `max_autonomy_level` to the design system's L1–L4. |
| **S3** (RD-08) | P0 §11.4/§11.5/§9.15 | No derivation rule for `idempotency_key`, `content_hash`, `diff_json`, `edit_distance`, `edit_categories` — yet dedup tests depend on them. | Define all: e.g. `idempotency_key = SHA-256(integration_id, provider_event_id, command_type)`; `content_hash = SHA-256(normalized markdown)`; token-level Levenshtein; seed an edit-category taxonomy. |
| **S4** (RD-18-half) | P0 §9.3/§9.5 | `*_asset_id` fields reference an `Asset` entity that is never defined. (Blob *store* is correctly deferred to host; the *entity* is the gap.) | Add an `Asset` entity (id, storage_ref, mime, sensitivity, hash) or mark `*_asset_id` nullable-deferred to Phase 1. |

### DOC HYGIENE (CONFIRMED)

| ID | Location | Fix |
|---|---|---|
| **H1** (CX-01) | MASTER lines 9, 2947, 6874, 10858 | Superseded sub-docs still self-label "Status: Implementation specification," same date as canonical. Add SUPERSEDED banners (and a `.gitignore`/`ARCHIVE/` move) so neither a human nor the loop ever treats MASTER as current. This is what makes the otherwise-harmless stale content (below) safe. |

---

## 3. Greenfield Decision Pack (only needed because you chose STANDALONE)

> These are the "use the repository's existing X" clauses. In a host repo they're *reuse*; standalone, they're **decisions**. Each becomes one ADR, approved by David, before the loop runs. Verifier A confirmed these are the genuine open choices (it *refuted* treating them as spec bugs).

| ADR | Decision | Recommended default |
|---|---|---|
| ADR-01 | **Auth / identity** (P0 §7 four roles) | Single founder account + scoped service-account API keys for agent + workspace-integration. No multi-tenant auth. |
| ADR-02 | **Stack forks** (P0 §5.3: Prisma/Drizzle, Vitest/Jest, DB/Redis queue, CI) | Drizzle + Vitest + Postgres-backed queue (pg-boss-style) + GitHub Actions (migrate+test on PR). One datastore. |
| ADR-03 | **Deploy target** (P0 §16 needs a persistent worker; §22 names none) | Railway or Fly (long-running worker process), not serverless-only. |
| ADR-04 | **Secret store** (P0 §17.2/§19) | Host-platform env vars + `credential_reference` naming convention. |
| ADR-05 | **Notion auth mode** (P0 §14.1 vs §19; RD-02 = mild underspec, not contradiction) | Confirm OAuth vs internal-integration token for a single solo workspace (internal token is far simpler). |
| ADR-06 | **Notion capability spike** (RD-03 — mechanism *is* specified as webhook-driven; the open item is Notion's real limits) | 1-day spike BEFORE the adapter slice: verify webhook event coverage, payload contents ("fetch latest" is mandatory — Notion webhooks don't carry content), signature verification, button automation, rate limits. Write findings into the adapter ADR with a polling fallback. |
| ADR-07 | **Model gateway + budgets** (RD-22) | Anthropic direct; per-agent max tokens/run + max cost/day enforced by the runtime. (Phase 0 needs no LLM — can wait for Phase 1.) |
| ADR-08 | **Content seeds** (RD-12 — business facts only David can author) | `seeds/` intake checklist (audience, claims, capabilities, evidence, CTAs, the offer). Empty seeds block Phase 1 activation, not Phase 0 code. |

**Note:** if you ever decide FOS lives inside an existing repo instead, ADR-01/02/03/04 collapse to "inherit host" and the stack decision must match that host. Confirm standalone before the loop starts.

### Refuted / downgraded (transparency — what the adversarial pass killed so you don't chase it)
- **RD-01 (auth "missing")** — REFUTED. Authorization *is* specified (P0 §7.5, 10 checks); auth is deliberately delegated.
- **RD-03 (capture "unspecified")** — REFUTED. Webhook-driven capture is specified; only Notion's exact event strings are impl-detail.
- **RD-16 (secret store "missing")** — REFUTED. Specified as host reuse.
- **RD-05 (claims check "unsatisfiable")** — PARTIAL/overstated. Rule 10 does not bar an agent from claim *extraction*; deterministic matching against `prohibited_language` is a viable path. Real (smaller) gap: no defined derivation of `claims_manifest_json` from founder-edited prose → make extraction an explicit advisory agent step that gates approval.
- **CX-02/03/06/10 (master "contradicts" canonical)** — downgraded to **STALE-by-design**. Canonical announces each reversal by name; the only live risk is H1 (mislabeling). Fix H1 and these become harmless.
- **IN-09 (`enrollment.*` events)** — REFUTED. DEP §3.5 explicitly allows additive phase events; coexistence is by design.

---

## 4. The autonomous build loop (six parts)

**Model routing (barbell):** decide on Opus `xhigh` (the Decision Pack + slice design, human-gated) → implement on **Sonnet `medium`** → **two fresh-context Opus verifiers** (`low`–`medium`) → human merge gate. Top tier appears exactly twice: deciding what to build, deciding whether it was built.

1. **Trigger** — watched `/loop` (self-paced) for cycles 1–3; then promote the standing instruction to a `/schedule` nightly Routine. Watching first is how the loop *earns* autonomy.
2. **Rules load (each cycle)** — read `CLAUDE.md`, the approved ADRs, the FOS conventions addendum, the *single* canonical spec section for the current slice, and `memory/INDEX.md`. Run `quarantine_scan.py` on the lessons dir first. **Never read MASTER.**
3. **Executor — ONE bounded slice/cycle** — a Sonnet coding subagent implements the next slice from the backlog (§5) in an isolated worktree. Target ≤~200-line diffs; split if larger. Never "make progress."
4. **The two adversarial verifiers** — after the coding subagent emits a **diff + test output + migrate up/down logs** (artifacts, never its own summary), two fresh-context Opus verifiers independently grade against the slice's checkable done-condition:
   - **V1 — contract/correctness lens:** runs the tests, reads the diff, checks every acceptance criterion + the spec contract for that slice.
   - **V2 — adversarial/regression lens:** tries to break it — missing edge cases, silent failures, **invented conventions** (the CLAUDE.md failure mode), scope creep beyond the slice, and any **weakened/deleted test** (hard stop).
   Both must pass. Their reports attach to the PR.
5. **Memory write** — append a lesson with a **provenance line** (cycle #, slice ID, the evidence). Write lessons **only** from claims both verifiers confirmed.
6. **Stop check (four exits, priority order):**
   - **Success:** done-condition met AND both verifiers pass AND PR opened (never merged).
   - **Retry ceiling:** same slice failing **3×** → stop, open an issue with state.
   - **Verifier-disagreement ceiling:** **3 consecutive** maker-vs-verifier *or* verifier-vs-verifier disagreements → **pause + escalate** with both sides' evidence. (Catches the *confidently wrong* loop, not just the stuck one.)
   - **Budget ceiling:** per-CYCLE token budget → park cleanly.

**Boundary / blast radius:** work only in worktree `[abs path]` on branch `fos-build/<slice>`; PR-per-slice, **never merge, never push main, never --force, never deploy/spend/delete**, never touch files outside the repo. **Kill method:** interrupt the `/loop` session (cycles 1–3); `/schedule` disable for the Routine.

### Standing-instruction (paste into the agent once ADRs + patches land)
```
Goal: implement FOS build slice <ID> to its checkable done-condition; PR opened, both verifier reports attached, NOT merged.
Boundary: work ONLY in worktree <abs path> on branch fos-build/<ID>; never merge/push main/--force/deploy/spend/delete; never touch files outside the repo; never read FOS_Complete_Specification_Set.md (superseded).
Each cycle: (1) read CLAUDE.md + approved ADRs + conventions addendum + the ONE canonical spec section for this slice + memory/INDEX.md; run quarantine_scan on lessons first. (2) implement ONE bounded slice (≤~200-line diff; split if larger). (3) emit diff + test output + migrate up/down logs; TWO fresh-context verifiers grade the artifacts (V1 contract/correctness, V2 adversarial/regression) against the done-condition. (4) append a lesson WITH provenance (cycle + evidence) ONLY from doubly-confirmed claims. (5) stop check: success / same slice 3x (open issue) / 3 consecutive disagreements (pause + escalate both sides) / cycle budget spent.
End: AGENT DONE (what changed / where — abs paths / what was checked — paste the passing line / PR link) or AGENT BLOCKED (the one specific question).
```

---

## 5. Sequencing & first slices

**Pre-loop (human-gated, not the loop):**
- **G0.** Confirm standalone. Draft & approve the 8 ADRs (§3). Apply the §2 spec patches (I can draft these as a PR; verifiers check; you merge). Fix H1 (archive MASTER).

**Loop, watched (cycles 1–3):**
- **Slice 0.1a — "canonical spine, no Notion":** migrations for `Product`/`FOSWorkspace`/`Person`/`EnrollmentOpportunity`/`ApplicationSubmission`/`OperationalEvent` (§9.1–9.7 + B0) — `EnrollmentOpportunity` carries `product_id` — + append-only event writer w/ correlation/causation (+ nullable `product_id` on envelope) + DB guard blocking UPDATE/DELETE on events + opportunity transition service (§12.1) + intake/transition endpoints with optimistic `version`.
  **Done-condition (mechanically gradeable):** (1) `migrate up`/`down` clean on empty Postgres; (2) intake creates Person+Opportunity+3 events sharing one correlation_id; duplicate intake (same idempotency key) creates nothing; (3) every legal §12.1 edge emits `opportunity.stage_changed`, **every illegal edge** returns 4xx + emits nothing (100% transition-matrix coverage, both directions); (4) stale-version transition rejected; (5) direct UPDATE/DELETE on `operational_event` fails at the DB layer; (6) all tests green, tagged `FOS0-CORE-*`.
  *Touches zero unresolved gaps — no Notion, no LLM, no claims, no pricing. Its verifier rubric is fully derivable from §9.7 + §12.1 + §20.1.*
- **Slice 0.1b:** `ArtifactRecord` + `ArtifactVersion` + immutability (§12.2), post-patch (B1/C2/C3/E2/E4/S3).
- **Slice 0.1c:** `Approval` service + `WorkspaceCommand` (post E1/E3/S2).
- **Slice 0.2 (gated on ADR-06 spike):** the Notion adapter — projections + reconciliation.

**Promote to nightly Routine** only after cycles 1–3 pass clean.

---

## Checkpoint
- **Weakest points:** (1) **F1** (duplicate founder-edit entity) and **IN-17** (shared `specification_critic` agent key) hinge on *intent the spec never states* — could be deliberate two-stage/versioning; treat as "spec must declare," not necessarily "bug." (2) **CX-10** resolves to STALE *only under the authority rule* — if any canonical phase (esp. P4) actually references the MCOM-only `AudienceSegment` fields, it escalates to a live within-canonical contradiction; not exhaustively field-audited across P4.
- **Unverified:** current Notion webhook/button/rate-limit capabilities (ADR-06 spike, not yet run); that P0 §9/§10 is the *complete* entity registry (header-grep supports it, but a hidden addendum defining `Offer`/`ProductSignal` would weaken B1/D1).
- **Load-bearing assumption:** **standalone, not host-repo.** This is what turns the "existing X" clauses into ADRs and keeps the TS/Next.js + Python-evals stack valid. If FOS is meant to live inside an existing app, §3 changes shape and the stack must match the host. **Confirm before G0.**
- **Needs human decision (not verification):** the 8 ADRs are business/infra choices only David can make; the content seeds (ADR-08) are facts only David can author.
