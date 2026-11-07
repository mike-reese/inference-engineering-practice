"""Component level (Trace 0b, Components tab): the trace image's server stamps (trace/server_stamps.jsonl, written by
deploy/server/ie_stamps) as spans, one per step a request takes inside the server container.

Each stamp names its component ("box") and the process it ran in (the trtllm-serve HTTP process or the executor
worker). Stamps carry the client's X-Request-ID where the HTTP process has it, and the proxy's client id (cid)
everywhere else; the Attributor joins the two. The devtools' live collector uses the same Attributor.
Standard library only: the devtools container imports this module.
"""
import json
from pathlib import Path

from ..schema import Run, Span
from .common import run_dir

# component -> (the Trace lane it is drawn in, what owns it)
BOXES = {
    "asgi": ("http", "uvicorn ASGI server + TensorRT-LLM ServerArrivalTimeMiddleware"),
    "validate": ("http", "FastAPI + pydantic: JSON body -> ChatCompletionRequest"),
    "parse": ("http", "TensorRT-LLM serve: parse_chat_messages_coroutines"),
    "template": ("http", "TensorRT-LLM inputs.apply_chat_template -> HF tokenizer's Jinja chat template"),
    "tokenizer": ("llm_api", "TensorRT-LLM DefaultInputProcessor -> HF fast tokenizer encode"),
    "llm_api": ("llm_api", "TensorRT-LLM LLM.generate_async"),
    "proxy": ("llm_api", "TensorRT-LLM GenerationExecutorProxy.submit"),
    "ipc_req": ("ipc", "pyzmq socket, pickled GenerationRequest (proxy -> worker)"),
    "worker": ("scheduler", "TensorRT-LLM BaseWorker.submit -> LlmRequest"),
    "fetch": ("scheduler", "PyExecutor: ExecutorRequestQueue.fetch_new_requests"),
    "scheduler": ("scheduler", "PyExecutor._schedule -> C++ capacity + micro-batch scheduler"),
    "kv_cache": ("scheduler", "KVCacheManager (C++ block manager via bindings)"),
    "forward": ("executor", "PyTorchModelEngine.forward (CUDA graph replay in decode)"),
    "sampler": ("executor", "TorchSampler.sample_async"),
    "update": ("executor", "PyExecutor._update_requests: token appended to the LlmRequest"),
    "responses": ("executor", "PyExecutor._enqueue_responses -> LlmResponse"),
    "ipc_rsp": ("ipc", "pyzmq socket, pickled responses (worker -> proxy)"),
    "detokenize": ("llm_api", "DetokenizedGenerationResultBase -> HF tokenizer decode_incrementally"),
    "postprocess": ("http", "TensorRT-LLM chat_stream_post_processor -> SSE event text"),
}


class Attributor:
    """Stamp -> the X-Request-IDs it belongs to. Feed stamps in file order (each process writes in time order).
    A stamp with an X-Request-ID binds its cid to it; later stamps with that cid belong to the same request.
    Stamps before any binding (engine start-up: KV estimation and warm-up requests) belong to none."""

    def __init__(self):
        self.by_cid = {}
        self.iter = {}  # worker pid -> the newest executor iteration seen (kv_cache stamps carry none)

    def feed(self, stamp: dict) -> list[str]:
        if stamp.get("box") == "scheduler" and stamp.get("iter") is not None:
            self.iter[stamp.get("pid")] = stamp["iter"]
        if stamp.get("box") == "kv_cache" and stamp.get("iter") is None:
            stamp["iter"] = self.iter.get(stamp.get("pid"))
        xrid, cid = stamp.get("xrid"), stamp.get("cid")
        if xrid and cid is not None:
            self.by_cid[cid] = xrid
        if xrid:
            return [xrid]
        cids = stamp.get("cids") or ([cid] if cid is not None else stamp.get("data", {}).get("cids", []))
        return [x for x in dict.fromkeys(self.by_cid.get(c) for c in cids) if x]


def read_stamps(path: Path) -> list[dict]:
    out = []
    for n, line in enumerate(path.read_text().splitlines()):
        try:
            out.append({**json.loads(line), "line": n})
        except ValueError:
            pass  # a line cut by the container's stop
    return out


def iteration_offset(run: Run, stamps: list[dict], owners: list[list[str]]) -> dict[str, int]:
    """Per request: /perf_metrics first_iter - the loop counter of its first scheduler stamp, so a stamp's iteration
    reads in the numbering the other levels use (the measured request 66-129)."""
    first = {}
    for s, rids in zip(stamps, owners):
        if s["box"] == "scheduler" and s.get("iter") is not None:
            for rid in rids:
                first.setdefault(rid, s["iter"])
    out = {}
    for span in run.spans:
        if span.component == "executor" and span.name == "request in executor" and span.request_id in first:
            out[span.request_id] = span.attrs["first_iter"] - first[span.request_id]
    return out


def components(path: Path, run: Run) -> None:
    file = str(path.relative_to(run_dir(path)))
    stamps = read_stamps(path)
    attributor = Attributor()
    owners = [attributor.feed(s) for s in stamps]
    offset = iteration_offset(run, stamps, owners)
    for s, rids in zip(stamps, owners):
        if s["box"] not in BOXES:
            continue
        lane, owner = BOXES[s["box"]]
        for rid in rids:
            loop = s.get("iter")
            iteration = loop + offset[rid] if loop is not None and rid in offset else None
            attrs = {"box": s["box"], "proc": s["proc"], "pid": s["pid"], "thread": s.get("thread"), "owner": owner,
                     "stamp": s["data"], "cid": s.get("cid"), "loop_iteration": loop}
            if iteration is not None:
                attrs["iteration"] = iteration
            run.spans.append(Span(f"{rid}/stamp/{s['line']}", "server", lane, s["name"], s["t0"], s.get("t1"), rid,
                                  attrs, {"file": file, "pointer": f"line {s['line'] + 1}"}))
