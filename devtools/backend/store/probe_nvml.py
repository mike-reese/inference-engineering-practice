"""NVML refresh probe (COMMAND_CENTER.md 6.5): how often each NVML counter takes a new value, and what
one read costs, so the live sampler polls each counter at its measured interval and not faster.

Each counter is polled alone at 5 ms for 10 s (a slow read, such as PCIe throughput, cannot skew another counter).
The refresh interval is the time between successive distinct values (median and p95): an upper bound on the true
refresh period, since two refreshes that return the same value count as one. GPM is probed the same way: a read whose
window is empty (DRAM bandwidth NaN) means no hardware update landed between two samples.

Usage (the first two in the devtools container, the sampler's environment; the third anywhere):
    python -m store.probe_nvml --phase idle > idle.json
    python -m store.probe_nvml --phase load > load.json        # while a GPU load runs
    python probe_nvml.py --combine idle.json load.json > /mnt/ie-data/cc/probe/nvml_refresh.json
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import threading
import time

POLL_S = 0.005
SECONDS = 10.0
SLOW_MS = 1000
MIN_CHANGES = 5      # fewer distinct values than this in 10 s: no refresh interval is measurable
GPM = ("nvml.gpm.sm_util", "nvml.gpm.sm_occupancy", "nvml.gpm.tensor_util", "nvml.gpm.dram_bw_util")
PCIE = ("nvml.pcie.rx", "nvml.pcie.tx")
SERIAL = 0.9         # concurrent PCIe reads whose wall time is at least this share of their summed cost serialize


def q(a: list[float], p: float) -> float | None:
    if not a:
        return None
    b = sorted(a)
    return round(b[min(len(b) - 1, int(len(b) * p))], 3)


def poll(read, seconds: float) -> dict:
    """read() -> value, or None for an empty read. Returns change times, read costs and value range."""
    changes, cost, values, empty = [], [], [], 0
    last = object()
    t0 = time.monotonic()
    nxt = t0
    while time.monotonic() - t0 < seconds:
        nxt += POLL_S
        time.sleep(max(0.0, nxt - time.monotonic()))
        t = time.perf_counter()
        v = read()
        cost.append((time.perf_counter() - t) * 1e3)
        if v is None:
            empty += 1
            continue
        values.append(v)
        if v != last:
            changes.append(time.monotonic())
            last = v
    gaps = [(b - a) * 1e3 for a, b in zip(changes[1:], changes[2:])]   # the first change is the first read
    return {"reads": len(cost), "empty_reads": empty, "distinct_changes": max(0, len(changes) - 1),
            "refresh_ms_median": q(gaps, 0.5), "refresh_ms_p95": q(gaps, 0.95),
            "read_ms_median": q(cost, 0.5), "read_ms_p95": q(cost, 0.95), "read_ms_max": q(cost, 1.0),
            "value_min": min(values) if values else None, "value_max": max(values) if values else None}


def probe(phase: str) -> dict:
    from store.nvml import Gpm, _nvml, counters   # run as python -m store.probe_nvml from devtools/backend
    n = _nvml()
    n.nvmlInit()
    h = n.nvmlDeviceGetHandleByIndex(0)
    out = {"phase": phase, "device": n.nvmlDeviceGetName(h), "driver": n.nvmlSystemGetDriverVersion(),
           "poll_ms": POLL_S * 1e3, "seconds_per_counter": SECONDS, "started_wall_ns": time.time_ns(), "counters": {}}
    for metric, (unit, read) in counters(n).items():
        out["counters"][metric] = {"unit": unit, **poll(lambda: float(read(h)), SECONDS)}
    gpm = Gpm(n, h)
    out["counters"]["nvml.gpm.sm_util"] = {"unit": "%", **poll(lambda: (gpm.read()[0] or {}).get("nvml.gpm.sm_util"),
                                                                 SECONDS)}
    read = counters(n)
    cost: dict[str, list] = {m: [] for m in PCIE}

    def burst(m: str) -> None:
        for _ in range(40):
            t = time.perf_counter()
            read[m][1](h)
            cost[m].append((time.perf_counter() - t) * 1e3)
    threads = [threading.Thread(target=burst, args=(m,)) for m in PCIE]
    t = time.perf_counter()
    [x.start() for x in threads]
    [x.join() for x in threads]
    wall = (time.perf_counter() - t) * 1e3
    out["pcie_concurrent"] = {"reads_each": 40, "wall_ms": round(wall, 1),
                              "summed_read_ms": round(sum(sum(v) for v in cost.values()), 1),
                              "read_ms_median": {m: q(v, 0.5) for m, v in cost.items()}}
    return out


def chosen_period(metric: str, phases: list[dict]) -> tuple[int, str]:
    """The polling period of one counter: the fastest measured median refresh over the phases, rounded to 1 ms (timer
    noise: 50.001 ms is 50 ms) and then up to 10 ms; GPM at least 100 ms; 1 s when no phase shows a measurable
    refresh or the refresh is no faster than 1 s."""
    meds = [p["counters"][metric]["refresh_ms_median"] for p in phases
            if p["counters"][metric]["distinct_changes"] >= MIN_CHANGES and p["counters"][metric]["refresh_ms_median"]]
    if not meds:
        return SLOW_MS, f"fewer than {MIN_CHANGES} distinct values in {SECONDS:g} s in every phase"
    ms = math.ceil(round(min(meds)) / 10) * 10
    if metric in GPM:
        ms = max(ms, 100)
    if ms >= SLOW_MS:
        return SLOW_MS, f"refresh {min(meds):g} ms, no faster than 1 s"
    return ms, f"median refresh {min(meds):g} ms (fastest phase), rounded to 1 ms, then up to 10 ms"


def groups(table: list[dict], phases: list[dict]) -> list[dict]:
    """Sampler groups (one thread each, one shared clock each): GPM; PCIe RX and TX, read in turn when their reads
    serialize; every other counter grouped by its period."""
    period = {r["metric"]: r["period_ms"] for r in table}
    out = [{"group": "nvml-gpm", "period_ms": max(period[m] for m in GPM if m in period), "metrics": list(GPM),
            "rule": "GPM: one sample pair gives all four metrics; period of nvml.gpm.sm_util"}]
    conc = [p["pcie_concurrent"] for p in phases if "pcie_concurrent" in p]
    if conc and all(c["wall_ms"] >= SERIAL * c["summed_read_ms"] for c in conc):
        cost = max(sum(c["read_ms_median"].values()) for c in conc)
        ms = max(math.ceil(cost / 10) * 10, *(period[m] for m in PCIE))
        out.append({"group": "nvml-pcie", "period_ms": ms, "metrics": list(PCIE),
                    "rule": f"each read blocks for its own 20 ms window and RX and TX reads serialize (concurrent "
                            f"reads took {min(c['wall_ms'] / c['summed_read_ms'] for c in conc):.0%} of their summed "
                            f"cost), so one read of each takes {cost:.1f} ms; rounded up to 10 ms"})
    else:
        share = max(c["wall_ms"] / c["summed_read_ms"] for c in conc) if conc else None
        why = (f"each read blocks for its own 20 ms window; concurrent RX and TX reads overlap (wall {share:.0%} of "
               "their summed cost), so each gets its own thread at its own period") if conc else "own period"
        out += [{"group": "nvml-pcie-" + m.split(".")[-1], "period_ms": period[m], "metrics": [m], "rule": why}
                for m in PCIE]
    rest = {}
    for m, ms in period.items():
        if m not in GPM and m not in PCIE:
            rest.setdefault(ms, []).append(m)
    out += [{"group": f"nvml-{ms}ms", "period_ms": ms, "metrics": ms_metrics, "rule": "counters with this period"}
            for ms, ms_metrics in sorted(rest.items())]
    return out


def combine(paths: list[str]) -> dict:
    phases = [json.load(open(p)) for p in paths]
    table = []
    for m in phases[0]["counters"]:
        period, why = chosen_period(m, phases)
        row = {"metric": m, "unit": phases[0]["counters"][m]["unit"], "period_ms": period, "rule": why}
        for p in phases:
            c = p["counters"][m]
            row[p["phase"]] = {k: c[k] for k in ("distinct_changes", "refresh_ms_median", "refresh_ms_p95",
                                                 "read_ms_median", "read_ms_p95", "empty_reads")}
        table.append(row)
    for m in GPM[1:]:
        table.append({**next(r for r in table if r["metric"] == GPM[0]), "metric": m,
                      "rule": f"read with {GPM[0]} from the same GPM sample pair"})
    return {"schema": "nvml-refresh/1", "probe": "devtools/backend/store/probe_nvml.py", "phases": phases,
            "table": table, "groups": groups(table, phases)}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--phase", help="label of this probe run, e.g. idle or load")
    ap.add_argument("--combine", nargs="+", help="phase files to merge into the refresh table")
    a = ap.parse_args()
    out = combine(a.combine) if a.combine else probe(a.phase or "unlabeled")
    json.dump(out, sys.stdout, indent=1, default=str)
    print()


if __name__ == "__main__":
    main()
