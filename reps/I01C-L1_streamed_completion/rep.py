import dataclasses
import hashlib
import importlib.util
import json
import os
import platform
import re
import subprocess
import sys
import time
import uuid
from importlib.metadata import version
from pathlib import Path
from typing import Any

os.environ.setdefault("HF_HUB_OFFLINE", "1")  # before any Hugging Face import: nothing is downloaded

import httpx
from huggingface_hub import hf_hub_download
from prometheus_client.parser import text_string_to_metric_families
from transformers import AutoTokenizer, PreTrainedTokenizerBase

from inference_analysis.completion import completion_record
from inference_analysis.kv_cache import kv_cache_shape

MODEL_ID = "Qwen/Qwen2.5-0.5B-Instruct"
REVISION = "7ae557604adf67be50417f59c2c2f167def9a775"
SYSTEM = "You are a concise assistant for an inference team."
USER_A = "In one short sentence, what does the KV cache store?"
USER_B = "Why does decode slow down as the KV cache grows?"
N_PREDICT_A = 64
N_PREDICT_B = 12

REP_DIR = Path(__file__).resolve().parent
RESULTS_DIR = REP_DIR / "results"
SERVER_SCRIPT = REP_DIR.parents[1] / "scripts" / "llama_cpp_server.py"
# rep.py starts the server with the script's default image and GGUF, so read them from there.
_spec = importlib.util.spec_from_file_location("llama_cpp_server", SERVER_SCRIPT)
_server_script = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_server_script)
ENGINE_IMAGE: str = _server_script.DEFAULT_IMAGE
ENGINE_GGUF: Path = _server_script.DEFAULT_GGUF.resolve()

CTX_SIZE = 4096
SERVER_FLAGS = [
    "--ctx-size", str(CTX_SIZE),
    "--parallel", "1",
    "--temp", "0",
    "--seed", "0",
    "--n-gpu-layers", "99",
    "--metrics",
]
MIB = 2**20
KV_SIZE_LINE = re.compile(
    r"llama_kv_cache: size =\s*([\d.]+) MiB \(\s*(\d+) cells,\s*(\d+) layers,.*"
    r"K \((\w+)\):\s*([\d.]+) MiB, V \((\w+)\):\s*([\d.]+) MiB"
)
METRICS = [
    "llamacpp:prompt_tokens_total",
    "llamacpp:tokens_predicted_total",
    "llamacpp:prompt_seconds_total",
    "llamacpp:tokens_predicted_seconds_total",
    "llamacpp:n_decode_total",
]
LINES: list[str] = []

def emit(line: str = "") -> None:
    """Print a line and keep it for results/output.txt"""
    print(line)
    LINES.append(line)

def start_server(name: str) -> tuple[str, str]:
    """Start llama.cpp server through the server script; return (base URL, the docker run command it recorded)."""
    r = subprocess.run(
        [sys.executable, str(SERVER_SCRIPT), "start", name, "--", *SERVER_FLAGS],
        capture_output=True, text=True, timeout=60,
    )
    if r.returncode != 0:
        raise RuntimeError(f"server did not start (exit {r.returncode}):\n{r.stderr}")
    docker_cmd = next(line[2:] for line in r.stderr.splitlines() if line.startswith("+ docker run"))
    return r.stdout.strip(), docker_cmd 

def stop_server(name: str) -> None:
    """Stop the server through the server script. Safe to call when it is already gone."""
    r = subprocess.run(
        [sys.executable, str(SERVER_SCRIPT), "stop", name],
        capture_output=True, text=True, timeout=30
    )
    emit(f"server: {r.stderr.strip()} (exit {r.returncode})")
    if r.returncode != 0:
        raise RuntimeError(
            f"server did not stop (exit {r.returncode}):\n{r.stderr}"
        )

def machine_state() -> dict[str, Any]:
    """SM clock, temperature and free GPU memory from nvidia-smi, and the 1/5/15-minute load average."""
    gpu = subprocess.run(
        ["nvidia-smi", "--query-gpu=clocks.sm,temperature.gpu,memory.free", "--format=csv,noheader,nounits"],
        capture_output=True, text=True, timeout=30, check=True,
    ).stdout.strip()
    sm_mhz, temp_c, free_mib = (int(v) for v in gpu.split(", "))
    return {"sm_clock_mhz": sm_mhz, "temperature_c": temp_c, "free_mib": free_mib, "load_average": os.getloadavg()}

def configuration(client: httpx.Client, url: str, docker_cmd: str) -> dict[str, Any]:
    """Step 1: versions, revision, the docker run command, /props, and the engine's GPU, image and GGUF."""
    if ENGINE_IMAGE not in docker_cmd or f"/models/{ENGINE_GGUF.name}" not in docker_cmd:
        raise RuntimeError(f"docker run does not use {ENGINE_IMAGE} and {ENGINE_GGUF.name}:\n{docker_cmd}")
    props = client.get(f"{url}/props").json()
    gpu = subprocess.run(
        ["nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader"],
        capture_output=True, text=True, timeout=30, check=True,
    ).stdout.strip()
    image_id = subprocess.run(
        ["docker", "image", "inspect", "--format", "{{.Id}}", ENGINE_IMAGE],
        capture_output=True, text=True, timeout=30, check=True,
    ).stdout.strip()
    with ENGINE_GGUF.open("rb") as f:
        gguf_sha256 = hashlib.file_digest(f, "sha256").hexdigest()
    config = {
        "python": platform.python_version(),
        **{pkg: version(pkg) for pkg in ("httpx", "prometheus-client", "transformers", "huggingface_hub")},
        "model": MODEL_ID,
        "revision": REVISION,
        "hf_hub_offline": os.environ["HF_HUB_OFFLINE"],
        "docker_run": docker_cmd,
        "build_info": props["build_info"],
        "eos_token": props["eos_token"],
        "total_slots": props["total_slots"],
        "gpu_name_driver": gpu,
        "engine_image": ENGINE_IMAGE,
        "engine_image_id": image_id,
        "gguf_path": str(ENGINE_GGUF),
        "gguf_bytes": ENGINE_GGUF.stat().st_size,
        "gguf_sha256": gguf_sha256,
    }
    emit("== Configuration")
    for key, value in config.items():
        emit(f"{key:18} {value}")
    return config

def inspect_kv_at_load(name: str, raw_config: dict) -> dict[str, Any]:
    """Step 2, point 1: the load log's KV lines beside kv_cache_shape at the cache's dtype (f16, 2 bytes)."""
    log = subprocess.run(["docker", "logs", name], capture_output=True, text=True, timeout=30).stderr
    lines = [line for line in log.splitlines() if "llama_kv_cache" in line or "Flash Attention" in line]
    match = KV_SIZE_LINE.search(log)
    if match is None:
        raise RuntimeError("no 'llama_kv_cache: size = ...' line in the load log")
    size_mib, cells, layers, k_type, k_mib, v_type, v_mib = match.groups()
    predicted = kv_cache_shape(raw_config, CTX_SIZE, dtype_bytes=2)
    weights_dtype = kv_cache_shape(raw_config, CTX_SIZE)  # default dtype_bytes=4: the wrong dtype
    record = {
        "log_lines": lines,
        "engine": {"size_mib": float(size_mib), "cells": int(cells), "layers": int(layers),
                    "k_type": k_type, "k_mib": float(k_mib), "v_type": v_type, "v_mib": float(v_mib)},
        "predicted": {**dataclasses.asdict(predicted), "size_mib": predicted.total_bytes / MIB,
                    "k_mib": predicted.total_bytes / 2 / MIB},
        "predicted_at_4_bytes_mib": weights_dtype.total_bytes / MIB,
        "num_hidden_layers": raw_config["num_hidden_layers"],
    }
    emit()
    emit("== Point 1: KV buffer at load")
    for line in lines:
        emit(line)
    emit(f"kv_cache_shape(config, {CTX_SIZE}, dtype_bytes=2): {predicted}")
    emit(f"size MiB: engine {size_mib} | predicted {record['predicted']['size_mib']:.2f} | "
        f"difference {float(size_mib) - record['predicted']['size_mib']:.4f}")
    emit(f"K MiB:    engine {k_mib} | predicted {record['predicted']['k_mib']:.2f} | "
        f"difference {float(k_mib) - record['predicted']['k_mib']:.4f}")
    emit(f"cells {cells} vs --ctx-size {CTX_SIZE}; layers {layers} vs num_hidden_layers {raw_config['num_hidden_layers']}")
    emit(f"K and V dtype: {k_type}, {v_type}; at the weights' 4 bytes the model predicts {record['predicted_at_4_bytes_mib']:.2f} MiB")
    return record

def inspect_prompts(tokenizer: PreTrainedTokenizerBase, eos_token: str) -> dict[str, Any]:
    """Step 3: both prompts rendered and counted with transformers, their shared prefix, and the eos ID."""
    rendered, ids = {}, {}
    for key, user in (("A", USER_A), ("B", USER_B)):
        messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]
        rendered[key] = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        ids[key] = tokenizer(rendered[key], add_special_tokens=False)["input_ids"]
    shared = 0
    for x, y in zip(ids["A"], ids["B"]):
        if x != y:
            break
        shared += 1
    record = {
        "rendered": rendered,
        "ids": ids,
        "counts": {key: len(v) for key, v in ids.items()},
        "shared_prefix": shared,
        "eos_token": eos_token,
        "eos_id": tokenizer.convert_tokens_to_ids(eos_token),
    }
    emit()
    emit("== Prompts (second sources)")
    emit(f"token counts: A {record['counts']['A']}, B {record['counts']['B']}; shared prefix {shared}")
    emit(f"eos_token {eos_token!r} -> ID {record['eos_id']}")
    return record

def read_metrics(client: httpx.Client, url: str) -> dict[str, float]:
    text = client.get(f"{url}/metrics").text
    return {s.name: s.value for family in text_string_to_metric_families(text) for s in family.samples}

def stream_request(client: httpx.Client, url: str, body: dict) -> dict[str, Any]:
    """Send one streamed /completion; time the headers and every data: line from the send."""
    events = []
    send_ns = time.perf_counter_ns()
    with client.stream("POST", f"{url}/completion", json={**body, "stream": True}) as response:
        headers_ns = time.perf_counter_ns()
        response.raise_for_status()
        for line in response.iter_lines():
            if line.startswith("data: "):
                events.append((time.perf_counter_ns(), json.loads(line.removeprefix("data: "))))
    return {
        "body": body,
        "headers_ms": (headers_ns - send_ns) / 1e6,
        "events": [{"ms": (t - send_ns) / 1e6, "event": e} for t, e in events],
        "record": completion_record(events, send_ns),
    }

def report_request(label: str, run: dict, n_prompt: int, eos_id: int, delta: dict[str, float]) -> dict[str, Any]:
    """Step 4: chunks, the final event beside its second sources, timings beside the client clock and /metrics."""
    rec, t = run["record"], run["record"].timings
    chunk_events = [e["event"] for e in run["events"] if not e["event"]["stop"]]
    emit()
    emit(f"== Request {label}: points 2-4")
    emit(f"headers arrive: {run['headers_ms']:.2f} ms after send ({len(run['events'])} data: events)")
    emit("index | ID | content | ms since send | tokens_predicted")
    for i, (token, content, ms, ev) in enumerate(zip(rec.tokens, rec.contents, rec.chunk_ms, chunk_events), start=1):
        emit(f"{i} | {token} | {content!r} | {ms:.2f} | {ev['tokens_predicted']}")

    remainders = {
        "ttft_minus_prompt_ms": rec.ttft_ms - t["prompt_ms"],
        "e2e_minus_both_ms": rec.e2e_ms - (t["prompt_ms"] + t["predicted_ms"]),
    }
    checks = {
        "chunks | tokens_predicted | predicted_n": (rec.n_chunks, rec.tokens_predicted, t["predicted_n"]),
        "stop_type | last ID | eos ID": (rec.stop_type, rec.tokens[-1], eos_id),
        "tokens_evaluated | tokenizer count": (rec.tokens_evaluated, n_prompt),
        "tokens_cached | count + chunks - 1": (rec.tokens_cached, n_prompt + rec.n_chunks - 1),
        "stopping_word | truncated": (rec.stopping_word, rec.truncated),
        "cache_n | prompt_n": (t["cache_n"], t["prompt_n"]),
        "TTFT | prompt_ms | remainder": (rec.ttft_ms, t["prompt_ms"], remainders["ttft_minus_prompt_ms"]),
        "e2e | prompt_ms + predicted_ms | remainder":
            (rec.e2e_ms, t["prompt_ms"] + t["predicted_ms"], remainders["e2e_minus_both_ms"]),
        "Δprompt_tokens_total | prompt_n": (delta["llamacpp:prompt_tokens_total"], t["prompt_n"]),
        "Δtokens_predicted_total | predicted_n": (delta["llamacpp:tokens_predicted_total"], t["predicted_n"]),
        "Δprompt_seconds_total×1000 | prompt_ms": (delta["llamacpp:prompt_seconds_total"] * 1000, t["prompt_ms"]),
        "Δtokens_predicted_seconds_total×1000 | predicted_ms":
            (delta["llamacpp:tokens_predicted_seconds_total"] * 1000, t["predicted_ms"]),
    }
    emit("value | second source(s):")
    for name, values in checks.items():
        emit(f"  {name}: " + " | ".join(f"{v:.3f}" if isinstance(v, float) else repr(v) for v in values))
    emit(f"timings: {t}")
    return {
        **run,
        "record": dataclasses.asdict(rec),
        "tokenizer_count": n_prompt,
        "remainders_ms": remainders,
        "metrics_delta": delta,
    }

def report_hazard(prompts: dict, hazard: dict, a: dict, totals_after_b: dict[str, float]) -> dict[str, Any]:
    """Step 5: the hazard's prompt_n read as the prompt length, beside the correct readings."""
    t = hazard["record"]["timings"]
    record = {
        "prompt_n": t["prompt_n"],
        "tokenizer_count": prompts["counts"]["A"],
        "cache_n": t["cache_n"],
        "shared_prefix": prompts["shared_prefix"],
        "tokens_evaluated": hazard["record"]["tokens_evaluated"],
        "delta_prompt_tokens_total": hazard["metrics_delta"]["llamacpp:prompt_tokens_total"],
        "reply_matches_a": hazard["record"]["tokens"] == a["record"]["tokens"],
        "totals_after_b": {k: totals_after_b[k] for k in METRICS},
    }
    emit()
    emit("== Hazard: a cached prefix counted as prefill")
    emit(f"prompt_n {record['prompt_n']} (the wrong reading of prompt length) | tokenizer count {record['tokenizer_count']}")
    emit(f"cache_n {record['cache_n']} | shared prefix of A and B {record['shared_prefix']}")
    emit(f"tokens_evaluated {record['tokens_evaluated']}; Δprompt_tokens_total {record['delta_prompt_tokens_total']:.0f}")
    emit(f"reply IDs equal request A's: {record['reply_matches_a']}")
    emit(f"/metrics totals after B (the wrong method, not per request): {record['totals_after_b']}")
    return record

def save_results(records: dict[str, Any]) -> None:
    json_text = json.dumps(
        records,
        indent=2,
        ensure_ascii=False,
        allow_nan=False,
    ) + "\n"

    RESULTS_DIR.mkdir(exist_ok=True)
    record_path = RESULTS_DIR / "record.json"
    output_path = RESULTS_DIR / "output.txt"

    record_path.write_text(json_text, encoding="utf-8")

    emit(f"Results JSON: {record_path}")
    emit(f"Printed output: {output_path}")
    output_path.write_text("\n".join(LINES) + "\n", encoding="utf-8")


def main() -> int:
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, revision=REVISION, local_files_only=True)
    with open(hf_hub_download(MODEL_ID, "config.json", revision=REVISION, local_files_only=True)) as f:
        raw_config = json.load(f)

    records: dict[str, Any] = {"machine_state_before_start": machine_state()}
    name = f"i01c-rep-{uuid.uuid4().hex[:8]}"
    try:
        url, docker_cmd = start_server(name)
        with httpx.Client(limits=httpx.Limits(max_keepalive_connections=0), timeout=60) as client:
            records["configuration"] = configuration(client, url, docker_cmd)
            records["kv_at_load"] = inspect_kv_at_load(name, raw_config)
            prompts = inspect_prompts(tokenizer, records["configuration"]["eos_token"])
            records["prompts"] = prompts

            bodies = {
                "A": {"prompt": prompts["rendered"]["A"], "n_predict": N_PREDICT_A, "cache_prompt": False},
                "B": {"prompt": prompts["rendered"]["B"], "n_predict": N_PREDICT_B, "cache_prompt": False},
                "hazard": {"prompt": prompts["rendered"]["A"], "n_predict": N_PREDICT_A},
            }
            prompt_key = {"A": "A", "B": "B", "hazard": "A"}
            metrics = [read_metrics(client, url)]
            records["metrics_before"] = metrics[0]
            requests = {}
            for label, body in bodies.items():
                run = stream_request(client, url, body)
                metrics.append(read_metrics(client, url))
                delta = {k: metrics[-1][k] - metrics[-2][k] for k in METRICS}
                requests[label] = report_request(
                    label, run, prompts["counts"][prompt_key[label]], prompts["eos_id"], delta
                )
                requests[label]["metrics_after"] = metrics[-1]
            records["requests"] = requests
            records["machine_state_after_requests"] = machine_state()
            records["hazard"] = report_hazard(prompts, requests["hazard"], requests["A"], metrics[2])
        emit()
        emit(f"machine state before start: {records['machine_state_before_start']}")
        emit(f"machine state after requests: {records['machine_state_after_requests']}")
    finally:
        try:
            stop_server(name)
        finally:
            save_results(records)
    return 0


if __name__ == "__main__":
    sys.exit(main())
