"""I02C-L1's three pass checks, on the newest saved evidence run. No server, no GPU.

The evidence run carries the engine's iteration statistics and no profiler: a TRACE=live run (labels.json), or a
run recorded on 2026-11-07, before iteration statistics moved out of the base config. The measured run (TRACE=off)
has no iteration statistics, so it cannot show check 1's engine rows.

Reads the raw saved records, not readout.json, except where a row is about the readout itself (check 3). Does not
import rep.py. A run whose pair failed fails these checks: run again under a new id (make rep), do not edit the run.
"""
import json
import math
import re
from pathlib import Path

import pytest
from prometheus_client.parser import text_string_to_metric_families

RESULTS = Path(__file__).resolve().parent / "results"
TOLERANCE_MS = 0.001  # float serialization and subtraction in a same-population identity; measured difference 0
QUEUE_SUM = "trtllm_request_queue_time_seconds_sum"
QUEUE_COUNT = "trtllm_request_queue_time_seconds_count"
SUCCESS = "trtllm_request_success_total"


def load(path: Path):
    return json.loads(path.read_text())


def prometheus_totals(text: str) -> dict[str, float]:
    totals = {QUEUE_SUM: 0.0, QUEUE_COUNT: 0.0, SUCCESS: 0.0}
    for family in text_string_to_metric_families(text):
        for sample in family.samples:
            if sample.name in totals:
                totals[sample.name] += sample.value
    return totals


def queue_intervals(entries: list[dict]) -> list[float]:
    """first_scheduled_time - arrival_time per native record, in seconds, on the engine's clock."""
    return [e["perf_metrics"]["timing_metrics"]["first_scheduled_time"]
            - e["perf_metrics"]["timing_metrics"]["arrival_time"] for e in entries]


def positive_sum_ms(intervals: list[float]) -> float:
    return math.fsum(v for v in intervals if v > 0) * 1000  # the engine's histogram observes only positive intervals


@pytest.fixture(scope="module")
def saved():
    def stamp(run: Path) -> str:
        return run.name.split("_")[1]  # <prefix>_<utc>_<id>

    runs = [r for r in RESULTS.iterdir() if (r / "labels.json").is_file()
            and load(r / "labels.json").get("iter_stats") and not load(r / "labels.json").get("profiler")]
    assert runs, "no saved run with iteration statistics: make rep REP=I02C-L1_one_slot_queue TRACE=live"
    run = max(runs, key=stamp)
    native = load(run / "native_records.json")
    iterations = [entry for line in (run / "engine_iterations_raw.jsonl").read_text().splitlines()
                  for entry in (json.loads(line)["response"] or [])]  # reader order; a failed read has no response
    return {
        "clients": {role: load(run / "client" / f"{run.name}-{role}.json") for role in ("A", "B")},
        "native": native["first"], "second": native["second"], "iterations": iterations,
        "offline_tokens": load(run / "prompt.json")["tokens"],
        "max_batch_size": int(re.search(r'"--max_batch_size",\s*"(\d+)"', (run / "topology.json").read_text())[1]),
        "prometheus": {w: prometheus_totals((run / f"prometheus_{w}.txt").read_text()) for w in ("baseline", "final")},
        "readout": load(run / "readout.json"),
    }


def test_1_two_client_requests_respect_one_scheduled_slot(saved):
    a, b = saved["clients"]["A"], saved["clients"]["B"]
    assert a["release_ns"] < b["send_ns"] < a["protocol_complete_ns"]  # A content < B send < A done
    edges = sorted([(c["send_ns"], 1) for c in (a, b)] + [(c["protocol_complete_ns"], -1) for c in (a, b)])
    in_flight, peak = 0, 0
    for _, change in edges:
        in_flight += change
        peak = max(peak, in_flight)
    assert peak == 2
    iterations = saved["iterations"]
    assert iterations, "no iteration statistics: an empty capture cannot pass the capacity check"
    assert max(i["inflightBatchingStats"]["numScheduledRequests"] for i in iterations) <= saved["max_batch_size"] == 1
    first = min(e["perf_metrics"]["first_iter"] for e in saved["native"])  # the pair's aggregate iteration window
    last = max(e["perf_metrics"]["last_iter"] for e in saved["native"])
    together = [i["iter"] for i in iterations if first <= i["iter"] <= last
                and i["inflightBatchingStats"]["numGenRequests"] == 1
                and i["inflightBatchingStats"]["numScheduledRequests"] == 1 and i["numQueuedRequests"] >= 1]
    assert len(together) >= 1  # the engine generating for one request while another sits in its input queue
    assert [(c["status"], c["complete"]) for c in (a, b)] == [(200, True)] * 2
    assert [c["usage"]["prompt_tokens"] - saved["offline_tokens"] for c in (a, b)] == [0, 0]


def test_2_native_queue_total_agrees_with_the_histogram(saved):
    intervals = queue_intervals(saved["native"])
    delta = {name: saved["prometheus"]["final"][name] - saved["prometheus"]["baseline"][name]
             for name in (QUEUE_SUM, QUEUE_COUNT, SUCCESS)}
    assert len(saved["native"]) == 2
    assert delta[SUCCESS] == 2
    assert delta[QUEUE_COUNT] == sum(v > 0 for v in intervals)
    assert abs(positive_sum_ms(intervals) - delta[QUEUE_SUM] * 1000) <= TOLERANCE_MS  # histogram sums are seconds
    assert saved["second"] == []  # the first read drained the deque


def test_3_an_unsupported_concurrent_join_stays_unavailable(saved):
    native_ids = [e["request_id"] for e in saved["native"]]
    client_ids = set()
    for record in saved["clients"].values():
        client_ids |= {record["request_id"]} | {e["event"].get("id") for e in record["events"]}
    assert all(isinstance(i, int) for i in native_ids)
    assert [i for i in native_ids if i in client_ids or str(i) in client_ids] == []  # validated joins: 0
    unavailable = {u["what"] for u in saved["readout"]["unavailable"]}
    assert {"A: engine queue interval", "B: engine queue interval"} <= unavailable
    for client in saved["readout"]["clients"].values():
        assert not any("queue" in key for key in client["durations"] if key != "unavailable")
    intervals = queue_intervals(saved["native"])
    assert abs(positive_sum_ms(intervals) - positive_sum_ms(intervals[::-1])) <= TOLERANCE_MS
