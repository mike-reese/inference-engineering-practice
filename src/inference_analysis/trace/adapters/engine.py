"""Level 2b: inside the server container. The engine's /perf_metrics records, joined to requests by rep.py
(engine_records.json: request id -> entry). Engine times are CLOCK_MONOTONIC seconds: x 1e9 is the run's clock.

unpaired(): the same records when no client/native join exists (I02C: two requests in flight; the native numeric
IDs match no client ID). rep.py saves native_records.json in the run folder:

    {"first":  [<each /perf_metrics entry exactly as returned, in returned order>],   # the run's population
     "second": [<the immediate second /perf_metrics read, as returned>],             # empty when drained
     "prometheus_reads": {"baseline": {"start_ns": int, "end_ns": int},              # CLOCK_MONOTONIC
                          "final":    {"start_ns": int, "end_ns": int}}}             # (time.monotonic_ns())

beside the two Prometheus scrapes as returned: prometheus_baseline.txt (after warm-up) and prometheus_final.txt
(after the population completed). Other keys are kept in the file and ignored here. Each entry becomes spans with
request_id None (native ID and iterations in attrs); metrics.aggregate() reads the same files for the set's totals.
Per-client native fields go to `unavailable`. Entries are never assigned to a client by order or duration.
"""
import json
from datetime import datetime, timezone
from pathlib import Path

from ..schema import Run, Span
from .common import run_dir

# Where TensorRT-LLM 1.2.1 sets each stamp (K18), and the component it belongs to.
STAMPS = {
    "server_arrival_time": ("http", "serve/responses_utils.py:1930",
                            "ASGI middleware: headers parsed, body not yet read"),
    "arrival_time": ("llm_api", "llmapi/llm.py:388", "LLM.generate_async: template and tokens done"),
    "first_scheduled_time": ("scheduler", "_torch/pyexecutor/seq_slot_manager.py:29", "gets a sequence slot"),
    "first_token_time": ("executor", "_torch/pyexecutor/py_executor.py:2649", "first token generated"),
    "server_first_token_time": ("http", "serve/openai_server.py:500", "stream generator has the first token"),
    "last_token_time": ("executor", "_torch/pyexecutor/py_executor.py:2649", "last token generated"),
}
DATA_FORM = {  # what the request is at each stamp (level 2b's "the data changes form")
    "server_arrival_time": "HTTP headers parsed; the JSON body not yet read",
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
            Span(f"{rid}/engine/http", "server", "http", "handler: body read, parse, template, tokenize", t["server_arrival_time"],
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


NO_JOIN = "no validated client/native join"


def unpaired(path: Path, run: Run) -> None:
    """native_records.json -> one queue span and one executor span per native entry, none assigned to a client."""
    file = str(path.relative_to(run_dir(path)))
    for i, entry in enumerate(json.loads(path.read_text())["first"]):
        nid, perf = entry["request_id"], entry["perf_metrics"]
        seconds = perf["timing_metrics"]
        t = {k: int(round(v * 1e9)) for k, v in seconds.items()}
        attrs = {"native_request_id": nid, "first_iter": perf["first_iter"], "last_iter": perf["last_iter"],
                 "timing_seconds": seconds, "kv_cache": perf.get("kv_cache_metrics"), "join": NO_JOIN,
                 "source": STAMPS["first_scheduled_time"][1]}
        raw = {"file": file, "pointer": f"/first/{i}"}
        run.spans += [
            Span(f"native/{nid}/queue", "server", "native", f"native {nid}: queue (first_scheduled - arrival)",
                 t["arrival_time"], t["first_scheduled_time"], None, attrs, raw),
            Span(f"native/{nid}/executor", "server", "native",
                 f"native {nid}: in executor (iterations {perf['first_iter']}-{perf['last_iter']})",
                 t["first_scheduled_time"], t["last_token_time"], None, attrs, raw),
        ]
    clients = [s.request_id for s in run.spans if s.component == "locust" and s.name == "request"]
    for rid in clients:
        for what in ("native engine queue", "native engine TTFT"):
            run.unavailable.append({"what": f"{rid}: {what}", "why": NO_JOIN})


ACCUMULATOR = ("raw source-defined accumulator: TensorRT-LLM 1.2.1 adds time.time() differences in seconds with += "
               "despite the MS suffix (executor_request_queue.py:643-654); not a duration, not converted")


def iterations(path: Path, run: Run) -> None:
    """engine_iterations_raw.jsonl -> one span per read and one per returned iteration entry, in reader order
    (reader_seq, then position in the response). The devtools engine collector is the sole /metrics reader and keeps
    its reads in memory; rep.py fetches GET /api/engine/iterations/raw?run_id=<run folder> and writes each element of
    its "reads" list, as returned, as one JSON line of this file. Nothing is
    deduplicated: an iter value can repeat or skip. request_id is None: the counts belong to no client.
    An entry's time is its UTC timestamp (the step's start) moved onto the run's clock with the read's own
    wall/monotonic pair. Its counts can be recorded later (QA: iteration 5 shows queued 1 about 24 ms before the
    second native arrival_time), so join it to native records by iter range, not by time."""
    file = str(path.relative_to(run_dir(path)))
    for n, text in enumerate(path.read_text().splitlines(), 1):
        read = json.loads(text)
        rs, entries = read["reader_seq"], read.get("response")
        kind = ("failed" if read.get("error") else f"status {read.get('status')}" if entries is None
                else "empty" if not entries else f"{len(entries)} entries")
        run.spans.append(Span(f"iterations/read/{rs}", "server", "iterations", f"/metrics read {rs}: {kind}",
                              read["read_start_mono_ns"], read["read_end_mono_ns"], None,
                              {k: read.get(k) for k in ("reader_seq", "status", "error", "empty", "entries",
                                                        "first_seq", "container")},
                              {"file": file, "pointer": f"line {n}"}))
        offset = read["read_start_ns"] - read["read_start_mono_ns"]  # wall - monotonic, from this read
        for i, stat in enumerate(entries or []):
            ib = stat.get("inflightBatchingStats") or {}
            when = datetime.strptime(stat["timestamp"], "%m-%d-%Y %H:%M:%S.%f").replace(tzinfo=timezone.utc)
            ns = int(when.timestamp() * 1e6) * 1000 - offset
            attrs = {"iter": stat.get("iter"), "reader_seq": rs, "index": i,
                     "seq": read["first_seq"] + i if read.get("first_seq") else None,
                     "timestamp": stat["timestamp"], "active": stat.get("numActiveRequests"),
                     "queued": stat.get("numQueuedRequests"), "scheduled": ib.get("numScheduledRequests"),
                     "context": ib.get("numContextRequests"), "context_tokens": ib.get("numCtxTokens"),
                     "generation": ib.get("numGenRequests"), "paused": ib.get("numPausedRequests"),
                     "max_active": stat.get("maxNumActiveRequests"), "new_active": stat.get("numNewActiveRequests"),
                     "completed": stat.get("numCompletedRequests"),
                     "newActiveRequestsQueueLatencyMS": stat.get("newActiveRequestsQueueLatencyMS"),
                     "newActiveRequestsQueueLatencyMS_meaning": ACCUMULATOR}
            run.spans.append(Span(f"iterations/{rs}/{i}", "server", "iterations",
                                  f"iteration {stat.get('iter')} (read {rs}, entry {i})", ns, ns, None, attrs,
                                  {"file": file, "pointer": f"line {n} /response/{i}"}))
