"""I02C v1 devtools additions, on slices of the author's QA pair 0 (tests/fixtures/make_i02c_unpaired.py):
the collector's raw /metrics persistence, and the unpaired native replay with its aggregate metrics."""
import asyncio
import importlib.util
import json
import shutil
import sys
from pathlib import Path

from aiohttp import web

from inference_analysis.trace.adapters.engine import NO_JOIN
from inference_analysis.trace.build import build_run

REPO = Path(__file__).resolve().parents[1]
FIXTURE = Path(__file__).parent / "fixtures" / "i02c_unpaired"
CLIENTS = ("I02C-QA-p0-A", "I02C-QA-p0-B")

sys.path.insert(0, str(REPO / "devtools" / "backend"))
spec = importlib.util.spec_from_file_location("engine_collector_raw", REPO / "devtools/backend/collectors/engine.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class Bus:
    def __init__(self, containers):
        self.state = {("containers", None): {"data": containers}}
        self.published = []

    def publish(self, topic, data, key=None):
        self.published.append((topic, data))


def read_all(monkeypatch, responses):
    """Run the collector's reader against a fake engine serving `responses` (a list, or a str: an invalid body), then
    a 503 as the engine stops. Returns (collector, bus)."""
    monkeypatch.setenv("REPO_HOST", "/host/repo")
    monkeypatch.setenv("REPO", "/repo")
    c = {"id": "c1", "name": "server-1", "project": "p", "service": "server", "state": "running",
         "mounts": [{"destination": "/config", "source": "/host/repo/reps/X/results/RUN1"}]}
    bus = Bus([c])
    engine = collector.EngineCollector(bus)
    served = []

    async def metrics(request):
        if len(served) == len(responses):
            bus.state[("containers", None)]["data"] = []  # the engine stops: the reader's loop ends
            return web.Response(status=503, text="stopping")
        served.append(responses[len(served)])
        r = served[-1]
        return web.Response(status=200, text=r) if isinstance(r, str) else web.json_response(r)

    async def main():
        app = web.Application()
        app.router.add_get("/metrics", metrics)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        await engine.read_iterations(c, f"127.0.0.1:{port}")
        await runner.cleanup()

    asyncio.run(main())
    return engine, bus


def test_raw_reads_held_in_reader_order_with_repeats_empty_and_failed(monkeypatch):
    responses = json.loads((FIXTURE / "metrics_reads.json").read_text())
    engine, bus = read_all(monkeypatch, ["not json", *responses])
    held = engine.raw_reads(run_id="RUN1")
    assert (held["run_id"], held["container"], held["dropped"], held["reading"]) == ("RUN1", "server-1", 0, False)
    lines = held["reads"]
    assert held["retained"] == len(lines) == 5 and [x["reader_seq"] for x in lines] == [1, 2, 3, 4, 5]
    assert lines[0]["error"].startswith("JSONDecodeError") and lines[0]["body"] == "not json"  # failed read kept
    assert [x["response"] for x in lines[1:4]] == responses  # unmodified, in reader order
    assert [s["iter"] for s in lines[1]["response"]].count(132) == 2  # the repeat is kept
    assert (lines[3]["empty"], lines[3]["entries"]) == (True, 0)
    assert (lines[4]["status"], lines[4]["response"], lines[4]["body"]) == (503, None, "stopping")
    assert [x["first_seq"] for x in lines] == [None, 1, 8, None, None]
    assert all(x["read_start_ns"] <= x["read_end_ns"] for x in lines)
    assert engine.raw_reads(container="server-1") == held
    assert not [d for topic, d in bus.published if topic == "event"]  # no write, so no write warning
    published = [it["iter"] for topic, d in bus.published if topic == "engine_iterations" for it in d["iterations"]]
    assert published == [s["iter"] for r in responses for s in r]  # live publishing unchanged


def test_raw_reads_bound_counts_evictions(monkeypatch):
    monkeypatch.setattr(collector, "KEEP_READS", 2)
    responses = json.loads((FIXTURE / "metrics_reads.json").read_text())
    held = read_all(monkeypatch, responses)[0].raw_reads(run_id="RUN1")
    assert ([x["reader_seq"] for x in held["reads"]], held["retained"], held["dropped"]) == ([3, 4], 2, 2)


def test_raw_route_matches_run_and_404s_unknown(monkeypatch):
    from aiohttp.test_utils import TestClient, TestServer
    spec = importlib.util.spec_from_file_location("devtools_app", REPO / "devtools/backend/app.py")
    app_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(app_module)
    engine = read_all(monkeypatch, json.loads((FIXTURE / "metrics_reads.json").read_text()))[0]

    async def main():
        app = web.Application()
        app["engine"] = engine
        app.router.add_get("/api/engine/iterations/raw", app_module.engine_iterations_raw)
        async with TestClient(TestServer(app)) as client:
            ok = await client.get("/api/engine/iterations/raw", params={"run_id": "RUN1"})
            missing = await client.get("/api/engine/iterations/raw", params={"run_id": "NOPE"})
            bare = await client.get("/api/engine/iterations/raw")
            return ok.status, await ok.json(), missing.status, await missing.json(), bare.status

    status, body, missing, error, bare = asyncio.run(main())
    assert status == 200 and set(body) == {"run_id", "container", "reads", "retained", "dropped", "reading"}
    assert body["run_id"] == "RUN1" and [x["reader_seq"] for x in body["reads"]] == [1, 2, 3, 4]
    assert missing == 404 and "NOPE" in error["error"] and bare == 400


def build(tmp_path: Path, reverse: bool = False):
    run = tmp_path / ("reversed" if reverse else "run")
    shutil.copytree(FIXTURE, run)
    (run / "metrics_reads.json").unlink()
    if reverse:
        data = json.loads((run / "native_records.json").read_text())
        data["first"].reverse()
        (run / "native_records.json").write_text(json.dumps(data))
    return build_run(run)


def metric(run, name):
    return next(m for m in run.metrics if m.name == name)


def test_unpaired_native_spans_join_no_client(tmp_path):
    run = build(tmp_path)
    native = [s for s in run.spans if s.component == "native"]
    assert len(native) == 4 and all(s.request_id is None for s in native)
    assert {s.attrs["native_request_id"] for s in native} == {3, 4}
    assert {(s.attrs["first_iter"], s.attrs["last_iter"]) for s in native} == {(4, 131), (133, 260)}
    assert all(s.raw["file"] == "native_records.json" for s in native)
    assert run.requests() == list(CLIENTS)  # only the client records carry request IDs
    assert not any(m.request_id is not None for m in run.metrics)  # no per-client native metric
    assert {(u["what"], u["why"]) for u in run.unavailable} == {
        (f"{rid}: native engine {what}", NO_JOIN) for rid in CLIENTS for what in ("queue", "TTFT")}


def test_aggregate_sum_count_and_prometheus_deltas(tmp_path):
    run = build(tmp_path)
    native_sum = metric(run, "native queue sum (unpaired set)")
    assert abs(native_sum.value - 2.749645) < 1e-9 and native_sum.unit == "s"
    assert native_sum.inputs == ("native/3/queue", "native/4/queue")
    assert metric(run, "native queue count (unpaired set)").value == 2
    assert metric(run, "Prometheus success delta").value == 2  # stop 1 -> 1, length absent -> 2
    assert metric(run, "Prometheus queue count delta").value == 2
    prom = metric(run, "Prometheus queue sum delta")
    assert abs(prom.value - 2.749645) < 1e-9 and prom.request_id is None
    assert all(i.startswith("prometheus/") for i in prom.inputs) and len(prom.inputs) == 2
    assert abs(metric(run, "native queue sum - Prometheus queue sum delta").value) < 0.001  # ms
    assert {s["file"] for s in run.sources} >= {"native_records.json", "prometheus_baseline.txt",
                                                "prometheus_final.txt"}


def test_aggregate_does_not_depend_on_native_order(tmp_path):
    forward, backward = build(tmp_path), build(tmp_path, reverse=True)
    assert [(m.name, m.value, m.inputs) for m in forward.metrics] == \
        [(m.name, m.value, m.inputs) for m in backward.metrics]


def test_raw_iterations_replay_in_reader_order(tmp_path, monkeypatch):
    run = build(tmp_path)
    reads = [s for s in run.spans if s.component == "iterations" and s.end_ns != s.start_ns]
    entries = sorted((s for s in run.spans if s.component == "iterations" and s.end_ns == s.start_ns),
                     key=lambda s: (s.attrs["reader_seq"], s.attrs["index"]))
    assert [s.name.split(":")[1].strip() for s in reads] == ["failed", "4 entries", "3 entries", "empty"]
    assert [s.attrs["iter"] for s in entries] == [3, 4, 5, 6, 130, 132, 132]  # the repeat is kept
    assert all(s.request_id is None for s in reads + entries)
    five = next(s for s in entries if s.attrs["iter"] == 5)
    assert (five.attrs["generation"], five.attrs["scheduled"], five.attrs["queued"]) == (1, 1, 1)
    assert five.raw == {"file": "engine_iterations_raw.jsonl", "pointer": "line 2 /response/2"}
    assert "not a duration" in five.attrs["newActiveRequestsQueueLatencyMS_meaning"]
    # the raw pane resolves the pointer to the entry as the engine returned it
    spec = importlib.util.spec_from_file_location("runs_raw", REPO / "devtools/backend/runs.py")
    runs = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runs)
    monkeypatch.setattr(runs, "find_run", lambda run_id: tmp_path / "run")
    assert runs.raw("x", five.raw["file"], five.raw["pointer"])["value"]["iter"] == 5


def test_warmup_client_gets_no_join_entry(tmp_path):
    run = tmp_path / "run"
    shutil.copytree(FIXTURE, run)
    (run / "metrics_reads.json").unlink()
    smoke = json.loads((run / "client" / f"{CLIENTS[0]}.json").read_text())  # a copy of A, marked as the warm-up
    smoke |= {"request_id": "smoke", "phase": "warmup"}
    (run / "client" / "smoke.json").write_text(json.dumps(smoke))
    built = build_run(run)
    whats = {u["what"]: u["why"] for u in built.unavailable}
    assert "smoke: native engine queue" not in whats and "smoke: native engine TTFT" not in whats
    assert whats["smoke: native engine record"] == "excluded warm-up: not in the native population"
    assert all(whats[f"{rid}: native engine {w}"] == NO_JOIN for rid in CLIENTS for w in ("queue", "TTFT"))
