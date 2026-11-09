"""Host and server-container trackers of one run (COMMAND_CENTER.md 3.2, 3.4; step P2). The trackers service of
deploy/compose.yaml runs this beside the server, in the server container's PID namespace (so pids are the ones
Nsight Systems and the component stamps record), and writes one JSON line per read into the folder it is given (the
run folder's trackers/). mono_ns is CLOCK_MONOTONIC, the run clock, when the read returned. Every line carries
session, this process's start (mono ns): a run that starts its server twice appends a second session to the same
files, and a rate never spans two sessions.

  host.jsonl    /proc/stat time per CPU (USER_HZ ticks) and /proc/meminfo MemTotal, MemAvailable (KiB), every 100 ms
  nvme.jsonl    the /proc/diskstats fields of the block device whose model contains $NVME_MODEL, every 100 ms
  uncore.jsonl  perf stat -a -I 100 over the memory controller (uncore_imc) and L3 (uncore_cbox) counters, one line
                per interval: perf's own interval end (perf_s) and each event's value and unit
  procs.jsonl   one line per process of the server container, the first time a 100 ms /proc poll sees it
  meta.jsonl    one line per session: the NVMe device, the perf command, USER_HZ, this process's cgroup

Raw counters only; the store adapters (devtools/backend/store/adapters/trackers.py) turn them into rates. Stdlib only.
"""
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

PERIOD_NS = 100_000_000
PERF_EVENTS = ("uncore_imc/data_reads/", "uncore_imc/data_writes/", "unc_cbo_cache_lookup.any_mesi",
               "unc_cbo_cache_lookup.any_i")
PERF = ("perf", "stat", "-a", "-I", "100", "-x", ";", "-e", ",".join(PERF_EVENTS))
CLK_TCK = os.sysconf("SC_CLK_TCK")
MEM = ("MemTotal", "MemAvailable")


SESSION = time.monotonic_ns()


def line(f, rec: dict) -> None:
    f.write(json.dumps({**rec, "session": SESSION}, separators=(",", ":")) + "\n")


def nvme_device(model: str) -> str:
    for d in sorted(Path("/sys/block").iterdir()):
        try:
            if model in (d / "device" / "model").read_text():
                return d.name
        except OSError:
            continue
    sys.exit(f"trackers: no block device whose model contains {model!r}")


def read_host() -> dict:
    cpu = {}
    with open("/proc/stat") as f:
        for text in f:
            if not text.startswith("cpu"):
                break
            name, *ticks = text.split()
            cpu[name] = [int(x) for x in ticks]
    mem = {}
    with open("/proc/meminfo") as f:
        for text in f:
            key, value = text.split(":", 1)
            if key in MEM:
                mem[key] = int(value.split()[0])
    return {"mono_ns": time.monotonic_ns(), "cpu": cpu, "mem_kib": mem}


def read_disk(dev: str) -> dict:
    with open("/proc/diskstats") as f:
        for text in f:
            parts = text.split()
            if parts[2] == dev:
                return {"mono_ns": time.monotonic_ns(), "dev": dev, "stat": [int(x) for x in parts[3:]]}
    raise RuntimeError(f"{dev} is not in /proc/diskstats")


def cgroup(pid) -> str | None:
    try:
        with open(f"/proc/{pid}/cgroup") as f:
            return f.read()
    except OSError:
        return None


def new_processes(seen: set, own: str, first: bool) -> list[dict]:
    """Processes not seen before, keyed (pid, start time) so a reused pid is a new process. This container's own
    processes (the same cgroup) are skipped."""
    out = []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            with open(f"/proc/{name}/stat") as f:
                stat = f.read()
            comm = stat[stat.index("(") + 1:stat.rindex(")")]
            rest = stat[stat.rindex(")") + 2:].split()
            key = (int(name), int(rest[19]))
            if key in seen:
                continue
            seen.add(key)
            if cgroup(name) == own:
                continue
            with open(f"/proc/{name}/cmdline", "rb") as f:
                cmdline = [a.decode(errors="replace") for a in f.read().split(b"\0") if a]
        except (OSError, ValueError, IndexError):
            continue                                   # the process ended between the listing and the read
        out.append({"pid": key[0], "ppid": int(rest[1]), "comm": comm, "cmdline": cmdline, "start_ticks": key[1],
                    "clk_tck": CLK_TCK, "first_poll": first})
    now = time.monotonic_ns()
    boot_minus_mono = time.clock_gettime_ns(time.CLOCK_BOOTTIME) - now
    return [{"mono_ns": now, **r, "boot_minus_mono_ns": boot_minus_mono} for r in out]


class Perf:
    """perf stat -I 100 in its own process; its interval lines (on stderr) grouped into one record per interval,
    stamped when the interval's first line arrived. Other lines (perf's errors) go to this process's stderr."""

    def __init__(self, path: Path):
        self.proc = subprocess.Popen(PERF, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, bufsize=1)
        self.thread = threading.Thread(target=self.read, args=(path,), daemon=True)
        self.thread.start()

    def read(self, path: Path) -> None:
        with path.open("a", buffering=1) as f:
            cur = None
            for text in self.proc.stderr:
                parts = text.rstrip("\n").split(";")
                try:
                    t = float(parts[0])
                    event, unit = parts[3], parts[2]
                except (ValueError, IndexError):
                    print("perf:", text.rstrip(), file=sys.stderr, flush=True)
                    continue
                if cur is None or cur["perf_s"] != t:
                    if cur is not None:
                        line(f, cur)
                    cur = {"mono_ns": time.monotonic_ns(), "perf_s": t, "counts": {}}
                try:
                    value = float(parts[1])
                except ValueError:
                    value = None                       # <not counted>, <not supported>
                cur["counts"][event] = [value, unit]
            if cur is not None:
                line(f, cur)

    def stop(self) -> None:
        self.proc.send_signal(signal.SIGINT)           # perf prints the last, partial interval and exits
        self.thread.join(timeout=5)


def main() -> None:
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    dev = nvme_device(os.environ["NVME_MODEL"])
    own = cgroup("self")
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    with (out / "meta.jsonl").open("a") as meta:
        line(meta, {"period_ns": PERIOD_NS, "clk_tck": CLK_TCK, "perf": {"command": list(PERF)}, "cgroup": own,
                    "nvme": {"dev": dev, "model": (Path("/sys/block") / dev / "device" / "model").read_text().strip()}})
    perf = Perf(out / "uncore.jsonl")
    seen: set = set()
    first = True
    with (out / "host.jsonl").open("a", buffering=1) as host, (out / "nvme.jsonl").open("a", buffering=1) as nvme, \
            (out / "procs.jsonl").open("a", buffering=1) as procs:
        tick = time.monotonic_ns()
        while not stop.is_set():
            line(host, read_host())
            line(nvme, read_disk(dev))
            for rec in new_processes(seen, own, first):
                line(procs, rec)
            first = False
            now = time.monotonic_ns()
            while tick <= now:                         # a late poll skips the ticks it missed, never bursts
                tick += PERIOD_NS
            stop.wait((tick - now) / 1e9)
    perf.stop()


if __name__ == "__main__":
    main()
