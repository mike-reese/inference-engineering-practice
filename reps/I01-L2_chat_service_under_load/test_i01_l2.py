"""I01-L2 pass checks (spec "Pass check", rows P1-P5) against one saved run.

    uv run python reps/I01-L2_chat_service_under_load/audit.py <RUN_ID>
    I01L2_RUN_ID=<RUN_ID> uv run pytest reps/I01-L2_chat_service_under_load/test_i01_l2.py -v

The module skips when I01L2_RUN_ID is unset, so the general test suite never depends on a run.
These tests read saved evidence only and never import rep.py.

Rows checked on fixed fixtures instead live in tests/test_chat_records.py: P2a-P2c (K5), the P3e method (K11),
the Locust and stability methods behind P4b-P4d (K6/K7) and the P5c-P5e methods (K15/K16).
"""
import json
import os
from pathlib import Path

import numpy as np
import pytest
from prometheus_client.parser import text_string_to_metric_families
from prometheus_client.utils import floatToGoString

from inference_analysis.chat_records import (
    chat_durations,
    engine_counter_seconds,
    half_p50_difference_ms,
    histogram_counts,
    locust_median_ms,
    locust_percentile_ms,
    locust_response_times,
)

REP_DIR = Path(__file__).resolve().parent
RUN_ID = os.environ.get("I01L2_RUN_ID")
if not RUN_ID:
    pytest.skip("set I01L2_RUN_ID to the run to check", allow_module_level=True)
RUN_DIR = REP_DIR / "results" / RUN_ID
EVIDENCE = RUN_DIR / "evidence"

# Fixed by the spec: Configuration, Known results K1/K2/K13 and the Pass check tolerances.
K1_COMMIT = "a7a98e0fffed794396b3fbad4dcdbbc184963645"
K1_DOCKERFILE_SHA256 = "9476a36157c1883ba7bbd2bb8b3ef855cd2bcd4e1965ef02a73524eed782b455"
BUILD_ARGS = {"CUDA_VERSION": "12.4.0", "UBUNTU_VERSION": "22.04", "CUDA_DOCKER_ARCH": "61"}
K2_OUTPUT_IDS = [16, 13, 3731, 198, 17, 13, 3731, 198, 18, 13, 3731, 198, 19, 13, 3731, 198,
                 20, 13, 3731, 198, 21, 13, 3731, 198, 22, 13, 3731, 198, 23, 13, 3731, 198]
K13_HOST = {"hostname": "omarchy-desktop", "cpu_count": 16, "mem_total_bytes": 67340988416}
K13_GPU = {"gpu_uuid": "GPU-2204ae42-2bdf-1439-aa06-59c98ac3b546", "driver_version": "580.178.04"}
ISLS = (64, 256, 1024)
BLOCK_ORDERS = [(64, 256, 1024), (256, 1024, 64), (1024, 64, 256)]
OSL = 32
WARMUPS = 3
MEASURED = 8
CONTROL_PAIRS = 3
PHASES = ("warmup", "normal", "diagnostic", "control", "failure")
PROM_JOBS = ("client", "dcgm", "node", "server")
BUCKETS_S = (0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1.0, 2.0, 5.0)
CHECKPOINTS = ("after_replay", "before_failure", "final")
GUARD_MS = 15.0
HISTOGRAM_SUM_TOL_S = 1e-12
ENGINE_SECONDS_TOL_S = 1e-9
OFFSET_WIDTH_MAX_MS = 0.25
SEGMENT_SUM_TOL_MS = 1e-9
LAUNCH_MINUS_PROMPT_MS = (0.0, 0.1)
DECODE_MINUS_PREDICTED_MS = (-0.1, 0.0)


def load(path: Path):
    return json.loads(path.read_text())


def ms(record: dict, end: str) -> float:
    return (record[end] - record["send_ns"]) / 1e6


def p50(values: list[float]) -> float:
    return float(np.quantile(values, 0.5, method="linear"))


def has_content(event: dict) -> bool:
    return bool(event["choices"]) and bool(event["choices"][0]["delta"].get("content"))


@pytest.fixture(scope="module")
def records() -> dict[str, dict]:
    loaded = (load(p) for p in (RUN_DIR / "client").glob(f"{RUN_ID}-*.json"))
    return {r["request_id"]: r for r in loaded}


@pytest.fixture(scope="module")
def steps() -> list[dict]:
    return load(EVIDENCE / "steps.json")


@pytest.fixture(scope="module")
def step_records(records) -> dict[int, list[dict]]:
    out = {}
    for path in sorted((RUN_DIR / "control").glob("step_*.json")):
        ids = [request["request_id"] for request in load(path)["requests"]]
        out[int(path.stem.split("_")[1])] = sorted((records[i] for i in ids), key=lambda r: r["send_ns"])
    return out


@pytest.fixture(scope="module")
def audit() -> dict:
    path = RUN_DIR / "audit" / "hf_parity.json"
    if not path.exists():
        pytest.fail(f"no {path.relative_to(REP_DIR)}: run audit.py {RUN_ID} first")
    return load(path)


@pytest.fixture(scope="module")
def split() -> dict:
    return load(RUN_DIR / "analysis" / "split_s0.json")


def replay_steps(steps: list[dict], phase: str) -> list[dict]:
    return [s for s in steps if s["control"] is None and s["phase"] == phase]


def detailed_complete(records: dict) -> list[dict]:
    return [r for r in records.values() if r["complete"] and r.get("detail", True)]


# --- 1. Built service versus pinned model audit -------------------------------------------------------------

def test_p1a_source_build_and_own_image():
    image = load(EVIDENCE / "server_image.json")
    assert image["source_commit"] == K1_COMMIT
    assert image["dockerfile_sha256"] == K1_DOCKERFILE_SHA256
    assert image["build_args"] == BUILD_ARGS and image["target"] == "server"
    servers = [c for c in load(EVIDENCE / "containers_inspect.json")
               if c["Config"]["Labels"].get("com.docker.compose.service") == "server"]
    assert len(servers) == 1 and servers[0]["Image"] == image["image_id"]


def test_p1b_isl(audit, records):
    assert {row["isl"]: row["hf_input_len"] for row in audit["rows"]} == {isl: isl for isl in ISLS}
    for record in records.values():
        if record["usage"] is not None:
            assert record["usage"]["prompt_tokens"] == record["isl"], record["request_id"]


def test_p1c_greedy_output_ids(audit):
    assert sorted(row["isl"] for row in audit["rows"]) == list(ISLS)
    for row in audit["rows"]:
        assert row["hf_output_ids"] == K2_OUTPUT_IDS
        assert any(s["control"] == "audit" for s in row["server"]), f"ISL {row['isl']}: no audit request"
        for server in row["server"]:
            assert server["output_ids"] == row["hf_output_ids"], server["request_id"]


def test_p1d_output_count(audit, records):
    for row in audit["rows"]:
        assert len(row["hf_output_ids"]) == OSL
        assert all(len(s["output_ids"]) == s["completion_tokens"] == OSL for s in row["server"])
    for record in records.values():
        if record["complete"]:
            assert record["usage"]["completion_tokens"] == OSL, record["request_id"]


# --- 2. Client record versus supported protocol/clock evidence ----------------------------------------------

def test_p2d_events_usage_status_match_the_raw_response(records):
    checked = detailed_complete(records)
    assert checked
    for record in checked:
        events = record["events"]
        assert record["status"] == 200
        first = events[0]["event"]["choices"][0]["delta"]
        assert first["role"] == "assistant" and not first.get("content"), record["request_id"]
        assert next(e["ns"] for e in events if has_content(e["event"])) == record["first_content_ns"]
        finishes = [e["event"]["choices"][0]["finish_reason"] for e in events
                    if e["event"]["choices"] and e["event"]["choices"][0]["finish_reason"]]
        assert finishes == [record["finish_reason"]]
        last = events[-1]["event"]
        assert last["choices"] == [] and last["usage"] == record["usage"] and last.get("timings") == record["timings"]
        times = [e["ns"] for e in events]
        assert times == sorted(times)
        assert (record["send_ns"] <= record["headers_ns"] <= record["first_content_ns"]
                <= record["protocol_complete_ns"] <= record["close_ns"])


def test_p2e_normal_exact_itl_and_eof_unavailable(records):
    for record in records.values():
        assert {"transport_eof_ms", "exact_itl_ms"} <= set(chat_durations(record)["unavailable"])
    normal = [r for r in detailed_complete(records) if not r.get("diagnostic")]
    assert normal
    for record in normal:
        assert not any(e["event"]["choices"] and e["event"]["choices"][0].get("logprobs") for e in record["events"])


def failure_record(records: dict, condition: str) -> dict:
    [record] = [r for r in records.values() if r.get("control") == "failure" and r.get("condition") == condition]
    return record


def test_p2f_failure_completeness_matches_k12(records):
    kill = failure_record(records, "midstream_kill")
    assert kill["status"] == 200 and kill["complete"] is False and kill["usage"] is None
    assert kill["error"]["type"] == "APIConnectionError"
    assert any(has_content(e["event"]) for e in kill["events"])
    durations = chat_durations(kill)
    assert durations["e2e_ms"] is None and durations["attempt_ms"] > durations["ttft_ms"] > 0

    down = failure_record(records, "server_down")
    assert down["status"] is None and down["headers_ns"] is None and down["complete"] is False
    assert down["error"]["type"] == "APIConnectionError"


# --- 3. Records versus collection/display -------------------------------------------------------------------

def metric_samples(path: Path) -> dict:
    samples = {}
    for family in text_string_to_metric_families(path.read_text()):
        for sample in family.samples:
            samples[(sample.name, tuple(sorted(sample.labels.items())))] = sample.value
    return samples


def server_counters(path: Path) -> dict[str, float]:
    lines = [line.split() for line in path.read_text().splitlines() if line and not line.startswith("#")]
    return {name: float(value) for name, value in lines}


def checkpoint(label: str) -> dict:
    return load(EVIDENCE / f"checkpoint_{label}.json")


def exported_before(label: str, step_records: dict) -> list[dict]:
    """Records the client exported to Prometheus before this checkpoint, in send order."""
    done = checkpoint(label)["steps_done"]
    sent = [r for index, recs in step_records.items() if index < done for r in recs]
    return sorted((r for r in sent if r.get("detail", True)), key=lambda r: r["send_ns"])


@pytest.mark.parametrize("label", CHECKPOINTS)
def test_p3a_requests_errors_usage(label, step_records):
    exported = exported_before(label, step_records)
    assert len(exported) == checkpoint(label)["exported"]
    samples = metric_samples(EVIDENCE / f"client_metrics_{label}.txt")
    for phase in PHASES:
        mine = [r for r in exported if r["phase"] == phase]
        done = [r for r in mine if r["complete"]]
        assert samples[("ie_client_requests_total", (("outcome", "complete"), ("phase", phase)))] == len(done)
        assert samples[("ie_client_requests_total", (("outcome", "incomplete"), ("phase", phase)))] == (
            len(mine) - len(done))
        assert samples[("ie_client_tokens_total", (("direction", "input"), ("phase", phase)))] == sum(
            r["usage"]["prompt_tokens"] for r in done)
        assert samples[("ie_client_tokens_total", (("direction", "output"), ("phase", phase)))] == sum(
            r["usage"]["completion_tokens"] for r in done)


def histogram_values(label: str, step_records: dict, phase: str, end: str) -> list[float]:
    # The client observes (end - send) / 1e9 for complete records; rebuild the identical float.
    return [(r[end] - r["send_ns"]) / 1e9 for r in exported_before(label, step_records)
            if r["phase"] == phase and r["complete"]]


METRIC_ENDS = [("ttft", "first_content_ns"), ("e2e", "protocol_complete_ns")]


@pytest.mark.parametrize("label", CHECKPOINTS)
@pytest.mark.parametrize("metric,end", METRIC_ENDS)
def test_p3b_bucket_and_count_reconstruction(label, metric, end, step_records):
    samples = metric_samples(EVIDENCE / f"client_metrics_{label}.txt")
    les = [floatToGoString(bound) for bound in BUCKETS_S] + ["+Inf"]
    for phase in PHASES:
        values = histogram_values(label, step_records, phase, end)
        scraped = [samples[(f"ie_client_{metric}_seconds_bucket", (("le", le), ("phase", phase)))] for le in les]
        assert scraped == histogram_counts(values, BUCKETS_S), phase
        assert samples[(f"ie_client_{metric}_seconds_count", (("phase", phase),))] == len(values)


@pytest.mark.parametrize("label", CHECKPOINTS)
@pytest.mark.parametrize("metric,end", METRIC_ENDS)
def test_p3c_histogram_sum(label, metric, end, step_records):
    samples = metric_samples(EVIDENCE / f"client_metrics_{label}.txt")
    for phase in PHASES:
        values = histogram_values(label, step_records, phase, end)
        scraped = samples[(f"ie_client_{metric}_seconds_sum", (("phase", phase),))]
        assert abs(scraped - sum(values)) <= HISTOGRAM_SUM_TOL_S, phase


def server_lifetime_complete(label: str, steps: list[dict], step_records: dict) -> list[dict]:
    """Complete records on the server start that this checkpoint snapshotted, up to the snapshot."""
    marker = checkpoint(label)
    lifetime = [s["step"] for s in steps if s["server_start"] == marker["server_start"] and s["step"] < marker["steps_done"]]
    return [r for index in lifetime for r in step_records[index] if r["complete"]]


@pytest.mark.parametrize("label", CHECKPOINTS)
def test_p3d_engine_token_counters_equal_usage(label, steps, step_records):
    done = server_lifetime_complete(label, steps, step_records)
    counters = server_counters(EVIDENCE / f"server_metrics_{label}.txt")
    assert counters["llamacpp:prompt_tokens_total"] == sum(r["usage"]["prompt_tokens"] for r in done)
    assert counters["llamacpp:tokens_predicted_total"] == sum(r["usage"]["completion_tokens"] for r in done)


@pytest.mark.parametrize("label", CHECKPOINTS)
def test_p3e_engine_seconds_equal_truncated_sums(label, steps, step_records):
    timings = [r["timings"] for r in server_lifetime_complete(label, steps, step_records)]
    counters = server_counters(EVIDENCE / f"server_metrics_{label}.txt")
    assert abs(counters["llamacpp:prompt_seconds_total"] - engine_counter_seconds(timings, "prompt")) <= (
        ENGINE_SECONDS_TOL_S)
    assert abs(counters["llamacpp:tokens_predicted_seconds_total"]
               - engine_counter_seconds(timings, "generation")) <= ENGINE_SECONDS_TOL_S


def test_p3f_host_identity():
    live = load(EVIDENCE / "host_identity.json")
    assert {k: live[k] for k in K13_HOST} == K13_HOST
    assert {k: live[k] for k in K13_GPU} == K13_GPU
    node = load(EVIDENCE / "prometheus" / "range_node.json")["data"]["result"]
    assert {s["metric"]["nodename"] for s in node if s["metric"]["__name__"] == "node_uname_info"} == {
        live["hostname"]}
    memory = {float(v) for s in node if s["metric"]["__name__"] == "node_memory_MemTotal_bytes" for _, v in s["values"]}
    assert memory == {live["mem_total_bytes"]}
    cpus = {s["metric"]["cpu"] for s in node if s["metric"]["__name__"] == "node_cpu_seconds_total"}
    assert len(cpus) == live["cpu_count"]
    dcgm = [s for s in load(EVIDENCE / "prometheus" / "range_dcgm.json")["data"]["result"]
            if s["metric"]["__name__"].startswith("DCGM_FI_")]  # skip Prometheus's own up/scrape_* series
    assert dcgm and {(s["metric"]["UUID"], s["metric"]["DCGM_FI_DRIVER_VERSION"]) for s in dcgm} == {
        (live["gpu_uuid"], live["driver_version"])}


def test_p3g_targets_rule_and_recovery(records):
    targets = load(EVIDENCE / "prometheus" / "targets.json")["data"]["activeTargets"]
    assert sorted(t["labels"]["job"] for t in targets) == list(PROM_JOBS)
    assert all(t["health"] == "up" for t in targets)
    failure = load(EVIDENCE / "failure.json")
    states = [s["state"] for s in failure["rule"]]
    transitions = [state for i, state in enumerate(states) if i == 0 or state != states[i - 1]]
    assert transitions == ["inactive", "pending", "firing", "inactive"]
    statuses = [h.get("status") for h in failure["health"]]
    assert statuses[-1] == 200 and 503 in statuses[:-1]
    recovery = [r for r in records.values() if r.get("control") == "failure" and r.get("condition") == "recovery"]
    assert len(recovery) == 3 and all(r["complete"] for r in recovery)


# --- 4. Prompt-length conclusion versus repeated client/engine evidence -------------------------------------

def test_p4a_counts_order_and_peak_concurrency(steps, step_records, records):
    normal = replay_steps(steps, "normal")
    assert [(s["block"], s["isl"]) for s in normal] == [
        (block, isl) for block, order in enumerate(BLOCK_ORDERS) for isl in order]
    for step in normal:
        assert len(step_records[step["step"]]) == MEASURED
        assert all(r["complete"] for r in step_records[step["step"]])
    for step in replay_steps(steps, "warmup"):
        assert len(step_records[step["step"]]) == WARMUPS
    ordered = sorted(records.values(), key=lambda r: r["send_ns"])
    for earlier, later in zip(ordered, ordered[1:]):
        assert later["send_ns"] >= earlier["close_ns"], later["request_id"]


def locust_duration_ms(record: dict) -> float:
    end = record["protocol_complete_ns"] if record["complete"] else record["close_ns"]
    return (end - record["send_ns"]) / 1e6


def test_p4b_locust_summaries_match_bucket_and_rank_reconstruction(steps, step_records):
    for step in steps:
        entry = load(RUN_DIR / "client" / f"step_{step['step']:04d}.done.json")["locust"][0]
        records = step_records[step["step"]]
        durations = [locust_duration_ms(r) for r in records]
        assert entry["num_requests"] == len(records)
        assert entry["num_failures"] == sum(not r["complete"] for r in records)
        assert entry["response_times"] == {str(k): v for k, v in locust_response_times(durations).items()}
        assert entry["median_ms"] == locust_median_ms(durations)
        assert entry["p95_ms"] == locust_percentile_ms(durations, 0.95)


def replay_e2e(step_records: dict, step: dict) -> list[float]:
    return [ms(r, "protocol_complete_ns") for r in step_records[step["step"]]]


def test_p4c_half_p50_difference(steps, step_records):
    for step in replay_steps(steps, "normal"):
        difference = half_p50_difference_ms(replay_e2e(step_records, step))
        assert abs(difference) <= GUARD_MS, f"step {step['step']} ISL {step['isl']}: {difference:.3f} ms"


def test_p4d_repeat_p50_range(steps, step_records):
    for isl in ISLS:
        medians = [p50(replay_e2e(step_records, s)) for s in replay_steps(steps, "normal") if s["isl"] == isl]
        assert len(medians) == len(BLOCK_ORDERS)
        assert max(medians) - min(medians) <= GUARD_MS, f"ISL {isl}: {medians}"


def control_e2e_p50_difference(records: dict, control: str, pair: int) -> float:
    def measured(condition):
        return [ms(r, "protocol_complete_ns") for r in records.values()
                if r.get("control") == control and r.get("pair") == pair and r.get("condition") == condition
                and r["phase"] != "warmup"]
    on, off = measured("on"), measured("off")
    assert len(on) == len(off) == 4
    return p50(on) - p50(off)


@pytest.mark.parametrize("pair", range(1, CONTROL_PAIRS + 1))
def test_p4e_log_capture_p50_difference(records, pair):
    assert abs(control_e2e_p50_difference(records, "logging", pair)) <= GUARD_MS


@pytest.mark.parametrize("pair", range(1, CONTROL_PAIRS + 1))
def test_p4f_observer_p50_difference(records, pair):
    assert abs(control_e2e_p50_difference(records, "observer", pair)) <= GUARD_MS


# --- 5. Request decomposition versus client, capture and server-log clocks ----------------------------------

def test_p5a_every_s0_request_joined(split, steps, step_records):
    s0 = [r for s in steps if s["server_start"] == 0 for r in step_records[s["step"]]]
    assert split["joined"] == len(s0)
    decomposable = {r["request_id"] for r in s0 if r["complete"] and r.get("detail", True)}
    assert {row["request_id"] for row in split["rows"]} == decomposable
    measured = {r["request_id"] for s in replay_steps(steps, "normal") for r in step_records[s["step"]]}
    assert len(measured) == len(ISLS) * len(BLOCK_ORDERS) * MEASURED and measured <= decomposable


def test_p5b_log_prompt_tokens_equal_usage(split, records):
    for row in split["rows"]:
        assert row["n_prompt"] == records[row["request_id"]]["usage"]["prompt_tokens"], row["request_id"]


def test_p5c_offset_interval(split):
    low, high = split["offset_ns_interval"]
    assert low <= high
    assert (high - low) / 1e6 <= OFFSET_WIDTH_MAX_MS


def test_p5d_smallest_segment_not_negative(split):
    assert min(s["ms"] for row in split["rows"] for s in row["ttft"] + row["e2e"]) >= 0


def test_p5e_segments_sum_to_ttft_and_e2e(split, records):
    for row in split["rows"]:
        durations = chat_durations(records[row["request_id"]])
        assert abs(sum(s["ms"] for s in row["ttft"]) - durations["ttft_ms"]) <= SEGMENT_SUM_TOL_MS
        assert abs(sum(s["ms"] for s in row["e2e"]) - durations["e2e_ms"]) <= SEGMENT_SUM_TOL_MS


def measured_rows(split: dict) -> list[dict]:
    rows = [r for r in split["rows"] if r["phase"] == "normal" and r["control"] is None]
    assert len(rows) == len(ISLS) * len(BLOCK_ORDERS) * MEASURED
    return rows


def segment_ms(row: dict, path: str, name: str) -> float:
    return next(s["ms"] for s in row[path] if s["name"] == name)


def test_p5f_launch_to_first_send_minus_prompt_ms(split, records):
    low, high = LAUNCH_MINUS_PROMPT_MS
    for row in measured_rows(split):
        difference = segment_ms(row, "ttft", "launch_to_first_result") - records[row["request_id"]]["timings"]["prompt_ms"]
        assert low <= difference <= high, f"{row['request_id']}: {difference:.6f} ms"


def test_p5g_first_send_to_release_minus_predicted_ms(split, records):
    low, high = DECODE_MINUS_PREDICTED_MS
    for row in measured_rows(split):
        difference = segment_ms(row, "e2e", "decode") - records[row["request_id"]]["timings"]["predicted_ms"]
        assert low <= difference <= high, f"{row['request_id']}: {difference:.6f} ms"
