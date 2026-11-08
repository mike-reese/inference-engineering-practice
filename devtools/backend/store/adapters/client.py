"""Client rows: one row vocabulary from two files.

  client/client_stamps.jsonl  ClientStamps. Written as the client runs (scripts/chat_client.py), so it is the live
                              source of a stamped run (labels.json "stamps": true). Each stamp carries the same ns as
                              the request record field it mirrors (send_ns, transport_trace, body_reads, events,
                              protocol_complete_ns; checked equal on every request of four runs), and becomes the row
                              the record would give: "send", "event: token", the transport stage span (written at
                              its .complete or .failed stamp), "body read", "protocol complete". Stamps with no record
                              field ("task picked request", "HTTP request built") are rows of their own.
  client/<request id>.json    ClientRecords. Written when a request ends (send_one record). Gives the request row
                              (send to protocol complete) and "response headers" (headers_ns, not stamped). In a run
                              with no client stamps it gives every client row (src trace/adapters/client.py).

Rows, names, span ids and raw pointers follow src/inference_analysis/trace/adapters/client.py, so run.json metrics
resolve their inputs and a stamped and an unstamped run read the same. Lanes client/locust, client/sdk,
client/transport; eids from registry run_json.json (client/<lane>/<request>/<short>#<n>, client/request/<request>).
"""
from __future__ import annotations

import json
from pathlib import Path

from .base import Ctx, Rows, request_short, slug
from .stamps import SRC  # noqa: F401  (puts src/ on sys.path)
from inference_analysis.trace.adapters.client import client as client_adapter, event_kind  # noqa: E402
from inference_analysis.trace.schema import Run  # noqa: E402

STAMPS_FILE = "client/client_stamps.jsonl"
STAMP_EVIDENCE = "Observed: client/client_stamps.jsonl (scripts/chat_client.py), CLOCK_MONOTONIC"
RECORD_EVIDENCE = "Observed: client/<request id>.json, the request record (scripts/chat_client.py send_one), CLOCK_MONOTONIC"
LANE = {"locust": "locust", "send_one": "sdk", "sdk": "sdk", "transport": "transport"}
KIND = {"locust": "client request", "sdk": "client event", "transport": "client transport"}


def _rule(ctx: Ctx, lane: str, kind: str) -> dict:
    try:
        return ctx.reg.event_rule("run_json", kind, thread=lane)
    except KeyError:                                     # a lane with no rule of its own (client/locust events)
        return {"eid": f"client/{lane}/{{request}}/{{short}}#{{n}}", "what": "The client records: {name}.",
                "term": "client stamp"}


def _row(out: Rows, ctx: Ctx, rid: str, lane: str, kind: str, name: str, start: int, end: int | None, args: dict,
         source: str, evidence: str, raw_file: str, raw_ptr: str, span_id: str | None) -> None:
    rule = _rule(ctx, lane, kind)
    f = {"request": request_short(rid), "short": slug(name), "name": name}
    b = args.get("bytes") if isinstance(args.get("bytes"), int) else None
    out.add(start=start, end=end if end is not None else start, lane=ctx.lane("client", lane), kind=kind, name=name,
            req=rid, eid=ctx.eid(rule["eid"], **f), what=rule["what"].format(**f), args={**args, "span_id": span_id},
            term=rule["term"], source=source, evidence=evidence, raw_file=raw_file, raw_ptr=raw_ptr, span_id=span_id,
            bytes=float(b) if b is not None else float("nan"))


class ClientStamps:
    source = "client_stamps"

    def __init__(self, ctx: Ctx):
        self.ctx = ctx
        self.started: dict[tuple, tuple] = {}            # (request, stage) -> (start ns, index in transport_trace)
        self.n: dict[tuple, int] = {}                    # (request, counter) -> next index

    def _next(self, rid: str, what: str) -> int:
        k = self.n[(rid, what)] = self.n.get((rid, what), -1) + 1
        return k

    def feed(self, stamps: list[dict]) -> Rows:
        out, ctx = Rows(), self.ctx
        for s in stamps:
            rid, box, name, data = s.get("xrid"), s.get("box") or "?", s.get("name") or "?", s.get("data") or {}
            if not rid:
                ctx.count(self.source, "stamps with no request id")
                continue
            ptr = f"line {s['line'] + 1}"

            def row(lane, kind, nm, start, end, args, span):
                _row(out, ctx, rid, lane, kind, nm, start, end, args, self.source, STAMP_EVIDENCE, STAMPS_FILE, ptr,
                     f"{rid}/client/{span}" if span else None)
            if box == "transport" and name != "body read":
                stage, _, edge = name.rpartition(".")
                j = self._next(rid, "transport")
                if edge == "started":
                    self.started[(rid, stage)] = (s["t0"], j)
                elif edge in ("complete", "failed") and (rid, stage) in self.started:
                    t0, j0 = self.started.pop((rid, stage))
                    row("transport", "client transport", stage, t0, s["t0"], {"outcome": edge}, f"transport/{j0}")
                else:
                    ctx.count(self.source, "transport stamps with no start")
            elif box == "transport":
                i = self._next(rid, "body")
                row("transport", "client transport", "body read", s["t0"], None,
                    {"bytes": data.get("bytes"), "text": data.get("text"), "index": i}, f"body_read/{i}")
            elif box == "sdk" and name == "SSE event parsed":
                i, event = self._next(rid, "event"), data.get("event") or {}
                kind = event_kind(event)
                choice = (event.get("choices") or [{}])[0]
                args = {"kind": kind, "index": i, "content": (choice.get("delta") or {}).get("content"),
                        "records": len(((choice.get("logprobs") or {}).get("content")) or []),
                        "finish_reason": choice.get("finish_reason"), "usage": event.get("usage")}
                if kind == "token":
                    args["token"] = self._next(rid, "token") + 1
                row("sdk", "client event", f"event: {kind}", s["t0"], None, args, f"event/{i}")
            elif box == "send_one" and name in ("send", "protocol complete"):
                row("sdk", "client event", name, s["t0"], None, {}, "send" if name == "send" else "protocol_complete")
            else:
                lane = LANE.get(box, box)
                row(lane, "client event" if box != "transport" else "client transport", name, s["t0"], s.get("t1"),
                    {"box": box, "stamp": data}, None)
        return out

    def flush(self) -> Rows:
        if self.started:
            self.ctx.count(self.source, "transport stages started and never completed", len(self.started))
        return Rows()


class ClientRecords:
    """client/<request id>.json. stamped: only the rows the stamps do not carry (request, response headers)."""
    source = "client_records"

    def __init__(self, ctx: Ctx):
        self.ctx, self.seen = ctx, set()
        self.anchors: dict[str, int] = {}                # request id -> UTC - monotonic ns (the record's anchor pair)

    def read(self, run_dir: Path) -> list[tuple[Path, dict]]:
        """Records not read yet; a file still being written (not JSON yet) is read at a later poll."""
        out = []
        for p in sorted((run_dir / "client").glob("*.json")):
            if p.name in self.seen:
                continue
            try:
                rec = json.loads(p.read_bytes())
            except (OSError, ValueError):
                continue
            self.seen.add(p.name)
            if isinstance(rec, dict) and "send_ns" in rec:
                out.append((p, rec))
        return out

    def feed(self, records: list[tuple[Path, dict]]) -> Rows:
        out, ctx = Rows(), self.ctx
        keep = {"request", "response headers"} if ctx.stamped else None
        for path, rec in records:
            run = Run(run_id=ctx.run)
            client_adapter(path, run)                    # the run.json adapter's spans of this record
            self.anchors.update(run.topology.get("clock_joins", {}))
            for sp in run.spans:
                if keep is not None and sp.name not in keep:
                    continue
                kind = KIND[sp.component]
                _row(out, ctx, sp.request_id, sp.component, kind, sp.name, sp.start_ns, sp.end_ns, dict(sp.attrs),
                     self.source, RECORD_EVIDENCE, sp.raw["file"], sp.raw["pointer"] or None, sp.id)
        return out

    def flush(self) -> Rows:
        return Rows()
