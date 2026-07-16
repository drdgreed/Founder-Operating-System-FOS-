# FOS — Greenfield Decision Pack (ADRs)

**Status:** DRAFT for David's approval · **Date:** 2026-07-16 · **Context:** standalone new repo, no host app.
These close the "use the existing repository's X" clauses the specs assume. Each becomes a committed `docs/adr/000N-*.md` once the repo exists. **Nothing is built until these are approved.**

Legend: ✅ = safe default, rubber-stamp · ⚠️ = **needs your decision** · 🧾 = **needs business facts only you have**

---

## ADR-01 — Authentication & identity ✅
**Context:** P0 §7 names four roles (founder, admin, agent service account, workspace-integration service account) and §6 forbids introducing "a second auth system" — which assumed a host. Standalone, there is no first.
**Decision:** Single founder account (email + passkey/WebAuthn or a simple session — you're the only human user) + **scoped service-account API keys** for the agent runtime and the Notion integration. No multi-tenant/org auth. Authorization follows P0 §7.5's 10 checks (already specified — not a gap).
**Consequences:** Minimal surface; keys rotate independently; matches a solo-founder threat model. Revisit only if FOS ever serves a second human.

## ADR-02 — Core stack (closes P0 §5.3 forks) ✅
**Decision:**
- Language/runtime: **TypeScript / Next.js** (App Router) monorepo.
- DB + ORM: **Postgres + Drizzle** (typed migrations, SQL-first — better fit for the event store than Prisma).
- Queue: **Postgres-backed** (pg-boss-style) — one datastore, no Redis at beta volume.
- Tests: **Vitest** (unit/integration) + **Playwright** (E2E, per spec).
- Validation: **Zod** as the single source of truth for entity + event + API schemas.
- CI: **GitHub Actions** — `migrate up` + typecheck + test on every PR (this is also the loop's verifier substrate).
**Consequences:** One language for API + Console; Drizzle schemas double as the machine-readable contracts the verifiers grade against. Python appears only in the evals sidecar (ADR-07).

## ADR-03 — Deployment target ✅ ACCEPTED: Railway
**Context:** P0 §16 defines 10 background jobs with retries/dead-letter + §14.8 reconciliation → needs a **persistent worker**, so serverless-only won't do.
**Decision:** **Railway** (one control plane you already run, long-running worker process, managed Postgres).
**Consequences:** Worker runs as a separate process alongside the Next.js app; Postgres managed by the platform.

## ADR-04 — Secret management ✅
**Decision:** Host-platform env vars (Railway/Fly secrets) + a `credential_reference` naming convention in-code (never raw secrets in records, per P0 §17.2). Local dev via `.env` (git-ignored). Upgrade path to a vault later if needed.
**Consequences:** Satisfies P0 §17.2/§19 without standing up a vault at beta.

## ADR-05 — Notion authorization mode ✅ ACCEPTED: internal-integration token
**Context:** P0 §19 lists `FOS_NOTION_CLIENT_ID/SECRET/REDIRECT_URI` (public OAuth) while §14.1 says "existing secret mechanism." For a single solo workspace these are very different builds.
**Decision:** **Internal-integration token** (one workspace, one founder). Drop `FOS_NOTION_CLIENT_ID/SECRET/REDIRECT_URI` from scope; keep `FOS_NOTION_WEBHOOK_SECRET`.
**Consequences:** Simpler build; no OAuth redirect flow. Revisit only if FOS ever connects *other people's* Notion workspaces.

## ADR-06 — Notion capability spike (before the adapter slice) ✅ (process)
**Context:** The capture mechanism *is* specified (webhook → verified → `WorkspaceCommand`), but Notion's real limits are load-bearing and unverified.
**Decision:** A **1-day spike before Slice 0.2 (the adapter)**, not before Phase-0 core. Verify: webhook event coverage; that payloads carry no content (so "fetch latest" is mandatory); signature verification; button-automation → URL; rate limits. Findings → an "Integration Boundary Decision Record" with an explicit **polling fallback**.
**Consequences:** De-risks the single most uncertain external dependency before any adapter code. Phase-0 core (Slices 0.1a–c) is unaffected and can start immediately.

## ADR-07 — Model gateway, budgets & the evals sidecar ✅
**Decision:**
- Provider: **Anthropic direct** (subscription-aligned; no third-party gateway).
- Per-agent guardrails: `max_tokens_per_run` + `max_cost_per_day` enforced by the runtime (add these fields to `AgentDefinition`).
- **Evals sidecar** (`fos-evals/`, Python): fixtures as JSON (input records + expected output-schema constraints + expected gate outcomes), graded by assertions on output schema + deterministic gates; promotion threshold e.g. **≥95% gate-pass over N shadow runs, zero critical failures** before an agent goes live. Results written back to `AgentRun.evaluation_json`.
**Consequences:** Phase 0 uses **no LLM at all** (good — the riskiest parts are deterministic), so this ADR only binds from Phase 1. The sidecar is the AI-platform portfolio surface; kept strictly quarantined from the product plane.

## ADR-08 — Content seeds & the Offer model 🧾 DEFERRED (seeds) / structure approved
**Context:** Two things only you can author: (1) the business content the system reasons over; (2) the **`Offer` entity** (blocker B1) — the specs reference `offer_id`/pricing-validation everywhere but model it nowhere.
**Decision:** Seeds **deferred** — you'll fill `seeds/` later; Phase 0 proceeds without them. I build the *shape* now:
- `seeds/` directory, one JSON per registry, **partitioned by product**: audience segments, product capabilities, approved claims + evidence, CTAs, founder-voice rules, narratives.
- **`Offer` entity** (proposed schema, now product-scoped per ADR-09): `id`, **`product_id`**, `offer_key`, `name`, `program_id?`, `cohort_id?`, `price_amount`, `currency`, `billing_period`, `availability_window_start/end`, `status` (draft/approved/active/retired), `approved_by`, `approved_at`. `EnrollmentOpportunity`/`Campaign` reference `offer_id`.
**🧾 Deferred — needed before Phase-1 *activation*, NOT Phase-0 code:** your real offer(s) per product (name, price, currency, billing, availability) + first-pass audience/claims/CTAs.
**Consequences:** Empty seeds block Phase-1 activation only. The `Offer` schema (with `product_id`) unblocks spec-patch B1.

## ADR-09 — Multi-product tenancy & product hierarchy ✅ ACCEPTED (from David's "more than one product; sub-offerings soon" constraint)
**Context:** FOS is the operating system for a **founder who runs a portfolio of products** — products are **peers** under one founder tenant, and each product **may gain sub-offerings** in the near future. The canonical specs are implicitly single-product. Retrofitting a scoping dimension (or a hierarchy) after data exists = backfilling every table, query, projection, and event — a migration nightmare. Designing it in now = one self-FK + one FK per product-owned entity.
**Decision:**
- Add a first-class **`Product`** entity as a **self-referential tree**: `id`, `parent_product_id` (nullable FK → Product), `product_key`, `name`, `product_type` (`product` | `sub_offering`), `status`, `created/updated_at`. **Top-level products = peers** (`parent_product_id` NULL); **sub-offerings = products with a parent**. Flat peers today; hierarchy is free when sub-offerings land.
- **One scoping column everywhere:** product-scoped entities carry a single `product_id` FK that may point at *either* a top product or a sub-offering node — no dual columns, no schema churn when depth grows.
- **Founder-level (cross-product, NO `product_id`):** `Person`, `EvidenceItem`, founder-voice, `DecisionRecord`, `OperatingReview`, the FOS tenant. *(Confirmed: a human/proof can touch several products.)*
- **Product-scoped (`product_id` FK):** `Offer`/`Program`/`Cohort`, `EnrollmentOpportunity`, `Campaign`, `AudienceSegment`, `ProductCapability`, `ProductClaim`, `ContentAsset`, `ProductSignal`.
- `OperationalEvent` envelope gains a nullable `product_id`; Notion projections become per-product (and per-sub-offering) filterable views.
- **Build, don't over-build (YAGNI on features, not schema):** the tree + scoping ship from commit 1; **deferred** until a real sub-offering exists — recursive rollups ("aggregate a product + all its sub-offerings"), product-switching UI, per-product dashboards.
**Consequences:** Every product-scoped query/authz check filters by `product_id`; roll-up queries will need recursive-CTE traversal of the tree (deferred). Slice 0.1a gains a self-referential `Product` table + a `product_id` FK on `EnrollmentOpportunity`. Stronger portfolio artifact (models a portfolio company with nested offerings, not one app). This is **spec-patch B0**.

---

## Status of decisions
- **ADR-03:** ✅ Railway (accepted 2026-07-16)
- **ADR-05:** ✅ internal token (accepted 2026-07-16)
- **ADR-08:** 🧾 seeds deferred; `Offer` structure approved (product-scoped)
- **ADR-09:** ✅ multi-product tenancy (added 2026-07-16) — **one open item: confirm the founder-level vs product-scoped entity split**
- ADR-01/02/04/06/07: ✅ defaults; object to any, else approved.

## Repo setup (when you create it)
- **Name:** suggest `fos` or `founder-operating-system` (public). Your public handle is `drdgreed` — consistent with the rest of your surface.
- **Visibility:** public (it's the showpiece); I'll ensure no secrets/seeds-with-real-data are ever committed (`.gitignore` + `credential_reference` discipline from commit 1).
- Once it exists, I'll scaffold: monorepo skeleton, `docs/adr/` (these 8, split into files), the spec-patch PR (the ~12 defects), CI, and the loop's standing-instruction — then Slice 0.1a as the first watched loop cycle.
