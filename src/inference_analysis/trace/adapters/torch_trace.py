"""Code level: the PyTorch profiler trace the engine writes (TLLM_TORCH_PROFILE_TRACE, trace/torch_trace.json).

Per kernel: the PyTorch op that launched it (name, input shapes), the CUDA launch call, the Python stack
(file:line, from the trace image's with_stack=True) and the launch configuration. Times: baseTimeNanoseconds +
ts (us) is CLOCK_REALTIME; converted with a client anchor pair.
"""
import bisect
import json
from pathlib import Path

from ..schema import Run, Span
from .common import clock_offset, engine_window, run_dir
from .nsys import layer_of

STEP_FRAME = "py_executor.py"  # the executor's _forward_step frame: one per iteration


def torch_trace(path: Path, run: Run) -> None:
    file = str(path.relative_to(run_dir(path)))
    data = json.loads(path.read_text())
    offset = clock_offset(run)
    if offset is None:
        run.unavailable.append({"what": "PyTorch trace times", "why": "no client anchor pair to convert UTC"})
        return
    base = int(data.get("baseTimeNanoseconds", 0))

    def mono(ts_us: float) -> int:
        return base + int(ts_us * 1000) - offset

    events = [e for e in data["traceEvents"] if e.get("ph") == "X"]
    ops = {}  # External id -> innermost cpu_op
    python = {}  # tid -> python_function events sorted by start
    by_id = {}  # Python id -> python_function event
    launches = {}
    for e in events:
        cat = e.get("cat")
        if cat == "cpu_op":
            ext = e["args"].get("External id")
            if ext is not None and (ext not in ops or e["dur"] < ops[ext]["dur"]):
                ops[ext] = e
        elif cat == "python_function":
            python.setdefault(e["tid"], []).append(e)
            by_id[e["args"].get("Python id")] = e
        elif cat in ("cuda_runtime", "cuda_driver") and "correlation" in e.get("args", {}):
            launches[e["args"]["correlation"]] = e
    for frames in python.values():
        frames.sort(key=lambda e: e["ts"])
    starts = {tid: [e["ts"] for e in frames] for tid, frames in python.items()}

    def stack(op: dict) -> list[str]:
        """Python frames that contain the op, outermost first (only frames inside the engine and model code).
        Start at the last frame that began before the op, then follow "Python parent id" up: the frames form a
        tree, so the first ancestor that still contains the op is the innermost enclosing frame."""
        frames = python.get(op["tid"], [])
        i = bisect.bisect_right(starts.get(op["tid"], []), op["ts"])
        frame = frames[i - 1] if i else None
        while frame and frame["ts"] + frame["dur"] < op["ts"] + op["dur"]:
            frame = by_id.get(frame["args"].get("Python parent id"))
        out = []
        while frame:
            out.append(frame["name"])
            frame = by_id.get(frame["args"].get("Python parent id"))
        out.reverse()
        return [f for f in out if "tensorrt_llm" in f or "torch/nn" in f][-12:]

    kernels = sorted((e for e in events if e.get("cat") == "kernel"), key=lambda e: e["ts"])
    # Iterations: the executor's _forward_step Python frames, numbered from the profile range's first iteration
    # (labels.profile_range, /perf_metrics numbering). A kernel belongs to the step its launch call ran in.
    steps = sorted((e["ts"], e["ts"] + e["dur"]) for e in events if e.get("cat") == "python_function"
                   and STEP_FRAME in e["name"] and e["name"].endswith(": _forward_step"))
    step_starts = [a for a, _ in steps]
    first_iter = int(str(run.labels.get("profile_range", "1-0")).split("-")[0])

    def iteration_of(k: dict) -> int | None:
        launch = launches.get(k["args"].get("correlation"))
        ts = launch["ts"] if launch else k["ts"]
        i = bisect.bisect_right(step_starts, ts) - 1
        return first_iter + i if i >= 0 and ts <= steps[i][1] else None

    iterations = [iteration_of(k) for k in kernels]
    by_iter = {}
    for k, i in zip(kernels, iterations):
        by_iter.setdefault(i, []).append(k["name"])
    layers = {i: iter(layer_of(names)) for i, names in by_iter.items()}
    windows = engine_window(run)
    for n, (k, i) in enumerate(zip(kernels, iterations)):
        args = k["args"]
        op = ops.get(args.get("External id"))
        launch = launches.get(args.get("correlation"))
        number = i
        attrs = {"grid": args.get("grid"), "block": args.get("block"),
                 "registers_per_thread": args.get("registers per thread"), "shared_memory": args.get("shared memory"),
                 "est_occupancy_pct": args.get("est. achieved occupancy %"), "iteration": number,
                 "iteration_basis": "launch inside the executor's _forward_step frame", "layer": next(layers[i]),
                 "duration_us": k["dur"],
                 "op": op["name"] if op else None, "shapes": op["args"].get("Input Dims") if op else None,
                 "op_ns": mono(op["ts"]) if op else None, "stack": stack(op) if op else [],
                 "launch": launch["name"] if launch else None, "launch_ns": mono(launch["ts"]) if launch else None}
        rid = next((r for r, a, b, _, _ in windows if number is not None and a <= number <= b), None)
        run.spans.append(Span(f"torch/kernel/{n}", "hardware", "gpu", k["name"][:160], mono(k["ts"]),
                              mono(k["ts"] + k["dur"]), rid, attrs, {"file": file, "pointer": f"kernel {n}"}))
    for n, e in enumerate(x for x in events if x.get("cat") == "gpu_memcpy"):
        run.spans.append(Span(f"torch/memcpy/{n}", "hardware", "pcie", e["name"], mono(e["ts"]),
                              mono(e["ts"] + e["dur"]), None, {"bytes": e["args"].get("bytes")},
                              {"file": file, "pointer": f"gpu_memcpy {n}"}))
