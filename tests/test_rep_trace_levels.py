"""Every rep exposes every trace level (owner, 2026-11-09: "All future reps must expose them - we truly want the 360
view here"). An untraced run fills only the request rung of the command center's execution ladder: iterations and
phases come from the component stamps, kernels and layers from Nsight Systems, modules from the code run."""
import importlib.util
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))
from compose_stack import TRACE_LEVELS  # noqa: E402

spec = importlib.util.spec_from_file_location("runner", REPO / "scripts" / "runner.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

# Built before the rule, with no engine stack to trace or no rep.toml. Nothing is added to this set.
BEFORE_THE_RULE = {"I01A-L1_chat_request_inspection", "I01B-L1_sampler_inspection", "I01C-L1_streamed_completion",
                   "I01-L2_chat_service_under_load", "I02B-L1_TTFT_percentiles_and_bootstrap"}


def trace_levels(rep: dict) -> set[str]:
    """The levels a manifest's actions run: the value after --trace in each command."""
    return {argv[i + 1] for argv in (a["argv"] for a in rep["actions"])
            for i, part in enumerate(argv[:-1]) if part == "--trace"}


def test_every_rep_has_a_manifest():
    folders = {p.name for p in (REPO / "reps").iterdir() if (p / "rep.py").is_file()} - BEFORE_THE_RULE
    missing = sorted(folders - {Path(rep["folder"]).name for rep in runner.manifests().values()})
    assert not missing, f"no rep.toml: {missing}"


def test_every_manifest_runs_every_trace_level():
    for rep in runner.manifests().values():
        missing = sorted(set(TRACE_LEVELS) - trace_levels(rep))
        assert not missing, f"{rep['folder']}/rep.toml has no action for --trace {missing}"


# --- what each level means (scripts/run_levels.py): I02A-L1's delineation, the same in every rep -------------------
import pytest  # noqa: E402
from compose_stack import trace_settings  # noqa: E402
from run_levels import level_engine_config, level_labels  # noqa: E402

BASE = "return_perf_metrics: true\n"


def test_off_is_the_measured_run_and_carries_no_instrument():
    assert level_engine_config(BASE, "off") == BASE
    labels = level_labels("off", trace_settings("off"))
    assert labels["measured"] and labels["graphs"]
    assert not (labels["profiler"] or labels["stamps"] or labels["iter_stats"])


def test_only_off_is_measured():
    assert [t for t in TRACE_LEVELS if level_labels(t, trace_settings(t))["measured"]] == ["off"]


def test_each_instrument_belongs_to_its_levels():
    labels = {t: level_labels(t, trace_settings(t)) for t in TRACE_LEVELS}
    assert {t for t, lab in labels.items() if lab["iter_stats"]} == {"live"}
    assert {t for t, lab in labels.items() if not lab["graphs"]} == {"code", "nographs"}
    assert {t for t, lab in labels.items() if lab["profiler"]} == {"timeline", "code", "kernels"}
    assert {t for t, lab in labels.items() if lab["stamps"]} == {"components", "timeline", "code", "kernels"}
    assert "enable_iter_perf_stats: true" in level_engine_config(BASE, "live")
    assert "cuda_graph_config: null" in level_engine_config(BASE, "code")


@pytest.mark.parametrize("line", ["enable_iter_perf_stats: true\n", "cuda_graph_config: null\n"])
def test_a_rep_cannot_put_a_level_setting_in_its_base_config(line):
    with pytest.raises(ValueError, match="trace level sets them"):
        level_engine_config(BASE + line, "off")


def test_every_rep_takes_its_config_and_labels_from_the_levels():
    for rep in runner.manifests().values():
        source = (REPO / rep["folder"] / "rep.py").read_text()
        for call in ("level_engine_config(", "level_labels("):
            assert call in source, f"{rep['folder']}/rep.py does not call run_levels.{call[:-1]}"
