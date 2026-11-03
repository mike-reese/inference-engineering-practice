"""The live Engine view's inputs: one TensorRT-LLM IterationStats -> one iteration, and the runner's report guard."""
import importlib.util
import sys
from pathlib import Path

import pytest
from aiohttp import web

REPO = Path(__file__).resolve().parents[1]


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sys.path.insert(0, str(REPO / "devtools" / "backend"))
engine = load("engine_collector", REPO / "devtools" / "backend" / "collectors" / "engine.py")
runner = load("runner_open", REPO / "scripts" / "runner.py")

# One /metrics entry as TensorRT-LLM 1.2.1 returns it (prefill of a 34-token prompt), trimmed to the fields used.
STAT = {"iter": 66, "iterLatencyMS": 143.26, "timestamp": "11-03-2026 18:52:50.764385", "gpuMemUsage": 10223681536,
        "numActiveRequests": 1, "numNewActiveRequests": 1, "numQueuedRequests": 0, "numCompletedRequests": 0,
        "maxNumActiveRequests": 1, "newActiveRequestsQueueLatencyMS": 0.0002,
        "inflightBatchingStats": {"numScheduledRequests": 1, "numContextRequests": 1, "numCtxTokens": 34,
                                  "numGenRequests": 0, "numPausedRequests": 0},
        "kvCacheStats": {"usedNumBlocks": 2, "freeNumBlocks": 16703, "maxNumBlocks": 16705, "tokensPerBlock": 32,
                         "allocNewBlocks": 130, "reusedBlocks": 0, "cacheHitRate": 0.0}}


def test_iteration_reads_batch_kv_and_the_utc_start():
    it = engine.iteration(STAT)
    assert (it["context_requests"], it["context_tokens"], it["generation_requests"]) == (1, 34, 0)
    assert (it["kv_used_blocks"], it["kv_max_blocks"], it["tokens_per_block"]) == (2, 16705, 32)
    assert it["ns"] == 1793731970764385000  # the container's clock is UTC; µs resolution kept
    assert it["latency_ms"] == 143.26 and it["iter"] == 66


def test_iteration_stats_flag_must_be_on_its_own_line():
    assert engine.ITER_STATS.search("return_perf_metrics: true\nenable_iter_perf_stats: true\n")
    assert not engine.ITER_STATS.search("enable_iter_perf_stats: false\n")
    assert not engine.ITER_STATS.search("# enable_iter_perf_stats: true\n")


def test_open_takes_only_nsight_reports_inside_one_run(tmp_path, monkeypatch):
    run = tmp_path / "reps" / "X" / "results" / "R1"
    (run / "trace").mkdir(parents=True)
    (run / "trace" / "kernels.ncu-rep").write_bytes(b"")
    (run / "config.yaml").write_text("")
    monkeypatch.setattr(runner, "REPO", tmp_path)
    assert runner.report_path("R1", "trace/kernels.ncu-rep").name == "kernels.ncu-rep"
    with pytest.raises(web.HTTPBadRequest):
        runner.report_path("R1", "config.yaml")
    with pytest.raises(web.HTTPNotFound):
        runner.report_path("R1", "../../../../etc/passwd")
    with pytest.raises(web.HTTPNotFound):
        runner.report_path("../R1", "trace/kernels.ncu-rep")
