import json

import pytest

from inference_analysis.trace.build import write_run
from inference_analysis.trace.schema import Metric, Run, Span, validate

MS = 1_000_000


def two_spans(path, run):
    """A stand-in adapter: one client instant and one server interval, read from a file."""
    send_ms = json.loads(path.read_text())["send_ms"]
    run.spans += [
        Span("c.send", "client", "sdk", "send", send_ms * MS, request_id="r1", raw={"file": path.name}),
        Span("s.queue", "server", "executor", "queue", 3 * MS, 4 * MS, request_id="r1"),
    ]
    run.metrics.append(Metric("queue_ms", "s.queue.end - s.queue.start", ("s.queue",), 1.0, "ms", "r1"))


def test_write_run(tmp_path):
    (tmp_path / "client.json").write_text(json.dumps({"send_ms": 1}))
    out = json.loads(write_run(tmp_path, [("client.json", two_spans)]).read_text())
    assert out["schema"] == "ie-run/1"
    assert [s["id"] for s in out["spans"]] == ["c.send", "s.queue"]
    assert out["requests"] == ["r1"]
    assert out["sources"][0]["file"] == "client.json" and len(out["sources"][0]["sha256"]) == 64


def test_validate_finds_a_backwards_span_and_a_dangling_input():
    run = Run("r", spans=[Span("a", "server", "executor", "x", 5 * MS, 4 * MS)],
              metrics=[Metric("m", "b - a", ("a", "b"), 1.0, "ms")])
    problems = validate(run)
    assert any("ends 1.0 ms before it starts" in p for p in problems)
    assert any("['b'] are not spans" in p for p in problems)


def test_an_unsound_run_is_not_written(tmp_path):
    def backwards(path, run):
        run.spans.append(Span("a", "server", "executor", "x", 5, 4))

    (tmp_path / "x.json").write_text("{}")
    with pytest.raises(ValueError, match="not sound"):
        write_run(tmp_path, [("x.json", backwards)])
    assert not (tmp_path / "run.json").exists()
