# AGENT_LESSONS — FOS project-specific lessons

Read at session start. Project-specific gotchas and repo-workflow lessons for the Founder Operating System repo.
Format: `P-XXX` — one line title, then **Symptom → Cause → Rule**, then a **Provenance** line (which cycle / what evidence).
Cross-project process lessons (general git/validation discipline) live in `~/tasks/lessons.md`, not here.

---

## P-001 · Marking a maker PR "ready" ≠ the PR page says ready — edit the body's status line in the same step

**Symptom:** After the adversarial verifier gate passed on PR #57 (P1.3a) and I marked it ready (`gh pr ready` → `isDraft:false`, `MERGEABLE`) and added a fix-round comment, the founder opened the PR and saw it "still waiting for adversarial verification." The work was genuinely verified and ready; the page said otherwise.

**Cause:** Cloud makers (RemoteTrigger) open their PR with a body whose opening line reads `**DRAFT — do not merge; awaiting adversarial verification.**`. `gh pr ready` only flips the draft _flag_; adding a comment appends _below_ the body. Neither touches the author-controlled body text, which GitHub renders at the top of the page. So the stale "awaiting verification" line kept contradicting the real PR state — the body and the state had diverged, and the reader trusts the body.

**Rule:** When a maker PR clears its verifier gate, in the **same step** that marks it ready, rewrite the body's status line to the verified-ready state via `gh pr edit --body-file` (e.g. "✅ VERIFIED — ready for merge; base passed N-verifier gate, fix commit passed re-verify"). Do not rely on the draft flag + a comment. Treat the body's top line as a status field that must match the PR state, and verify it after editing (`gh pr view --json body,isDraft`). Corollary: a `gh pr checks` still showing `QUEUED/pending` is CI runner latency, not a failure — report it as pending, don't conflate it with the body-staleness issue.

**Provenance:** P1.3a / PR #57, 2026-07-20. Founder correction ("57 says it's still waiting for adversarial verification") after I marked #57 ready without editing the maker's stale body line. Verified via raw GitHub API (`gh api …/pulls/57`, `…/issues/58`) that state was ready and objects existed; root cause was the un-edited body, fixed by rewriting the opening line.

---

## P-002 · Run `npm run lint` before pushing any locally-authored commit — cloud makers format, you don't

**Symptom:** PR #59 (docs-only, this very `AGENT_LESSONS.md`) failed the CI `node` job at step `npm run lint` because the hand-written markdown didn't match Prettier style (`*flag*` vs `_flag_`). `typecheck` and `test` were reported as skipped — they run _after_ lint and never got the chance.

**Cause:** Commits authored locally (directly, not via a RemoteTrigger cloud maker) bypass the formatting pass the cloud makers run in their verify loop. Root `npm run lint` is `prettier --check .` over ALL files including markdown/JSON/config; any deviation fails the node job at the lint step, which gates typecheck and test.

**Rule:** Before pushing any commit I authored locally, run `npm run lint` (or `npm run format` to auto-fix) and confirm clean — especially for docs/markdown/config, where it's easy to forget Prettier governs them too. Do not assume "it's just a markdown file" is lint-exempt. The cloud makers already do this; the gap is only on my own hand-authored commits.

**Provenance:** PR #59, 2026-07-20. CI `node` step-6 (`prettier --check`) failure on `docs/AGENT_LESSONS.md`; fixed with `prettier --write` (only change was `*emphasis*` → `_emphasis_`).

---

## P-003 · Monitor/check-in loops must be read-and-report only — never granted write/Task/merge authority

**Symptom:** PR #62 appeared unbidden — a real #52 follow-up, but opened against main from _before_ #66 merged, 10 commits stale, colliding hard with the just-merged #66 (a duplicate `FOS1-RT-18` test at the same line, plus overlapping `pipeline.ts` catch-block edits). It had never been through the adversarial gate. This was the **second** parallel-session collision in the project.

**Cause:** a `send_later` "watch PR #61" check-in loop was configured with the full write toolset (`Edit`/`Write`/`MultiEdit`/`Task`) and an "address anything actionable" mandate, re-arming hourly. With nothing actionable on #61, a firing of that loop grabbed issue #52 off the backlog and opened a PR against stale `main` — unsupervised, ungated, on a base that a concurrent interactive slice (#66) was about to invalidate. A loop meant to _observe_ instead _produced_ work.

**Rule:** a loop whose job is to _watch/report_ on a PR gets read-and-report tools ONLY — no `Edit`/`Write`/`MultiEdit`/`Task`, no branch/PR creation, no merge. Any actual code work goes through an explicit, supervised maker dispatch on a known-fresh base (`run_once`, scoped `allowed_tools`), never a watcher's latitude to "fix anything." When creating check-in routines, scope `allowed_tools` to read/report (`Read`/`Grep`/`Glob`/`Bash` read-only + the PR-read MCP) and never leave a standing loop with write authority pointed at the repo. Corollary: before merging any PR, confirm its head branch was branched from _current_ main (a stale base + a shared-file slice = a silent collision that only surfaces at merge/rebase).

**Provenance:** PR #62, 2026-07-20. A `send_later` watcher (persistent session `session_01215A2y3UFrFDgpmWv3CrLQ`, watching PR #61) opened PR #62 for #52 at 07:24 UTC — ~3 min after that watcher fired at 07:21 — against main-before-#66. Surfaced when the founder asked why #62 was still WIP; the loop was disabled and #62 rebased + gated + de-collided (tests renumbered `RT-21/22/23`).
