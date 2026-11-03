"""Level 2b: inside the server container. The engine's /perf_metrics records, joined to requests by rep.py
(engine_records.json: request id -> entry). Engine times are CLOCK_MONOTONIC seconds: x 1e9 is the run's clock.
"""
import json
from pathlib import Path

from ..schema import Run, Span
from .common import run_dir

# Where TensorRT-LLM 1.2.1 sets each stamp (K18), and the component it belongs to.
STAMPS = {
    "server_arrival_time": ("http", "serve/responses_utils.py:1929", "middleware: request arrives (uvicorn)"),
    "arrival_time": ("llm_api", "llmapi/llm.py:388", "LLM.generate_async: template and tokens done"),
    "first_scheduled_time": ("scheduler", "_torch/pyexecutor/seq_slot_manager.py:29", "gets a sequence slot"),
    "first_token_time": ("executor", "_torch/pyexecutor/py_executor.py:2649", "first token generated"),
    "server_first_token_time": ("http", "serve/openai_server.py:500", "stream generator has the first token"),
    "last_token_time": ("executor", "_torch/pyexecutor/py_executor.py:2649", "last token generated"),
}
DATA_FORM = {  # what the request is at each stamp (level 2b's "the data changes form")
    "server_arrival_time": "HTTP body bytes (JSON)",
    "arrival_time": "token IDs (prompt_tokens) in a GenerationRequest",
    "first_scheduled_time": "an LlmRequest in a slot; KV blocks allocated",
    "first_token_time": "logits -> sampled token ID (prefill done)",
    "server_first_token_time": "detokenized text in an SSE event",
    "last_token_time": "the last token ID",
}


def engine(path: Path, run: Run) -> None:
    file = str(path.relative_to(run_dir(path)))
    for rid, entry in json.loads(path.read_text()).items():
        perf = entry["perf_metrics"]
        t = {k: int(round(v * 1e9)) for k, v in perf["timing_metrics"].items()}
        for field, (component, source, what) in STAMPS.items():
            run.spans.append(Span(f"{rid}/engine/{field}", "server", component, field, t[field], None, rid,
                                  {"source": source, "what": what, "data": DATA_FORM[field],
                                   "seconds": perf["timing_metrics"][field]},
                                  {"file": file, "pointer": f"/{rid}/perf_metrics/timing_metrics/{field}"}))
        common = {"engine_request_id": entry["request_id"], "first_iter": perf["first_iter"],
                  "last_iter": perf["last_iter"], "kv_cache": perf.get("kv_cache_metrics")}
        raw = {"file": file, "pointer": f"/{rid}"}
        run.spans += [
            Span(f"{rid}/engine/http", "server", "http", "handler: template, tokenize", t["server_arrival_time"],
                 t["arrival_time"], rid, {}, raw),
            Span(f"{rid}/engine/queue", "server", "scheduler", "queue (executor pickup)", t["arrival_time"],
                 t["first_scheduled_time"], rid, {}, raw),
            Span(f"{rid}/engine/prefill", "server", "executor", "prefill (iteration %d)" % perf["first_iter"],
                 t["first_scheduled_time"], t["first_token_time"], rid, {}, raw),
            Span(f"{rid}/engine/decode", "server", "executor",
                 "decode (iterations %d-%d)" % (perf["first_iter"] + 1, perf["last_iter"]),
                 t["first_token_time"], t["last_token_time"], rid, {}, raw),
            Span(f"{rid}/engine/request", "server", "executor", "request in executor", t["first_scheduled_time"],
                 t["last_token_time"], rid, common, raw),
        ]
