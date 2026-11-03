"""Level 2a: inside the client container. One send_one record (client/<request id>.json) -> client spans.

The client clock is CLOCK_MONOTONIC (time.perf_counter_ns), the run's clock: no conversion.
"""
import base64
import json
from pathlib import Path

from ..schema import Run, Span
from .common import run_dir


def event_kind(event: dict) -> str:
    choices = event.get("choices") or []
    if not choices:
        return "usage" if event.get("usage") else "empty"
    delta = choices[0].get("delta") or {}
    logprobs = choices[0].get("logprobs") or {}
    if delta.get("content") or logprobs.get("content"):
        return "token"
    return "role" if delta.get("role") else "empty"


def criteria(path: Path, request_id: str) -> dict:
    """The request's criteria from the step file that asked for it (control/step_*.json)."""
    for step_file in sorted((run_dir(path) / "control").glob("step_*.json")):
        step = json.loads(step_file.read_text())
        for i, item in enumerate(step["requests"]):
            if item["request_id"] == request_id:
                return {"step": step_file.name, "phase": step["phase"], "isl": step.get("isl"),
                        "diagnostic": step.get("diagnostic", False), "max_tokens": item["max_tokens"],
                        "messages": item["messages"], "turns": sum(m["role"] == "user" for m in item["messages"]),
                        "timeout_s": step.get("timeout_s")}
    return {}


def client(path: Path, run: Run) -> None:
    record = json.loads(path.read_text())
    if "send_ns" not in record:
        return  # a step result, not a request record
    rid = record["request_id"]
    file = str(path.relative_to(run_dir(path)))
    run.topology.setdefault("clock_joins", {})[rid] = (record["anchor_pair"]["utc_ns"]
                                                       - record["anchor_pair"]["monotonic_ns"])
    end = record["protocol_complete_ns"] or record["close_ns"]
    usage = record.get("usage") or {}
    attrs = {"phase": record.get("phase"), "status": record["status"], "complete": record["complete"],
             "finish_reason": record.get("finish_reason"), "usage": usage, "error": record.get("error"),
             "criteria": criteria(path, rid), "diagnostic": record.get("diagnostic"),
             "measured": record.get("phase") not in ("warmup",)}
    spans = [
        Span(f"{rid}/client/request", "client", "locust", "request", record["send_ns"], end, rid, attrs,
             {"file": file, "pointer": ""}),
        Span(f"{rid}/client/send", "client", "sdk", "send", record["send_ns"], None, rid, {},
             {"file": file, "pointer": "/send_ns"}),
    ]
    if record.get("headers_ns"):
        spans.append(Span(f"{rid}/client/headers", "client", "sdk", "response headers", record["headers_ns"],
                          None, rid, {"status": record["status"]}, {"file": file, "pointer": "/headers_ns"}))
    started = {}
    for i, t in enumerate(record.get("transport_trace", [])):
        stage, _, edge = t["name"].rpartition(".")
        if edge == "started":
            started[stage] = (i, t["ns"])
        elif edge in ("complete", "failed") and stage in started:
            j, start = started.pop(stage)
            spans.append(Span(f"{rid}/client/transport/{j}", "client", "transport", stage, start, t["ns"], rid,
                              {"outcome": edge}, {"file": file, "pointer": f"/transport_trace/{j}"}))
    for i, read in enumerate(record.get("body_reads", [])):
        text = base64.b64decode(read["base64"]).decode(errors="replace")
        spans.append(Span(f"{rid}/client/body_read/{i}", "client", "transport", "body read", read["ns"], None, rid,
                          {"bytes": read["bytes"], "text": text, "index": i},
                          {"file": file, "pointer": f"/body_reads/{i}"}))
    token = 0
    for i, item in enumerate(record.get("events", [])):
        event = item["event"]
        kind = event_kind(event)
        choice = (event.get("choices") or [{}])[0]
        attrs = {"kind": kind, "index": i, "content": (choice.get("delta") or {}).get("content"),
                 "records": len(((choice.get("logprobs") or {}).get("content")) or []),
                 "finish_reason": choice.get("finish_reason"), "usage": event.get("usage")}
        if kind == "token":
            token += 1
            attrs["token"] = token
        spans.append(Span(f"{rid}/client/event/{i}", "client", "sdk", f"event: {kind}", item["ns"], None, rid,
                          attrs, {"file": file, "pointer": f"/events/{i}"}))
    if record.get("protocol_complete_ns"):
        spans.append(Span(f"{rid}/client/protocol_complete", "client", "sdk", "protocol complete",
                          record["protocol_complete_ns"], None, rid, {},
                          {"file": file, "pointer": "/protocol_complete_ns"}))
    run.spans += spans
