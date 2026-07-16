from fos_evals.runner import FixtureResult, GateOutcome, summarize


def test_promotion_threshold_blocks_on_critical_failure():
    results = [FixtureResult(f"f{i}", GateOutcome.PASS) for i in range(20)]
    results.append(FixtureResult("f_crit", GateOutcome.CRITICAL_FAIL))
    report = summarize("fos.example_agent", results)
    # 20/21 pass rate is high, but a single critical failure blocks promotion.
    assert report.critical_failures == 1
    assert report.promotable() is False


def test_promotion_allows_clean_high_pass_rate():
    results = [FixtureResult(f"f{i}", GateOutcome.PASS) for i in range(19)]
    results.append(FixtureResult("f_fail", GateOutcome.FAIL))
    report = summarize("fos.example_agent", results)
    assert report.pass_rate == 0.95
    assert report.promotable(threshold=0.95) is True
