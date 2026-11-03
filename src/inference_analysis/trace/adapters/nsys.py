"""Level 3 (timeline): Nsight Systems' SQLite export (trace/*.sqlite) -> executor NVTX ranges, kernels, copies.

Times are offsets from TARGET_INFO_SESSION_START_TIME.utcEpochNs (CLOCK_REALTIME, Nsight Systems 2025.5); the
client's anchor pair converts them to CLOCK_MONOTONIC like the wire times.
Iterations are the executor's `_forward_step` NVTX ranges. With TLLM_LLMAPI_ENABLE_NVTX the range text carries the
engine's iteration counter ("[Executor] _forward_step 65: 1 ctx reqs, 0 gen reqs"). The label counts from 0 and
/perf_metrics' first_iter/last_iter count from 1, so label + 1 = the record's iteration. Checked by time on run
I02A-TRACE-timeline_20261103T164724Z_f91205: first_iter 66's first_scheduled_time falls 0.33 ms before label 65.
Each kernel belongs to the range its launch call ran in.
"""
import bisect
import re
import sqlite3
from pathlib import Path

from ..schema import Run, Span
from .common import clock_offset, engine_window, run_dir

EXECUTOR_RANGES = ("_forward_step", "_schedule", "_fetch_new_requests", "_prepare_inputs", "_sample_async",
                   "_handle_responses", "_update_requests", "_process_requests")
STEP = re.compile(r"^(?:\[Executor\] )?(_forward_step)(?: (\d+): (.*))?$")
MEMCPY_KIND = {1: "host to device", 2: "device to host", 8: "device to device", 10: "peer to peer"}


def layer_of(names: list[str]) -> list[int | None]:
    """Layer index per kernel in one iteration: each decoder layer runs two RMSNorm kernels (input, post-attention).
    A heuristic for Qwen2-style models, labeled so."""
    out, norms = [], 0
    for name in names:
        if "RMSNorm" in name or "rmsnorm" in name:
            norms += 1
        layer = (norms - 1) // 2 if norms else None
        out.append(layer if layer is None or layer < 1000 else None)
    return out


def nsys(path: Path, run: Run) -> None:
    file = str(path.relative_to(run_dir(path)))
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    offset = clock_offset(run)
    if offset is None:
        run.unavailable.append({"what": "Nsight Systems times", "why": "no client anchor pair to convert UTC"})
        return
    base = db.execute("select utcEpochNs from TARGET_INFO_SESSION_START_TIME").fetchone()[0] - offset
    strings = dict(db.execute("select id, value from StringIds"))
    tables = {r[0] for r in db.execute("select name from sqlite_master where type='table'")}

    # Executor ranges and iterations
    steps = []
    for start, end, text, text_id, tid in db.execute(
            "select start, end, text, textId, globalTid from NVTX_EVENTS where end is not null order by start"):
        label = text or strings.get(text_id) or ""
        step = STEP.match(label)
        name = step.group(1) if step else label
        if name in EXECUTOR_RANGES:
            attrs = {"thread": tid, "label": label}
            if step and step.group(2):
                attrs["iteration"] = int(step.group(2)) + 1
                attrs["batch"] = step.group(3)
                steps.append((start, end, attrs["iteration"]))
            run.spans.append(Span(f"nsys/nvtx/{start}/{name}", "server", "executor", name, base + start, base + end,
                                  None, attrs, {"file": file, "pointer": f"NVTX_EVENTS start={start}"}))
    steps.sort()
    starts = [s[0] for s in steps]

    def iteration(ns: int) -> int | None:
        i = bisect.bisect_right(starts, ns) - 1
        return steps[i][2] if i >= 0 and ns <= steps[i][1] else None

    launches = {}
    if "CUPTI_ACTIVITY_KIND_RUNTIME" in tables:
        launches = {c: (s, strings.get(n)) for c, s, n in db.execute(
            "select correlationId, start, nameId from CUPTI_ACTIVITY_KIND_RUNTIME")}
    windows = engine_window(run)

    def request_for(it: int | None) -> str | None:
        return next((rid for rid, a, b, _, _ in windows if it is not None and a <= it <= b), None)

    rows = db.execute("""select start, end, correlationId, shortName, demangledName, gridX, gridY, gridZ, blockX,
        blockY, blockZ, registersPerThread, staticSharedMemory, dynamicSharedMemory, graphNodeId
        from CUPTI_ACTIVITY_KIND_KERNEL order by start""").fetchall()
    per_iter = {}
    kernels = []
    for r in rows:
        launch = launches.get(r[2])
        it = iteration(launch[0]) if launch else None
        kernels.append((r, launch, it))
        per_iter.setdefault(it, []).append(strings.get(r[3], "?"))
    layers = {it: iter(layer_of(names)) for it, names in per_iter.items()}
    for n, (r, launch, it) in enumerate(kernels):
        name = strings.get(r[3], "?")
        attrs = {"kernel": strings.get(r[4], name), "grid": [r[5], r[6], r[7]], "block": [r[8], r[9], r[10]],
                 "registers_per_thread": r[11], "shared_memory": r[12] + r[13], "iteration": it,
                 "layer": next(layers[it]), "graph_node": r[14], "duration_us": (r[1] - r[0]) / 1000,
                 "launch": launch[1] if launch else None, "launch_ns": base + launch[0] if launch else None}
        run.spans.append(Span(f"nsys/kernel/{n}", "hardware", "gpu", name, base + r[0], base + r[1],
                              request_for(it), attrs, {"file": file, "pointer": f"CUPTI_ACTIVITY_KIND_KERNEL row {n}"}))
    if "CUPTI_ACTIVITY_KIND_MEMCPY" in tables:
        for n, (start, end, size, kind, corr) in enumerate(db.execute(
                "select start, end, bytes, copyKind, correlationId from CUPTI_ACTIVITY_KIND_MEMCPY order by start")):
            launch = launches.get(corr)
            it = iteration(launch[0]) if launch else None
            run.spans.append(Span(f"nsys/memcpy/{n}", "hardware", "pcie", MEMCPY_KIND.get(kind, f"copy {kind}"),
                                  base + start, base + end, request_for(it),
                                  {"bytes": size, "iteration": it, "kind": MEMCPY_KIND.get(kind)},
                                  {"file": file, "pointer": f"CUPTI_ACTIVITY_KIND_MEMCPY row {n}"}))
    # Cross-check: the record's first iteration must start within 2 ms after its first_scheduled_time.
    numbered = {it: (a, b) for a, b, it in steps}
    for rid, a, b, sched, last in windows:
        if a in numbered and not 0 <= numbered[a][0] + base - sched <= 2_000_000:
            run.unavailable.append({"what": f"iteration numbers for {rid}",
                                    "why": f"_forward_step range for iteration {a} starts "
                                           f"{(numbered[a][0] + base - sched) / 1e6:.3f} ms from first_scheduled_time"})
