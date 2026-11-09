"""The P2 trackers of a run folder (COMMAND_CENTER.md 3.2, 3.4, 7.2): the trackers sidecar's raw reads
(deploy/trackers/trackers.py) and the host sampler's GPU process reads (scripts/gpu_sampler.py):

  trackers/host.jsonl    clock host:    CPU busy % (all CPUs, then each) and RAM used, every 100 ms
  trackers/nvme.jsonl    clock nvme:    NVMe read and write bytes per second, time busy, every 100 ms
  trackers/uncore.jsonl  clock uncore:  RAM and L3 bandwidth from perf's uncore counters, every 100 ms interval
  trackers/procs.jsonl   rows of kind `process start`, one per process of the server container
  gpu_apps.jsonl         clock gpu-apps-<process> per GPU process: the GPU memory it holds, every 500 ms

The live writer tails these files and the importer reads them whole, through the same feed(), so live and final
samples and rows are the same. A rate needs two reads of one session (one tracker process; a second server start
appends a second session): each sample covers the interval that ends at its timestamp.
A sample adapter declares a clock (its Columns) in `clocks` before feed() returns the clock's first sample.
"""
from __future__ import annotations

import math
from pathlib import Path

from .base import Column, Ctx, LineTail, Rows, slug

Sample = tuple[str, int, dict]      # (clock, CLOCK_MONOTONIC ns, {column: value})
NAN = math.nan
SOURCE = "trackers"
PROC_EVIDENCE = ("Observed: starttime of /proc/<pid>/stat (USER_HZ ticks since boot, 10 ms resolution), found by the "
                 "trackers sidecar's 100 ms poll of /proc in the server container's PID namespace "
                 "(deploy/trackers/trackers.py); CLOCK_MONOTONIC = boot time - (CLOCK_BOOTTIME - CLOCK_MONOTONIC at "
                 "the poll). A process that lives under 100 ms can be missed.")
GPU_APP_EVIDENCE = ("Observed: nvidia-smi --query-compute-apps (host pid, process name), polled by "
                    "scripts/gpu_sampler.py")


def busy(a: list[int] | None, b: list[int] | None) -> float:
    """CPU busy % between two /proc/stat lines: 1 - (idle + iowait) / all, over user..steal (guest time is already
    inside user and nice)."""
    if a is None or b is None:
        return NAN
    d = [y - x for x, y in zip(a[:8], b[:8])]
    total = sum(d)
    return 100.0 * (total - d[3] - d[4]) / total if total > 0 else NAN


class HostSamples:
    def __init__(self, ctx: Ctx):
        self.ctx, self.prev, self.cpus = ctx, None, None
        self.clocks: dict[str, list[Column]] = {}

    def feed(self, recs: list[dict]) -> list[Sample]:
        out = []
        for r in recs:
            if self.cpus is None:
                self.cpus = [c for c in r["cpu"] if c != "cpu"]
                cores = [Column(f"host.cpu.busy.{c}", "host.cpu.core.busy", "host/cpu", f"CPU {c[3:]} busy")
                         for c in self.cpus]
                self.clocks["host"] = [Column("host.cpu.busy", "host.cpu.busy", "host/cpu"),
                                       Column("host.mem.used", "host.mem.used", "host/ram"), *cores]
            prev, self.prev = self.prev, r
            if prev is None or prev.get("session") != r.get("session"):
                continue
            mem = r["mem_kib"]
            v = {"host.cpu.busy": busy(prev["cpu"].get("cpu"), r["cpu"].get("cpu")),
                 "host.mem.used": (mem["MemTotal"] - mem["MemAvailable"]) / 1024}
            for c in self.cpus:
                v[f"host.cpu.busy.{c}"] = busy(prev["cpu"].get(c), r["cpu"].get(c))
            out.append(("host", r["mono_ns"], v))
        return out


class NvmeSamples:
    """/proc/diskstats fields (Documentation/admin-guide/iostats.rst): 2 sectors read, 6 sectors written (512 B),
    9 milliseconds with I/O in flight."""
    SECTOR = 512
    METRICS = ("nvme.read", "nvme.write", "nvme.busy")

    def __init__(self, ctx: Ctx):
        self.ctx, self.prev = ctx, None
        self.clocks: dict[str, list[Column]] = {}

    def feed(self, recs: list[dict]) -> list[Sample]:
        out = []
        for r in recs:
            self.clocks.setdefault("nvme", [Column(m, m, "host/nvme") for m in self.METRICS])
            prev, self.prev = self.prev, r
            if prev is None or prev.get("session") != r.get("session"):
                continue
            dt = (r["mono_ns"] - prev["mono_ns"]) / 1e9
            d = [b - a for a, b in zip(prev["stat"], r["stat"])]
            rates = (d[2] * self.SECTOR / dt, d[6] * self.SECTOR / dt, 100.0 * d[9] / (dt * 1e3))
            out.append(("nvme", r["mono_ns"], dict(zip(self.METRICS, rates))))
        return out


class UncoreSamples:
    """perf stat -I intervals: the memory controller counts 64-byte lines that perf prints in MiB (sysfs scale); a
    CBox lookup is one 64-byte line. The interval is perf's own: this end minus the previous one (the first of a
    session from perf's start)."""
    IMC = {"host.ram.read": "uncore_imc/data_reads/", "host.ram.write": "uncore_imc/data_writes/"}
    CBOX = {"host.l3.lookup": "unc_cbo_cache_lookup.any_mesi", "host.l3.miss": "unc_cbo_cache_lookup.any_i"}
    LINE = 64

    def __init__(self, ctx: Ctx):
        self.ctx, self.prev_s, self.session = ctx, 0.0, None
        self.clocks: dict[str, list[Column]] = {}

    def feed(self, recs: list[dict]) -> list[Sample]:
        out = []
        for r in recs:
            self.clocks.setdefault("uncore", [Column("host.ram.bw", "host.ram.bw", "host/ram")] +
                                   [Column(m, m, "host/ram") for m in self.IMC] +
                                   [Column(m, m, "host/cpu") for m in self.CBOX])
            if r.get("session") != self.session:
                self.prev_s, self.session = 0.0, r.get("session")
            dt, self.prev_s = r["perf_s"] - self.prev_s, r["perf_s"]
            v = {m: self.count(r, e, "MiB") * 2 ** 20 / dt for m, e in self.IMC.items()}
            v |= {m: self.count(r, e, "") * self.LINE / dt for m, e in self.CBOX.items()}
            v["host.ram.bw"] = v["host.ram.read"] + v["host.ram.write"]
            out.append(("uncore", r["mono_ns"], v))
        return out

    @staticmethod
    def count(r: dict, event: str, unit: str) -> float:
        value, got = r["counts"].get(event, [None, unit])
        if got != unit:
            raise ValueError(f"trackers/uncore.jsonl line {r['line'] + 1}: {event} in {got!r}, expected {unit!r}")
        return NAN if value is None else value


class ProcessStarts:
    source = SOURCE

    def __init__(self, ctx: Ctx):
        self.ctx = ctx

    def feed(self, recs: list[dict]) -> Rows:
        out, ctx = Rows(), self.ctx
        for r in recs:
            pid, comm = r["pid"], r["comm"]
            t = r["start_ticks"] * 1_000_000_000 // r["clk_tck"] - r["boot_minus_mono_ns"]
            how = "was running when the trackers started" if r["first_poll"] else "starts"
            out.add(start=t, end=t, lane=ctx.lane(f"server pid {pid}", None, pid=pid), kind="process start", name=comm,
                    eid=ctx.eid("process/{pid}/start", pid=pid),
                    what=f"Process {pid} ({comm}) {how} in the server container; its parent is pid {r['ppid']}.",
                    args={k: r[k] for k in ("pid", "ppid", "comm", "cmdline", "start_ticks", "clk_tck", "first_poll")}
                    | {"seen_mono_ns": r["mono_ns"]},
                    term="process start (/proc poll)", source=self.source, evidence=PROC_EVIDENCE,
                    raw_file="trackers/procs.jsonl", raw_ptr=f"line {r['line'] + 1}", contain=False)
        return out

    def flush(self) -> Rows:
        return Rows()


class GpuApps:
    """One clock per GPU process from its first appearance; every later successful read gives it a sample, 0 MiB once
    the read no longer lists it. A process of a rep container (registry lanes) sits on its process thing, named by its
    pid inside the container as the other adapters name it; any other process sits on the host by its host pid."""
    METRIC = "gpu.app.memory.used"

    def __init__(self, ctx: Ctx):
        self.ctx, self.clock_of = ctx, {}
        self.clocks: dict[str, list[Column]] = {}

    def feed(self, recs: list[dict]) -> list[Sample]:
        out = []
        for r in recs:
            if not r["ok"]:
                self.ctx.count("gpu_apps", "failed reads")
                continue
            held: dict[str, float] = {}
            for a in r["apps"]:
                clock = self.clock_of.get(a["pid"]) or self.declare(a)
                held[clock] = held.get(clock, 0.0) + float(a["used_mib"])
            out += [(c, r["mono_ns"], {self.METRIC: held.get(c, 0.0)}) for c in self.clocks]
        return out

    def declare(self, a: dict) -> str:
        ctx = self.ctx
        rep = a.get("ns_pid") is not None and any(x["process_prefix"] == a.get("service") for x in ctx.lane_rules)
        if rep:
            name = f"{a['service']} pid {a['ns_pid']}"
            thing = ctx.process(name, a["ns_pid"])
        else:
            name = f"host pid {a['pid']}"
            exe = a["name"].split(" --")[0].replace("\\", "/").rsplit("/", 1)[-1]
            thing = ctx.thing(f"host/{name}", "host", "process", f"{exe} ({name})",
                              {"pid": a["pid"], "container": a.get("container")}, GPU_APP_EVIDENCE)
        clock = self.clock_of[a["pid"]] = f"gpu-apps-{slug(name)}"
        self.clocks[clock] = [Column(self.METRIC, self.METRIC, thing, f"GPU memory held by {name}")]
        return clock


class Trackers:
    FILES = {"host": "trackers/host.jsonl", "nvme": "trackers/nvme.jsonl", "uncore": "trackers/uncore.jsonl",
             "procs": "trackers/procs.jsonl", "gpu_apps": "gpu_apps.jsonl"}

    def __init__(self, run_dir: Path, ctx: Ctx):
        self.tails = {k: LineTail(run_dir / rel) for k, rel in self.FILES.items()}
        self.procs = ProcessStarts(ctx)
        self.sampled = {"host": HostSamples(ctx), "nvme": NvmeSamples(ctx), "uncore": UncoreSamples(ctx),
                        "gpu_apps": GpuApps(ctx)}

    def read(self, final: bool = False) -> dict[str, list[dict]]:
        return {k: t.read(final) for k, t in self.tails.items()}

    def rows(self, got: dict) -> Rows:
        return self.procs.feed(got["procs"])

    def samples(self, got: dict) -> list[Sample]:
        return [s for k, a in self.sampled.items() for s in a.feed(got[k])]

    @property
    def clocks(self) -> dict[str, list[Column]]:
        return {c: cols for a in self.sampled.values() for c, cols in a.clocks.items()}

    def unreadable(self) -> dict[str, int]:
        return {self.FILES[k]: t.bad for k, t in self.tails.items() if t.bad}
