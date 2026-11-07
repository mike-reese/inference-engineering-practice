"""Component stamps for the trace image: one JSON line per step a request takes inside the server container.

Loaded at interpreter start by ie_stamps.pth (trace image only). Active when IE_SERVER_STAMPS names a file, or when
/trace/server_stamps.jsonl already exists (the MPI-spawned worker process may not inherit the environment; the HTTP
process creates the file first). Inactive otherwise: nothing is patched.

Each line: {"t0": ns, "t1": ns or null, "pid", "proc": "http"|"worker", "box": component, "name", ids, "data"}.
Clock: time.monotonic_ns() = CLOCK_MONOTONIC, the same clock as the client's perf_counter_ns and the run's spans.
The patches wrap TensorRT-LLM 1.2.1 functions by name (import hook below); a wrapper never changes arguments or
results, and a failure while recording is swallowed so the engine keeps serving.
"""
import contextvars
import functools
import importlib.abc
import importlib.machinery
import json
import os
import sys
import threading
import time

DEFAULT = "/trace/server_stamps.jsonl"
PATH = os.environ.get("IE_SERVER_STAMPS") or (DEFAULT if os.path.exists(DEFAULT) else None)
MAX_TEXT = 4000  # characters of text kept per value (the templated prompt is ~200)

XRID = contextvars.ContextVar("ie_xrid", default=None)  # the client's X-Request-ID, set per HTTP request
_lock = threading.Lock()
_file = None


def now() -> int:
    return time.monotonic_ns()


def emit(box: str, name: str, t0: int, t1: int | None = None, proc: str = "http", data: dict | None = None, **ids):
    global _file
    try:
        line = {"t0": t0, "t1": t1, "pid": os.getpid(), "thread": threading.current_thread().name, "proc": proc,
                "box": box, "name": name, **{k: v for k, v in ids.items() if v is not None}, "data": data or {}}
        text = json.dumps(line, default=str) + "\n"
        with _lock:
            if _file is None:
                _file = open(PATH, "a", buffering=1)  # line-buffered: one write() per stamp, readable live
            _file.write(text)
    except Exception:
        pass


def clip(text):
    return text if not isinstance(text, str) or len(text) <= MAX_TEXT else text[:MAX_TEXT] + "…"


def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


# ---- HTTP process: ASGI, handler, template, tokenizer, LLM API, proxy, detokenize, postprocess ----

def patch_responses_utils(mod):
    cls = mod.ServerArrivalTimeMiddleware
    original = cls.__call__

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            return await original(self, scope, receive, send)
        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        xrid = headers.get("x-request-id")
        if xrid is None or scope.get("path") != "/v1/chat/completions":
            return await original(self, scope, receive, send)
        XRID.set(xrid)
        emit("asgi", "request headers", now(), xrid=xrid,
             data={"method": scope.get("method"), "path": scope.get("path"), "headers": headers})
        body = {"bytes": 0}

        async def receive_stamped():
            message = await receive()
            if message.get("type") == "http.request":
                chunk = message.get("body", b"")
                body["bytes"] += len(chunk)
                if not message.get("more_body", False):
                    emit("asgi", "request body", now(), xrid=xrid,
                         data={"bytes": body["bytes"], "body": clip(safe(lambda: chunk.decode()))})
            return message

        chunks = {"n": 0}

        async def send_stamped(message):
            t0 = now()
            await send(message)
            t1 = now()
            if message.get("type") == "http.response.start":
                emit("asgi", "response headers", t0, t1, xrid=xrid, data={"status": message.get("status")})
            elif message.get("type") == "http.response.body":
                chunk = message.get("body", b"")
                if chunk:
                    chunks["n"] += 1
                    emit("asgi", "SSE frame sent", t0, t1, xrid=xrid,
                         data={"frame": chunks["n"], "bytes": len(chunk), "text": clip(safe(lambda: chunk.decode()))})
        return await original(self, scope, receive_stamped, send_stamped)

    cls.__call__ = __call__


def patch_openai_server(mod):
    cls = mod.OpenAIServer
    original_chat = cls.openai_chat

    @functools.wraps(original_chat)
    async def openai_chat(self, request, raw_request):
        xrid = XRID.get()
        if xrid:
            emit("validate", "ChatCompletionRequest built", now(), xrid=xrid,
                 data={"messages": safe(lambda: request.model_dump(mode="json").get("messages")),
                       # 1.2.1 stores the wire's max_tokens as max_completion_tokens (validation_alias="max_tokens")
                       "max_completion_tokens": safe(lambda: request.max_completion_tokens),
                       "stream": safe(lambda: request.stream)})
        return await original_chat(self, request, raw_request)

    cls.openai_chat = openai_chat

    original_parse = mod.parse_chat_messages_coroutines

    def parse_chat_messages_coroutines(*args, **kwargs):
        t0 = now()
        out = original_parse(*args, **kwargs)
        if XRID.get():
            emit("parse", "messages -> conversation", t0, now(), xrid=XRID.get(),
                 data={"conversation": safe(lambda: [dict(m) for m in out[0]])})
        return out

    mod.parse_chat_messages_coroutines = parse_chat_messages_coroutines

    original_template = mod.apply_chat_template

    def apply_chat_template(*args, **kwargs):
        t0 = now()
        out = original_template(*args, **kwargs)
        if XRID.get():
            emit("template", "chat template rendered", t0, now(), xrid=XRID.get(),
                 data={"text": clip(out) if isinstance(out, str) else str(out)[:MAX_TEXT],
                       "characters": safe(lambda: len(out))})
        return out

    mod.apply_chat_template = apply_chat_template

    original_post = mod.chat_stream_post_processor

    def chat_stream_post_processor(rsp, args):
        t0 = now()
        out = original_post(rsp, args)
        if XRID.get():
            emit("postprocess", "SSE event(s) built", t0, now(), xrid=XRID.get(), cid=safe(lambda: rsp.id),
                 data={"events": [clip(e) for e in out] if isinstance(out, list) else None})
        return out

    mod.chat_stream_post_processor = chat_stream_post_processor


def patch_registry(mod):
    cls = mod.DefaultInputProcessor
    original = cls.__call__

    def __call__(self, inputs, sampling_params):
        t0 = now()
        out = original(self, inputs, sampling_params)
        if XRID.get():
            ids = safe(lambda: list(out[0]))
            emit("tokenizer", "text -> token IDs", t0, now(), xrid=XRID.get(),
                 data={"token_ids": ids, "count": len(ids or []),
                       "tokenizer": safe(lambda: type(self.tokenizer.tokenizer).__name__)})
        return out

    cls.__call__ = __call__


def patch_executor(mod):
    """GenerationExecutor.generate_async: the LLM API hands the tokenized prompt to the executor here. Stamped at entry
    (the handoff), with the prompt_token_ids argument as received; the proxy's submit and the ZMQ send follow inside."""
    cls = mod.GenerationExecutor
    original = cls.generate_async

    def generate_async(self, prompt_token_ids, *args, **kwargs):
        t0 = now()
        out = original(self, prompt_token_ids, *args, **kwargs)
        if XRID.get():
            ids = safe(lambda: list(prompt_token_ids))
            sp = kwargs.get("sampling_params", args[0] if args else None)
            emit("llm_api", "prompt_token_ids handed to the executor", t0, now(), xrid=XRID.get(),
                 cid=safe(lambda: out.request_id),
                 data={"prompt_token_ids": ids, "count": len(ids or []), "max_tokens": safe(lambda: sp.max_tokens),
                       "streaming": kwargs.get("streaming")})
        return out

    cls.generate_async = generate_async


def patch_proxy(mod):
    cls = mod.GenerationExecutorProxy
    original = cls.submit

    def submit(self, request):
        t0 = now()
        out = original(self, request)
        emit("proxy", "GenerationResult created, request sent", t0, now(), xrid=XRID.get(), cid=safe(lambda: request.id),
             data={"prompt_tokens": safe(lambda: len(request.prompt_token_ids))})
        return out

    cls.submit = submit


def patch_result(mod):
    cls = mod.DetokenizedGenerationResultBase
    original = cls._handle_response

    def _handle_response(self, response):
        t0 = now()
        before = safe(lambda: [len(o.text) for o in self.outputs], [])
        original(self, response)
        o = safe(lambda: self.outputs[0])
        emit("detokenize", "token IDs -> text", t0, now(), xrid=XRID.get(), cid=safe(lambda: self.id),
             data={"new_token_ids": safe(lambda: list(o.token_ids_diff)), "tokens_so_far": safe(lambda: len(o.token_ids)),
                   "new_text": safe(lambda: o.text[before[0]:] if before else o.text), "finished": safe(lambda: self._done)})

    cls._handle_response = _handle_response


# ---- Both processes: the ZMQ sockets between them ----

def _payload(obj):
    """(kind, ids) for the objects the request path sends: a GenerationRequest, or a list of responses."""
    if hasattr(obj, "prompt_token_ids") and hasattr(obj, "id"):
        return "request", {"cid": obj.id, "prompt_tokens": safe(lambda: len(obj.prompt_token_ids))}
    items = obj if isinstance(obj, list) else [obj]
    cids = [c for c in (safe(lambda r=r: r.client_id) for r in items) if c is not None]
    return ("responses", {"cids": cids, "count": len(items)}) if cids else (None, None)


def patch_ipc(mod):
    cls = mod.ZeroMqQueue
    original_put, original_get = cls.put, cls.get

    def put(self, obj, *args, **kwargs):
        kind, info = _payload(obj)
        t0 = now()
        out = original_put(self, obj, *args, **kwargs)
        if kind:
            import pickle
            size = safe(lambda: len(pickle.dumps(obj)))
            box, proc = ("ipc_req", "http") if kind == "request" else ("ipc_rsp", "worker")
            emit(box, f"ZMQ send ({kind})", t0, now(), proc=proc, xrid=XRID.get() if kind == "request" else None,
                 cid=info.get("cid"), data={**info, "pickled_bytes": size, "address": safe(lambda: self.address[0])})
        return out

    def get(self, *args, **kwargs):
        obj = original_get(self, *args, **kwargs)
        t1 = now()
        kind, info = _payload(obj)
        if kind:
            box, proc = ("ipc_req", "worker") if kind == "request" else ("ipc_rsp", "http")
            emit(box, f"ZMQ receive ({kind})", t1, None, proc=proc, cid=info.get("cid"), data=info)
        return obj

    cls.put, cls.get = put, get


# ---- Worker process: BaseWorker, PyExecutor loop, KV cache manager ----

def _req(r):
    return {"cid": safe(lambda: r.py_client_id), "eid": safe(lambda: r.py_request_id),
            "state": safe(lambda: str(r.state).split(".")[-1]), "prompt_len": safe(lambda: r.py_prompt_len),
            "decoding_iter": safe(lambda: r.py_decoding_iter)}


def patch_base_worker(mod):
    cls = mod.BaseWorker
    original = cls.submit

    def submit(self, request):
        t0 = now()
        out = original(self, request)
        eid = safe(lambda: self._client_id_to_request_id.get(request.id))
        emit("worker", "LlmRequest enqueued", t0, now(), proc="worker", cid=safe(lambda: request.id), eid=eid,
             data={"prompt_token_ids": safe(lambda: list(request.prompt_token_ids)),
                   "max_tokens": safe(lambda: request.sampling_params.max_tokens)})
        return out

    cls.submit = submit


def patch_py_executor(mod):
    cls = mod.PyExecutor

    def wrap(method, box, name, describe, instant=False):
        """instant: stamp the return only (the call blocks while the executor waits for work)."""
        original = getattr(cls, method)

        def wrapper(self, *args, **kwargs):
            t0 = now()
            out = original(self, *args, **kwargs)
            t1 = now()
            info = safe(lambda: describe(self, args, out))
            if info is not None:
                if instant:
                    info["call_ms"] = (t1 - t0) / 1e6
                emit(box, name, t1 if instant else t0, None if instant else t1, proc="worker",
                     iter=safe(lambda: self.iter_counter), cids=[r["cid"] for r in info.get("requests", [])], data=info)
            return out
        setattr(cls, method, wrapper)

    def fetched(self, args, out):
        return {"requests": [_req(r) for r in out], "active": len(self.active_requests)} if out else None

    def scheduled(self, args, out):
        batch, _, fitting = out
        ctx, gen = list(batch.context_requests), list(batch.generation_requests)
        if not ctx and not gen:
            return None
        chosen = {id(r) for r in ctx + gen}
        return {"requests": [_req(r) for r in ctx + gen],
                "context": [{**_req(r), "chunk": safe(lambda r=r: r.context_chunk_size),
                             "position": safe(lambda r=r: r.context_current_position)} for r in ctx],
                "generation": [_req(r) for r in gen],
                "paused": [_req(r) for r in batch.paused_requests],
                "not_scheduled": [_req(r) for r in self.active_requests if id(r) not in chosen],
                "active": len(self.active_requests), "num_fitting_requests": fitting,
                "max_batch_size": safe(lambda: self.max_batch_size), "max_num_tokens": safe(lambda: self.max_num_tokens),
                "inflight_ids": safe(lambda: sorted(self.inflight_req_ids))}

    def batch_of(args):
        b = args[0]
        return list(b.context_requests) + list(b.generation_requests)

    def forwarded(self, args, out):
        reqs = batch_of(args)
        return {"requests": [_req(r) for r in reqs], "context": len(args[0].context_requests),
                "generation": len(args[0].generation_requests),
                "num_ctx_tokens": safe(lambda: self.model_engine.iter_states.get("num_ctx_tokens")),
                "logits_shape": safe(lambda: list(out["logits"].shape))} if reqs else None

    def sampled(self, args, out):
        reqs = batch_of(args)
        return {"requests": [_req(r) for r in reqs],
                "note": "sampling launched on the GPU; the token reaches the host in the next iteration's update"} if reqs else None

    def updated(self, args, out):
        state = args[0]
        reqs = safe(lambda: list(state.scheduled_requests.context_requests) + list(state.scheduled_requests.generation_requests), [])
        if not reqs:
            return None
        return {"requests": [{**_req(r), "last_token_id": safe(lambda r=r: r.get_tokens(0)[-1]),
                              "num_tokens": safe(lambda r=r: len(r.get_tokens(0)))} for r in reqs]}

    def responded(self, args, out):
        return {"requests": [{"cid": safe(lambda r=r: r.client_id), "eid": rid} for rid, r in args[0]]} if args[0] else None

    wrap("_fetch_and_activate_new_requests", "fetch", "new requests taken from the queue", fetched, instant=True)
    wrap("_schedule", "scheduler", "batch scheduled", scheduled)
    wrap("_forward_step", "forward", "model forward launched", forwarded)
    wrap("_sample_async", "sampler", "sampling launched", sampled)
    wrap("_update_requests", "update", "sampled tokens appended", updated)
    original_enqueue = cls._enqueue_responses

    def _enqueue_responses(self, responses):
        responses = list(responses)
        t0 = now()
        out = original_enqueue(self, responses)
        info = safe(lambda: responded(self, (responses,), out))
        if info:
            emit("responses", "LlmResponses queued for the worker's sender", t0, now(), proc="worker",
                 iter=safe(lambda: self.iter_counter), cids=[r["cid"] for r in info["requests"]], data=info)
        return out

    cls._enqueue_responses = _enqueue_responses


def patch_resource_manager(mod):
    cls = mod.KVCacheManager
    original_prepare, original_free = cls.prepare_resources, cls.free_resources
    known = {}  # engine request id -> the block ids last seen

    def prepare_resources(self, scheduled_batch):
        t0 = now()
        out = original_prepare(self, scheduled_batch)
        t1 = now()
        reqs = safe(lambda: list(scheduled_batch.context_requests) + list(scheduled_batch.generation_requests), [])
        if reqs and not getattr(self, "is_draft", False):
            rows = []
            for r in reqs:
                blocks = safe(lambda r=r: list(self.get_cache_indices(r)), [])
                before = known.get(r.py_request_id, [])
                known[r.py_request_id] = blocks
                rows.append({**_req(r), "blocks": blocks, "new_blocks": [b for b in blocks if b not in before],
                             "tokens_in_cache": safe(lambda r=r: len(r.get_tokens(0)))})
            emit("kv_cache", "KV blocks allocated", t0, t1, proc="worker", cids=[x["cid"] for x in rows],
                 data={"requests": rows, "free_blocks": safe(self.get_num_free_blocks),
                       "tokens_per_block": safe(lambda: self.tokens_per_block)})
        return out

    def free_resources(self, request, *args, **kwargs):
        blocks = safe(lambda: list(self.get_cache_indices(request)), [])
        t0 = now()
        out = original_free(self, request, *args, **kwargs)
        known.pop(safe(lambda: request.py_request_id), None)
        if not getattr(self, "is_draft", False):
            emit("kv_cache", "KV blocks released", t0, now(), proc="worker", cids=[safe(lambda: request.py_client_id)],
                 data={"requests": [{**_req(request), "blocks": blocks}], "free_blocks": safe(self.get_num_free_blocks)})
        return out

    cls.prepare_resources, cls.free_resources = prepare_resources, free_resources


PATCHES = {
    "tensorrt_llm.serve.responses_utils": patch_responses_utils,
    "tensorrt_llm.serve.openai_server": patch_openai_server,
    "tensorrt_llm.inputs.registry": patch_registry,
    "tensorrt_llm.executor.executor": patch_executor,
    "tensorrt_llm.executor.proxy": patch_proxy,
    "tensorrt_llm.executor.result": patch_result,
    "tensorrt_llm.executor.ipc": patch_ipc,
    "tensorrt_llm.executor.base_worker": patch_base_worker,
    "tensorrt_llm._torch.pyexecutor.py_executor": patch_py_executor,
    "tensorrt_llm._torch.pyexecutor.resource_manager": patch_resource_manager,
}


class _Loader(importlib.abc.Loader):
    def __init__(self, inner, patch):
        self.inner, self.patch = inner, patch

    def create_module(self, spec):
        return self.inner.create_module(spec)

    def exec_module(self, module):
        self.inner.exec_module(module)
        try:
            self.patch(module)
            emit("stamps", f"patched {module.__name__}", now(), proc="setup")
        except Exception as error:  # a renamed function: say so in the stamps, keep serving
            emit("stamps", f"patch failed {module.__name__}: {error!r}", now(), proc="setup")


class _Finder(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        if name not in PATCHES:
            return None
        spec = importlib.machinery.PathFinder.find_spec(name, path)
        if spec is not None and spec.loader is not None:
            spec.loader = _Loader(spec.loader, PATCHES[name])
        return spec


if PATH:
    try:
        open(PATH, "a").close()  # exists from the first process on: the worker finds it without the environment
    except OSError:
        PATH = None
if PATH:
    sys.meta_path.insert(0, _Finder())
