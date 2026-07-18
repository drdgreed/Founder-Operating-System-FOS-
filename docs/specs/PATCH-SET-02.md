# Canonical Patch Set 02 — Artifact Event Taxonomy & Draft-Editable Immutability

**Status:** AUTHORITATIVE. Supersedes the cited sections. Where this conflicts with an original section, this wins.
**Date:** 2026-07-16 · **Provenance:** Slice 0.1b adversarial verification (Verifier B ruled the §9.7 artifact-event set incomplete for the §12.2 machine; owner decisions: **granular** event taxonomy + **in-place draft editing**).
**Depends on:** PATCH-SET-01 (§E2 status carrier, §E4 artifact_type enum, §S1 event registry, §S3 content_hash).

---

## A — Granular artifact event taxonomy (supersedes §9.7's artifact-event list)

§9.7 named only `artifact.created`, `artifact.version_created`, `artifact.approval_requested`, `artifact.approved`, `artifact.rejected` — insufficient to cover the 14-edge §12.2 machine. The canonical artifact event set is now, **one named event per lifecycle transition** (workflow-semantic naming, extending §9.7's style):

| Event `type` | Emitted on |
|---|---|
| `artifact.created` | ArtifactRecord + v1 created |
| `artifact.version_created` | a revision creates a new version |
| `artifact.draft_edited` | in-place content edit of a `draft` version (§B) |
| `artifact.approval_requested` | `draft → in_review` |
| `artifact.approved` | `in_review → approved` |
| `artifact.approved_with_edits` | `in_review → approved_with_edits` |
| `artifact.rejected` | `in_review → rejected` |
| `artifact.deferred` | `in_review → deferred` |
| `artifact.revision_requested` | `in_review → draft` (re-open) |
| `artifact.marked_ready` | `approved`/`approved_with_edits → ready_for_action` |
| `artifact.executed` | `ready_for_action → executed` |
| `artifact.failed` | `ready_for_action → failed` |
| `artifact.superseded` | any `{draft, approved, approved_with_edits, ready_for_action} → superseded` |

**Rule:** the transition service emits exactly the event above for each legal §12.2 edge (no generic `artifact.status_changed`). The full (from→to)→event map is derivable from this table; the 14 legal edges each map to exactly one event.

## B — Draft-editable / status-gated immutability (supersedes the always-immutable reading; aligns with §9.13 literal)

§9.13: "Approved or executed versions are immutable" + carries `immutable_at`. Ruling: content is **mutable while the version is in `draft`**, and **locks the moment it leaves `draft`**.
- **In-place edit** of a `draft` version's `body_markdown` is permitted; `content_hash` is recomputed (§S3) and an `artifact.draft_edited` event is emitted `{ artifactId, versionId, previousContentHash, contentHash }`.
- On a transition **out of `draft`** (`draft → in_review` / `draft → superseded`), set `immutable_at = now()` (content locks). On a revision-request **re-open** (`in_review → draft`), the version becomes editable again, so **clear `immutable_at = null`**. Invariant: `immutable_at` is non-null **iff** the version's content is currently locked (`approval_status <> 'draft'`).
- The DB content-immutability trigger becomes **status-gated**: it RAISES on a change to `body_markdown`/`content_hash` only when the row's existing `approval_status <> 'draft'`. `approval_status`/`updated_at`/`immutable_at` remain mutable so lifecycle transitions work.
- Post-approval content changes still go through **revision → new version** (§12.2), never mutation.

## C — S1 payload registry for artifact events (fulfills §S1 for these types)

§S1 mandates a per-`type` Zod payload schema in `@fos/contracts`. Register the artifact event payloads there and validate each event's `payload` against its type's schema on the write path:
- `artifact.created`: `{ artifactId, versionId, artifactType }`
- `artifact.version_created`: `{ artifactId, versionId, versionNumber }`
- `artifact.draft_edited`: `{ artifactId, versionId, previousContentHash, contentHash }`
- all lifecycle transition events (approval_requested … superseded): `{ artifactId, versionId, fromStatus, toStatus }`

Add a small registry (map: event `type` → Zod payload schema) + a validator the event writer (or artifact service) calls; unregistered artifact event types are rejected at write time. (Event types outside the artifact domain remain governed by their own slices; this patch registers the artifact set only.)

## D — Ratify `updated_at` on §9.13 ArtifactVersion (closes #9)

§9.13's field list names only `created_at`; the 0.1b implementation also carries `updated_at`, required by §B's mutable-status/`immutable_at` design (a lifecycle transition mutates `approval_status`/`immutable_at` on an existing row, which needs a mutation timestamp distinct from the immutable `created_at`). This is not a new convention: every other §9 entity already lists `updated_at` alongside `created_at`. Ratified: §9.13's field list is amended to add `updated_at` (non-nullable, defaults to now, updated on every write), consistent with the rest of §9.

---

## Not changed
§12.2 transition matrix (14 legal / 86 illegal — unchanged), §E2 status-carrier model, §E4 artifact_type enum, §S3 hashing. Terminal states `rejected`/`deferred` remain terminal (no re-open) per §12.2 as written.
