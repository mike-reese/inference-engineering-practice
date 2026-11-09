"""The P2 tracker acceptance check (COMMAND_CENTER.md 7.4 P2): under a memory load, the trackers sidecar's samples
against standalone tools over the same window.

  RAM bandwidth  host.ram.bw (perf stat -I 100, through adapters/trackers.py) against one standalone
                 perf stat -a -e uncore_imc/data_reads/,uncore_imc/data_writes/ -- sleep 10: within 5 %
  host CPU %     host.cpu.busy (/proc/stat every 100 ms, through the adapter) against mpstat 1 10 (100 - %idle -
                 %iowait of its Average line): within 2 points

Everything runs in containers: the trackers image as compose runs it (cap_drop ALL, CAP_PERFMON), a check image on top
of it with stress-ng (the load: stress-ng --stream 4) and sysstat (mpstat). Each tool's window is bracketed by
CLOCK_MONOTONIC reads in its own container (the clock is not namespaced); a tracker sample counts when its interval
lies inside that window. Usage: uv run --no-sync python devtools/verify/trackers_check.py OUT_DIR. Exits 1 on a miss.
"""
import json
import re
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "devtools" / "backend"))
from store.adapters.base import Ctx  # noqa: E402
from store.adapters.trackers import HostSamples, UncoreSamples  # noqa: E402
from store.registry import Registry  # noqa: E402

TRACKERS = "ie-trackers:alpine3.20"
CHECK = "ie-trackers-check:alpine3.20"
CHECK_DOCKERFILE = f"FROM {TRACKERS}\nRUN apk add --no-cache stress-ng sysstat\n"
WINDOW_S = 10
WARM_S = 2
RAM_TOLERANCE = 0.05
CPU_TOLERANCE_POINTS = 2.0
MONO = "python3 -c 'import time; print(time.monotonic_ns())'"
PERF_CMD = (f"{MONO}; perf stat -a -e uncore_imc/data_reads/,uncore_imc/data_writes/ -o /dev/stdout -- "
            f"sleep {WINDOW_S}; {MONO}")
MPSTAT_CMD = f"{MONO}; LC_ALL=C mpstat 1 {WINDOW_S}; {MONO}"
PERFMON = ["--cap-drop", "ALL", "--cap-add", "PERFMON", "--network", "none"]


def docker(*args: str, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", *args], check=True, text=True, capture_output=True, **kw)


def bracketed(out: str) -> tuple[int, int, str]:
    lines = out.strip().splitlines()
    return int(lines[0]), int(lines[-1]), "\n".join(lines[1:-1])


def standalone_ram(out: str) -> tuple[float, float, int, int]:
    """(bytes per second over perf's own elapsed time, elapsed s, t0, t1) from perf stat's human output."""
    t0, t1, text = bracketed(out)
    mib = sum(float(m.group(1).replace(",", "")) for m in
              re.finditer(r"^\s*([\d,.]+)\s+MiB\s+uncore_imc/data_(?:reads|writes)/", text, re.M))
    elapsed = float(re.search(r"([\d.]+) seconds time elapsed", text).group(1))
    return mib * 2 ** 20 / elapsed, elapsed, t0, t1


def standalone_cpu(out: str) -> tuple[float, int, int]:
    t0, t1, text = bracketed(out)
    head = next(line.split() for line in text.splitlines() if "%idle" in line)    # time CPU %usr ... %idle
    values = next(r for r in (line.split() for line in text.splitlines()) if r[:2] == ["Average:", "all"])
    col = {name: values[i] for i, name in enumerate(head)}
    return 100.0 - float(col["%idle"]) - float(col["%iowait"]), t0, t1


def tracked(out: Path, adapter, name: str) -> list[tuple[int, int, dict]]:
    """[(interval start ns, end ns, values)] through the store adapter, one per sample."""
    recs = [json.loads(line) | {"line": i} for i, line in enumerate((out / name).read_text().splitlines())]
    samples = adapter.feed(recs)
    if name == "uncore.jsonl":    # perf's own interval, end-stamped at the record's mono_ns
        return [(r["mono_ns"] - round((r["perf_s"] - p) * 1e9), r["mono_ns"], v)
                for (_, _, v), r, p in zip(samples, recs, [0.0] + [r["perf_s"] for r in recs])]
    return [(a["mono_ns"], b["mono_ns"], v) for (_, _, v), a, b in zip(samples, recs, recs[1:])]


def window_mean(samples: list, metric: str, t0: int, t1: int) -> tuple[float, int]:
    inside = [(b - a, v[metric]) for a, b, v in samples if a >= t0 and b <= t1]
    return sum(dt * x for dt, x in inside) / sum(dt for dt, _ in inside), len(inside)


def main() -> None:
    out = Path(sys.argv[1]).resolve() / "trackers"
    out.mkdir(parents=True, exist_ok=False)
    out.chmod(0o777)                                   # the tracker is root without CAP_DAC_OVERRIDE
    docker("build", "-q", "-t", CHECK, "-", input=CHECK_DOCKERFILE)
    name = f"ie-trackers-check-{time.time_ns()}"
    docker("run", "-d", "--name", f"{name}-trackers", *PERFMON, "-e", "NVME_MODEL=SN7100", "-v", f"{out}:/out",
           TRACKERS, "python3", "-u", "/trackers.py", "/out")
    docker("run", "-d", "--rm", "--name", f"{name}-load", "--network", "none", CHECK,
           "stress-ng", "--stream", "4", "--timeout", f"{WINDOW_S + 2 * WARM_S}s", "--quiet")
    try:
        time.sleep(WARM_S)
        perf = subprocess.Popen(["docker", "run", "--rm", *PERFMON, CHECK, "sh", "-c", PERF_CMD],
                                stdout=subprocess.PIPE, text=True)
        mpstat = subprocess.Popen(["docker", "run", "--rm", "--network", "none", CHECK, "sh", "-c", MPSTAT_CMD],
                                  stdout=subprocess.PIPE, text=True)
        perf_out, mpstat_out = perf.communicate()[0], mpstat.communicate()[0]
    finally:
        subprocess.run(["docker", "stop", "-t", "5", f"{name}-trackers"], capture_output=True)
        subprocess.run(["docker", "logs", f"{name}-trackers"], check=False)
        subprocess.run(["docker", "rm", "-f", f"{name}-trackers", f"{name}-load"], capture_output=True)

    ctx = Ctx("trackers-check", None, Registry.load(), wall_offset_ns=0)
    ram_ref, elapsed, p0, p1 = standalone_ram(perf_out)
    ram, n_ram = window_mean(tracked(out, UncoreSamples(ctx), "uncore.jsonl"), "host.ram.bw", p0, p1)
    cpu_ref, m0, m1 = standalone_cpu(mpstat_out)
    cpu, n_cpu = window_mean(tracked(out, HostSamples(ctx), "host.jsonl"), "host.cpu.busy", m0, m1)
    ram_ok = abs(ram - ram_ref) <= RAM_TOLERANCE * ram_ref
    cpu_ok = abs(cpu - cpu_ref) <= CPU_TOLERANCE_POINTS
    print(f"RAM bandwidth  standalone perf stat {ram_ref / 2 ** 30:8.3f} GiB/s over {elapsed:.3f} s;"
          f"  tracker host.ram.bw {ram / 2 ** 30:8.3f} GiB/s over {n_ram} intervals;"
          f"  diff {100 * (ram - ram_ref) / ram_ref:+.2f} % (limit 5 %)  {'ok' if ram_ok else 'FAIL'}")
    print(f"host CPU busy  mpstat 1 {WINDOW_S} {cpu_ref:8.2f} %;"
          f"  tracker host.cpu.busy {cpu:8.2f} % over {n_cpu} intervals;"
          f"  diff {cpu - cpu_ref:+.2f} points (limit 2)  {'ok' if cpu_ok else 'FAIL'}")
    print(f"windows (CLOCK_MONOTONIC s): perf {p0 / 1e9:.3f}-{p1 / 1e9:.3f}, mpstat {m0 / 1e9:.3f}-{m1 / 1e9:.3f}")
    sys.exit(0 if ram_ok and cpu_ok else 1)


if __name__ == "__main__":
    main()
