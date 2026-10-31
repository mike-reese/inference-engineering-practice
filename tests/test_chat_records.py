import json
import statistics
from pathlib import Path

import numpy as np
import pytest

from inference_analysis.chat_records import (
    causal_pairs,
    chat_durations,
    content_event_gaps,
    engine_counter_seconds,
    half_p50_difference_ms,
    held_back_line_miss_ms,
    histogram_counts,
    locust_bucket_ms,
    locust_median_ms,
    locust_percentile_ms,
    locust_response_times,
    log_offset_bounds,
    paired_bootstrap_interval,
    request_segments,
    service_output_throughput,
)

FIXTURES = Path(__file__).parent / "fixtures"

# K5 (spec I01-L2, Known results): the author's first smoke request, client monotonic ns.
SEND_NS = 4423405483198
HEADERS_NS = 4423434611003
ROLE_NS = 4423470296183
CONTENT_NS = [
    4423470495984, 4423473820236, 4423480513166, 4423487648821, 4423494478935, 4423501230632,
    4423507902084, 4423514590798, 4423521580927, 4423528760387, 4423535600941, 4423542340064,
    4423548999864, 4423556045669, 4423563207563, 4423569870046, 4423576551271, 4423583148080,
    4423590015106, 4423596931418, 4423603667284, 4423610315377, 4423616883197, 4423623873764,
    4423630714070, 4423637682624, 4423644318974, 4423650898808, 4423657906707, 4423664770341,
    4423671732297, 4423678394584,
]
FINISH_NS = 4423678698129
USAGE_NS = 4423679314707
PROTOCOL_COMPLETE_NS = 4423679518400
CLOSE_NS = 4423679522354
USAGE = {"prompt_tokens": 64, "completion_tokens": 32, "total_tokens": 96}
FAILED = {"type": "APIConnectionError", "message": "Connection error."}


def chunk(content=None, role=None, finish=None) -> dict:
    return {"choices": [{"index": 0, "delta": {"role": role, "content": content}, "finish_reason": finish}],
            "usage": None}


def k5_record() -> dict:
    events = [{"ns": ROLE_NS, "event": chunk(role="assistant")}]
    events += [{"ns": ns, "event": chunk(content="x")} for ns in CONTENT_NS]
    events.append({"ns": FINISH_NS, "event": chunk(finish="length")})
    events.append({"ns": USAGE_NS, "event": {"choices": [], "usage": USAGE}})
    return {
        "request_id": "k5", "send_ns": SEND_NS, "headers_ns": HEADERS_NS, "first_content_ns": CONTENT_NS[0],
        "protocol_complete_ns": PROTOCOL_COMPLETE_NS, "close_ns": CLOSE_NS, "status": 200, "error": None,
        "finish_reason": "length", "usage": USAGE, "complete": True, "detail": True, "events": events,
    }


def test_k5_durations():
    durations = chat_durations(k5_record())
    assert durations["headers_ms"] == pytest.approx(29.127805, abs=1e-6)
    assert durations["ttft_ms"] == pytest.approx(65.012786, abs=1e-6)
    assert durations["e2e_ms"] == pytest.approx(274.035202, abs=1e-6)
    assert durations["attempt_ms"] == pytest.approx(274.039156, abs=1e-6)
    assert set(durations["unavailable"]) == {"transport_eof_ms", "exact_itl_ms"}


def test_k5_gaps_skip_role_finish_and_usage_events():
    gaps = content_event_gaps(k5_record())
    assert len(gaps) == 31
    assert sum(gaps) == pytest.approx(207.8986, abs=1e-6)
    assert statistics.fmean(gaps) == pytest.approx(6.706406451612903, abs=1e-9)


def test_midstream_failure_keeps_ttft_and_attempt_but_has_no_e2e():
    record = k5_record() | {"complete": False, "protocol_complete_ns": None, "usage": None, "error": FAILED}
    durations = chat_durations(record)
    assert durations["e2e_ms"] is None
    assert durations["ttft_ms"] == pytest.approx(65.012786, abs=1e-6)
    assert durations["attempt_ms"] == pytest.approx(274.039156, abs=1e-6)
    assert "APIConnectionError" in durations["unavailable"]["e2e_ms"]


def test_connection_failure_has_no_headers_content_or_e2e():
    record = k5_record() | {
        "complete": False, "status": None, "headers_ns": None, "first_content_ns": None,
        "protocol_complete_ns": None, "finish_reason": None, "usage": None, "events": [], "error": FAILED,
    }
    durations = chat_durations(record)
    assert durations["headers_ms"] is None and durations["ttft_ms"] is None and durations["e2e_ms"] is None
    assert {"headers_ms", "ttft_ms", "e2e_ms"} <= set(durations["unavailable"])


def test_gaps_refuse_a_record_without_saved_events():
    with pytest.raises(ValueError):
        content_event_gaps(k5_record() | {"detail": False, "events": []})


def test_each_request_is_truncated_before_summing():
    timings = [{"prompt_ms": 1.9, "predicted_ms": 10.5}, {"prompt_ms": 2.9, "predicted_ms": 20.99}]
    assert engine_counter_seconds(timings, "prompt") == pytest.approx(0.003, abs=1e-12)
    assert engine_counter_seconds(timings, "generation") == pytest.approx(0.030, abs=1e-12)


def test_k11_reference_totals():
    timings = json.loads((FIXTURES / "k11_engine_timings.json").read_text())
    assert len(timings) == 176
    assert engine_counter_seconds(timings, "prompt") == pytest.approx(7.838, abs=1e-9)
    assert engine_counter_seconds(timings, "generation") == pytest.approx(41.795, abs=1e-9)


def test_k11_raw_decimal_sum_is_the_wrong_representation():
    timings = json.loads((FIXTURES / "k11_engine_timings.json").read_text())
    raw_prompt_ms = sum(t["prompt_ms"] for t in timings)
    raw_generation_ms = sum(t["predicted_ms"] for t in timings)
    assert raw_prompt_ms - engine_counter_seconds(timings, "prompt") * 1e3 == pytest.approx(81.691, abs=1e-6)
    assert raw_generation_ms - engine_counter_seconds(timings, "generation") * 1e3 == pytest.approx(84.711, abs=1e-6)


def test_rejects_negative_time_and_unknown_phase():
    with pytest.raises(ValueError):
        engine_counter_seconds([{"prompt_ms": -0.5}], "prompt")
    with pytest.raises(ValueError):
        engine_counter_seconds([], "decode")


TTFT_SEGMENTS = ["client_before_connect", "network_to_server", "server_receive", "template_tokenize", "queue",
                 "launch_to_first_result", "server_send", "network_to_client", "client_parse"]


def pilot2() -> list[dict]:
    return json.loads((FIXTURES / "k15_pilot2.json").read_text())


def pilot2_offset(rows: list[dict]) -> int:
    low, high = log_offset_bounds([pair for row in rows for pair in causal_pairs(row["stream"], row["task"])])
    return (low + high) // 2


def test_bounds_take_the_tightest_pair_on_each_side():
    pairs = [
        {"pcap_ns": 1_000_500, "log_us": 1_000, "log_after_pcap": True},
        {"pcap_ns": 2_000_700, "log_us": 2_000, "log_after_pcap": True},
        {"pcap_ns": 3_000_900, "log_us": 3_000, "log_after_pcap": False},
        {"pcap_ns": 4_001_000, "log_us": 4_000, "log_after_pcap": False},
    ]
    assert log_offset_bounds(pairs) == (700, 900)


def test_contradicting_or_one_sided_pairs_raise():
    with pytest.raises(ValueError):
        log_offset_bounds([{"pcap_ns": 900, "log_us": 0, "log_after_pcap": True},
                           {"pcap_ns": 700, "log_us": 0, "log_after_pcap": False}])
    with pytest.raises(ValueError):
        log_offset_bounds([{"pcap_ns": 900, "log_us": 0, "log_after_pcap": True}])


def test_k15_pilot2_offset_interval():
    rows = pilot2()
    assert len(rows) == 99
    low, high = log_offset_bounds([pair for row in rows for pair in causal_pairs(row["stream"], row["task"])])
    assert (low, high) == (1793225063705705159, 1793225063705781634)
    assert (high - low) / 1e6 == pytest.approx(0.076475, abs=1e-9)


def test_k15_segments_are_positive_and_sum_to_ttft_and_e2e():
    rows = pilot2()
    offset = pilot2_offset(rows)
    for row in rows:
        record = row["record"]
        segments = request_segments(record, row["stream"], row["task"], offset)
        assert [s["name"] for s in segments["ttft"]] == TTFT_SEGMENTS
        assert all(s["ms"] > 0 for s in segments["ttft"] + segments["e2e"])
        ttft_ms = (record["first_content_ns"] - record["send_ns"]) / 1e6
        e2e_ms = (record["protocol_complete_ns"] - record["send_ns"]) / 1e6
        assert sum(s["ms"] for s in segments["ttft"]) == pytest.approx(ttft_ms, abs=1e-9)
        assert sum(s["ms"] for s in segments["e2e"]) == pytest.approx(e2e_ms, abs=1e-9)


# K16 prints template_tokenize as 2.309; the exact even-N median is 2.3085, rounded half up in the table.
K16_ISL_64 = {"client_before_connect": 0.856, "network_to_server": 0.508, "server_receive": 0.052,
              "template_tokenize": 2.3085, "queue": 0.135, "launch_to_first_result": 21.132,
              "server_send": 0.073, "network_to_client": 0.312, "client_parse": 0.115}


def test_k16_isl_64_medians():
    rows = pilot2()
    offset = pilot2_offset(rows)
    measured = [request_segments(r["record"], r["stream"], r["task"], offset)["ttft"]
                for r in rows if r["record"]["isl"] == 64 and r["record"]["phase"] == "normal"]
    assert len(measured) == 24
    for i, name in enumerate(TTFT_SEGMENTS):
        assert statistics.median(segments[i]["ms"] for segments in measured) == pytest.approx(K16_ISL_64[name], abs=5e-4)


def test_negative_segment_raises():
    row = pilot2()[0]
    late_offset = pilot2_offset(pilot2()) + 10_000_000
    with pytest.raises(ValueError):
        request_segments(row["record"], row["stream"], row["task"], late_offset)


def test_record_without_transport_detail_raises():
    row = pilot2()[0]
    with pytest.raises(ValueError):
        request_segments(row["record"] | {"detail": False}, row["stream"], row["task"], pilot2_offset(pilot2()))


# K6/K7 (spec I01-L2, Known results): the author's steady pilot, 3 repeats x 3 ISLs x 8 measured requests.
def k6_batches() -> list[dict]:
    return json.loads((FIXTURES / "k6_k7_pilot.json").read_text())


def batch_ms(batch: dict, end: str) -> list[float]:
    return [(r[end] - r["send_ns"]) / 1e6 for r in batch["records"]]


def p50(values) -> float:
    return float(np.quantile(values, 0.5, method="linear"))


def test_locust_buckets_round_to_two_significant_digits():
    assert [locust_bucket_ms(t) for t in (47.4, 99.6, 147, 249.9, 3432, 58760)] == [47, 100, 150, 250, 3400, 59000]


def test_locust_percentile_and_clamped_median_by_hand():
    durations = [101.0, 104.0, 96.0, 250.0, 248.7]
    assert locust_response_times(durations) == {100: 2, 96: 1, 250: 2}
    assert locust_percentile_ms(durations, 0.5) == 100
    assert locust_percentile_ms(durations, 0.95) == 250
    assert locust_median_ms([258.99767]) == 258.99767  # bucket 260 is above the raw maximum, so Locust clamps


def test_k7_locust_reconstruction_matches_all_nine_replay_summaries():
    for batch in k6_batches():
        durations = batch_ms(batch, "protocol_complete_ns")
        assert {str(k): v for k, v in locust_response_times(durations).items()} == batch["locust"]["response_times"]
        assert locust_percentile_ms(durations, 0.5) == batch["locust"]["p50_ms"]
        assert locust_percentile_ms(durations, 0.95) == batch["locust"]["p95_ms"]


def test_k7_pooled_isl_1024_raw_p50_versus_locust():
    durations = [d for b in k6_batches() if b["isl"] == 1024 for d in batch_ms(b, "protocol_complete_ns")]
    assert len(durations) == 24
    assert p50(durations) == pytest.approx(335.5840705, abs=1e-6)
    assert locust_percentile_ms(durations, 0.5) == 340


def test_k6_stability_references():
    batches = k6_batches()
    half = [half_p50_difference_ms(batch_ms(b, "protocol_complete_ns")) for b in batches]
    assert max(abs(h) for h in half) == pytest.approx(2.268960, abs=1e-6)
    ranges = []
    for isl in (64, 256, 1024):
        medians = [p50(batch_ms(b, "protocol_complete_ns")) for b in batches if b["isl"] == isl]
        ranges.append(max(medians) - min(medians))
    assert max(ranges) == pytest.approx(11.521152, abs=1e-6)


def test_half_p50_difference_needs_an_even_count():
    assert half_p50_difference_ms([1.0, 3.0, 10.0, 20.0]) == pytest.approx(13.0)
    with pytest.raises(ValueError):
        half_p50_difference_ms([1.0, 2.0, 3.0])


def k7_ttft_p50(isl: int) -> list[float]:
    return [p50(batch_ms(b, "first_content_ns")) for b in k6_batches() if b["isl"] == isl]


def test_k7_bootstrap_interval():
    differences = [high - low for low, high in zip(k7_ttft_p50(64), k7_ttft_p50(1024))]
    assert statistics.fmean(differences) == pytest.approx(90.328720, abs=1e-6)
    low, high = paired_bootstrap_interval(differences)
    assert (low, high) == (pytest.approx(88.511643, abs=1e-6), pytest.approx(91.237682, abs=1e-6))


def test_k7_held_back_line_miss():
    means = {isl: statistics.fmean(k7_ttft_p50(isl)) for isl in (64, 256, 1024)}
    fit = held_back_line_miss_ms((64, means[64]), (1024, means[1024]), (256, means[256]))
    assert fit["predicted_ms"] == pytest.approx(43.824598, abs=1e-6)
    assert fit["miss_ms"] == pytest.approx(-8.397028, abs=1e-6)


def test_histogram_counts_are_cumulative_and_include_the_bound():
    counts = histogram_counts([0.01, 0.05, 0.051, 0.3, 7.0], (0.025, 0.05, 0.1))
    assert counts == [1, 2, 3, 5]


def test_service_output_throughput_uses_first_send_to_last_completion():
    records = [
        {"send_ns": 0, "protocol_complete_ns": 500_000_000, "complete": True, "usage": {"completion_tokens": 32}},
        {"send_ns": 1_000_000_000, "protocol_complete_ns": 1_500_000_000, "complete": True,
         "usage": {"completion_tokens": 32}},
    ]
    assert service_output_throughput(records) == pytest.approx(64 / 1.5)
    with pytest.raises(ValueError):
        service_output_throughput(records + [{"send_ns": 0, "complete": False}])
