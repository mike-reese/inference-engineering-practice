"""Container cold starts in the store: the Docker adapter's startup span and the server log's startup phases
(devtools/backend/store/adapters/docker.py, server_log.py)."""
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "devtools" / "backend"))
from store.adapters.base import Ctx  # noqa: E402
from store.adapters.docker import DockerEvents  # noqa: E402
from store.adapters.server_log import ServerLog  # noqa: E402
from store.registry import Registry  # noqa: E402

REG = Registry.load()
S = 1_000_000_000
EPOCH = 1_794_206_400 * S                     # 2026-11-09T06:40:00Z
PROJECT = "ie-i02a-l1"


def ctx(tmp_path: Path) -> Ctx:
    (tmp_path / "topology.json").write_text(json.dumps({"project": PROJECT, "containers": []}))
    return Ctx("run", tmp_path, REG, wall_offset_ns=EPOCH)


def event(t_s: float, container: str, action: str, line: int) -> dict:
    return {"mono_ns": int(t_s * S), "container": f"{PROJECT}-{container}-1", "project": PROJECT,
            "action": action, "line": line}


def rows(r) -> list[dict]:
    return [r.row(i) for i in range(len(r))]


def test_startup_span_runs_from_start_to_first_health_status_even_across_live_reads(tmp_path):
    d = DockerEvents(ctx(tmp_path))
    first = rows(d.feed([event(0.9, "server", "start", 0), event(1.0, "client", "start", 1)]))
    second = rows(d.feed([event(66.3, "server", "health_status: healthy", 2), event(68.9, "client", "die", 3),
                          event(70.0, "server", "health_status: healthy", 4)]))
    assert [r["kind"] for r in first] == ["container event", "container event"]
    [span] = [r for r in second if r["kind"] == "container startup"]
    assert (span["start"], span["end"]) == (int(0.9 * S), int(66.3 * S))
    assert span["eid"] == f"docker/{PROJECT}-server-1/startup#0"
    assert span["lane"] == next(r["lane"] for r in first if r["name"] == "start" and "server" in r["what"])
    assert d.health[span["lane"]] == [int(66.3 * S), int(70.0 * S)]


def test_a_container_without_a_health_status_gets_no_startup_span(tmp_path):
    d = DockerEvents(ctx(tmp_path))
    got = rows(d.feed([event(1.0, "client", "start", 0), event(68.9, "client", "die", 1)])) + rows(d.flush())
    assert [r["kind"] for r in got] == ["container event", "container event"]


LOG = """\
server-1  | 2026-11-09T06:40:01.000000000Z == PyTorch ==
server-1  | 2026-11-09T06:40:26.000000000Z [TensorRT-LLM] TensorRT LLM version: 1.2.1
server-1  | 2026-11-09T06:40:27.000000000Z rank 0 using MpiPoolSession to spawn MPI processes
server-1  | 2026-11-09T06:40:38.000000000Z [TensorRT-LLM] TensorRT LLM version: 1.2.1
Loading weights concurrently: 100%|##########| 488/488
server-1  | 2026-11-09T06:40:39.000000000Z [TensorRT-LLM][INFO] Refreshed the MPI local session
server-1  | 2026-11-09T06:40:40.000000000Z [TRT-LLM] [I] [Autotuner] Autotuning process starts ...
server-1  | 2026-11-09T06:41:04.000000000Z [TRT-LLM] [I] [Autotuner] Autotuning process ends
server-1  | 2026-11-09T06:41:05.000000000Z [TRT-LLM] [I] [Autotuner] Autotuning process starts ...
server-1  | 2026-11-09T06:41:06.500000000Z INFO:     Started server process [1]
server-1  | 2026-11-09T06:41:06.600000000Z INFO:     Application startup complete.
"""


def test_server_log_phases_tile_the_cold_start_and_end_at_the_first_health_status(tmp_path):
    c = ctx(tmp_path)
    d = DockerEvents(c)
    d.feed([event(0.9, "server", "start", 0), event(71.3, "server", "health_status: healthy", 1)])
    (tmp_path / "server_s1.log").write_text(LOG)
    got = rows(ServerLog(c, d.health).read(tmp_path / "server_s1.log"))
    assert [(r["name"], r["start"] / S, r["end"] / S) for r in got] == [
        ("main process imports", 1.0, 26.0),
        ("LLM API setup", 26.0, 27.0),
        ("worker spawn and imports", 27.0, 39.0),
        ("model init and weight load", 39.0, 40.0),
        ("autotuner warmup", 40.0, 64.0),
        ("CUDA graphs, memory profile, KV cache", 64.0, 66.5),
        ("HTTP server startup", 66.5, 66.6),
        ("waiting for the healthcheck", 66.6, 71.3),
    ]
    assert {r["kind"] for r in got} == {"startup phase"} and len({r["lane"] for r in got}) == 1
    assert got[0]["lane"] == next(iter(d.health))


def test_a_missing_marker_stops_the_phases_and_is_counted(tmp_path):
    c = ctx(tmp_path)
    (tmp_path / "server_s1.log").write_text("".join(x for x in LOG.splitlines(True) if "Autotuning" not in x))
    got = rows(ServerLog(c, {}).read(tmp_path / "server_s1.log"))
    assert [r["name"] for r in got] == ["main process imports", "LLM API setup", "worker spawn and imports"]
    assert any("autotuner warmup" in k for k in c.stats["server_log"])
