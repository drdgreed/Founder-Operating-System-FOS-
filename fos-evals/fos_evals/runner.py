"""Eval-harness interface stub (ADR-07).

The concrete grader/fixture loader lands with the first agent slice (Phase 1).
This module fixes the shapes so fixtures can be authored against a stable
contract now.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class GateOutcome(str, Enum):
    PASS = "pass"
    FAIL = "fail"
    CRITICAL_FAIL = "critical_fail"


@dataclass(frozen=True)
class FixtureResult:
    fixture_id: str
    outcome: GateOutcome
    detail: str = ""


@dataclass(frozen=True)
class PromotionReport:
    agent_key: str
    total: int
    passed: int
    critical_failures: int

    @property
    def pass_rate(self) -> float:
        return self.passed / self.total if self.total else 0.0

    def promotable(self, threshold: float = 0.95) -> bool:
        """An agent is promotable iff pass_rate >= threshold AND no critical failures."""
        return self.pass_rate >= threshold and self.critical_failures == 0


def summarize(agent_key: str, results: list[FixtureResult]) -> PromotionReport:
    passed = sum(1 for r in results if r.outcome is GateOutcome.PASS)
    criticals = sum(1 for r in results if r.outcome is GateOutcome.CRITICAL_FAIL)
    return PromotionReport(
        agent_key=agent_key,
        total=len(results),
        passed=passed,
        critical_failures=criticals,
    )
