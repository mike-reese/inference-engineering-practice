"""GET /api/v3/reps and the moments lint (devtools/backend/store/reps.py): the D13 session shape, path resolution, and
a lint that fails on a moment whose path or event does not resolve in a run."""
import json
import sys
from pathlib import Path

import duckdb

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "devtools" / "backend"))
from store import reps  # noqa: E402

LATENCY = {"run1-warmup": {"client": {"ttft_ms": 9.0}},
           "run1-measured": {"client": {"ttft_ms": 12.5, "note": "x", "series": [1, 2]}, "engine": {"queue_ms": 1.5},
                             "wire": {}, "remainder": {},
                             "segments": [{"name": "send -> wire", "ms": 1.0},
                                          {"name": "first_scheduled_time -> first_token_time", "ms": 7.0}]}}
MOMENTS = """request = "measured"
[[moments]]
id = "first-token"
title = "t"
lesson = "l"
at = "client.ttft_ms"
event = "event: token"
evidence = [{ label = "prefill", path = "segments[first_scheduled_time].ms" },
            { label = "queue", path = "engine.queue_ms" }]
"""


def make(tmp: Path, moments: str, names: list[str]) -> tuple[Path, Path]:
    repo, store = tmp / "repo", tmp / "store"
    rep = repo / "reps" / "X1-L1_thing"
    run_dir = rep / "results" / "run1_20261108T000000Z_abc"
    run_dir.mkdir(parents=True)
    (rep / "README.md").write_text("# X1-L1 -- A thing\n\n## Mechanism\nHow.\n\n## Task\nDo.\n\n## Other\nskip\n")
    (rep / "rep.toml").write_text('id = "X1-L1"\ncompose_projects = ["ie-x1"]\n'
                                  '[[actions]]\nid = "off"\nlabel = "Off"\n')
    (rep / "moments.toml").write_text(moments)
    (run_dir / "labels.json").write_text(json.dumps({"trace": "off"}))
    (run_dir / "latency.json").write_text(json.dumps(LATENCY))
    g = store / "runs" / run_dir.name / "g1"
    g.mkdir(parents=True)
    (g.parent / "manifest.json").write_text(json.dumps({
        "run": run_dir.name, "generation": 1, "status": "final", "requests": ["run1-warmup", "run1-measured"],
        "names": names, "source": {"run_dir": str(run_dir.relative_to(repo))}}))
    con = duckdb.connect()
    con.execute("create table e as select * from (values (0, 1, 0), (1, 1, 1), (2, 0, 2)) t(id, req, name)")
    con.execute(f"copy e to '{g}/events-b0.parquet' (format parquet)")
    return repo, store


def test_catalog_has_the_d13_session_shape(tmp_path):
    repo, store = make(tmp_path, MOMENTS, ["response headers", "event: token", "other"])
    cat = reps.catalog(repo, store)
    rep, = cat["reps"]
    assert set(rep) == {"id", "title", "folder", "registered", "actions", "sections", "moments"}
    assert rep["title"] == "A thing" and rep["registered"] and set(rep["sections"]) == {"Mechanism", "Task"}
    assert rep["actions"] == [{"id": "off", "group": None, "label": "Off", "description": None, "measured": None,
                               "minutes": None, "options": []}]
    run, = cat["runs"]
    assert run["rep"] == "X1-L1" and run["labels"] == {"trace": "off"} and run["started"] == "20261108T000000Z"
    assert run["result"]["request_id"] == "run1-measured"
    assert run["result"]["client"] == {"ttft_ms": 12.5, "note": "x"}          # scalars only


def test_value_at_picks_a_segment_by_name_start():
    result = reps.measured(LATENCY, "measured")
    assert reps.value_at(result, "segments[first_scheduled_time].ms") == 7.0
    assert reps.value_at(result, "segments[1].ms") == 7.0
    assert reps.value_at(result, "engine.missing") is None


def test_lint_passes_then_fails_on_a_missing_event_or_path(tmp_path):
    repo, store = make(tmp_path / "a", MOMENTS, ["response headers", "event: token", "other"])
    assert reps.lint(None, repo, store)[0] == []
    repo, store = make(tmp_path / "b", MOMENTS.replace('"event: token"', '"SDK yields the token"'),
                       ["response headers", "event: token", "other"])
    misses = reps.lint(None, repo, store)[0]
    assert len(misses) == 1 and "SDK yields the token" in misses[0]
    repo, store = make(tmp_path / "c", MOMENTS.replace("engine.queue_ms", "engine.prefill_ms"),
                       ["response headers", "event: token", "other"])
    misses = reps.lint(None, repo, store)[0]
    assert len(misses) == 1 and "engine.prefill_ms" in misses[0]


def test_a_run_without_results_is_listed_and_a_rep_with_none_fails(tmp_path):
    repo, store = make(tmp_path, MOMENTS, ["nothing"])
    (repo / "reps" / "X1-L1_thing" / "results" / "run1_20261108T000000Z_abc" / "latency.json").unlink()
    misses, notes = reps.lint(None, repo, store)
    assert any("results not computed" in n for n in notes)
    assert len(misses) == 1 and "resolve on no run" in misses[0]
    assert reps.catalog(repo, store)["runs"][0]["result"] is None


def test_moments_read_the_result_file_they_name_whole(tmp_path):
    moments = MOMENTS.replace('request = "measured"', 'request = "measured"\nresult = "analysis/readout.json"')
    moments = moments.replace("client.ttft_ms", "clients.B.ttft_ms").replace("segments[first_scheduled_time].ms",
                                                                         "queue.sum_ms")
    repo, store = make(tmp_path, moments.replace("engine.queue_ms", "clients.A.ttft_ms"),
                       ["response headers", "event: token", "other"])
    run_dir = repo / "reps" / "X1-L1_thing" / "results" / "run1_20261108T000000Z_abc"
    (run_dir / "analysis").mkdir()
    readout = {"clients": {"A": {"ttft_ms": 40.0}, "B": {"ttft_ms": 2700.0}}, "queue": {"sum_ms": 2690.0}}
    (run_dir / "analysis" / "readout.json").write_text(json.dumps(readout))
    assert reps.catalog(repo, store)["runs"][0]["result"] == readout
    assert reps.lint(None, repo, store)[0] == []
    (run_dir / "analysis" / "readout.json").write_text(json.dumps({"clients": {"A": {"ttft_ms": 40.0}}}))
    misses = reps.lint(None, repo, store)[0]
    assert len(misses) == 2 and all("clients.B.ttft_ms" in m or "queue.sum_ms" in m for m in misses)


def test_a_run_whose_complete_value_is_false_keeps_its_result_and_names_the_request(tmp_path):
    moments = MOMENTS.replace('request = "measured"', 'request = "measured"\nresult = "readout.json"\n'
                                                      'complete = "clients.B.complete"')
    moments = moments.replace("client.ttft_ms", "clients.B.ttft_ms").replace("segments[first_scheduled_time].ms",
                                                                         "clients.A.ttft_ms")
    repo, store = make(tmp_path, moments.replace("engine.queue_ms", "clients.A.ttft_ms"),
                       ["response headers", "event: token", "other"])
    run_dir = repo / "reps" / "X1-L1_thing" / "results" / "run1_20261108T000000Z_abc"
    failed = {"clients": {"A": {"complete": True, "ttft_ms": 40.0}, "B": {"complete": False, "ttft_ms": None}}}
    (run_dir / "readout.json").write_text(json.dumps(failed))
    misses, notes = reps.lint(None, repo, store)
    run = reps.catalog(repo, store)["runs"][0]
    assert run["result"] == failed and run["incomplete"] == "measured"
    assert any("request measured did not complete" in n and "clients.B.complete" in n for n in notes)
    assert len(misses) == 1 and "resolve on no run" in misses[0]
    done = {"clients": {"A": {"complete": True, "ttft_ms": 40.0}, "B": {"complete": True, "ttft_ms": 2700.0}}}
    (run_dir / "readout.json").write_text(json.dumps(done))
    run = reps.catalog(repo, store)["runs"][0]
    assert run["result"] == done and run["incomplete"] is None
    assert reps.lint(None, repo, store)[0] == []
