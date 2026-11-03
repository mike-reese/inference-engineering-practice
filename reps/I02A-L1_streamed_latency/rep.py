"""I02A-L1: one streamed request to TensorRT-LLM, measured on the client, wire and engine clocks.

    make rep                    # measured run (TRACE=off)
    make rep TRACE=timeline     # Nsight Systems run, labeled, not measured (also: code, kernels)
    make k4                     # walkthrough addition 3: break check 1 on purpose
    make source                 # walkthrough addition 2: where each engine time is stamped

Watch it live in the devtools (http://127.0.0.1:7700): Lifecycle, Requests, then the run under Trace.
"""
import argparse
import json
import os
import secrets
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

REP_DIR = Path(__file__).resolve().parent
REPO = REP_DIR.parents[1]
sys.path.insert(0, str(REPO / "scripts"))
from compose_stack import (NCU_CACHE, NCU_CLOCK, NCU_SETS, TRACE_IMAGE, TRACE_LEVELS, Stack,  # noqa: E402
                           has_profiler, prepare_run_dir, trace_settings)

from inference_analysis.efficiency import efficiency  # noqa: E402
from inference_analysis.latency import N_TTFT, latency_records  # noqa: E402
from inference_analysis.server_evidence import pcap_streams  # noqa: E402
from inference_analysis.trace.build import write_run  # noqa: E402

PROJECT = "ie-i02a-l1"
RESULTS_DIR = REP_DIR / "results"
SERVER_IMAGE = "ie-tensorrt-llm:1.2.1-nvml-byref"
IMAGES = (SERVER_IMAGE, "ie-capture:alpine3.20", "ie-client:i01-l2")
PATCHED_FILE = "/usr/local/lib/python3.12/dist-packages/tensorrt_llm/_utils.py"
MODEL_DIR = Path.home() / (".local/share/inference-engineering/models/Qwen2.5-0.5B-Instruct/"
                           "7ae557604adf67be50417f59c2c2f167def9a775")
ENGINE_CONFIG = """return_perf_metrics: true
perf_metrics_max_requests: 100
kv_cache_config:
  enable_block_reuse: false
  free_gpu_memory_fraction: 0.5
"""
MESSAGES = [
    {"role": "system", "content": "You are a concise assistant for an inference team."},
    {"role": "user", "content": "Why does decode slow down as the KV cache grows?"},
]
K4_MESSAGES = [{"role": "user", "content": "What is 2 plus 2? Answer briefly."}]
MAX_TOKENS = 64
LIVE_HOLD_S = 6  # live level: seconds the stack stays up after the last request (the collector's read cycle is <= ~4 s)
GPU_QUERY = "utilization.gpu,utilization.memory,memory.used,power.draw,clocks.sm,temperature.gpu,pcie.link.gen.current"
SOURCE_STAMPS = {  # K18: the file each engine time is set in, and the text that sets it
    "server_arrival_time": ("serve/responses_utils.py", "server_arrival_time"),
    "arrival_time": ("llmapi/llm.py", "arrival_time = steady_clock_now"),
    "first_scheduled_time": ("_torch/pyexecutor/seq_slot_manager.py", "set_first_scheduled_time"),
    # first_token_time and last_token_time are set in C++ (GenericLlmRequest::updatePerfMetrics, libtensorrt_llm.so):
    # first_token_time on the first call, last_token_time on every call. This is the Python line that calls it.
    "first_token_time": ("_torch/pyexecutor/py_executor.py", "update_perf_metrics("),
    "last_token_time": ("_torch/pyexecutor/py_executor.py", "update_perf_metrics("),
    "server_first_token_time": ("serve/openai_server.py", "server_first_token_time = get_steady_clock_now"),
}


PROGRESS = False  # --progress json


def progress(step: str, **data) -> None:
    """--progress json: one line per step as it starts, for the devtools runner (scripts/runner.py)."""
    if PROGRESS:
        print("@@progress " + json.dumps({"step": step, "wall_ns": time.time_ns(), **data}), flush=True)


def run(*cmd: str) -> str:
    return subprocess.run(cmd, check=True, text=True, capture_output=True).stdout.strip()


def save_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, indent=2))


def execution_basis() -> dict:
    """What this run ran on: GPU, Docker, the exact images, the patched file's hash, torch."""
    import torch
    query = "name,compute_cap,driver_version,clocks.sm,temperature.gpu,power.draw"
    gpu = dict(zip(query.split(","), run("nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader").split(", ")))
    if gpu["compute_cap"] != "12.0":
        sys.exit(f"expected compute capability 12.0 (RTX 5060 Ti), found {gpu['compute_cap']}")
    return {
        "utc": datetime.now(timezone.utc).isoformat(),
        "gpu": gpu,
        "docker": run("docker", "version", "--format", "{{.Server.Version}}"),
        "compose": run("docker", "compose", "version", "--short"),
        "images": {image: run("docker", "image", "inspect", image, "--format", "{{.Id}}") for image in IMAGES},
        "patched_file_sha256": run("docker", "run", "--rm", "--entrypoint", "sha256sum", SERVER_IMAGE,
                                   PATCHED_FILE).split()[0],
        "torch": torch.__version__,
    }


def offline_prompt(messages: list[dict]) -> dict:
    """Point 1: the chat template rendered and tokenized outside the server, from the files the engine mounts."""
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR)
    text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    encoded = tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=True)
    ids = encoded["input_ids"] if hasattr(encoded, "keys") else encoded  # a BatchEncoding in transformers 5.20.2
    return {"rendered": text, "tokens": len(ids), "input_ids": list(ids), "returned": type(encoded).__name__}


def step(phase: str, request_id: str, messages=MESSAGES, **options) -> dict:
    """One control file for the client container: one streamed request, every body read recorded."""
    return {"phase": phase, "isl": 34, "diagnostic": True, "detail": True,
            "requests": [{"request_id": request_id, "messages": messages, "max_tokens": MAX_TOKENS}], **options}


def read_perf_metrics(base: str, poll_s: float = 0.0) -> list:
    """GET /perf_metrics. Each read empties the engine's buffer (K9): only this script may call it."""
    deadline = time.monotonic() + poll_s
    while True:
        entries = httpx.get(f"{base}/perf_metrics", timeout=5).json()
        if entries or time.monotonic() >= deadline:
            return entries
        time.sleep(0.05)


class GpuSampler:
    """nvidia-smi every 100 ms, each line stamped on read with CLOCK_MONOTONIC (the run's clock) -> gpu.csv."""

    def __init__(self, path: Path):
        self.path = path
        self.process = subprocess.Popen(["nvidia-smi", f"--query-gpu={GPU_QUERY}", "--format=csv,noheader,nounits",
                                         "-lms", "100"], stdout=subprocess.PIPE, text=True, bufsize=1)
        self.thread = threading.Thread(target=self.read, daemon=True)
        self.thread.start()

    def read(self) -> None:
        with self.path.open("w") as out:
            for line in self.process.stdout:
                out.write(f"{time.monotonic_ns()},{','.join(v.strip() for v in line.split(','))}\n")
                out.flush()

    def stop(self) -> None:
        self.process.terminate()
        self.thread.join(timeout=5)


def run_stack(run_id: str, trace: str = "off", options: dict | None = None) -> dict:
    """Start the stack, warm up, drain, send the measured request, read its engine record, stop, decode.
    options: the profiler's run options (compose_stack.trace_settings); None keeps the level's defaults."""
    level = TRACE_LEVELS[trace]
    settings = trace_settings(trace, options)
    config = ENGINE_CONFIG + ("cuda_graph_config: null\n" if level.get("graphs") is False else "") \
        + ("enable_iter_perf_stats: true\n" if level.get("iter_stats") else "")  # /metrics for the live Engine view
    run_dir = prepare_run_dir(RESULTS_DIR, run_id, config)
    save_json(run_dir / "labels.json", {"trace": trace, "measured": trace == "off", "graphs": level.get("graphs", True),
                                        "profiler": has_profiler(trace), "iter_stats": bool(level.get("iter_stats")),
                                        "profile_range": settings["profile_range"],
                                        "options": settings["options"]})
    basis = execution_basis()
    stack = Stack(PROJECT, RESULTS_DIR, run_id, trace=trace, options=options)
    measured_id = f"{run_id}-measured"
    slow = trace == "kernels"  # Nsight Compute replays each kernel: the profiled iteration takes minutes
    sampler = GpuSampler(run_dir / "gpu.csv")
    try:
        progress("stack up")
        base = stack.up()
        basis["version"] = httpx.get(f"{base}/version", timeout=5).json()
        progress("warm-up request")
        stack.run_step(step("warmup", f"{run_id}-warmup"), timeout_s=600 if trace != "off" else 60)
        progress("drain /perf_metrics")
        drained = read_perf_metrics(base, poll_s=2.0)
        progress("measured request", note="minutes under Nsight Compute" if slow else None)
        stack.run_step(step("diagnostic", measured_id, **({"timeout_s": 7200} if slow else {})),
                       timeout_s=7200 if slow else 600 if trace != "off" else 60)
        progress("read /perf_metrics twice")
        first, second = read_perf_metrics(base, poll_s=2.0), read_perf_metrics(base)
        if has_profiler(trace):  # the profiler's stop fires at the next iteration: one more request closes the capture
            progress("closer request (ends the profiler range)")
            stack.run_step(step("closer", f"{run_id}-closer"), timeout_s=7200 if slow else 600)
            read_perf_metrics(base)
        if level.get("iter_stats"):  # the devtools read /metrics in ~2 s batches (up to ~4 s): let the last one land
            progress("hold the stack for the Engine view's last iterations")
            time.sleep(LIVE_HOLD_S)
    finally:
        sampler.stop()
        progress("stack down")
        stack.down()
    save_json(run_dir / "basis.json", basis)
    save_json(run_dir / "perf_metrics.json", {"warmup_drain": drained, "first": first, "second": second})
    joined = {}
    if len(drained) == 1:
        joined[f"{run_id}-warmup"] = drained[0]
    if len(first) == 1:  # isolation is the join (K10): one request in flight, a drain before, one record after
        joined[measured_id] = first[0]
    save_json(run_dir / "engine_records.json", joined)
    stack.chown()
    progress("decode capture (tshark)")
    tsv = stack.pcap_frames() if stack.pcap().exists() else ""
    if has_profiler(trace):
        progress("export profiler reports")
    stack.export_trace()
    stack.chown()
    return {"run_dir": run_dir, "stack": stack, "measured_id": measured_id, "drained": drained, "first": first,
            "second": second, "frames_tsv": tsv}


def analyze(result: dict, prompt: dict) -> dict:
    """Decode the capture, join the three clocks, compute efficiency; save streams, latency and efficiency."""
    run_dir = result["run_dir"]
    streams = pcap_streams(result["frames_tsv"]) if result["frames_tsv"] else {}
    save_json(run_dir / "streams.json", streams)
    entries = json.loads((run_dir / "engine_records.json").read_text())
    latency, eff = {}, {}
    for rid, entry in entries.items():
        record = json.loads((run_dir / "client" / f"{rid}.json").read_text())
        latency[rid] = latency_records(record, entry, streams.get(rid))
        eff[rid] = efficiency(MODEL_DIR, entry, record["usage"]["prompt_tokens"], record["usage"]["completion_tokens"])
    save_json(run_dir / "latency.json", latency)
    save_json(run_dir / "efficiency.json", eff)
    return latency


def print_table(run_id: str, result: dict, prompt: dict, latency: dict) -> None:
    rid = result["measured_id"]
    lat = latency.get(rid)
    record = json.loads((result["run_dir"] / "client" / f"{rid}.json").read_text())
    usage = record["usage"]
    print(f"\nrun {run_id} -> {result['run_dir']}")
    print(f"/perf_metrics records: warm-up drain {len(result['drained'])}, after measured {len(result['first'])}, "
          f"second read {len(result['second'])} (expect 1, 1, 0)")
    print(f"prompt: offline {prompt['tokens']} tokens, usage.prompt_tokens {usage['prompt_tokens']}; "
          f"completion_tokens {usage['completion_tokens']}, cached {usage['prompt_tokens_details']['cached_tokens']}")
    if not lat:
        print("no latency record (no engine record for the measured request)")
        return
    c, e, r, w = lat["client"], lat["engine"], lat["remainder"], lat.get("wire", {})
    print(f"events {len(record['events'])}, token events {c['token_events']}, token records {c['token_records']}")
    print(f"\n{'ms from send':<28}{'client':>10}{'wire':>10}{'engine':>10}{'client-engine':>15}")
    rows = [("response headers", c["headers_ms"], w.get("headers_ms"), None, None),
            ("first body read", c["first_body_read_ms"], None, None, None),
            ("TTFT (first token event)", c["ttft_ms"], w.get("ttft_ms"), e["ttft_ms"], r["ttft_ms"]),
            ("end-to-end", c["e2e_ms"], w.get("done_ms"), e["e2e_ms"], r["e2e_ms"]),
            ("mean ITL (/ n-1)", c["mean_itl_ms"], w.get("mean_itl_ms"), e["mean_itl_ms"], r["mean_itl_ms"]),
            ("engine queue", None, None, e["queue_ms"], None),
            ("engine decode span", None, None, e["decode_span_ms"], None),
            ("engine HTTP-layer TTFT", None, None, e["http_ttft_ms"], None)]
    fmt = lambda v: f"{v:10.3f}" if isinstance(v, (int, float)) else f"{'–':>10}"  # noqa: E731
    for name, *values in rows:
        print(f"{name:<28}" + "".join(fmt(v) for v in values[:3]) + f"{fmt(values[3]):>15}")
    print(f"perceived TPS {c['perceived_tps']:.1f}" if c["perceived_tps"] else f"exact ITL Unavailable: {c['unavailable']}")
    if "segments" in lat:
        print(f"\nsegments (client TTFT = the first {N_TTFT}):")
        for s in lat["segments"]:
            print(f"  {s['ms']:8.3f}  {s['name']:<52} [{s['clocks']}]")
        print(f"  {sum(s['ms'] for s in lat['segments'][:N_TTFT]):8.3f}  sum of the {N_TTFT} = client TTFT {c['ttft_ms']:.3f}")


def k4_demo() -> None:
    """Walkthrough addition 3: the K4 prompt with the engine's default skip_special_tokens, then with false."""
    run_id = datetime.now(timezone.utc).strftime("K4_%Y%m%dT%H%M%SZ_") + secrets.token_hex(3)
    run_dir = prepare_run_dir(RESULTS_DIR, run_id, ENGINE_CONFIG)
    save_json(run_dir / "labels.json", {"trace": "off", "measured": False, "demo": "K4"})
    stack = Stack(PROJECT, RESULTS_DIR, run_id)
    try:
        stack.up()
        stack.run_step(step("warmup", f"{run_id}-warmup"))
        stack.run_step(step("control", f"{run_id}-default", K4_MESSAGES, skip_special_tokens=None))
        stack.run_step(step("control", f"{run_id}-false", K4_MESSAGES))
    finally:
        stack.down()
    stack.chown()
    out = {}
    for name in ("default", "false"):
        record = json.loads((run_dir / "client" / f"{run_id}-{name}.json").read_text())
        tokens = [e for e in record["events"] if (e["event"].get("choices") or [{}])[0].get("logprobs")]
        records = sum(len(e["event"]["choices"][0]["logprobs"]["content"] or []) for e in tokens)
        out[name] = {"skip_special_tokens": "engine default" if name == "default" else False,
                     "events": len(record["events"]), "token_events": len(tokens), "records": records,
                     "completion_tokens": record["usage"]["completion_tokens"],
                     "text": "".join((e["event"]["choices"][0]["delta"].get("content") or "") for e in tokens),
                     "check_1_holds": records == record["usage"]["completion_tokens"]}
        print(f"{name:>8}: {out[name]['records']} records against completion_tokens {out[name]['completion_tokens']}"
              f" -> check 1 {'holds' if out[name]['check_1_holds'] else 'FAILS'}")
    save_json(RESULTS_DIR / "k4_demo.json", {"run_id": run_id, **out})


def source_lines() -> None:
    """Walkthrough addition 2: the line in the image's installed source that stamps each timing field (K18)."""
    root = "/usr/local/lib/python3.12/dist-packages/tensorrt_llm"
    out = {}
    for field, (file, pattern) in SOURCE_STAMPS.items():
        found = subprocess.run(["docker", "run", "--rm", "--entrypoint", "grep", SERVER_IMAGE, "-nF", pattern,
                                f"{root}/{file}"], text=True, capture_output=True).stdout.splitlines()
        out[field] = [{"file": file, "line": int(line.split(":", 1)[0]), "text": line.split(":", 1)[1].strip()}
                      for line in found]
        for hit in out[field]:
            print(f"{field:<24} {file}:{hit['line']}  {hit['text'][:90]}")
    save_json(RESULTS_DIR / "source_lines.json", out)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--trace", default=os.environ.get("TRACE", "off"), choices=list(TRACE_LEVELS))
    parser.add_argument("--k4", action="store_true")
    parser.add_argument("--source", action="store_true")
    parser.add_argument("--progress", choices=["none", "json"], default="none",
                        help="json: one @@progress line per step (the devtools runner reads them)")
    # Profiler options (labels.json "options"); left out = the level's default.
    parser.add_argument("--profile-range", help="executor iterations to profile, first-last (measured request: 66-129)")
    parser.add_argument("--ncu-set", choices=list(NCU_SETS), help="TRACE=kernels: what Nsight Compute collects")
    parser.add_argument("--ncu-cache", choices=NCU_CACHE, help="TRACE=kernels: flush caches before each pass, or not")
    parser.add_argument("--ncu-clock", choices=NCU_CLOCK, help="TRACE=kernels: lock base clocks, or not")
    args = parser.parse_args()
    options = {"profile_range": args.profile_range, "ncu_set": args.ncu_set, "ncu_cache": args.ncu_cache,
               "ncu_clock": args.ncu_clock}
    try:
        trace_settings(args.trace, options)  # a bad option fails here, before a run folder exists
    except ValueError as error:
        parser.error(str(error))
    global PROGRESS
    PROGRESS = args.progress == "json"
    if args.k4:
        return k4_demo()
    if args.source:
        return source_lines()
    if args.trace in ("code", "kernels"):
        run("docker", "image", "inspect", TRACE_IMAGE)  # fails clearly: run `make images` first
    prefix = "I02A" if args.trace == "off" else f"I02A-TRACE-{args.trace}"
    run_id = datetime.now(timezone.utc).strftime(f"{prefix}_%Y%m%dT%H%M%SZ_") + secrets.token_hex(3)
    progress("run", run_id=run_id, trace=args.trace)
    prompt = offline_prompt(MESSAGES)
    result = run_stack(run_id, args.trace, options)
    save_json(result["run_dir"] / "prompt.json", prompt)
    progress("analysis")
    latency = analyze(result, prompt)
    print_table(run_id, result, prompt, latency)
    progress("run.json")
    out = write_run(result["run_dir"])
    print(f"\nrun.json: {out}  ({len(json.loads(out.read_text())['spans'])} spans)")
    print(f"devtools: http://127.0.0.1:7700/#trace/{run_id}")
    progress("done", run_id=run_id)
    if args.trace != "off":
        kind = ("profiled run" if has_profiler(args.trace)
                else "unprofiled run with engine iteration stats" if TRACE_LEVELS[args.trace].get("iter_stats")
                else "unprofiled comparison run (CUDA graphs off)")
        print(f"TRACE={args.trace}: {kind}, labeled; not a measured result.")


if __name__ == "__main__":
    main()
