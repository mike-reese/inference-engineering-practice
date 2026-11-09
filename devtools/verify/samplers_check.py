"""The host sampler's acceptance check: a recorded run's fast samples (scripts/gpu_sampler.py, through
adapters/trackers.py as the store reads them) against the slower, independent sources the backend captured for the
same run, and against their own periods.

  periods       gpu-mem clock (NVML, gpu_procs.jsonl) median gap within 10 % of 50 ms; each container's cgroup
                clock (containers.jsonl) within 10 % of 100 ms
  GPU split     every read: reserve + listed processes + unattributed = used, and unattributed >= 0 (a negative rest
                means the process figures overcount)
  GPU total     gpu.mem.used against the backend's nvml.memory.used (capture/gpu.jsonl, another NVML handle in another
                process) where the latter held still across its neighbours: within 4 MiB of the host read nearest in
                time (at most 25 ms away)
  RAM           Docker's docker.mem_bytes (capture/docker-stats.jsonl, the same cgroup through the daemon, about once a
                second) inside the range of container.mem_bytes over the second before the record arrived (to 100 ms
                after), widened by 5 % or 4 MiB. The capture stamps a Docker record when it arrives, and in run
                I02A_20261109T205538Z_14d5d8 some arrived up to 0.6 s after their read (measured: the value matched
                the cgroup read 0.4 to 0.6 s earlier while memory moved), so the nearest cgroup read is no reference
  CPU           Docker's docker.cpu_pct over its interval (its previous record to this one) against the time-weighted
                mean of container.cpu_pct over the same interval: within 5 points or 10 %

Usage: uv run --no-sync python devtools/verify/samplers_check.py RUN_DIR [STORE_RUN_DIR]. STORE_RUN_DIR defaults to
/mnt/ie-data/cc/store/runs/<run> (its capture/ holds the backend's records). Exits 1 on a miss.
"""
import bisect
import json
import statistics
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "devtools" / "backend"))
from store.adapters.base import Ctx, slug  # noqa: E402
from store.adapters.trackers import ContainerSamples, GpuProcs  # noqa: E402
from store.registry import Registry  # noqa: E402

STORE = Path("/mnt/ie-data/cc/store/runs")
MS = 1_000_000
PERIOD_TOLERANCE = 0.10
GPU_MIB = 4.0
GPU_NEAR_NS = 25 * MS
RAM_SHARE, RAM_BYTES = 0.05, 4 * 2 ** 20
DOCKER_WINDOW_NS = (1000 * MS, 100 * MS)
CPU_POINTS, CPU_SHARE = 5.0, 0.10


def lines(path: Path) -> list[dict]:
    return [json.loads(x) for x in path.read_text().splitlines() if x.strip()] if path.is_file() else []


def nearest(ts: list[int], t: int) -> int:
    k = bisect.bisect_left(ts, t)
    return min((j for j in (k - 1, k) if 0 <= j < len(ts)), key=lambda j: abs(ts[j] - t))


class Report:
    def __init__(self):
        self.failed = 0

    def check(self, ok: bool, what: str) -> None:
        self.failed += not ok
        print(("ok   " if ok else "FAIL ") + what)


def main(run_dir: Path, store_dir: Path) -> int:
    r, ctx = Report(), Ctx(run_dir.name, run_dir, Registry.load(), wall_offset_ns=0)
    by: dict[str, list[tuple[int, dict]]] = {}
    gp, cs = GpuProcs(ctx), ContainerSamples(ctx)
    for clock, t, v in gp.feed(lines(run_dir / "gpu_procs.jsonl")) + cs.feed(lines(run_dir / "containers.jsonl")):
        by.setdefault(clock, []).append((t, v))
    r.check("gpu-mem" in by, f"gpu_procs.jsonl: {len(by.get('gpu-mem', []))} NVML reads")
    cgroups = sorted(c for c in by if c.startswith("cgroup-"))
    r.check(bool(cgroups), f"containers.jsonl: {len(cgroups)} containers of the run's projects")
    if r.failed:
        return 1

    for clock, want in [("gpu-mem", 50)] + [(c, 100) for c in cgroups]:
        ts = [t for t, _ in by[clock]]
        gaps = sorted((b - a) / MS for a, b in zip(ts, ts[1:]))
        med = statistics.median(gaps)
        r.check(abs(med - want) <= want * PERIOD_TOLERANCE,
                f"period {clock}: median {med:.1f} ms (want {want}), p95 {gaps[int(0.95 * (len(gaps) - 1))]:.1f}, "
                f"max {gaps[-1]:.1f}, {len(ts)} reads")

    held: dict[int, float] = {}
    for clock, recs in by.items():
        if clock.startswith("gpu-proc-"):
            for t, v in recs:
                held[t] = held.get(t, 0.0) + v["gpu.proc.memory.used"]
    dev = by["gpu-mem"]
    worst = max(abs(v["gpu.mem.reserved"] + held.get(t, 0.0) + v["gpu.mem.unattributed"] - v["gpu.mem.used"])
                for t, v in dev)
    low = min(v["gpu.mem.unattributed"] for _, v in dev)
    r.check(worst < 1e-6 and low >= 0, f"GPU split closes on every read (max error {worst:.2g} MiB); smallest "
                                       f"unattributed {low:.0f} MiB")

    ts = [t for t, _ in dev]
    nv = [(x["mono_ns"], x["values"]["nvml.memory.used"]) for x in lines(store_dir / "capture" / "gpu.jsonl")
          if "nvml.memory.used" in x["values"]]
    pairs = []
    for (_, a), (t, b), (_, c) in zip(nv, nv[1:], nv[2:]):
        j = nearest(ts, t)
        if a == b == c and abs(ts[j] - t) <= GPU_NEAR_NS:
            pairs.append(abs(dev[j][1]["gpu.mem.used"] - b))
    r.check(bool(pairs) and max(pairs) <= GPU_MIB,
            f"GPU total vs backend NVML: {len(pairs)} steady pairs, max diff {max(pairs, default=float('nan')):.2f} "
            f"MiB (limit {GPU_MIB})")

    stats: dict[str, list[dict]] = {}
    for x in lines(store_dir / "capture" / "docker-stats.jsonl"):
        stats.setdefault(x["container"], []).append(x)
    for name, recs in sorted(stats.items()):
        clock = f"cgroup-{slug(name)}"
        if clock not in by:
            continue
        cg = by[clock]
        cts = [t for t, _ in cg]
        ram, cpu = [], []
        for prev, x in zip([None] + recs, recs):
            seen = [v["container.mem_bytes"] for t, v in cg
                    if x["mono_ns"] - DOCKER_WINDOW_NS[0] <= t <= x["mono_ns"] + DOCKER_WINDOW_NS[1]]
            if seen:
                b = x["docker.mem_bytes"]
                tol = max(RAM_BYTES, RAM_SHARE * b)
                ram.append(min(seen) - tol <= b <= max(seen) + tol)
            if prev is None:
                continue
            w = [(t - cg[k - 1][0], v["container.cpu_pct"]) for k, (t, v) in enumerate(cg)
                 if k and prev["mono_ns"] < t <= x["mono_ns"] and v["container.cpu_pct"] == v["container.cpu_pct"]]
            if len(w) >= 5:
                mean = sum(dt * p for dt, p in w) / sum(dt for dt, _ in w)
                d = x["docker.cpu_pct"]
                cpu.append(abs(mean - d) <= max(CPU_POINTS, CPU_SHARE * d))
        r.check(bool(ram) and all(ram), f"RAM {name}: {sum(ram)} of {len(ram)} Docker records inside the cgroup reads' "
                                        f"range over their second (5 % or 4 MiB)")
        r.check(bool(cpu) and sum(cpu) >= 0.9 * len(cpu), f"CPU {name}: {sum(cpu)} of {len(cpu)} Docker intervals "
                                                          f"within 5 points or 10 % of the cgroup mean (90 % needed)")
    print(f"{r.failed} failed")
    return 1 if r.failed else 0


if __name__ == "__main__":
    run = Path(sys.argv[1]).resolve()
    sys.exit(main(run, Path(sys.argv[2]) if len(sys.argv) > 2 else STORE / run.name))
