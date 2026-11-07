"""One fixed synthetic TTFT sample: percentile conventions and bootstrap intervals.

Run directly with uv. Each execution saves new artifacts; no serving system runs.
"""
import hashlib
import json
import math
import os
import platform
import subprocess
import sys
import time
from decimal import Decimal
from functools import partial
from importlib.metadata import version
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import bootstrap

from inference_analysis.latency import latency_table

TOLERANCE_MS = 1e-10


def comparison(actual, reference) -> dict:
    """Record an absolute numerical comparison, with zero relative tolerance."""
    actual = np.asarray(actual, dtype=np.float64)
    reference = np.asarray(reference, dtype=np.float64)
    if actual.shape != reference.shape:
        raise ValueError(f"comparison shapes differ: {actual.shape} and {reference.shape}")
    difference = actual - reference
    return {
        "actual_ms": actual.tolist(),
        "reference_ms": reference.tolist(),
        "difference_ms": difference.tolist(),
        "max_absolute_difference_ms": float(np.max(np.abs(difference))),
        "absolute_tolerance_ms": TOLERANCE_MS,
        "passed": bool(np.all(np.abs(difference) <= TOLERANCE_MS)),
    }


def save_json(path: Path, value) -> None:
    """Create one artifact without replacing an existing file."""
    with path.open("x") as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write("\n")


def main() -> int:
    mode = os.environ.get("IE_STUDY_MODE", "learn")
    if mode not in {"learn", "verify"}:
        raise ValueError("IE_STUDY_MODE must be learn or verify; unset it for a normal run")

    ttft_ms = np.asarray(
        [
            40, 14, 180, 19, 12, 26, 55, 16, 21, 500,
            18, 29, 13, 90, 22, 15, 33, 20, 17, 24,
        ],
        dtype=np.float64,
    )

    rows = [
        {"row_id": f"s{i:02d}", "ttft_ms": float(value)}
        for i, value in enumerate(ttft_ms, start=1)
    ]
    ordered_rows = sorted(rows, key=lambda row: row["ttft_ms"])
    ordered_values = [row["ttft_ms"] for row in ordered_rows]
    percentiles = np.asarray([50, 90, 95, 99])

    by_method = {
        method: latency_table(
            ttft_ms, percentiles, method=method
        ).tolist()
        for method in ("inverted_cdf", "linear")
    }

    # These four scalar substitutions check the library; they are not a second
    # percentile implementation. Decimal keeps the reference positions exact.
    scalar_references = []
    for q in percentiles.tolist():
        fraction = Decimal(q) / Decimal(100)
        rank = math.ceil(Decimal(len(rows)) * fraction)
        position = Decimal(len(rows) - 1) * fraction
        lower = int(position)
        upper = math.ceil(position)
        weight = position - lower
        left = Decimal(str(ordered_values[lower]))
        right = Decimal(str(ordered_values[upper]))
        interpolated = left + weight * (right - left)
        scalar_references.append({
            "percentile": q,
            "inverted_cdf_rank_one_based": rank,
            "selected_row_id": ordered_rows[rank - 1]["row_id"],
            "selected_value_ms": ordered_values[rank - 1],
            "linear_position_zero_based": str(position),
            "lower_index": lower,
            "upper_index": upper,
            "lower_row_id": ordered_rows[lower]["row_id"],
            "upper_row_id": ordered_rows[upper]["row_id"],
            "lower_value_ms": float(left),
            "upper_value_ms": float(right),
            "interpolation_fraction": str(weight),
            "linear_reference_ms": float(interpolated),
            "substitution": f"{left} + {weight} * ({right} - {left}) = {interpolated} ms",
        })

    pandas_values = pd.Series(ttft_ms).quantile(
        percentiles / 100, interpolation="linear"
    ).to_numpy()
    total_ms = sum(row["ttft_ms"] for row in rows)
    mean_ms = float(np.mean(ttft_ms))
    p50_ms = by_method["linear"][0]
    method_gap_ms = by_method["linear"][3] - by_method["inverted_cdf"][3]

    statistic = partial(np.percentile, q=[50, 99], method="linear")

    boot = bootstrap(
        (ttft_ms,),
        statistic,
        n_resamples=10_000,
        confidence_level=0.95,
        method="percentile",
        vectorized=True,
        axis=0,
        batch=1_000,
        rng=np.random.default_rng(20261106),
    )
    distribution = boot.bootstrap_distribution
    interval = np.stack((boot.confidence_interval.low, boot.confidence_interval.high))
    reconstructed_interval = np.percentile(
        distribution, [2.5, 97.5], axis=-1, method="linear"
    )

    # Inspect the neighboring sorted bootstrap estimates at each endpoint.
    # This verifies extraction from SciPy's distribution, not interval coverage.
    endpoint_rows = []
    scalar_interval = np.empty((2, 2))  # endpoint (low/high), statistic (P50/P99)
    for statistic_index, q in enumerate((50, 99)):
        ordered_estimates = np.sort(distribution[statistic_index])
        for endpoint_index, endpoint_q in enumerate((Decimal("2.5"), Decimal("97.5"))):
            position = Decimal(len(ordered_estimates) - 1) * endpoint_q / 100
            lower = int(position)
            upper = math.ceil(position)
            weight = position - lower
            left = Decimal(str(float(ordered_estimates[lower])))
            right = Decimal(str(float(ordered_estimates[upper])))
            value = left + weight * (right - left)
            scalar_interval[endpoint_index, statistic_index] = float(value)
            endpoint_rows.append({
                "statistic_percentile": q,
                "bootstrap_distribution_percentile": str(endpoint_q),
                "position_zero_based": str(position),
                "lower_index": lower,
                "upper_index": upper,
                "lower_estimate_ms": float(left),
                "upper_estimate_ms": float(right),
                "substitution": f"{left} + {weight} * ({right} - {left}) = {value} ms",
            })

    checks = [
        {
            "id": 1,
            "name": "inverted_cdf agrees with explicit sorted ranks",
            "comparisons": {
                "sorted_rows_vs_numpy_sort": comparison(ordered_values, np.sort(ttft_ms)),
                "selected_ranks": comparison(
                    by_method["inverted_cdf"],
                    [row["selected_value_ms"] for row in scalar_references],
                ),
                "fixed_reference": comparison(by_method["inverted_cdf"], [21, 90, 180, 500]),
            },
        },
        {
            "id": 2,
            "name": "linear agrees with scalar positions and pandas",
            "comparisons": {
                "scalar_interpolation": comparison(
                    by_method["linear"],
                    [row["linear_reference_ms"] for row in scalar_references],
                ),
                "fixed_reference": comparison(by_method["linear"], [21.5, 99, 196, 439.2]),
                "pandas_corroboration": comparison(by_method["linear"], pandas_values),
                "method_gap": comparison(method_gap_ms, -60.8),
            },
            "independence_limit": "pandas delegates to NumPy; it is corroboration only",
        },
        {
            "id": 3,
            "name": "mean agrees with complete sum and differs from P50",
            "comparisons": {
                "sum_divided_by_count": comparison(mean_ms, total_ms / len(rows)),
                "fixed_mean": comparison(mean_ms, 58.2),
                "mean_minus_linear_p50": comparison(mean_ms - p50_ms, 36.7),
            },
        },
        {
            "id": 4,
            "name": "SciPy interval agrees with its saved distribution",
            "comparisons": {
                "fixed_seeded_endpoints": comparison(interval, [[17.5, 52.15], [31, 500]]),
                "distribution_reconstruction": comparison(interval, reconstructed_interval),
                "scalar_endpoint_extraction": comparison(interval, scalar_interval),
            },
            "independence_limit": "endpoint agreement does not validate coverage or IID assumptions",
        },
    ]
    for check in checks:
        check["passed"] = all(item["passed"] for item in check["comparisons"].values())

    script_path = Path(__file__).resolve()
    numpy_path = Path(np.__file__).resolve()
    storage_command = ["findmnt", "-T", str(numpy_path), "-n", "-o", "SOURCE,TARGET,FSTYPE"]
    storage = subprocess.run(storage_command, capture_output=True, text=True)
    basis = {
        "mode": mode,
        "run_actor": "tutor author verification" if mode == "verify" else "operator; not automatically learner mastery",
        "interpreter": sys.executable,
        "python": platform.python_version(),
        "numpy": np.__version__,
        "pandas": pd.__version__,
        "scipy": version("scipy"),
        "dtype": str(ttft_ms.dtype),
        "device": "CPU",
        "working_directory": str(Path.cwd()),
        "argv": [sys.executable, *sys.argv],
        "source_sha256": hashlib.sha256(script_path.read_bytes()).hexdigest(),
        "numpy_package_path": str(numpy_path),
        "storage": {
            "command": storage_command,
            "returncode": storage.returncode,
            "stdout": storage.stdout.strip(),
            "stderr": storage.stderr.strip(),
        },
        "serving": {
            "applicable": False,
            "reason": "chosen synthetic data; no request was sent or timed",
            "engine": None,
            "model": None,
            "GPU_measurement": None,
            "ISL_OSL_concurrency": None,
        },
    }

    result = {
        "rep_id": "I02B-L1",
        "study_mode": mode,
        "evidence": "Calculated",
        "input_kind": "chosen synthetic TTFT",
        "unit": "ms",
        "request_count": len(rows),
        "input_rows": rows,
        "ordered_rows": ordered_rows,
        "percentiles": percentiles.tolist(),
        "by_method": by_method,
        "scalar_references": scalar_references,
        "pandas_linear_ms": pandas_values.tolist(),
        "mean": {
            "sum_ms": total_ms,
            "count": len(rows),
            "complete_arithmetic": "(" + " + ".join(str(row["ttft_ms"]) for row in rows)
            + f") / {len(rows)} = {total_ms / len(rows)} ms",
            "numpy_mean_ms": mean_ms,
            "linear_p50_ms": p50_ms,
            "mean_minus_linear_p50_ms": mean_ms - p50_ms,
        },
        "method_hazard": {
            "intended_method": "inverted_cdf",
            "substituted_method": "linear",
            "intended_p99_ms": by_method["inverted_cdf"][3],
            "substituted_p99_ms": by_method["linear"][3],
            "difference_ms": method_gap_ms,
        },
        "checks": checks,
        "all_checks_passed": all(check["passed"] for check in checks),
        "limits": [
            "Twenty chosen synthetic rows describe no actual server workload.",
            "Row resampling assumes IID observations; it does not establish IID for real requests.",
            "More bootstrap resamples add no new request evidence or unseen tail values.",
            "A percentile-bootstrap interval need not achieve nominal coverage for a tiny-sample tail.",
            "SciPy's public result does not expose the original row indexes of each resample.",
            "A fixed seed establishes reproducibility, not statistical correctness or coverage.",
            "No GPU utilization, efficiency, bottleneck or serving-component attribution follows from these inputs.",
        ],
    }
    result["bootstrap"] = {
        "statistic_percentiles": [50, 99],
        "sample_percentile_method": "linear",
        "interval_method": "percentile",
        "confidence_level": 0.95,
        "n_resamples": 10_000,
        "seed": 20261106,
        "vectorized": True,
        "axis": 0,
        "batch": 1_000,
        "independent_unit": "one whole synthetic request row; IID assumed",
        "distribution_axes": ["statistic", "resample"],
        "distribution_shape": list(distribution.shape),
        "first_5_resamples_ms": distribution[:, :5].tolist(),
        "displayed_resamples_per_statistic": 5,
        "omitted_resamples_per_statistic": distribution.shape[-1] - 5,
        "interval_low_ms": boot.confidence_interval.low.tolist(),
        "interval_high_ms": boot.confidence_interval.high.tolist(),
        "reconstructed_interval_axes": ["endpoint (low, high)", "statistic (P50, P99)"],
        "reconstructed_interval_ms": reconstructed_interval.tolist(),
        "scalar_endpoint_rows": endpoint_rows,
    }

    prefix = "I02B-QA" if mode == "verify" else "I02B"
    run_dir = (
        script_path.parent
        / "results"
        / f"{prefix}-{time.time_ns()}"
    )
    run_dir.mkdir(parents=True, exist_ok=False)

    distribution_path = run_dir / "bootstrap_distribution.json"
    save_json(
        distribution_path,
        {
            "axes": ["statistic", "resample"],
            "statistic_percentiles": [50, 99],
            "unit": "ms",
            "values": distribution.tolist(),
        },
    )

    save_json(run_dir / "basis.json", basis)
    save_json(run_dir / "sample.json", {
        "provenance": "chosen synthetic input",
        "unit": "ms",
        "input_rows": rows,
        "ordered_rows": ordered_rows,
    })
    result["bootstrap_distribution_file"] = str(distribution_path)
    result["basis_file"] = str(run_dir / "basis.json")
    save_json(run_dir / "statistics.json", result)

    lines = [
        f"I02B-L1 | mode={mode} | Calculated from 20 chosen synthetic TTFT values (ms)",
        "Input rows, complete: " + json.dumps(rows),
        "Sorted rows, complete: " + json.dumps(ordered_rows),
        "Percentiles (%): " + repr(percentiles.tolist()),
        "inverted_cdf (ms): " + repr(by_method["inverted_cdf"]),
        "linear (ms): " + repr(by_method["linear"]),
    ]
    for row in scalar_references:
        lines.append(
            f"P{row['percentile']}: inverted_cdf rank {row['inverted_cdf_rank_one_based']} "
            f"selects {row['selected_row_id']} = {row['selected_value_ms']} ms; "
            f"linear position {row['linear_position_zero_based']}: {row['substitution']}"
        )
    lines.extend([
        "pandas linear (ms; shares NumPy): " + repr(pandas_values.tolist()),
        "Mean: " + result["mean"]["complete_arithmetic"],
        f"Mean - linear P50: {mean_ms} - {p50_ms} = {mean_ms - p50_ms} ms",
        f"P99 method gap, linear - inverted_cdf: {method_gap_ms} ms",
        f"Bootstrap distribution shape: {distribution.shape}; axes: statistic, resample",
        "First 5 of 10000 estimates per statistic (9995 per statistic omitted here; full data saved): "
        + repr(distribution[:, :5].tolist()),
        "95% interval lows (P50, P99; ms): " + repr(boot.confidence_interval.low.tolist()),
        "95% interval highs (P50, P99; ms): " + repr(boot.confidence_interval.high.tolist()),
    ])
    for row in endpoint_rows:
        lines.append(
            f"P{row['statistic_percentile']} interval endpoint at distribution "
            f"P{row['bootstrap_distribution_percentile']}, position {row['position_zero_based']}: "
            + row["substitution"]
        )
    for check in checks:
        difference = max(item["max_absolute_difference_ms"] for item in check["comparisons"].values())
        lines.append(
            f"Check {check['id']}: {'PASS' if check['passed'] else 'FAIL'} | {check['name']} | "
            f"max difference {difference!r} ms <= {TOLERANCE_MS} ms"
        )
    lines.extend([
        f"Checks: {sum(check['passed'] for check in checks)}/4 passed",
        "Limits: synthetic input; IID assumed; bootstrap endpoint agreement does not establish coverage.",
        f"Results: {run_dir}",
    ])
    transcript = "\n".join(lines) + "\n"
    with (run_dir / "console.txt").open("x") as stream:
        stream.write(transcript)
    print(transcript, end="")
    return 0 if result["all_checks_passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
