import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "devtools" / "backend"))
from lifecycle import Lifecycle  # noqa: E402

S = 10**9  # ns per second


def test_phases_start_at_their_marker_lines_in_order():
    life = Lifecycle(started_ns=0)
    log = [
        (25 * S, "[TensorRT-LLM] TensorRT LLM version: 1.2.1"),
        (30 * S, "[TensorRT-LLM][INFO] [MemUsageChange] Allocated 0.02 GiB for max tokens"),  # not a marker
        (38 * S, "[TRT-LLM] [I] Use 1.17 GB for model weights."),
        (39 * S, "[TRT-LLM] [I] [Autotuner] Autotuning process starts ..."),
        (61 * S, "[TRT-LLM] [I] [Autotuner] Autotuning process ends"),
        (62 * S, "[TRT-LLM] [I] [Autotuner] Autotuning process starts ..."),  # the rebuild's rerun: ignored
    ]
    started = [line for ns, line in log if life.feed(ns, line)]
    assert len(started) == 4
    assert [m["phase"] for m in life.marks] == [
        "API process: Python imports", "API process: server setup", "weights: load", "autotuner", "CUDA graph capture"]
    assert life.marks[1]["values"] == ["1.2.1"] and life.marks[2]["values"] == ["1.17"]
    assert life.lines(3) == (39 * S, 61 * S)  # the autotuner phase, [start, end)


def test_serving_ends_the_startup_and_is_open_ended():
    life = Lifecycle(started_ns=0)
    life.feed(64 * S, "INFO:     Application startup complete.")
    life.add("serving", 66 * S, "Docker: health_status: healthy")
    assert not life.feed(70 * S, "[TRT-LLM] [I] Autotuning process starts")  # nothing after serving
    assert life.lines(len(life.marks) - 1) == (66 * S, None)
