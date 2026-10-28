import json
import re
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

import httpx
import pytest
from huggingface_hub import hf_hub_download
from prometheus_client.parser import text_string_to_metric_families
from transformers import AutoTokenizer

from inference_analysis.completion import CompletionRecord, completion_record
from inference_analysis.kv_cache import kv_cache_shape

REPO_ROOT = Path(__file__).resolve().parents[2]
SERVER_SCRIPT = REPO_ROOT / "scripts" / "llama_cpp_server.py"
CTX_SIZE = 4096
SERVER_FLAGS = [
    "--ctx-size", str(CTX_SIZE),
    "--parallel", "1",
    "--temp", "0",
    "--seed", "0",
    "--n-gpu-layers", "99",
    "--metrics",
]

MODEL_ID = "Qwen/Qwen2.5-0.5B-Instruct"
REVISION = "7ae557604adf67be50417f59c2c2f167def9a775"
SYSTEM = "You are a concise assistant for an inference team."
USER_A = "In one short sentence, what does the KV cache store?"
USER_B = "Why does decode slow down as the KV cache grows?"
N_PREDICT_A = 64
N_PREDICT_B = 12

MIB = 2**20
REMAINDER_MAX_MS = 10.0  # above the largest measured remainder, below the smallest prompt_ms
KV_SIZE_LINE = re.compile(
    r"llama_kv_cache: size =\s*([\d.]+) MiB \(\s*(\d+) cells,\s*(\d+) layers,.*"
    r"K \((\w+)\):\s*([\d.]+) MiB, V \((\w+)\):\s*([\d.]+) MiB"
)


def run_server_script(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SERVER_SCRIPT), *args],
        capture_output=True, text=True, timeout=60,
    )

def messages(user: str) -> list[dict[str, str]]:
    return [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]

def read_metrics(client: httpx.Client, url: str) -> dict[str, float]:
    text = client.get(f"{url}/metrics").text
    return {s.name: s.value for family in text_string_to_metric_families(text) for s in family.samples}

def stream_completion(client: httpx.Client, url: str, body: dict) -> CompletionRecord:
    events = []
    send_ns = time.perf_counter_ns()
    with client.stream("POST", f"{url}/completion", json=body) as response:
        response.raise_for_status()
        for line in response.iter_lines():
            if line.startswith("data: "):
                events.append((time.perf_counter_ns(), json.loads(line.removeprefix("data: "))))
    return completion_record(events, send_ns)

def shared_prefix(a: list[int], b: list[int]) -> int:
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


@pytest.fixture(scope="module")
def tokenizer():
    return AutoTokenizer.from_pretrained(MODEL_ID, revision=REVISION)

@pytest.fixture(scope="module")
def raw_config() -> dict:
    with open(hf_hub_download(MODEL_ID, "config.json", revision=REVISION)) as f:
        return json.load(f)

@pytest.fixture(scope="module")
def prompts(tokenizer) -> dict:
    rendered = {
        key: tokenizer.apply_chat_template(messages(user), tokenize=False, add_generation_prompt=True)
        for key, user in (("A", USER_A), ("B", USER_B))
    }
    ids = {key: tokenizer(text, add_special_tokens=False)["input_ids"] for key, text in rendered.items()}
    return {"rendered": rendered, "ids": ids}

@pytest.fixture(scope="module")
def run(prompts):
    """One server start: the load log, then A, B and the hazard in that order, /metrics around each."""
    if shutil.which("docker") is None or shutil.which("nvidia-smi") is None:
        pytest.skip("needs Docker and an NVIDIA GPU")
    name = f"i01c-test-{uuid.uuid4().hex[:8]}"
    r = run_server_script("start", name, "--", *SERVER_FLAGS)
    if r.returncode != 0:
        pytest.fail(f"server did not start:\n{r.stderr}")
    url = r.stdout.strip()
    try:
        log = subprocess.run(["docker", "logs", name], capture_output=True, text=True).stderr
        requests = {
            "A": {"prompt": prompts["rendered"]["A"], "n_predict": N_PREDICT_A, "cache_prompt": False},
            "B": {"prompt": prompts["rendered"]["B"], "n_predict": N_PREDICT_B, "cache_prompt": False},
            "hazard": {"prompt": prompts["rendered"]["A"], "n_predict": N_PREDICT_A},
        }
        records, metrics = {}, {}
        with httpx.Client(limits=httpx.Limits(max_keepalive_connections=0), timeout=60) as client:
            eos_token = client.get(f"{url}/props").json()["eos_token"]
            for key, body in requests.items():
                before = read_metrics(client, url)
                records[key] = stream_completion(client, url, {**body, "stream": True})
                after = read_metrics(client, url)
                metrics[key] = {k: after[k] - before[k] for k in after}
        yield {"log": log, "eos_token": eos_token, "records": records, "metrics": metrics}
    finally:
        run_server_script("stop", name)


def test_kv_buffer_at_load(run, raw_config):
    match = KV_SIZE_LINE.search(run["log"])
    assert match, "no 'llama_kv_cache: size = ...' line in the load log"
    size_mib, cells, layers, k_type, k_mib, v_type, v_mib = match.groups()
    predicted = kv_cache_shape(raw_config, CTX_SIZE, dtype_bytes=2)

    assert float(size_mib) == pytest.approx(predicted.total_bytes / MIB, abs=0.005)
    assert float(k_mib) == pytest.approx(predicted.total_bytes / 2 / MIB, abs=0.005)
    assert int(cells) == CTX_SIZE
    assert int(layers) == raw_config["num_hidden_layers"] == 24
    assert (k_type, v_type) == ("f16", "f16")

def test_stream_and_final_event_counted_twice(run, prompts, tokenizer):
    a, b = run["records"]["A"], run["records"]["B"]

    for key, record in (("A", a), ("B", b)):
        n_prompt = len(prompts["ids"][key])
        # chunks (stop false) against the engine's two counts
        assert record.n_chunks == record.tokens_predicted == record.timings["predicted_n"]
        # prompt length against the tokenizer; cells = prompt + reply - 1
        assert record.tokens_evaluated == n_prompt
        assert record.tokens_cached == n_prompt + record.n_chunks - 1
        assert (record.stopping_word, record.truncated) == ("", False)

    # A stops on the end-of-sequence token, which is its last chunk
    assert a.stop_type == "eos"
    assert a.tokens[-1] == tokenizer.convert_tokens_to_ids(run["eos_token"]) == 151645
    # B stops at the limit
    assert b.stop_type == "limit"
    assert b.n_chunks == N_PREDICT_B

def test_engine_timings_against_client_clock_and_metrics(run):
    for key in ("A", "B"):
        record, delta = run["records"][key], run["metrics"][key]
        t = record.timings

        # client clock (independent): the engine's intervals sit inside the client's
        assert 0 < record.ttft_ms - t["prompt_ms"] <= REMAINDER_MAX_MS
        assert 0 < record.e2e_ms - (t["prompt_ms"] + t["predicted_ms"]) <= REMAINDER_MAX_MS

        # /metrics (not independent): the same engine values, exported
        assert delta["llamacpp:prompt_tokens_total"] == t["prompt_n"]
        assert delta["llamacpp:tokens_predicted_total"] == t["predicted_n"]
        assert delta["llamacpp:prompt_seconds_total"] * 1000 == pytest.approx(t["prompt_ms"], abs=1)
        assert delta["llamacpp:tokens_predicted_seconds_total"] * 1000 == pytest.approx(t["predicted_ms"], abs=1)

def test_hazard_cached_prefix_counted_as_prefill(run, prompts):
    hazard, a = run["records"]["hazard"], run["records"]["A"]
    n_prompt = len(prompts["ids"]["A"])
    prefix = shared_prefix(prompts["ids"]["A"], prompts["ids"]["B"])

    assert hazard.timings["cache_n"] == prefix == 18
    assert hazard.timings["prompt_n"] == n_prompt - prefix == 17
    assert hazard.tokens_evaluated == n_prompt == 35
    assert run["metrics"]["hazard"]["llamacpp:prompt_tokens_total"] == hazard.timings["prompt_n"]
    assert hazard.tokens == a.tokens
