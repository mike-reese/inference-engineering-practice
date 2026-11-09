"""I02C-L1: two streamed requests sharing one engine slot (TensorRT-LLM 1.2.1, --max_batch_size 1).

    make rep REP=I02C-L1_one_slot_queue              # the measured run: smoke and warm-up, the pair, the engine reads
    make rep REP=I02C-L1_one_slot_queue TRACE=live   # the same pair with the engine's iteration stats: check 1's evidence
    make rep REP=I02C-L1_one_slot_queue TRACE=timeline   # also code, kernels, nographs, components: labeled, not measured
    make check REP=I02C-L1_one_slot_queue            # the three pass checks on the newest saved live run

Keep the devtools open (http://127.0.0.1:7700): on a live run its engine collector is the only /metrics reader and
this script copies its raw iteration reads into the run's folder.
"""
import argparse
import json
import re
import secrets
import subprocess
import sys
import sysconfig
import time
from datetime import datetime, timezone
from pathlib import Path
import math
import os
import httpx

REP_DIR = Path(__file__).resolve().parent
REPO = REP_DIR.parents[1]
sys.path.insert(0, str(REPO / "scripts"))
from compose_stack import (TRACE_IMAGE, TRACE_LEVELS, Stack, has_profiler, prepare_run_dir,  # noqa: E402
                           trace_settings, uses_stamps)
from gpu_sampler import GpuSampler  # noqa: E402
from run_levels import level_engine_config, level_labels  # noqa: E402
from inference_analysis.chat_records import chat_durations  # noqa: E402
from inference_analysis.trace.build import write_run  # noqa: E402
from prometheus_client.parser import text_string_to_metric_families  # noqa: E402
PROJECT = "ie-i02c-l1"
RESULTS_DIR = REP_DIR / "results"
SERVER_IMAGE = "ie-tensorrt-llm:1.2.1-nvml-byref"
IMAGES = (SERVER_IMAGE, "ie-capture:alpine3.20", "ie-trackers:alpine3.20", "ie-client:i01-l2")
MODEL_NAME = "nvidia/Qwen3-8B-FP8"
MODEL_REVISION = "2cebc4c89e25abc17668c81b01dceaf3d8b914d5"
MODEL_DIR = Path.home() / ".local/share/inference-engineering/models/Qwen3-8B-FP8" / MODEL_REVISION
ENGINE_CONFIG = """dtype: bfloat16
max_num_tokens: 1024
return_perf_metrics: true
perf_metrics_max_requests: 100
iter_stats_max_iterations: 1000
kv_cache_config:
  enable_block_reuse: false
  free_gpu_memory_fraction: 0.1
  max_tokens: 2048
  dtype: auto
"""
MESSAGES = [
    {"role": "system", "content": "You are a concise assistant for an inference team."},
    {"role": "user", "content": "Explain why a second inference request can wait while another request is decoding."},
]
SMOKE_MESSAGES = [{"role": "user", "content": "What is 2 plus 2? Reply with only the number."}]
TEMPLATE_KWARGS = {"enable_thinking": False}
MAX_TOKENS = 128  # with ignore_eos: A decodes long enough for B to arrive and wait
SMOKE_MAX_TOKENS = 32
RELEASE_TIMEOUT_S = 30  # A's first content took well under 1 s in author QA; this only catches a stuck server
HOLD_S = 6  # the collector's /metrics read waits ~2 s on the engine: let its last batch land before the stop
DEVTOOLS = "http://127.0.0.1:7700"
# Executor iterations (/perf_metrics numbering) of this workload: smoke 1-33, A 34-161, B 163-290.
LAST_ITERATION = 290
# The iterations each profiler covers by default (--profile-range changes it).
#   timeline  the whole run: Nsight Systems records every kernel and copy of both requests.
#   code      the slot hand-off. The PyTorch profiler writes one contiguous range, and all 257 iterations of the pair
#             would be about 2 GB of trace. 158-166 holds every distinct code path: A decoding while B waits, A's
#             last iteration, B scheduled, B's prefill, B's first decodes.
#   kernels   B's first decode iteration (Nsight Compute replays every kernel: minutes per iteration).
PROFILE_RANGES = {"timeline": f"1-{LAST_ITERATION}", "code": "158-166", "kernels": "164-164"}
PROGRESS = False  # --progress json


def progress(step: str, **data) -> None:
    """--progress json: one line per step as it starts, for the devtools runner (scripts/runner.py)."""
    if PROGRESS:
        print("@@progress " + json.dumps({"step": step, "wall_ns": time.time_ns(), **data}), flush=True)
    else:
        print(step)


def run(*cmd: str) -> str:
    return subprocess.run(cmd, check=True, text=True, capture_output=True).stdout.strip()


def save_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, indent=2))


def device(path) -> str:
    """The block device a path is read from."""
    return run("findmnt", "-n", "-o", "SOURCE", "-T", str(path))


def gpu_state() -> dict:
    query = "name,driver_version,memory.total,memory.used,clocks.sm,temperature.gpu,power.draw"
    return dict(zip(query.split(","), run("nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader").split(", ")))


def execution_basis() -> dict:
    """What this run ran on: GPU state, Docker, the images, the model's own metadata, storage devices."""
    config = json.loads((MODEL_DIR / "config.json").read_text())
    return {
        "utc": datetime.now(timezone.utc).isoformat(),
        "gpu_start": gpu_state(),
        "docker": run("docker", "version", "--format", "{{.Server.Version}}"),
        "compose": run("docker", "compose", "version", "--short"),
        "images": {image: run("docker", "image", "inspect", image, "--format", "{{.Id}}") for image in IMAGES},
        "model": {"name": MODEL_NAME, "path": str(MODEL_DIR), "revision": MODEL_REVISION,
                  "quantization_config": config["quantization_config"], "torch_dtype": config["torch_dtype"],
                  "kv_cache_dtype": None},  # what the engine realized, read from its log after the run
        "storage": {"model": device(MODEL_DIR),
                    "docker_root": device(run("docker", "info", "--format", "{{.DockerRootDir}}")),
                    "site_packages": device(sysconfig.get_paths()["purelib"])},
        "engine_config": ENGINE_CONFIG,
    }


def offline_prompt(messages: list[dict]) -> dict:
    """The chat template rendered and tokenized outside the server, from the files the engine mounts."""
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR)
    text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, **TEMPLATE_KWARGS)
    encoded = tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=True, **TEMPLATE_KWARGS)
    ids = encoded["input_ids"] if hasattr(encoded, "keys") else encoded  # a BatchEncoding in transformers 5.20.2
    return {"rendered": text, "tokens": len(ids), "template_kwargs": TEMPLATE_KWARGS}

def drain(base: str, expect: int, poll_s: float) -> list[dict]:
    """GET /perf_metrics until `expect` records came back or poll_s passed. Each read empties the engine's deque,
    so every response is kept, in order. Only this script reads /perf_metrics."""
    reads, deadline = [], time.monotonic() + poll_s
    while True:
        start = time.monotonic_ns()
        entries = httpx.get(f"{base}/perf_metrics", timeout=5).json()
        reads.append({"start_ns": start, "end_ns": time.monotonic_ns(), "entries": entries})
        if sum(len(r["entries"]) for r in reads) >= expect or time.monotonic() >= deadline:
            return reads
        time.sleep(0.05)

def records(reads: list[dict]) -> list[dict]:
    return [entry for read in reads for entry in read["entries"]]


def scrape(base: str, run_dir: Path, which: str) -> dict:
    """GET /prometheus/metrics, saved exactly as returned. A scrape does not drain anything."""
    start = time.monotonic_ns()
    response = httpx.get(f"{base}/prometheus/metrics", timeout=5)
    end = time.monotonic_ns()
    response.raise_for_status()
    (run_dir / f"prometheus_{which}.txt").write_text(response.text)
    return {"start_ns": start, "end_ns": end}


def request(request_id: str, messages: list[dict], max_tokens: int) -> dict:
    return {"request_id": request_id, "messages": messages, "max_tokens": max_tokens}

def smoke_answer(run_dir: Path, request_id: str) -> str:
    """The model's answer: the content before its own end token. ignore_eos forces tokens after it; they are not
    part of the answer. skip_special_tokens=False keeps <|im_end|> in the content, so the split is visible."""
    record = json.loads((run_dir / "client" / f"{request_id}.json").read_text())
    text = "".join((e["event"].get("choices") or [{}])[0].get("delta", {}).get("content") or ""
                   for e in record["events"])
    return text.split("<|im_end|>")[0].strip()

def save_iterations(run_id: str, run_dir: Path) -> dict:
    """The devtools collector's raw /metrics reads for this run, written into this run's folder. The collector is the
    only /metrics reader (each read empties the engine's buffer); this copies what it read, unchanged."""
    response = httpx.get(f"{DEVTOOLS}/api/engine/iterations/raw", params={"run_id": run_id}, timeout=10)
    response.raise_for_status()
    data = response.json()
    with (run_dir / "engine_iterations_raw.jsonl").open("w") as out:
        for read in data["reads"]:
            out.write(json.dumps(read) + "\n")
    return {key: data[key] for key in ("container", "retained", "dropped", "reading")}

def run_stack(run_id: str, prompt: dict, trace: str, options: dict) -> Path:
    """Start, smoke and warm up, drain, baseline scrape, the pair, read its population, final scrape, stop."""
    level = TRACE_LEVELS[trace]
    profiled, slow = has_profiler(trace), trace == "kernels"
    if level.get("iter_stats"):
        httpx.get(DEVTOOLS, timeout=2).raise_for_status()  # the collector must be up before the engine starts
    stack = Stack(PROJECT, RESULTS_DIR, run_id, trace=trace, options=options, model_dir=MODEL_DIR,
                  last_iteration=LAST_ITERATION)  # a bad range fails here, before a run folder exists
    run_dir = prepare_run_dir(RESULTS_DIR, run_id, level_engine_config(ENGINE_CONFIG, trace))
    save_json(run_dir / "labels.json", level_labels(trace, stack.settings) | {"rep": "I02C-L1"})
    save_json(run_dir / "prompt.json", prompt)
    basis = execution_basis()
    timeout_s = 7200 if slow else 600 if trace != "off" else 120  # a profiled iteration takes far longer
    client_timeout = {"timeout_s": timeout_s} if profiled else {}
    sampler = GpuSampler(run_dir)
    perf, prom = {}, {}
    try:
        progress("stack up")
        base = stack.up()
        basis["version"] = httpx.get(f"{base}/version", timeout=5).json()
        progress("smoke and warm-up request (excluded)")
        stack.run_step({"phase": "warmup", "isl": None, "chat_template_kwargs": TEMPLATE_KWARGS,
                        "requests": [request(f"{run_id}-smoke", SMOKE_MESSAGES, SMOKE_MAX_TOKENS)], **client_timeout},
                       timeout_s=timeout_s)
        answer = smoke_answer(run_dir, f"{run_id}-smoke")
        print(f"smoke answer: {answer!r} (expect '4')")
        if answer != "4":
            raise RuntimeError(f"correctness smoke failed: {answer!r}; the pair is not run")
        perf["warmup"] = drain(base, expect=1, poll_s=2.0)
        prom["baseline"] = scrape(base, run_dir, "baseline")
        progress("pair: A, then B on A's first content")
        stack.run_step({"kind": "pair", "phase": "normal", "isl": prompt["tokens"], "pair": 0,
                        "chat_template_kwargs": TEMPLATE_KWARGS, "release_timeout_s": RELEASE_TIMEOUT_S,
                        "requests": [request(f"{run_id}-A", MESSAGES, MAX_TOKENS),
                                     request(f"{run_id}-B", MESSAGES, MAX_TOKENS)], **client_timeout},
                       timeout_s=timeout_s)
        perf["pair"] = drain(base, expect=2, poll_s=2.0)
        perf["second"] = drain(base, expect=0, poll_s=0)  # one read, immediately after: expected empty
        prom["final"] = scrape(base, run_dir, "final")
        if profiled:  # the profiler's stop fires at the next iteration: one more request closes the capture
            progress("closer request (ends the profiler range)")
            stack.run_step({"phase": "closer", "isl": None, "chat_template_kwargs": TEMPLATE_KWARGS,
                            "requests": [request(f"{run_id}-closer", SMOKE_MESSAGES, SMOKE_MAX_TOKENS)],
                            **client_timeout}, timeout_s=timeout_s)
            perf["closer"] = drain(base, expect=1, poll_s=2.0)
        if level.get("iter_stats") or uses_stamps(trace):
            progress(f"hold {HOLD_S} s for the devtools' last /metrics batch or stamp read")
            time.sleep(HOLD_S)
    finally:
        sampler.stop()
        basis["gpu_end"] = gpu_state()
        save_json(run_dir / "perf_metrics_reads.json", perf)
        save_json(run_dir / "native_records.json", {"first": records(perf.get("pair", [])),
                                                    "second": records(perf.get("second", [])),
                                                    "prometheus_reads": prom})
        if level.get("iter_stats"):
            try:
                basis["iterations"] = save_iterations(run_id, run_dir)
            except (httpx.HTTPError, KeyError) as error:
                basis["iterations"] = {"error": f"{type(error).__name__}: {error}"}
                print(f"WARNING: could not fetch the collector's /metrics reads: {error}")
        progress("stack down")
        stack.down()
        log = (run_dir / f"server_s{stack.server_start}.log").read_text()
        realized = re.search(r"kv_cache_quant_algo=(\w+)", log)
        basis["model"]["kv_cache_dtype"] = realized.group(1) if realized else None
        save_json(run_dir / "basis.json", basis)
        stack.chown()
    if stack.pcap().exists():
        stack.pcap_frames()
    if profiled:
        progress("export profiler reports")
        stack.export_trace()
        stack.chown()
    return run_dir

QUEUE_SUM = "trtllm_request_queue_time_seconds_sum"
QUEUE_COUNT = "trtllm_request_queue_time_seconds_count"
SUCCESS = "trtllm_request_success_total"
NO_JOIN = "no validated client/native join"


def prometheus_totals(text: str) -> dict[str, float]:
    """Each series this rep reads, summed over its label sets, parsed by prometheus_client (not the server's code)."""
    totals = {QUEUE_SUM: 0.0, QUEUE_COUNT: 0.0, SUCCESS: 0.0}
    for family in text_string_to_metric_families(text):
        for sample in family.samples:
            if sample.name in totals:
                totals[sample.name] += sample.value
    return totals


def native_queue(entries: list[dict]) -> dict:
    """first_scheduled_time - arrival_time for each native record, as an unpaired set. The engine's histogram
    observes only positive intervals, so the sum and count use only those."""
    intervals = [e["perf_metrics"]["timing_metrics"]["first_scheduled_time"]
                 - e["perf_metrics"]["timing_metrics"]["arrival_time"] for e in entries]
    positive = [v for v in intervals if v > 0]
    return {"native_ids": [e["request_id"] for e in entries], "intervals_s": intervals,
            "sum_s": math.fsum(positive), "count": len(positive)}


def readout(run_id: str, run_dir: Path, prompt: dict) -> dict:
    out = {"run_id": run_id, "offline_prompt_tokens": prompt["tokens"], "clients": {}, "unavailable": []}
    for role in ("A", "B"):
        record = json.loads((run_dir / "client" / f"{run_id}-{role}.json").read_text())
        out["clients"][role] = {key: record[key] for key in ("request_id", "status", "complete", "send_ns",
                                                             "first_content_ns", "release_ns",
                                                             "protocol_complete_ns", "usage")}
        out["clients"][role]["durations"] = chat_durations(record)
        out["unavailable"].append({"what": f"{role}: engine queue interval", "why": NO_JOIN})
    native = json.loads((run_dir / "native_records.json").read_text())
    out["native"] = {**native_queue(native["first"]), "second_read_entries": len(native["second"])}
    base, final = (prometheus_totals((run_dir / f"prometheus_{w}.txt").read_text()) for w in ("baseline", "final"))
    out["prometheus_delta"] = {name: final[name] - base[name] if final[name] >= base[name] else None for name in base}
    prom_sum = out["prometheus_delta"][QUEUE_SUM]
    out["queue_sum_difference_ms"] = None if prom_sum is None else (out["native"]["sum_s"] - prom_sum) * 1000
    labels = json.loads((run_dir / "labels.json").read_text())
    out["iterations_saved"] = (run_dir / "engine_iterations_raw.jsonl").exists() if labels["iter_stats"] else None
    if labels.get("profile_range"):  # traced run: is the slot hand-off inside the profiled iterations?
        first, last = (int(x) for x in labels["profile_range"].split("-"))
        spans = sorted((e["perf_metrics"]["first_iter"], e["perf_metrics"]["last_iter"]) for e in native["first"])
        handoff = [spans[0][1], spans[1][0]] if len(spans) == 2 else None  # earlier record's last, later one's first
        out["trace"] = {"profile_range": labels["profile_range"], "native_iteration_spans": spans,
                        "handoff_iterations": handoff,
                        "handoff_in_range": bool(handoff) and first <= handoff[0] and handoff[1] <= last}
    save_json(run_dir / "readout.json", out)
    return out

def ms(value) -> str:
    return f"{value:9.1f}" if isinstance(value, (int, float)) else f"{'–':>9}"


def print_readout(out: dict) -> None:
    a, b = out["clients"]["A"], out["clients"]["B"]
    t0 = a["send_ns"]
    print(f"\nrun {out['run_id']}  (client times in ms from A's send, perf_counter_ns)")
    print(f"release order: A first content {ms((a['release_ns'] - t0) / 1e6)} < B send {ms((b['send_ns'] - t0) / 1e6)}"
          f" < A done {ms((a['protocol_complete_ns'] - t0) / 1e6)}: "
          f"{a['release_ns'] < b['send_ns'] < a['protocol_complete_ns']}")
    print(f"{'client':<7}{'status':>7}{'ISL':>5}{'OSL':>5}{'TTFC':>9}{'e2e':>9}   (each request on its own; n=1 each)")
    for role, c in out["clients"].items():
        d, u = c["durations"], c["usage"] or {}
        print(f"{role:<7}{c['status']!s:>7}{u.get('prompt_tokens', '–')!s:>5}{u.get('completion_tokens', '–')!s:>5}"
              f"{ms(d['ttft_ms'])}{ms(d['e2e_ms'])}")
    n, p = out["native"], out["prometheus_delta"]
    print(f"offline prompt tokens {out['offline_prompt_tokens']}")
    print(f"native records {len(n['native_ids'])} (ids {n['native_ids']}); immediate second read "
          f"{n['second_read_entries']} entries")
    print(f"native queue sum {n['sum_s']:.6f} s over {n['count']} | Prometheus delta: queue sum {p[QUEUE_SUM]} s, "
          f"queue count {p[QUEUE_COUNT]}, success {p[SUCCESS]}")
    print(f"native - Prometheus queue sum: {out['queue_sum_difference_ms']} ms "
          f"(same engine timestamps: checks the export, not the clock)")
    print(f"A and B engine queue intervals: Unavailable ({NO_JOIN})")
    if "trace" in out:
        t = out["trace"]
        print(f"traced iterations {t['profile_range']}; native iteration spans {t['native_iteration_spans']}; "
              f"slot hand-off {t['handoff_iterations']} inside the range: {t['handoff_in_range']}")
    if out["iterations_saved"] is None:
        print("no iteration stats at this level: check 1's engine evidence comes from a TRACE=live run")
    elif not out["iterations_saved"]:
        print("WARNING: engine_iterations_raw.jsonl missing: the collector's /metrics reads were not saved. "
              "Check 1 has no engine evidence for this run.")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--trace", default=os.environ.get("TRACE") or "off", choices=list(TRACE_LEVELS))
    parser.add_argument("--progress", choices=["none", "json"], default="none",
                        help="json: one @@progress line per step (the devtools runner reads them)")
    parser.add_argument("--profile-range", help="executor iterations to profile, first-last (A 34-161, B 163-290)")
    args = parser.parse_args()
    trace = args.trace
    options = {"profile_range": args.profile_range or PROFILE_RANGES.get(trace)}
    try:
        trace_settings(trace, options, LAST_ITERATION)  # a bad option fails here, before a run folder exists
    except ValueError as error:
        parser.error(str(error))
    global PROGRESS
    PROGRESS = args.progress == "json"
    if uses_stamps(trace):
        run("docker", "image", "inspect", TRACE_IMAGE)  # fails clearly: run `make images` first
    prefix = "I02C" if trace == "off" else f"I02C-TRACE-{trace}"
    run_id = datetime.now(timezone.utc).strftime(f"{prefix}_%Y%m%dT%H%M%SZ_") + secrets.token_hex(3)
    progress("run", run_id=run_id, trace=trace)
    prompt = offline_prompt(MESSAGES)
    print(f"offline prompt: {prompt['tokens']} tokens (thinking off)")
    run_dir = run_stack(run_id, prompt, trace, options)
    out = readout(run_id, run_dir, prompt)
    print_readout(out)
    progress("run.json")
    path = write_run(run_dir)
    print(f"\nrun.json: {path}\ndevtools: {DEVTOOLS}/#trace/{run_id}")
    progress("done", run_id=run_id)
    if trace != "off":
        kind = ("profiled run" if has_profiler(trace)
                else "unprofiled run with engine iteration stats" if TRACE_LEVELS[trace].get("iter_stats")
                else "unprofiled run with component stamps" if TRACE_LEVELS[trace].get("stamps")
                else "unprofiled comparison run (CUDA graphs off)")
        print(f"TRACE={trace}: {kind}, labeled; not a measured result.")


if __name__ == "__main__":
    main()
