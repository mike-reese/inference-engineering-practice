"""The GPU, read on the host while a rep runs, each read stamped with CLOCK_MONOTONIC (the run's clock) on return:
  gpu.csv          nvidia-smi --query-gpu every 100 ms, one line per read
  gpu_apps.jsonl   nvidia-smi --query-compute-apps every 500 ms, one JSON line per read: each process holding GPU
                   memory, with its container and its pid inside the container (/proc/<pid>/cgroup, NSpid)
"""
import json
import re
import subprocess
import threading
import time
from pathlib import Path

GPU_QUERY = "utilization.gpu,utilization.memory,memory.used,power.draw,clocks.sm,temperature.gpu,pcie.link.gen.current"
APPS_QUERY = "pid,used_memory,process_name"  # the name last: it can hold commas
APPS_PERIOD_NS = 500_000_000
NAME_CHARS = 160
DOCKER_SCOPE = re.compile(r"docker-([0-9a-f]{64})\.scope")


class GpuSampler:
    def __init__(self, run_dir: Path):
        self.process = subprocess.Popen(["nvidia-smi", f"--query-gpu={GPU_QUERY}", "--format=csv,noheader,nounits",
                                         "-lms", "100"], stdout=subprocess.PIPE, text=True, bufsize=1)
        self.thread = threading.Thread(target=self.read, args=(run_dir / "gpu.csv",), daemon=True)
        self.thread.start()
        self.stopping = threading.Event()
        self.apps_thread = threading.Thread(target=self.apps, args=(run_dir / "gpu_apps.jsonl",), daemon=True)
        self.apps_thread.start()

    def read(self, path: Path) -> None:
        with path.open("w") as out:
            for line in self.process.stdout:
                out.write(f"{time.monotonic_ns()},{','.join(v.strip() for v in line.split(','))}\n")
                out.flush()

    def apps(self, path: Path) -> None:
        containers: dict[str, dict] = {}
        with path.open("w", buffering=1) as out:
            tick = time.monotonic_ns()
            while not self.stopping.is_set():
                r = subprocess.run(["nvidia-smi", f"--query-compute-apps={APPS_QUERY}",
                                    "--format=csv,noheader,nounits"], capture_output=True, text=True)
                rec = {"mono_ns": time.monotonic_ns(), "ok": r.returncode == 0, "apps": []}
                for line in r.stdout.splitlines() if r.returncode == 0 else []:
                    pid, used, name = (x.strip() for x in line.split(",", 2))
                    rec["apps"].append({"pid": int(pid), "used_mib": float(used), "name": name[:NAME_CHARS],
                                        **process_place(int(pid), containers)})
                out.write(json.dumps(rec, separators=(",", ":")) + "\n")
                now = time.monotonic_ns()
                while tick <= now:
                    tick += APPS_PERIOD_NS
                self.stopping.wait((tick - now) / 1e9)

    def stop(self) -> None:
        self.process.terminate()
        self.thread.join(timeout=5)
        self.stopping.set()
        self.apps_thread.join(timeout=5)


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
