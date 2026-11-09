"""What each trace level means, the same in every rep (owner, 2026-11-09: keep I02A-L1's delineation).

    off         the measured run: the normal image, CUDA graphs on, no profiler, no stamps, no iteration stats.
                The only level whose numbers are results.
    live        off plus the engine's iteration stats (enable_iter_perf_stats): they add work to every iteration.
    components  off plus the component stamps: every stamp is a file write.
    nographs    off with CUDA graphs off: against the measured run it shows what graphs save.
    timeline    Nsight Systems and the stamps, CUDA graphs on: the production kernel path, slowed by the profiler.
    code        the PyTorch profiler and the stamps, CUDA graphs off: a graph replay has no per-op launches to name.
    kernels     Nsight Compute and the stamps, CUDA graphs on: per-kernel counters, not on the run clock.

A rep never adds an instrument to a level. A rep whose evidence needs one (I02C-L1 reads the iteration stats) takes
that evidence from the level that carries it, and its `off` run stays the measured run.
"""
from compose_stack import TRACE_LEVELS, has_profiler, uses_stamps

# The engine settings a level owns. A rep's base config that sets one would change what `off` means.
LEVEL_KEYS = ("enable_iter_perf_stats", "cuda_graph_config")


def level_engine_config(base: str, trace: str) -> str:
    """The rep's engine config at a trace level: its base config plus the settings the level owns."""
    owned = [key for key in LEVEL_KEYS if any(line.split(":")[0].strip() == key for line in base.splitlines())]
    if owned:
        raise ValueError(f"the rep's engine config sets {owned}: the trace level sets them "
                         f"(TRACE=live for iteration stats, TRACE=nographs or code for CUDA graphs off)")
    level = TRACE_LEVELS[trace]
    return base + ("cuda_graph_config: null\n" if level.get("graphs") is False else "") \
        + ("enable_iter_perf_stats: true\n" if level.get("iter_stats") else "")


def level_labels(trace: str, settings: dict) -> dict:
    """labels.json for a run at a trace level. settings: compose_stack.trace_settings() for the run."""
    level = TRACE_LEVELS[trace]
    return {"trace": trace, "measured": trace == "off", "graphs": level.get("graphs", True),
            "profiler": has_profiler(trace), "iter_stats": bool(level.get("iter_stats")), "stamps": uses_stamps(trace),
            "profile_range": settings["profile_range"], "options": settings["options"]}
