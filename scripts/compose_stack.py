"""Start, drive and stop the Compose stack: TensorRT-LLM server, packet capture, Locust client.

TRACE (off, timeline, code, kernels) adds deploy/compose.profile.yaml: the trace image, SYS_ADMIN, and the
profiler around trtllm-serve. Traced runs are labeled and never feed the measured numbers.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
COMPOSE_FILE = REPO_ROOT / "deploy" / "compose.yaml"
PROFILE_FILE = REPO_ROOT / "deploy" / "compose.profile.yaml"
SERVICES = ("server", "capture", "client")
SERVER_PORT = 8080
CAPTURE_IMAGE = "ie-capture:alpine3.20"
TRACE_IMAGE = "ie-tensorrt-llm:1.2.1-nvml-byref-trace"
TSHARK_FIELDS = ("frame.number", "frame.time_epoch", "tcp.stream", "tcp.srcport", "tcp.dstport", "tcp.flags.syn",
                 "tcp.flags.fin", "frame.len", "tcp.payload")
NCU_METRICS = ("gpu__time_duration.sum,dram__bytes_op_read.sum,dram__bytes_op_write.sum,dram__bytes_read.sum,"
               "dram__bytes_write.sum,lts__t_bytes.sum,l1tex__t_bytes.sum,"
               "dram__throughput.avg.pct_of_peak_sustained_elapsed,sm__throughput.avg.pct_of_peak_sustained_elapsed,"
               "sm__inst_executed_pipe_tensor.sum,launch__registers_per_thread,launch__shared_mem_per_block,"
               "launch__grid_size,launch__block_size")

# What each trace level runs. profile_range: the executor iterations the profiler covers (warm-up 1-64; the
# measured request 66-129, checked against /perf_metrics by the adapters). graphs: CUDA graphs on or off.
TRACE_LEVELS = {
    "off": {},
    "timeline": {"prefix": "nsys profile -o /trace/timeline -f true --trace=cuda,nvtx,osrt --sample=none "
                           "--cpuctxsw=none --cuda-graph-trace=node --capture-range=cudaProfilerApi "
                           "--capture-range-end=stop --kill=none",
                 "profile_range": "1-129", "graphs": True},
    # code: graphs off, so each kernel keeps the op, shapes and Python stack that launched it (owner ruling
    # 2026-11-03). Inside a graph replay there are no per-op launches to attribute.
    "code": {"prefix": "", "torch_trace": "/trace/torch_trace.json", "profile_range": "66-129", "graphs": False},
    # kernels: graphs on, as in the measured run; --graph-profiling node profiles each kernel inside the replay.
    # --set full: every section (occupancy, launch stats, warp states, scheduler, instructions, roofline):
    # 41 replay passes per kernel, against 12 for the earlier 3 sections (measured 2026-11-03, ncu 2026.3.1).
    "kernels": {"prefix": "ncu --target-processes all --profile-from-start off --graph-profiling node --set full "
                          f"--import-source yes --metrics {NCU_METRICS} -o /trace/kernels -f",
                "profile_range": "67-67", "graphs": True},
    # nographs: no profiler, CUDA graphs off. Against a measured run it shows what graphs save.
    "nographs": {"graphs": False, "profiler": False},
}


def has_profiler(trace: str) -> bool:
    """Off and nographs run the normal image with no profiler; the other levels add compose.profile.yaml."""
    return trace != "off" and TRACE_LEVELS[trace].get("profiler", True)


def profiler_range(engine_range: str) -> str:
    """profile_range is in /perf_metrics' numbering (first_iter, last_iter count from 1). TLLM_PROFILE_START_STOP
    counts like the executor's NVTX labels, from 0: one less. Seen on the timeline run: the profiler logged
    "started at iteration 1" and label 0 was absent; first_iter 66 ran in label 65."""
    if not engine_range:
        return ""
    a, b = (int(x) - 1 for x in engine_range.split("-"))
    return f"{max(a, 0)}-{b}"


def write_atomic(path: Path, data: dict) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(path)


def prepare_run_dir(results_dir: Path, run_id: str, engine_config: str) -> Path:
    run_dir = results_dir / run_id
    (run_dir / "client").mkdir(parents=True)
    (run_dir / "control").mkdir()
    (run_dir / "trace").mkdir()
    (run_dir / "config.yaml").write_text(engine_config)
    for d in (run_dir, run_dir / "trace"):
        d.chmod(0o777)
    return run_dir


def sh(*cmd: str, capture: bool = True, check: bool = True) -> str:
    return subprocess.run(cmd, check=check, text=True, capture_output=capture).stdout


class Stack:
    def __init__(self, project: str, results_dir: Path, run_id: str, trace: str = "off"):
        if trace not in TRACE_LEVELS:
            raise ValueError(f"TRACE={trace}: use one of {list(TRACE_LEVELS)}")
        self.project = project
        self.results_dir = results_dir
        self.run_id = run_id
        self.run_dir = results_dir / run_id
        self.trace = trace
        self.server_start = 0
        self.next_step = 0

    def env(self) -> dict:
        level = TRACE_LEVELS[self.trace]
        return {**os.environ, "RESULTS_DIR": str(self.results_dir), "RUN_ID": self.run_id,
                "SERVER_START": str(self.server_start), "TRACE_PREFIX": level.get("prefix", ""),
                "PROFILE_RANGE": profiler_range(level.get("profile_range", "")),
                "TORCH_TRACE": level.get("torch_trace", "")}

    def compose(self, *args: str, capture: bool = False, check: bool = True) -> subprocess.CompletedProcess:
        files = ["-f", str(COMPOSE_FILE)] + (["-f", str(PROFILE_FILE)] if has_profiler(self.trace) else [])
        cmd = ["docker", "compose", "-p", self.project, *files, *args]
        return subprocess.run(cmd, env=self.env(), check=check, text=True, capture_output=capture)

    def up(self) -> str:
        self.server_start += 1
        self.next_step = 0
        print(f"TRACE={self.trace} RUN_ID={self.run_id} SERVER_START={self.server_start}: "
              f"docker compose -p {self.project} up -d --wait {' '.join(SERVICES)}  (watch it: devtools #lifecycle)")
        self.compose("up", "-d", "--wait", *SERVICES)
        self.save_topology()
        address = self.compose("port", "server", str(SERVER_PORT), capture=True).stdout.strip()
        return f"http://{address}"

    def save_topology(self) -> None:
        """Level 0 for the run: every container and network of the project, as docker inspect reports them."""
        ids = self.compose("ps", "-q", capture=True).stdout.split()
        containers = json.loads(sh("docker", "inspect", *ids))
        networks = sorted({n for c in containers for n in c["NetworkSettings"]["Networks"]})
        query = "name,compute_cap,driver_version,memory.total,pci.bus_id"
        gpu = dict(zip(query.split(","), sh("nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader")
                       .strip().split(", ")))
        write_atomic(self.run_dir / "topology.json", {
            "captured_ns": time.monotonic_ns(), "project": self.project, "containers": containers,
            "networks": json.loads(sh("docker", "network", "inspect", *networks)) if networks else [], "gpu": gpu})

    def run_step(self, step: dict, timeout_s: float = 60) -> dict:
        name = f"step_{self.next_step:04d}"
        self.next_step += 1
        write_atomic(self.run_dir / "control" / f"{name}.json", step)
        done = self.run_dir / "client" / f"{name}.done.json"
        deadline = time.monotonic() + timeout_s
        while not done.exists():
            if time.monotonic() > deadline:
                raise TimeoutError(f"{name}: no result after {timeout_s} s "
                                   f"(inspect: iectl logs {self.project} client; iectl lifecycle)")
            time.sleep(0.02)
        result = json.loads(done.read_text())
        if not result["ok"]:
            raise RuntimeError(f"{name} failed: {result['error']}")
        return result

    def down(self) -> None:
        logs = self.compose("logs", "--no-color", "--timestamps", "server", capture=True).stdout
        (self.run_dir / f"server_s{self.server_start}.log").write_text(logs)
        if has_profiler(self.trace):
            # Under a profiler, PID 1 is the profiler's launcher (ncu's dash wrapper ignores SIGTERM as PID 1), so
            # compose's SIGTERM never reaches the engine. Stop the engine itself; the profiler then writes its report.
            self.compose("exec", "-T", "server", "pkill", "-TERM", "-f", "^/usr/bin/python /usr/local/bin/trtllm-serve",
                         check=False)
        self.compose("down")

    def pcap(self) -> Path:
        return self.run_dir / f"{self.run_id}_s{self.server_start}.pcap"

    def pcap_frames(self) -> str:
        """Every TCP frame of the capture as TShark fields (tab-separated, one header line), saved as frames.tsv."""
        fields = [arg for f in TSHARK_FIELDS for arg in ("-e", f)]
        tsv = sh("docker", "run", "--rm", "-v", f"{self.run_dir}:/cap:ro", CAPTURE_IMAGE, "tshark", "-r",
                 f"/cap/{self.pcap().name}", "-Y", "tcp", "-T", "fields", "-E", "header=y", "-E", "separator=/t",
                 "-o", "tcp.desegment_tcp_streams:FALSE", *fields)
        (self.run_dir / "frames.tsv").write_text(tsv)
        return tsv

    def export_trace(self) -> None:
        """Turn the profiler's reports into files the adapters read (runs in the trace image)."""
        trace = self.run_dir / "trace"
        if self.trace == "timeline" and (trace / "timeline.nsys-rep").exists():
            self.in_trace_image("nsys export --type sqlite --force-overwrite true -o /trace/timeline.sqlite "
                                "/trace/timeline.nsys-rep")
        if self.trace == "kernels" and (trace / "kernels.ncu-rep").exists():
            self.in_trace_image(f"ncu -i /trace/kernels.ncu-rep --page raw --csv --metrics {NCU_METRICS} "
                                "> /trace/kernels.csv")
            # Made here, world-writable like trace/: the container runs as root, and split_sass writes into the
            # folder as this user. A root-owned sass/ fails with Permission denied (run 20261103T175947Z).
            (trace / "sass").mkdir(exist_ok=True)
            (trace / "sass").chmod(0o777)
            self.in_trace_image("ncu -i /trace/kernels.ncu-rep --page source --csv "
                                "--print-source sass > /trace/sass/all.csv")
            split_sass(trace / "sass" / "all.csv")
            # Every section's metrics and rule findings per kernel (occupancy, warp states, ...), long format.
            self.in_trace_image("ncu -i /trace/kernels.ncu-rep --page details --csv --print-details all "
                                "> /trace/sections.csv")
        if self.trace == "code" and (trace / "torch_trace.json").exists():
            self.copy_sources()

    def in_trace_image(self, command: str) -> None:
        sh("docker", "run", "--rm", "-v", f"{self.run_dir / 'trace'}:/trace", TRACE_IMAGE, "bash", "-c", command)

    def copy_sources(self) -> None:
        """The engine files the code-level trace names, copied out of the image, for the source pane."""
        import re
        text = (self.run_dir / "trace" / "torch_trace.json").read_text()
        files = sorted({m for m in re.findall(r'"name": "(/[^"(]+\.py)\(\d+\)', text)})
        if files:
            listing = self.run_dir / "trace" / "source_files.txt"
            listing.write_text("\n".join(files))
            self.in_trace_image("mkdir -p /trace/source && cat /trace/source_files.txt | "
                                "xargs -I{} cp --parents {} /trace/source/ 2>/dev/null; true")

    def chown(self) -> None:
        """Captures and reports are written by root in the containers (K17): give them back to this user."""
        sh("docker", "run", "--rm", "-v", f"{self.run_dir}:/out", CAPTURE_IMAGE, "chown", "-R",
           f"{os.getuid()}:{os.getgid()}", "/out")


def split_sass(path: Path) -> None:
    """ncu's source page for every kernel, one file per kernel ID (trace/sass/<id>.txt). The export (`--page source
    --csv`) starts each kernel's table with a `"Kernel Name","<name>"` line, in launch order: the same order and IDs
    as kernels.csv."""
    if not path.exists():
        return
    current, lines = -1, []

    def flush():
        if current >= 0:
            (path.parent / f"{current}.txt").write_text("\n".join(lines))

    for line in path.read_text().splitlines():
        if line.startswith('"Kernel Name"'):
            flush()
            current, lines = current + 1, []
        lines.append(line)
    flush()


if __name__ == "__main__":
    results_dir, run_id = Path(sys.argv[1]).resolve(), sys.argv[2]
    config = ("return_perf_metrics: true\n"
              "perf_metrics_max_requests: 100\n"
              "kv_cache_config:\n"
              "  enable_block_reuse: false\n"
              "  free_gpu_memory_fraction: 0.5\n")
    prepare_run_dir(results_dir, run_id, config)
    stack = Stack("ie-hand-check", results_dir, run_id)
    print("server:", stack.up())
    input("Stack is up. Press Enter to stop it. ")
    stack.down()
