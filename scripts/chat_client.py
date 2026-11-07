import os
import json
from pathlib import Path
import time 
import httpx2
from openai import DefaultHttpxClient, OpenAI
import openai
import base64
from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram, ProcessCollector, start_http_server

SERVER_BASE_URL = os.environ["SERVER_BASE_URL"]
METRICS_PORT = 9410
PHASES = ("warmup", "normal", "diagnostic", "control", "failure")
BUCKETS_S = (0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1.0, 2.0, 5.0)

# Component stamps (deploy/compose.stamps.yaml): one JSON line per client step, read live by the devtools.
# Unset in the measured run: stamp() returns at once and nothing is written.
STAMPS_PATH = os.environ.get("IE_CLIENT_STAMPS")
_stamps_file = None


def stamp(box: str, name: str, xrid: str, t0: int, t1: int | None = None, **data):
    global _stamps_file
    if not STAMPS_PATH:
        return
    if _stamps_file is None:
        _stamps_file = open(STAMPS_PATH, "a", buffering=1)
    _stamps_file.write(json.dumps({"t0": t0, "t1": t1, "proc": "client", "box": box, "name": name, "xrid": xrid,
                                   "data": data}, default=str) + "\n")


class ClientMetrics:
    def __init__(self):
        self.registry = CollectorRegistry()
        ProcessCollector(registry=self.registry)
        self.requests = Counter("ie_client_requests", "Finished request attempts", ["phase", "outcome"], registry=self.registry)
        self.in_flight = Gauge("ie_client_in_flight", "Requests in progress", ["phase"], registry=self.registry)
        self.ttft = Histogram("ie_client_ttft_seconds", "Send to first content, complete requests", ["phase"], buckets=BUCKETS_S, registry=self.registry)
        self.e2e = Histogram("ie_client_e2e_seconds", "Send to protocol complete, complete requests", ["phase"], buckets=BUCKETS_S, registry=self.registry)
        self.tokens = Counter("ie_client_tokens", "Tokens from final usage", ["phase", "direction"], registry=self.registry)

        for phase in PHASES:
            for outcome in ("complete", "incomplete"):
                self.requests.labels(phase,outcome)
            for direction in ("input", "output"):
                self.tokens.labels(phase, direction)
            self.in_flight.labels(phase)
            self.ttft.labels(phase)
            self.e2e.labels(phase)

    def start_server(self):
        start_http_server(METRICS_PORT, registry=self.registry)

    def observe(self, record: dict, phase: str):
        outcome = "complete" if record["complete"] else "incomplete"
        self.requests.labels(phase, outcome).inc()
        if not record["complete"]:
            return
        self.ttft.labels(phase).observe((record["first_content_ns"] - record["send_ns"]) / 1e9)
        self.e2e.labels(phase).observe((record["protocol_complete_ns"] - record["send_ns"]) / 1e9)
        self.tokens.labels(phase, "input").inc(record["usage"]["prompt_tokens"])
        self.tokens.labels(phase, "output").inc(record["usage"]["completion_tokens"])




class ObservedBody(httpx2.SyncByteStream):
    def __init__(self, inner, record: dict):
        self.inner = inner
        self.record = record

    def __iter__(self):
        for block in self.inner:
            self.record["body_reads"].append({
                "ns": time.perf_counter_ns(),
                "bytes": len(block),
                "base64": base64.b64encode(block).decode("ascii"),
            })
            stamp("transport", "body read", self.record["request_id"], self.record["body_reads"][-1]["ns"],
                  bytes=len(block), text=block.decode("utf-8", "replace"))
            yield block

    def close(self):
        self.inner.close()

class ObservedTransport(httpx2.BaseTransport):
    def __init__(self):
        self.inner = httpx2.HTTPTransport(
            limits=httpx2.Limits(max_connections=1, max_keepalive_connections=1, keepalive_expiry=30.0),
            retries=0,
            trust_env=False
        )
        self.records: dict[str, dict] = {}

    def handle_request(self, request):
        record = self.records.get(request.headers["x-request-id"])
        if record is None:
            return self.inner.handle_request(request)

        def trace(name, info):
            record["transport_trace"].append({"ns": time.perf_counter_ns(), "name": name})
            stamp("transport", name, record["request_id"], record["transport_trace"][-1]["ns"])

        stamp("sdk", "HTTP request built", record["request_id"], time.perf_counter_ns(), method=request.method,
              url=str(request.url), headers=dict(request.headers), body=request.content.decode("utf-8", "replace"))
        
        request.extensions["trace"] = trace
        response = self.inner.handle_request(request)
        response.stream = ObservedBody(response.stream, record)
        return response

    def close(self):
        self.inner.close()


def make_client() -> tuple[OpenAI, ObservedTransport]:
    transport = ObservedTransport()
    http_client = DefaultHttpxClient(
        transport=transport,
        timeout=httpx2.Timeout(10.0, connect=2.0, pool=2.0),
        trust_env=False,
    )
    client = OpenAI(base_url=SERVER_BASE_URL, api_key="unused", max_retries=0, http_client=http_client)
    return client, transport

def send_one(client: OpenAI, transport: ObservedTransport, request_id: str, messages: list[dict], max_tokens: int,
             diagnostic: bool = False, detail: bool = True, timeout_s: float | None = None,
             skip_special_tokens: bool | None = False) -> dict:
    record = {
        "request_id": request_id,
        "headers_ns": None,
        "first_content_ns": None,
        "protocol_complete_ns": None,
        "close_ns": None,
        "status": None,
        "events": [],
        "usage": None,
        "finish_reason": None,
        "error": None,
        "body_reads": [],
        "transport_trace": [],
    }
    record["diagnostic"] = diagnostic
    record["detail"] = detail
    record["anchor_pair"] = {"utc_ns": time.time_ns(), "monotonic_ns": time.perf_counter_ns()}
    if detail:
        transport.records[request_id] = record
    record["send_ns"] = time.perf_counter_ns()
    stamp("send_one", "send", request_id, record["send_ns"], messages=messages, max_tokens=max_tokens)
    token_options = {"logprobs": True, "top_logprobs": 1} if diagnostic else {"logprobs": False}

    try:
        api = client.with_options(timeout=timeout_s) if timeout_s else client  # profiled runs: minutes per token
        with api.chat.completions.with_streaming_response.create(
            model="local",
            messages=messages,
            max_tokens=max_tokens,
            temperature=0,
            seed=0,
            stream=True,
            stream_options={"include_usage": True},
            **token_options,
            # skip_special_tokens None: leave the engine's default (True), for the K4 demonstration only.
            extra_body={"ignore_eos": True, **({} if skip_special_tokens is None
                                                else {"skip_special_tokens": skip_special_tokens})},
            extra_headers={"X-Request-ID": request_id},
        ) as response:
            record["headers_ns"] = time.perf_counter_ns()
            record["status"] = response.status_code

            for chunk in response.parse():
                now = time.perf_counter_ns()
                if detail:
                    record["events"].append({"ns": now, "event": chunk.model_dump()})
                stamp("sdk", "SSE event parsed", request_id, now, event=chunk.model_dump())

                if chunk.choices: 
                    choice = chunk.choices[0]
                    if choice.delta.content and record["first_content_ns"] is None:
                        record["first_content_ns"] = now
                    if choice.finish_reason is not None:
                        record["finish_reason"] = choice.finish_reason
                if chunk.usage is not None:
                    record["usage"] = chunk.usage.model_dump()

            record["protocol_complete_ns"] = time.perf_counter_ns()
            stamp("send_one", "protocol complete", request_id, record["protocol_complete_ns"],
                  finish_reason=record["finish_reason"], usage=record["usage"])
    except openai.APIStatusError as exc:
        record["status"] = exc.status_code
        record["error"] = {"type": type(exc).__name__, "message": str(exc)}
    except Exception as exc:
        record["error"] = {"type": type(exc).__name__, "message": str(exc)}
    finally:   
        transport.records.pop(request_id, None)
        record["close_ns"] = time.perf_counter_ns()

    record["complete"] = (
        record["error"] is None
        and record["status"] == 200
        and record["first_content_ns"] is not None
        and record["finish_reason"] is not None
        and record["usage"] is not None
    )    
    return record 

def save_record(record: dict, folder: Path) -> Path:
    path = folder / f"{record['request_id']}.json"
    path.write_text(json.dumps(record, indent=2))
    return path



