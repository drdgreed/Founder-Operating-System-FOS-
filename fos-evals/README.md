# fos-evals — agent-quality evaluation harness

Python sidecar (ADR-07), **quarantined** from the TypeScript product plane. It scores FOS agents against fixtures before they may be promoted from shadow → founder-review → live.

## Contract (per ADR-07)

- **Fixtures** (`fixtures/`): JSON — input records + expected output-schema constraints + expected deterministic-gate outcomes.
- **Grading:** assertions on output schema + deterministic gate results (no LLM-judges in the gate path; an LLM-judge may advise, never decide).
- **Promotion threshold:** e.g. ≥95% gate-pass over N shadow runs with zero critical failures. Results are written back to `AgentRun.evaluation_json`.

## Status

Scaffold only — Phase 0 uses no LLM, so no agents exist yet. The first fixtures + graders land with the Phase-1 agent slice. `runner.py` holds the interface stub.

## Run

```
pip install -e ".[dev]"
ruff check .
pytest
```
