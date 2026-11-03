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
