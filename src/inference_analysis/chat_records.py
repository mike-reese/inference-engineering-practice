import base64
import re

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


ENGINE_TIMING_KEYS = {"prompt": "prompt_ms", "generation": "predicted_ms"}


def engine_counter_seconds(timings: list[dict], phase: str) -> float:
    if phase not in ENGINE_TIMING_KEYS:
        raise ValueError(f"phase must be one of {sorted(ENGINE_TIMING_KEYS)}, got {phase!r}")
    key = ENGINE_TIMING_KEYS[phase]
    total_ms = 0
    for timing in timings:
        value = timing[key]
        if value < 0:
            raise ValueError(f"negative {key}: {value}")
        total_ms += int(value)
    return total_ms / 1e3


def causal_pairs(stream: dict, task: dict) -> list[dict]:
    candidates = [
        (stream["request_last_ns"], task["handler_us"], True),
        (stream["last_data_ns"], task["access_us"], True),
        (stream["first_content_ns"], task["first_send_us"], False),
    ]
    return [{"pcap_ns": pcap_ns, "log_us": log_us, "log_after_pcap": log_after_pcap}
            for pcap_ns, log_us, log_after_pcap in candidates
            if pcap_ns is not None and log_us is not None]


def log_offset_bounds(pairs: list[dict]) -> tuple[int, int]:
    lower = [p["pcap_ns"] - p["log_us"] * 1000 for p in pairs if p["log_after_pcap"]]
    upper = [p["pcap_ns"] - p["log_us"] * 1000 for p in pairs if not p["log_after_pcap"]]
    if not lower or not upper:
        raise ValueError("need at least one pair bounding each side of the offset")
    low, high = max(lower), min(upper)
    if low > high:
        raise ValueError(f"causal pairs contradict each other: lower bound {low} > upper bound {high}")
    return low, high


CONTENT_TEXT = re.compile(rb'"delta":\{"content":"[^"]')


def _first_content_read_ns(record: dict) -> int:
    for read in record["body_reads"]:
        if CONTENT_TEXT.search(base64.b64decode(read["base64"])):
            return read["ns"]
    raise ValueError(f"{record['request_id']}: no body read carried content")


def _trace_ns(record: dict, name: str) -> int:
    for event in record["transport_trace"]:
        if event["name"] == name:
            return event["ns"]
    raise ValueError(f"{record['request_id']}: no {name} in the transport trace")


def request_segments(record: dict, stream: dict, task: dict, offset_ns: int) -> dict:
    if not record.get("detail", True):
        raise ValueError(f"{record['request_id']}: transport detail was not saved")
    anchor = record["anchor_pair"]

    def client_utc(ns: int) -> int:
        return anchor["utc_ns"] + (ns - anchor["monotonic_ns"])

    def log_utc(us: int) -> int:
        return us * 1000 + offset_ns

    connect = _trace_ns(record, "connection.connect_tcp.started")
    content_read = _first_content_read_ns(record)
    shared = [
        ("client_before_connect", "client", record["send_ns"], connect),
        ("network_to_server", "client->pcap", client_utc(connect), stream["request_last_ns"]),
        ("server_receive", "pcap->log", stream["request_last_ns"], log_utc(task["handler_us"])),
        ("template_tokenize", "log", log_utc(task["handler_us"]), log_utc(task["post_us"])),
        ("queue", "log", log_utc(task["post_us"]), log_utc(task["launch_us"])),
        ("launch_to_first_result", "log", log_utc(task["launch_us"]), log_utc(task["first_send_us"])),
    ]
    ttft_tail = [
        ("server_send", "log->pcap", log_utc(task["first_send_us"]), stream["first_content_ns"]),
        ("network_to_client", "pcap->client", stream["first_content_ns"], client_utc(content_read)),
        ("client_parse", "client", content_read, record["first_content_ns"]),
    ]
    e2e_tail = [
        ("decode", "log", log_utc(task["first_send_us"]), log_utc(task["release_us"])),
        ("server_send_rest", "log->pcap", log_utc(task["release_us"]), stream["last_data_ns"]),
        ("network_and_client_rest", "pcap->client", stream["last_data_ns"],
         client_utc(record["protocol_complete_ns"])),
    ]

    def build(rows):
        segments = []
        for name, clock, start, end in rows:
            if end < start:
                raise ValueError(f"{record['request_id']}: negative {name} ({(end - start) / NS_PER_MS} ms)")
            segments.append({"name": name, "clock": clock, "ms": (end - start) / NS_PER_MS})
        return segments

    return {"ttft": build(shared + ttft_tail), "e2e": build(shared + e2e_tail)}


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
