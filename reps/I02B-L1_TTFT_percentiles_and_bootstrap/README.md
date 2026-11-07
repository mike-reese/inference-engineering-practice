# I02B-L1 — TTFT percentiles and bootstrap intervals

**Mechanism.** Compare sample-percentile conventions and percentile-bootstrap intervals
on 20 chosen synthetic TTFT values. All statistics are **Calculated**; no server ran.

**Task.** Preserve the input rows, calculate P50/P90/P95/P99 with two methods, compare
the mean with P50, and reconstruct SciPy's P50/P99 interval endpoints from its distribution.

**Configuration.** Python 3.12.14, NumPy 2.5.4, pandas 3.0.6, SciPy 1.18.1; CPU, float64.
One fixed 20-row sample. Bootstrap: linear P50/P99, 10,000 resamples, 95% confidence,
percentile interval method, axis 0, vectorized, batch 1,000, fresh RNG seed 20261106.
The independent unit is a whole synthetic row; IID is assumed, not established.

| Inspection | Library result (ms) | Reference and meaning |
| --- | --- | --- |
| P50/P90/P95/P99, inverted_cdf | 21 / 90 / 180 / 500 | Sorted one-based ranks 10 / 18 / 19 / 20 |
| P50/P90/P95/P99, linear | 21.5 / 99 / 196 / 439.2 | Scalar positions 9.5 / 17.1 / 18.05 / 18.81 |
| Mean versus linear P50 | 58.2 versus 21.5 | Complete sum 1164 / 20; difference 36.7 |
| P50 95% bootstrap interval | [17.5, 31] | Distribution percentiles 2.5 and 97.5 |
| P99 95% bootstrap interval | [52.15, 500] | Same endpoint extraction on P99 estimates |

Values above are rounded for display. Raw precision, every scalar substitution and
all 20,000 bootstrap estimates are saved. pandas agrees with NumPy but uses NumPy
internally; scalar rank/interpolation arithmetic is the independent reference.

| Check | Reference | Max difference (ms) | Result |
| --- | --- | --- | --- |
| 1: selected observations | Explicit ranks and fixed values | 0 | PASS |
| 2: interpolation | Scalar values, pandas, method gap | 4.121e-13 | PASS |
| 3: mean | Complete sum/count and fixed values | 0 | PASS |
| 4: interval endpoints | Saved distribution and scalar endpoint positions | 2.132e-14 | PASS |

**Pass rule.** Absolute difference at most 1e-10 ms, with zero relative tolerance.
This allowance covers floating-point arithmetic, not request variation or uncertainty.
The method substitution changes P99 by about −60.8 ms and fails the intended method's reference.

**Meaning and limits.** The few large values pull this sample's mean above its P50.
The P99 interval is much wider than P50's interval because the sample has sparse tail evidence.
More resamples add no new requests or unseen slow values. Matching interval endpoints checks
extraction, not nominal coverage; these synthetic results justify no serving-capacity decision.
The practical use is declaring the method, sample size and uncertainty in real benchmark claims.

**Toolkit.** `latency_table(ttft_ms, percentiles, *, method)` delegates to NumPy and
returns an array in the requested percentile order; reuse is not a requirement of this rep.

**Reproduce** from the practice repository:

```bash
uv run --no-sync python reps/I02B-L1_TTFT_percentiles_and_bootstrap/rep.py
```

Every execution creates a fresh results directory. `IE_STUDY_MODE=verify` selects a
separate `I02B-QA-...` identifier. No Makefile, control CLI, plots or devtools are required
for this synthetic rep under Mike's session decisions. No commit or push was made by the tutor.

Verified artifacts: [statistics](results/I02B-QA-1794014393885875025/statistics.json),
[basis](results/I02B-QA-1794014393885875025/basis.json),
[complete distribution](results/I02B-QA-1794014393885875025/bootstrap_distribution.json),
[console walkthrough](results/I02B-QA-1794014393885875025/console.txt).
