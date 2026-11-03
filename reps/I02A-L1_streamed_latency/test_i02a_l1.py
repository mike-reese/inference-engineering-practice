"""I02A-L1's five pass checks, on a fresh stack (one module-scoped fixture). Skipped without the GPU.

Does not import rep.py; uses the same pieces (compose_stack, latency_records, pcap_streams). Do not run while rep.py
runs: one GPU serves one engine. Watch it in the devtools under the project ie-i02a-l1-test.
"""
import base64
import json
import shutil
import sys
import time
from pathlib import Path

import httpx
import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
from compose_stack import Stack, prepare_run_dir  # noqa: E402

from inference_analysis.latency import latency_records  # noqa: E402
from inference_analysis.server_evidence import pcap_streams  # noqa: E402

MODEL_DIR = Path.home() / (".local/share/inference-engineering/models/Qwen2.5-0.5B-Instruct/"
                           "7ae557604adf67be50417f59c2c2f167def9a775")
CONFIG = ("return_perf_metrics: true\nperf_metrics_max_requests: 100\nkv_cache_config:\n"
          "  enable_block_reuse: false\n  free_gpu_memory_fraction: 0.5\n")
MESSAGES = [
    {"role": "system", "content": "You are a concise assistant for an inference team."},
    {"role": "user", "content": "Why does decode slow down as the KV cache grows?"},
]

pytestmark = pytest.mark.skipif(shutil.which("nvidia-smi") is None, reason="needs the GPU")


def step(phase, rid):
    return {"phase": phase, "isl": 34, "diagnostic": True, "detail": True,
            "requests": [{"request_id": rid, "messages": MESSAGES, "max_tokens": 64}]}


def perf(base, poll_s=0.0):
    deadline = time.monotonic() + poll_s
    while True:
        entries = httpx.get(f"{base}/perf_metrics", timeout=5).json()
        if entries or time.monotonic() >= deadline:
            return entries
        time.sleep(0.05)


@pytest.fixture(scope="module")
def measured(tmp_path_factory):
    results = tmp_path_factory.mktemp("i02a")
    results.chmod(0o777)
    run_id = "I02A_test"
    prepare_run_dir(results, run_id, CONFIG)
    stack = Stack("ie-i02a-l1-test", results, run_id)
    try:
        base = stack.up()
        stack.run_step(step("warmup", "t-warmup"))
        drained = perf(base, 2.0)
        stack.run_step(step("diagnostic", "t-measured"))
        first, second = perf(base, 2.0), perf(base)
    finally:
        stack.down()
    stack.chown()
    record = json.loads((results / run_id / "client" / "t-measured.json").read_text())
    streams = pcap_streams(stack.pcap_frames())
    from transformers import AutoTokenizer
    encoded = AutoTokenizer.from_pretrained(MODEL_DIR).apply_chat_template(MESSAGES, add_generation_prompt=True)
    offline = len(encoded["input_ids"] if hasattr(encoded, "keys") else encoded)
    stream = streams["t-measured"]
    return {"record": record, "drained": drained, "first": first, "second": second, "streams": streams,
            "stream": stream, "offline": offline, "latency": latency_records(record, first[0], stream)}


def token_events(record):
    return [e for e in record["events"] if (e["event"].get("choices") or [{}])[0].get("logprobs")]


def test_1_token_counts(measured):
    record = measured["record"]
    usage = record["usage"]
    records = [len(e["event"]["choices"][0]["logprobs"]["content"]) for e in token_events(record)]
    assert usage["prompt_tokens"] == measured["offline"]
    assert set(records) == {1}
    assert usage["completion_tokens"] == sum(records)
    assert len(records) == usage["completion_tokens"]
    assert usage["prompt_tokens_details"]["cached_tokens"] == 0


def test_2_client_intervals_against_the_engine(measured):
    lat = measured["latency"]
    c, e, r = lat["client"], lat["engine"], lat["remainder"]
    assert abs(r["mean_itl_ms"]) <= 0.1
    assert 0 < r["ttft_ms"] <= 10
    assert 0 < c["ttft_ms"] - e["http_ttft_ms"] <= 10
    assert 0 < r["e2e_ms"] <= 10


def test_3_which_client_time_is_the_first_token(measured):
    record, lat = measured["record"], measured["latency"]
    c = lat["client"]
    assert c["headers_ms"] < c["first_body_read_ms"]
    first_read = base64.b64decode(record["body_reads"][0]["base64"])
    assert b'"role":"assistant"' in first_read and b'"logprobs"' not in first_read  # the role event only
    assert c["ttft_ms"] > c["first_body_read_ms"]
    assert c["headers_ms"] - lat["engine"]["ttft_ms"] < 0


def test_4_the_join(measured):
    first = measured["first"]
    assert len(measured["drained"]) == 1
    assert len(first) == 1 and measured["second"] == []
    p = first[0]["perf_metrics"]
    assert p["last_iter"] - p["first_iter"] + 1 == measured["record"]["usage"]["completion_tokens"]
    assert isinstance(first[0]["request_id"], int)


def test_5_the_wire(measured):
    lat, stream = measured["latency"], measured["stream"]
    assert "t-measured" in measured["streams"]  # one chat request per stream, joined by X-Request-ID
    assert len(stream["token_event_ns"]) == measured["record"]["usage"]["completion_tokens"]
    assert abs(lat["wire"]["mean_itl_ms"] - lat["client"]["mean_itl_ms"]) <= 0.05
    assert min(s["ms"] for s in lat["segments"]) > 0
    headers_wire_ms = lat["wire"]["headers_ms"]
    first_token_ms = sum(s["ms"] for s in lat["segments"][:4])  # send -> first_token_time, on the client clock
    assert headers_wire_ms - first_token_ms < 0
