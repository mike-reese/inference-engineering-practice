import numpy as np
from scipy import stats

NS_PER_MS = 1_000_000

ALWAYS_UNAVAILABLE = {
    "transport_eof_ms": "the SDK stops at [DONE] and closes the response; transport EOF is not observed",
    "exact_itl_ms": "content events are text deliveries, not tokens; the normal path has no per-token clock",
}


def _since_send(record: dict, key: str) -> float | None:
    end = record.get(key)
    if end is None:
        return None
    return (end - record["send_ns"]) / NS_PER_MS


def _incomplete_reason(record: dict) -> str:
    if record["error"] is not None:
        return record["error"]["type"]
    missing = [key for key in ("first_content_ns", "finish_reason", "usage") if record.get(key) is None]
    return f"status {record['status']}, missing {missing}"


def chat_durations(record: dict) -> dict:
    durations = {
        "headers_ms": _since_send(record, "headers_ns"),
        "ttft_ms": _since_send(record, "first_content_ns"),
        "e2e_ms": _since_send(record, "protocol_complete_ns") if record["complete"] else None,
        "attempt_ms": _since_send(record, "close_ns"),
    }
    unavailable = dict(ALWAYS_UNAVAILABLE)
    if durations["headers_ms"] is None:
        unavailable["headers_ms"] = "no HTTP response headers arrived"
    if durations["ttft_ms"] is None:
        unavailable["ttft_ms"] = "no nonempty content arrived"
    if durations["e2e_ms"] is None:
        unavailable["e2e_ms"] = f"incomplete response: {_incomplete_reason(record)}"
    return {**durations, "unavailable": unavailable}


def _has_content(event: dict) -> bool:
    choices = event.get("choices") or []
    return bool(choices) and bool(choices[0]["delta"].get("content"))


def content_event_gaps(record: dict) -> list[float]:
    if not record.get("detail", True):
        raise ValueError(f"{record['request_id']}: events were not saved (detail off)")
    times = [item["ns"] for item in record["events"] if _has_content(item["event"])]
    return [(later - earlier) / NS_PER_MS for earlier, later in zip(times, times[1:])]


def locust_bucket_ms(response_time_ms: float) -> int:
    """Locust 2.47's bucket_response_time: keep about two significant digits."""
    if response_time_ms < 100:
        return round(response_time_ms)
    if response_time_ms < 1000:
        return int(round(response_time_ms, -1))
    if response_time_ms < 10000:
        return int(round(response_time_ms, -2))
    return int(round(response_time_ms, -3))


def locust_response_times(durations_ms: list[float]) -> dict[int, int]:
    buckets = {}
    for duration in durations_ms:
        key = locust_bucket_ms(duration)
        buckets[key] = buckets.get(key, 0) + 1
    return buckets


def locust_percentile_ms(durations_ms: list[float], percent: float) -> int:
    """Locust 2.47's calculate_response_time_percentile, rebuilt from raw durations."""
    buckets = locust_response_times(durations_ms)
    num_requests = len(durations_ms)
    allowed_above = int(num_requests * percent)
    processed = 0
    for bucket in sorted(buckets, reverse=True):
        processed += buckets[bucket]
        if num_requests - processed <= allowed_above:
            return bucket
    return 0


def locust_median_ms(durations_ms: list[float]) -> float:
    """Locust 2.47's median_response_time: the 0.5 bucket, clamped to the raw min and max."""
    median = locust_percentile_ms(durations_ms, 0.5) or 0
    return min(max(median, min(durations_ms)), max(durations_ms))


def histogram_counts(values: list[float], bounds: tuple[float, ...]) -> list[int]:
    """Cumulative classic-histogram counts: one per upper bound (value <= bound), then +Inf."""
    return [sum(1 for v in values if v <= bound) for bound in bounds] + [len(values)]


def half_p50_difference_ms(values_in_send_order: list[float]) -> float:
    """Second-half P50 minus first-half P50 (NumPy linear), for the within-replay stability guard."""
    if len(values_in_send_order) % 2:
        raise ValueError(f"need an even count, got {len(values_in_send_order)}")
    half = len(values_in_send_order) // 2
    first, second = values_in_send_order[:half], values_in_send_order[half:]
    return float(np.quantile(second, 0.5, method="linear") - np.quantile(first, 0.5, method="linear"))


def paired_bootstrap_interval(differences: list[float], seed: int = 20261028, resamples: int = 10000,
                              confidence: float = 0.95) -> tuple[float, float]:
    """Percentile bootstrap of the mean over whole-block paired differences (spec Level 2 additions)."""
    result = stats.bootstrap((np.asarray(differences, dtype=float),), np.mean, n_resamples=resamples,
                             confidence_level=confidence, method="percentile", rng=np.random.default_rng(seed))
    return float(result.confidence_interval.low), float(result.confidence_interval.high)


def held_back_line_miss_ms(low: tuple[float, float], high: tuple[float, float], held: tuple[float, float]) -> dict:
    """Fit a line through two (x, y) endpoints and report its miss at a held-back x: observed minus predicted."""
    (x0, y0), (x1, y1), (x, observed) = low, high, held
    predicted = y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return {"predicted_ms": predicted, "observed_ms": observed, "miss_ms": observed - predicted}


def service_output_throughput(records: list[dict]) -> float:
    """Output tokens per second over first send to last protocol completion; complete records only."""
    if not all(r["complete"] for r in records):
        raise ValueError("throughput needs complete records")
    tokens = sum(r["usage"]["completion_tokens"] for r in records)
    window_ns = max(r["protocol_complete_ns"] for r in records) - min(r["send_ns"] for r in records)
    return tokens / (window_ns / 1e9)
