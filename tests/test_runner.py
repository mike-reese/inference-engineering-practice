"""The devtools runner's registry: every reps/*/rep.toml parses and declares commands that point at real files."""
import importlib.util
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("runner", REPO / "scripts" / "runner.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def test_every_manifest_parses_with_unique_actions():
    reps = runner.manifests()
    assert reps, "no reps/*/rep.toml"
    for rep in reps.values():
        assert "error" not in rep, rep.get("error")
        ids = [a["id"] for a in rep["actions"]]
        assert len(ids) == len(set(ids)), f"{rep['id']}: duplicate action ids"
        assert rep.get("compose_projects"), f"{rep['id']}: the runner needs the projects to check before a start"


def test_commands_resolve_to_files_in_the_rep():
    for rep in runner.manifests().values():
        for action in rep["actions"]:
            assert all("{" not in part for part in action["argv"]), action["argv"]
            scripts = [p for p in action["argv"] if p.endswith(".py")]
            assert scripts and all((REPO / p).is_file() for p in scripts), (rep["id"], action["id"], scripts)


def test_progress_log_patterns_compile_and_match_their_label_groups():
    import re
    for rep in runner.manifests().values():
        spec = rep.get("progress_log")
        if not spec:
            continue
        pattern = re.compile(spec["pattern"])
        groups = {int(n) for n in re.findall(r"\{(\d+)\}", spec["label"])}
        assert groups and max(groups) <= pattern.groups, (rep["id"], spec)


# --- options (P2) ---------------------------------------------------------------------------------------------------
import asyncio  # noqa: E402
import json  # noqa: E402
import sys  # noqa: E402
import tomllib  # noqa: E402

import pytest  # noqa: E402

ACTION = {"id": "kernels", "argv": ["python", "rep.py"], "options": [
    {"id": "profile_range", "arg": "--profile-range", "pattern": r"^\d{1,3}-\d{1,3}$", "default": "67-67"},
    {"id": "ncu_set", "arg": "--ncu-set", "choices": ["full", "memory"], "default": "full"}]}


def test_options_fill_defaults_and_append_every_argument():
    values, args = runner.resolve_options(ACTION, {"ncu_set": "memory"})
    assert values == {"profile_range": "67-67", "ncu_set": "memory"}
    assert args == ["--profile-range", "67-67", "--ncu-set", "memory"]


@pytest.mark.parametrize("given", [{"ncu_set": "everything"}, {"profile_range": "67-67; rm -rf /"},
                                   {"profile_range": "1" * 40}, {"shell": "x"}])
def test_options_outside_the_manifest_are_refused(given):
    with pytest.raises(ValueError):
        runner.resolve_options(ACTION, given)


def test_every_option_default_passes_the_runner_and_the_rep():
    sys.path.insert(0, str(REPO / "scripts"))
    from compose_stack import LAST_ITERATION, trace_settings
    for rep in runner.manifests().values():
        last = rep.get("last_iteration", LAST_ITERATION)  # the rep's workload length in executor iterations
        for action in rep["actions"]:
            if not action.get("options"):
                continue
            values, _ = runner.resolve_options(action, {})
            argv = action["argv"]
            if "--trace" in argv:  # rep.py checks the same values again (ranges, iteration count)
                trace_settings(argv[argv.index("--trace") + 1], values, last)


# --- queue, cancel, history (P2) ------------------------------------------------------------------------------------
def fake(seconds: float) -> tuple[dict, dict]:
    code = f"import time; print('started', flush=True); time.sleep({seconds}); print('done')"
    return {"id": "fake", "compose_projects": []}, {"id": "sleep", "label": "sleep", "argv": [sys.executable, "-c", code]}


def test_queue_runs_one_at_a_time_cancels_and_history_survives_a_restart(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "STATE", tmp_path)
    monkeypatch.setattr(runner, "CANCEL_WAIT", (5, 5))

    async def scenario():
        r = runner.Runner()
        scheduler = asyncio.create_task(r.schedule())
        first = r.add(*fake(0.2), {}, [])
        second = r.add(*fake(30), {}, [])
        third = r.add(*fake(30), {}, [])
        for _ in range(100):
            await asyncio.sleep(0.1)
            if second.state == "running" and second.lines:
                break
        assert first.state == "ok" and first.lines[-1] == "done"
        assert second.state == "running" and third.state == "queued"
        r.cancel(third)
        r.cancel(second)  # SIGINT: the sleeping python exits with KeyboardInterrupt
        for _ in range(100):
            await asyncio.sleep(0.1)
            if second.state == "cancelled":
                break
        assert second.state == "cancelled" and third.state == "cancelled" and third.started_ns is None
        scheduler.cancel()

    asyncio.run(scenario())
    restored = runner.Runner().jobs
    assert [restored[i].state for i in (1, 2, 3)] == ["ok", "cancelled", "cancelled"]
    assert "started" in restored[2].lines


def test_a_job_left_running_reads_back_as_lost(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "STATE", tmp_path)
    (tmp_path / "jobs").mkdir()
    record = {"id": 7, "rep": "fake", "action": "sleep", "label": "sleep", "argv": ["x"], "state": "running",
              "started_ns": 1}
    (tmp_path / "jobs" / "7.json").write_text(json.dumps(record))
    job = runner.Runner().jobs[7]
    assert job.state == "lost" and job.ended_ns == 1
    assert runner.Runner().add(*fake(0), {}, []).id == 8  # numbering continues


# --- register (P3) --------------------------------------------------------------------------------------------------
@pytest.fixture
def repo(tmp_path, monkeypatch):
    (tmp_path / "reps" / "X1_new").mkdir(parents=True)
    (tmp_path / "reps" / "X1_new" / "rep.py").write_text("")
    (tmp_path / "reps" / "X1_new" / "test_x1.py").write_text("")
    (tmp_path / "reps" / "X0_old").mkdir()
    (tmp_path / "reps" / "X0_old" / "rep.py").write_text("")
    (tmp_path / "reps" / "X0_old" / "rep.toml").write_text('id = "X0"\ncompose_projects = ["x0"]\n')
    monkeypatch.setattr(runner, "REPO", tmp_path)
    return tmp_path


BODY = {"folder": "reps/X1_new", "id": "X1", "title": "New \"quoted\" rep", "compose_projects": ["ie-x1"],
        "actions": [{"id": "off", "label": "Measured", "script": "rep.py", "args": ["--trace", "off"], "measured": True},
                    {"id": "check", "script": "test_x1.py", "group": "check", "minutes": 2}]}


def test_register_offers_only_folders_without_a_manifest(repo):
    assert runner.unregistered() == [{"folder": "reps/X1_new", "scripts": ["rep.py", "test_x1.py"]}]


def test_register_writes_a_manifest_the_runner_reads(repo):
    path, text = runner.manifest_text(BODY)
    assert path == repo / "reps" / "X1_new" / "rep.toml"
    data = tomllib.loads(text)
    assert data["title"] == BODY["title"] and data["compose_projects"] == ["ie-x1"]
    assert data["actions"][0]["command"] == ["uv", "run", "--no-sync", "python", "{rep}/rep.py", "--trace", "off"]
    assert data["actions"][1]["command"][3:5] == ["pytest", "-q"] and data["actions"][1]["group"] == "check"


@pytest.mark.parametrize("change", [
    {"folder": "reps/X0_old"}, {"folder": "../etc"}, {"id": "X0"}, {"id": "a b"}, {"compose_projects": []},
    {"compose_projects": ["Bad Name"]},
    {"actions": [{"id": "a", "script": "../rep.py"}]}, {"actions": [{"id": "a", "script": "rep.py", "args": ["$(id)"]}]},
    {"actions": [{"id": "a", "script": "rep.py", "args": ["../../x"]}]},
    {"actions": [{"id": "a", "script": "rep.py"}, {"id": "a", "script": "rep.py"}]}])
def test_register_refuses_what_it_cannot_run_safely(repo, change):
    with pytest.raises(ValueError):
        runner.manifest_text(BODY | change)


# --- dry run (command center P1) ------------------------------------------------------------------------------------
def test_dry_run_validates_and_returns_the_job_but_starts_nothing(tmp_path, monkeypatch):
    from aiohttp.test_utils import TestClient, TestServer
    folder = tmp_path / "reps" / "X1_dry"
    folder.mkdir(parents=True)
    marker = tmp_path / "started"
    (folder / "rep.toml").write_text(f"""id = "X1"
compose_projects = []
[[actions]]
id = "go"
label = "go"
command = ["{sys.executable}", "-c", "open({str(marker)!r}, 'w')"]
[[actions.options]]
id = "range"
arg = "--range"
pattern = '^\\d{{1,3}}-\\d{{1,3}}$'
default = "1-2"
""")
    monkeypatch.setattr(runner, "REPO", tmp_path)
    monkeypatch.setattr(runner, "STATE", tmp_path / "state")

    async def scenario():
        async with TestClient(TestServer(runner.make_app())) as client:
            post = lambda options: client.post("/runner/jobs", json={"rep": "X1", "action": "go", "options": options,
                                                                     "dry_run": True})
            ok, bad = await post({"range": "66-129"}), await post({"range": "x"})
            await asyncio.sleep(0.5)
            listed, health = await client.get("/runner/jobs"), await client.get("/runner/health")
            return ok.status, await ok.json(), bad.status, await listed.json(), await health.json()

    status, job, bad, listed, health = asyncio.run(scenario())
    assert status == 200 and job["dry_run"] is True and job["state"] == "dry run" and job["started_ns"] is None
    assert job["argv"][-2:] == ["--range", "66-129"]
    assert bad == 400 and listed == [] and not marker.exists()
    assert health["dry_run"] is True
