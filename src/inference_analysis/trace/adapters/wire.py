"""Level 1: the network. frames.tsv (TShark on the capture at the server's eth0) -> one span per frame.

Capture times are CLOCK_REALTIME; each request's frames are converted with that request's client anchor pair.
"""
import json
import re
from pathlib import Path

from ...server_evidence import DONE, TOKEN_EVENT, request_frames
from ..schema import Run, Span
from .common import clock_offset, run_dir

DATA_LINE = re.compile(rb"^data: (.*)$", re.M)


def describe(frame: dict) -> tuple[str, dict]:
    p = frame["payload"]
    attrs = {"direction": "to server" if frame["to_server"] else "to client", "bytes": len(p),
             "frame_len": frame["frame_len"], "number": frame["number"]}
    if frame["syn"]:
        return ("SYN" if frame["to_server"] else "SYN-ACK"), attrs
    if frame["fin"]:
        return "FIN", attrs
    if not p:
        return "ACK", attrs
    attrs["text"] = p.decode(errors="replace")[:4000]
    if p.startswith(b"POST "):
        return "request line and headers", attrs
    if p.startswith(b"HTTP/1.1"):
        return "response headers", attrs
    if frame["to_server"]:
        attrs["body"] = _json(p)
        return "request body", attrs
    events = DATA_LINE.findall(p)
    attrs["token_events"] = len(TOKEN_EVENT.findall(p))
    attrs["events"] = len(events)
    if DONE in p:
        attrs["done"] = True
        return "data: [DONE]", attrs
    if attrs["token_events"]:
        return f"{attrs['token_events']} token event(s)", attrs
    if events:
        return "event (no token)", attrs
    return "chunk terminator" if p.strip() in (b"0", b"") or p.startswith(b"0\r\n") else "data", attrs


def _json(p: bytes):
    try:
        return json.loads(p)
    except ValueError:
        return None


def wire(path: Path, run: Run) -> None:
    file = str(path.relative_to(run_dir(path)))
    for rid, frames in request_frames(path.read_text()).items():
        offset = clock_offset(run, rid)
        if offset is None:
            run.unavailable.append({"what": f"wire times for {rid}", "why": "no client anchor pair to convert UTC"})
            continue
        token = 0
        for f in frames:
            name, attrs = describe(f)
            if attrs.get("token_events"):
                attrs["first_token"] = token + 1
                token += attrs["token_events"]
            run.spans.append(Span(f"{rid}/wire/{f['number']}", "network", "eth0", name, f["ns"] - offset, None, rid,
                                  attrs, {"file": file, "pointer": f"frame.number={f['number']}"}))
