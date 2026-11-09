"""The GPU and the containers, read on the host while a rep runs, each read stamped with CLOCK_MONOTONIC (the run's
clock) on return:
  gpu.csv           nvidia-smi --query-gpu every 100 ms, one line per read
  gpu_procs.jsonl   NVML every 50 ms, one JSON line per read: the device's memory used and reserved by the driver, and
                    every process holding GPU memory (compute and graphics), with its container and its pid inside the
                    container (/proc/<pid>/cgroup, NSpid)
  containers.jsonl  cgroup v2 and /proc/<pid>/net/dev every 100 ms, one JSON line per read: the CPU time, memory and
                    network bytes of every Compose container
"""
import json
import os
import re
import subprocess
import threading
import time
from pathlib import Path

GPU_QUERY = "utilization.gpu,utilization.memory,memory.used,power.draw,clocks.sm,temperature.gpu,pcie.link.gen.current"
PROCS_PERIOD_NS = 50_000_000
CONTAINERS_PERIOD_NS = 100_000_000
NAME_CHARS = 160
MiB = 2 ** 20
DOCKER_SCOPE = re.compile(r"docker-([0-9a-f]{64})\.scope")
CGROUP_SLICE = Path("/sys/fs/cgroup/system.slice")
PROJECT = "com.docker.compose.project"
SERVICE = "com.docker.compose.service"


class GpuSampler:
    def __init__(self, run_dir: Path):
        self.process = subprocess.Popen(["nvidia-smi", f"--query-gpu={GPU_QUERY}", "--format=csv,noheader,nounits",
                                         "-lms", "100"], stdout=subprocess.PIPE, text=True, bufsize=1)
        self.stopping = threading.Event()
        self.threads = [threading.Thread(target=self.read, args=(run_dir / "gpu.csv",), daemon=True),
                        threading.Thread(target=self.every, args=(run_dir / "gpu_procs.jsonl", PROCS_PERIOD_NS,
                                                                  GpuProcs().read), daemon=True),
                        threading.Thread(target=self.every, args=(run_dir / "containers.jsonl", CONTAINERS_PERIOD_NS,
                                                                  Containers().read), daemon=True)]
        for t in self.threads:
            t.start()

    def read(self, path: Path) -> None:
        with path.open("w") as out:
            for line in self.process.stdout:
                out.write(f"{time.monotonic_ns()},{','.join(v.strip() for v in line.split(','))}\n")
                out.flush()

    def every(self, path: Path, period_ns: int, read) -> None:
        """One read() per period on a fixed grid; a read that overruns skips the grid points it covered."""
        with path.open("w", buffering=1) as out:
            tick = time.monotonic_ns()
            while not self.stopping.is_set():
                out.write(json.dumps(read(), separators=(",", ":")) + "\n")
                now = time.monotonic_ns()
                while tick <= now:
                    tick += period_ns
                self.stopping.wait((tick - now) / 1e9)

    def stop(self) -> None:
        self.process.terminate()
        self.stopping.set()
        for t in self.threads:
            t.join(timeout=5)


class GpuProcs:
    """NVML's memory info (v2: used excludes what the driver reserves) and its compute and graphics process lists. A
    process in both lists is one entry of type C+G, as nvidia-smi shows it."""

    def __init__(self, nvml=None, place=None):
        self.n, self.h = nvml, None
        self.place = place or (lambda pid, containers: process_place(pid, containers))
        self.names: dict[int, str] = {}
        self.containers: dict[str, dict] = {}

    def read(self) -> dict:
        try:
            if self.h is None:
                if self.n is None:
                    import pynvml  # nvidia-ml-py
                    self.n = pynvml
                self.n.nvmlInit()
                self.h = self.n.nvmlDeviceGetHandleByIndex(0)
            n, h = self.n, self.h
            mem = n.nvmlDeviceGetMemoryInfo(h, version=n.nvmlMemory_v2)
            lists = (("C", n.nvmlDeviceGetComputeRunningProcesses(h)), ("G", n.nvmlDeviceGetGraphicsRunningProcesses(h)))
        except Exception as error:  # NVML errors are its own exception classes; the read is recorded as failed
            return {"mono_ns": time.monotonic_ns(), "ok": False, "error": str(error)[:200]}
        mono_ns = time.monotonic_ns()
        procs: dict[int, dict] = {}
        for kind, listed in lists:
            for p in listed:
                used = p.usedGpuMemory
                if p.pid in procs:
                    procs[p.pid]["type"] = "C+G"
                    continue
                procs[p.pid] = {"pid": p.pid, "used_mib": None if used is None else used / MiB, "type": kind,
                                "name": self.name(p.pid), **self.place(p.pid, self.containers)}
        return {"mono_ns": mono_ns, "ok": True, "used_mib": mem.used / MiB, "reserved_mib": mem.reserved / MiB,
                "procs": list(procs.values())}

    def name(self, pid: int) -> str:
        if pid not in self.names:
            try:
                name = self.n.nvmlSystemGetProcessName(pid)
                self.names[pid] = (name.decode() if isinstance(name, bytes) else name)[:NAME_CHARS]
            except Exception:
                self.names[pid] = ""
        return self.names[pid]


class Containers:
    """Every Compose container's cgroup v2 counters (systemd driver: system.slice/docker-<id>.scope) and, when it has
    a network namespace of its own, the bytes of its interfaces other than lo (what `docker stats` sums). A container
    is inspected once, when its scope first appears."""

    def __init__(self, slice_dir: Path = CGROUP_SLICE, proc: Path = Path("/proc"), inspect=None):
        self.slice, self.proc = slice_dir, proc
        self.inspect = inspect or docker_inspect
        self.known: dict[str, dict | None] = {}  # full id -> {id, name, project, service, pid, own_netns} or None

    def read(self) -> dict:
        out = []
        try:
            scopes = [(m.group(1), e.path) for e in os.scandir(self.slice) if (m := DOCKER_SCOPE.fullmatch(e.name))]
        except OSError as error:
            return {"mono_ns": time.monotonic_ns(), "ok": False, "error": str(error)[:200]}
        for cid, path in scopes:
            if cid not in self.known:
                self.known[cid] = self.inspect(cid)
            info = self.known[cid]
            if info is None:
                continue
            try:
                rec = cgroup_counters(Path(path))
            except OSError:
                continue  # the container stopped between the scan and the read
            rx = tx = None
            if info["own_netns"]:
                try:
                    rx, tx = net_bytes((self.proc / str(info["pid"]) / "net" / "dev").read_text())
                except OSError:
                    pass
            out.append({"id": cid[:12], "name": info["name"], "project": info["project"], **rec,
                        "rx_bytes": rx, "tx_bytes": tx})
        return {"mono_ns": time.monotonic_ns(), "ok": True, "containers": out}


def cgroup_counters(path: Path) -> dict:
    """CPU time (cpu.stat usage_usec), memory (memory.current and memory.stat inactive_file) and the memory limit
    (memory.max, None when "max") of one cgroup v2 directory."""
    stat = dict(line.split() for line in (path / "cpu.stat").read_text().splitlines())
    mem_stat = dict(line.split() for line in (path / "memory.stat").read_text().splitlines())
    limit = (path / "memory.max").read_text().strip()
    return {"cpu_usec": int(stat["usage_usec"]), "memory_current": int((path / "memory.current").read_text()),
            "inactive_file": int(mem_stat.get("inactive_file", 0)), "mem_limit": None if limit == "max" else int(limit)}


def net_bytes(text: str) -> tuple[int, int]:
    """Received and sent bytes over every interface but lo, from /proc/<pid>/net/dev."""
    rx = tx = 0
    for line in text.splitlines()[2:]:
        name, _, fields = line.partition(":")
        if name.strip() == "lo":
            continue
        f = fields.split()
        rx, tx = rx + int(f[0]), tx + int(f[8])
    return rx, tx


def docker_inspect(cid: str) -> dict | None:
    """Name, Compose project and service, init pid and whether it has its own network namespace; None for a container
    outside Compose or one that is gone."""
    fmt = "{{json .Name}}\t{{json .Config.Labels}}\t{{.State.Pid}}\t{{.HostConfig.NetworkMode}}"
    r = subprocess.run(["docker", "inspect", "--format", fmt, cid], capture_output=True, text=True)
    if r.returncode != 0:
        return None
    name, labels, pid, mode = r.stdout.strip().split("\t")
    labels = json.loads(labels) or {}
    if PROJECT not in labels:
        return None
    own = not (mode in ("host", "none") or mode.startswith("container:"))
    return {"name": json.loads(name).lstrip("/"), "project": labels[PROJECT], "service": labels.get(SERVICE),
            "pid": int(pid), "own_netns": own}


def process_place(pid: int, containers: dict) -> dict:
    """{ns_pid, container, service}: the pid inside its PID namespace and, for a Docker container, its name and compose
    service (docker inspect, once per container); None where the process is gone or not in a container."""
    try:
        status = Path(f"/proc/{pid}/status").read_text()
        cgroup = Path(f"/proc/{pid}/cgroup").read_text()
    except OSError:
        return {"ns_pid": None, "container": None, "service": None}
    ns = next((line.split()[-1] for line in status.splitlines() if line.startswith("NSpid:")), None)
    m = DOCKER_SCOPE.search(cgroup)
    if m and m.group(1) not in containers:
        r = subprocess.run(["docker", "inspect", "--format",
                            '{{.Name}}\t{{index .Config.Labels "com.docker.compose.service"}}', m.group(1)],
                           capture_output=True, text=True)
        name, _, service = r.stdout.strip().partition("\t")
        containers[m.group(1)] = {"container": name.lstrip("/") or None, "service": service or None}
    place = containers[m.group(1)] if m else {"container": None, "service": None}
    return {"ns_pid": int(ns) if ns and m else None, **place}
