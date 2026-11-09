"""Start, drive and stop the Compose stack: TensorRT-LLM server, packet capture, trackers, Locust client.

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
STAMPS_FILE = REPO_ROOT / "deploy" / "compose.stamps.yaml"
SERVICES = ("server", "capture", "trackers", "client")
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
    # --gpu-metrics-devices=all: the GPU's own counters (SM activity, DRAM and PCIe throughput, tensor pipe) sampled
    # at 10 kHz, as rows under the kernels in nsys-ui (metric set gb20x on the RTX 5060 Ti; needs SYS_ADMIN).
    "timeline": {"prefix": "nsys profile -o /trace/timeline -f true --trace=cuda,nvtx,osrt --sample=none "
                           "--cpuctxsw=none --cuda-graph-trace=node --capture-range=cudaProfilerApi "
                           "--capture-range-end=stop --kill=none --gpu-metrics-devices=all",
                 "profile_range": "1-129", "graphs": True},
    # code: graphs off, so each kernel keeps the op, shapes and Python stack that launched it (owner ruling
    # 2026-11-03). Inside a graph replay there are no per-op launches to attribute.
    "code": {"prefix": "", "torch_trace": "/trace/torch_trace.json", "profile_range": "66-129", "graphs": False},
    # kernels: graphs on, as in the measured run; --graph-profiling node profiles each kernel inside the replay.
    # --set full: every section (occupancy, launch stats, warp states, scheduler, instructions, roofline):
    # 41 replay passes per kernel, against 12 for the earlier 3 sections (measured 2026-11-03, ncu 2026.3.1).
    "kernels": {"prefix": None,  # ncu_prefix(): its section set, cache and clock control are run options
                "profile_range": "67-67", "graphs": True},
    # nographs: no profiler, CUDA graphs off. Against a measured run it shows what graphs save.
    "nographs": {"graphs": False, "profiler": False},
    # live: no profiler, CUDA graphs on, plus the engine's iteration stats (enable_iter_perf_stats) for the devtools'
    # live Engine view. Labeled not measured: the stats add work to every iteration (owner ruling 2026-11-03).
    "live": {"graphs": True, "profiler": False, "iter_stats": True},
    # components: no profiler, CUDA graphs on, the trace image's component stamps (deploy/compose.stamps.yaml) and
    # the client's, tailed live by the devtools' Components tab. Labeled not measured: every stamp is a file write.
    # The profiled levels carry the same stamps (uses_stamps).
    "components": {"graphs": True, "profiler": False, "stamps": True},
}


# Run options (rep.py flags, the Run tab's form). Each defaults to what the level ran with before options existed.
NCU_SETS = {  # what ncu collects; more sections = more replay passes per kernel (ncu 2026.3.1, lm_head matmul)
    "full": "--set full",  # every section and rule: 41 passes
    "detailed": "--set detailed",
    "basic": "--set basic",  # launch stats, occupancy, speed of light
    "memory": "--section SpeedOfLight --section MemoryWorkloadAnalysis --section SourceCounters",  # 12 passes
}
NCU_CACHE = ("all", "none")  # --cache-control: flush caches before every pass (default), or keep them warm
NCU_CLOCK = ("base", "none")  # --clock-control: lock the GPU to its base clock (default), or leave its own clocks
LAST_ITERATION = 129  # the measured request's last executor iteration (/perf_metrics numbering); the closer follows
MAX_KERNEL_ITERATIONS = 3  # a profiled iteration takes about 13 minutes under --set full


def ncu_prefix(ncu_set: str = "full", ncu_cache: str = "all", ncu_clock: str = "base") -> str:
    """Nsight Compute around trtllm-serve. --graph-profiling node profiles each kernel inside a CUDA graph replay."""
    return ("ncu --target-processes all --profile-from-start off --graph-profiling node "
            f"{NCU_SETS[ncu_set]} --cache-control {ncu_cache} --clock-control {ncu_clock} "
            f"--import-source yes --metrics {NCU_METRICS} -o /trace/kernels -f")


def trace_settings(trace: str, options: dict | None = None, last_iteration: int = LAST_ITERATION) -> dict:
    """The profiler prefix and iteration range a level runs with after the run's options, and the options in full
    (defaults filled in) for labels.json. ValueError names an option the level does not take or a bad value.
    last_iteration: the last executor iteration of the rep's workload (I02A: 129); a range may not pass it."""
    level = TRACE_LEVELS[trace]
    given = {k: v for k, v in (options or {}).items() if v is not None}
    ncu = {"ncu_set": "full", "ncu_cache": "all", "ncu_clock": "base"}
    if trace == "kernels":
        ncu |= {k: given.pop(k) for k in list(given) if k in ncu}
        if ncu["ncu_set"] not in NCU_SETS or ncu["ncu_cache"] not in NCU_CACHE or ncu["ncu_clock"] not in NCU_CLOCK:
            raise ValueError(f"Nsight Compute options: {ncu}")
    rng = given.pop("profile_range", None)
    if rng is not None and not level.get("profile_range"):
        raise ValueError(f"TRACE={trace} has no profile range")
    rng = rng or level.get("profile_range")
    if rng:
        a, _, b = rng.partition("-")
        if not (a.isdigit() and b.isdigit() and 1 <= int(a) <= int(b) <= last_iteration):
            raise ValueError(f"profile range {rng!r}: first-last, 1 <= first <= last <= {last_iteration}")
        if trace == "kernels" and int(b) - int(a) + 1 > MAX_KERNEL_ITERATIONS:
            raise ValueError(f"profile range {rng!r}: at most {MAX_KERNEL_ITERATIONS} iterations under Nsight Compute")
    if given:
        raise ValueError(f"TRACE={trace} does not take {sorted(given)}")
    prefix = ncu_prefix(**ncu) if trace == "kernels" else level.get("prefix", "")
    out = {"profile_range": rng} if rng else {}
    return {"prefix": prefix, "profile_range": rng, "options": out | (ncu if trace == "kernels" else {})}


def has_profiler(trace: str) -> bool:
    """Off, nographs and live run the normal image with no profiler; the other levels add compose.profile.yaml."""
    return trace != "off" and TRACE_LEVELS[trace].get("profiler", True)


def uses_stamps(trace: str) -> bool:
    """Component stamps (server and client): the components level and every profiled level, never the measured run."""
    return has_profiler(trace) or bool(TRACE_LEVELS[trace].get("stamps"))


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
    (run_dir / "trackers").mkdir()
    (run_dir / "config.yaml").write_text(engine_config)
    for d in (run_dir, run_dir / "trace", run_dir / "trackers"):
        d.chmod(0o777)
    return run_dir


def sh(*cmd: str, capture: bool = True, check: bool = True) -> str:
    return subprocess.run(cmd, check=check, text=True, capture_output=capture).stdout


class Stack:
    def __init__(self, project: str, results_dir: Path, run_id: str, trace: str = "off", options: dict | None = None,
                 model_dir: Path | None = None, last_iteration: int = LAST_ITERATION):
        if trace not in TRACE_LEVELS:
            raise ValueError(f"TRACE={trace}: use one of {list(TRACE_LEVELS)}")
        self.project = project
        self.results_dir = results_dir
        self.run_id = run_id
        self.run_dir = results_dir / run_id
        self.trace = trace
        self.model_dir = model_dir
        self.settings = trace_settings(trace, options, last_iteration)  # ValueError before anything starts
        self.server_start = 0
        self.next_step = 0

    def env(self) -> dict:
        level = TRACE_LEVELS[self.trace]
        return {**os.environ, "RESULTS_DIR": str(self.results_dir), "RUN_ID": self.run_id,
                "SERVER_START": str(self.server_start), "TRACE_PREFIX": self.settings["prefix"],
                "PROFILE_RANGE": profiler_range(self.settings["profile_range"] or ""),
                "TORCH_TRACE": level.get("torch_trace", ""),
                **({"MODEL_DIR": str(self.model_dir)} if self.model_dir else {})}

    def compose(self, *args: str, capture: bool = False, check: bool = True) -> subprocess.CompletedProcess:
        files = ["-f", str(COMPOSE_FILE)] + (["-f", str(PROFILE_FILE)] if has_profiler(self.trace) else []) \
            + (["-f", str(STAMPS_FILE)] if uses_stamps(self.trace) else [])
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
            # Every section's metrics and rule findings per kernel, long format. The devtools read only the kernel
            # strip's headline from it (occupancy, waves, finding count); the sections themselves open in ncu-ui.
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
