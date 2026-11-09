"""Live GPU samples from NVML (COMMAND_CENTER.md 6.5): GPM counters at 100 ms and the other NVML counters
at the refresh interval probe_nvml.py measured (registry/kinds.json `metrics`, group nvml, `period_ms`).

One thread per sample clock (registry kinds.json metrics, field clock) reads; every read becomes one record {mono_ns,
wall_ns, group, values, read_ms, window_ns?} handed to `sink` (the backend appends it to capture/gpu.jsonl and writes
it through RunWriter as that clock's samples block). GPM window rule (lead decision, 2026-11-08): a GPM read is
dropped and counted by reason, never recorded or plotted, when its window is empty (two samples in one hardware
update: SM, occupancy and tensor read 0 and DRAM bandwidth reads NaN), zero, or shorter than GPM_MIN_WINDOW_MS; a
window of 50 ms or more is kept. mono_ns is taken when the read returns (CLOCK_MONOTONIC, which the container shares
with the host and the rep's stamps). GPM values describe about 165 ms before the read (measured against nsys on one
run); the read time is kept as is (owner, 2026-11-08) and the lag is stated in each GPM metric's evidence.
"""
from __future__ import annotations

import math
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Callable

GPM_PERIOD_MS = 100          # GPM updates about every 100 ms on this card; faster polling mostly returns empty windows
GPM_MIN_WINDOW_MS = 50       # a shorter GPM window is dropped (lead decision 2026-11-08)
SLOW_PERIOD_MS = 1000        # a counter that refreshes no faster than 1 s is polled at 1 s


def _nvml():
    import pynvml  # nvidia-ml-py; imported on use: the v1 backend starts where NVML is missing
    return pynvml


# metric -> (unit, read(handle)). Units are the registry's (kinds.json metrics).
def counters(n) -> dict[str, tuple[str, Callable]]:
    return {
        "nvml.memory.used": ("MiB", lambda h: n.nvmlDeviceGetMemoryInfo(h).used / 2 ** 20),
        "nvml.power.draw": ("W", lambda h: n.nvmlDeviceGetPowerUsage(h) / 1000),
        "nvml.clocks.sm": ("MHz", lambda h: n.nvmlDeviceGetClockInfo(h, n.NVML_CLOCK_SM)),
        "nvml.pcie.rx": ("KB/s", lambda h: n.nvmlDeviceGetPcieThroughput(h, n.NVML_PCIE_UTIL_RX_BYTES)),
        "nvml.pcie.tx": ("KB/s", lambda h: n.nvmlDeviceGetPcieThroughput(h, n.NVML_PCIE_UTIL_TX_BYTES)),
        "nvml.temperature.gpu": ("°C", lambda h: n.nvmlDeviceGetTemperature(h, n.NVML_TEMPERATURE_GPU)),
    }


def gpm_metrics(n) -> dict[str, int]:
    return {"nvml.gpm.sm_util": n.NVML_GPM_METRIC_SM_UTIL, "nvml.gpm.sm_occupancy": n.NVML_GPM_METRIC_SM_OCCUPANCY,
            "nvml.gpm.tensor_util": n.NVML_GPM_METRIC_ANY_TENSOR_UTIL,
            "nvml.gpm.dram_bw_util": n.NVML_GPM_METRIC_DRAM_BW_UTIL}


class Gpm:
    """GPM metrics between the previous sample and a new one. read() returns None for an empty window."""

    def __init__(self, n, handle):
        self.n, self.h, self.ids = n, handle, gpm_metrics(n)
        self.prev, self.cur = n.nvmlGpmSampleAlloc(), n.nvmlGpmSampleAlloc()
        n.nvmlGpmSampleGet(handle, self.prev)
        self.prev_ns = time.monotonic_ns()

    def read(self) -> tuple[dict | None, int]:
        """(values, window ns); values is None when any metric is NaN (an empty window)."""
        n = self.n
        n.nvmlGpmSampleGet(self.h, self.cur)
        now = time.monotonic_ns()
        m = n.c_nvmlGpmMetricsGet_t()
        m.version, m.numMetrics, m.sample1, m.sample2 = n.NVML_GPM_METRICS_GET_VERSION, len(self.ids), self.prev, self.cur
        for j, v in enumerate(self.ids.values()):
            m.metrics[j].metricId = v
        n.nvmlGpmMetricsGet(m)
        values = {k: float(m.metrics[j].value) for j, k in enumerate(self.ids)}
        window = now - self.prev_ns
        self.prev, self.cur, self.prev_ns = self.cur, self.prev, now
        if any(math.isnan(v) for v in values.values()):
            return None, window
        return values, window


def gpm_drop(values: dict | None, window_ns: int | None) -> str | None:
    """Why a GPM read is dropped (GPM window rule), or None to keep it."""
    if values is None:
        return "empty window"
    if not window_ns:
        return "zero window"
    if window_ns < GPM_MIN_WINDOW_MS * 1_000_000:
        return f"window under {GPM_MIN_WINDOW_MS} ms"
    return None


@dataclass
class Group:
    """Counters read together at one period: one sample clock of the run (one samples block)."""
    name: str
    period_ns: int
    metrics: list[str]
    gpm: bool


@dataclass
class Stats:
    reads: dict = field(default_factory=dict)
    gpm_dropped: dict = field(default_factory=dict)    # reason -> GPM reads dropped (empty, zero, short window)
    errors: dict = field(default_factory=dict)
    read_ms_max: dict = field(default_factory=dict)
    late_ms_max: dict = field(default_factory=dict)
    recent: deque = field(default_factory=lambda: deque(maxlen=200))   # (mono_ns, group, what) of drops, errors

    def snapshot(self) -> dict:
        return {"reads": dict(self.reads), "gpm_dropped": dict(self.gpm_dropped), "errors": dict(self.errors),
                "read_ms_max": {k: round(v, 3) for k, v in self.read_ms_max.items()},
                "late_ms_max": {k: round(v, 3) for k, v in self.late_ms_max.items()},
                "recent": [{"mono_ns": t, "group": g, "what": w} for t, g, w in self.recent]}


def registry_groups(metric_rules: dict) -> dict[str, tuple[float, list[str]]]:
    """{clock: (period_ms, [metric, ...])} of the registry's nvml metrics (kinds.json metrics, group nvml)."""
    out: dict[str, tuple[float, list[str]]] = {}
    for m, r in metric_rules.items():
        if r.get("group") != "nvml":
            continue
        if not r.get("clock") or not r.get("period_ms"):
            raise ValueError(f"kinds.json: nvml metric {m} needs a clock and a measured period_ms")
        period, ms = out.setdefault(r["clock"], (r["period_ms"], []))
        if period != r["period_ms"]:
            raise ValueError(f"kinds.json: clock {r['clock']} has periods {period} and {r['period_ms']} ms")
        ms.append(m)
    return out


class NvmlSampler:
    """One thread per group, so a slow read (PCIe throughput blocks about 21 ms) never delays another group.
    groups: {clock: (period_ms, [metric, ...])}. sink(record) runs on the group's thread."""

    def __init__(self, groups: dict[str, tuple[float, list[str]]], sink: Callable[[dict], None], device: int = 0):
        self.n = _nvml()
        self.n.nvmlInit()
        self.h = self.n.nvmlDeviceGetHandleByIndex(device)
        self.read_counter, gpm_ids = counters(self.n), gpm_metrics(self.n)
        self.groups = []
        for k, (p, ms) in groups.items():
            gpm = [m in gpm_ids for m in ms]
            if any(gpm) and not all(gpm):
                raise ValueError(f"NVML sampler: group {k} mixes GPM and other counters")
            bad = [m for m in ms if m not in gpm_ids and m not in self.read_counter]
            if bad:
                raise ValueError(f"NVML sampler: no reader for {bad}")
            if all(gpm) and p < GPM_PERIOD_MS:
                raise ValueError(f"NVML sampler: GPM is never polled faster than {GPM_PERIOD_MS} ms")
            self.groups.append(Group(k, int(p * 1e6), list(ms), all(gpm)))
        self.sink, self.stats, self.stop = sink, Stats(), threading.Event()
        self.threads = [threading.Thread(target=self._run, args=(g,), name=f"nvml-{g.name}", daemon=True)
                        for g in self.groups]

    def start(self) -> "NvmlSampler":
        for t in self.threads:
            t.start()
        return self

    def close(self) -> None:
        self.stop.set()
        for t in self.threads:
            t.join(timeout=2)

    def _run(self, g: Group) -> None:
        gpm = Gpm(self.n, self.h) if g.gpm else None   # one GPM sample pair per thread
        due = time.monotonic_ns() + g.period_ns
        while True:
            wait = (due - time.monotonic_ns()) / 1e9
            if wait > 0 and self.stop.wait(wait):
                return
            if self.stop.is_set():
                return
            began = time.monotonic_ns()
            self.stats.late_ms_max[g.name] = max(self.stats.late_ms_max.get(g.name, 0.0), (began - due) / 1e6)
            t = time.perf_counter()
            rec = None
            try:
                if gpm is not None:
                    values, window = gpm.read()
                    why = gpm_drop(values, window)
                    if why:
                        self.stats.gpm_dropped[why] = self.stats.gpm_dropped.get(why, 0) + 1
                        self.stats.recent.append((began, g.name, why))
                    else:
                        rec = {"values": values, "window_ns": window}
                else:
                    rec = {"values": {m: float(self.read_counter[m][1](self.h)) for m in g.metrics}}
            except self.n.NVMLError as e:
                self.stats.errors[str(e)] = self.stats.errors.get(str(e), 0) + 1
                self.stats.recent.append((began, g.name, str(e)))
            cost = (time.perf_counter() - t) * 1e3
            now = time.monotonic_ns()
            due = max(due + g.period_ns, began + g.period_ns)   # reads start at least one period apart, no drift
            if rec is None:
                continue
            self.stats.read_ms_max[g.name] = max(self.stats.read_ms_max.get(g.name, 0.0), cost)
            self.stats.reads[g.name] = self.stats.reads.get(g.name, 0) + 1
            self.sink({"mono_ns": now, "wall_ns": time.time_ns(), "group": g.name, **rec, "read_ms": round(cost, 3)})
