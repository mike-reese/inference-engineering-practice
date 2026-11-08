"""Server component stamps: trace/server_stamps.jsonl (deploy/server/ie_stamps), one row per stamp and request.

The Attributor and BOXES of src/inference_analysis/trace/adapters/components.py join a stamp to the requests it
belongs to (X-Request-ID where the HTTP process has it, the proxy's client id elsewhere). Every stamp is fed to the
Attributor in file order, also the ones whose box draws no row, as the run.json adapter does. Iteration = the
executor loop counter + 1 (registry run_json.json iteration_from); kv_cache stamps take the newest loop counter seen.

Derived iterations (live only; the importer derives them from all rows, derive.ITERATION_RULE): one per scheduler
stamp, written once the scheduler stamps of the next two iterations are read, so its end is bounded.
"""
from __future__ import annotations

import os
import sys
from collections import defaultdict
from pathlib import Path

from .base import Ctx, Rows, request_short, slug

SRC = Path(os.environ.get("REPO", "/repo")) / "src"
if not (SRC / "inference_analysis").is_dir():
    SRC = Path(__file__).resolve().parents[4] / "src"
sys.path.insert(0, str(SRC))
from inference_analysis.trace.adapters.components import BOXES, Attributor  # noqa: E402

FILE = "trace/server_stamps.jsonl"
EVIDENCE = "Observed: trace/server_stamps.jsonl (deploy/server/ie_stamps), CLOCK_MONOTONIC"
INFERRED_ITERATION_BOX = "kv_cache"   # kv_cache stamps carry no loop counter of their own and place no iteration end
MESSAGE_SOURCES = ("client_records", "client_stamps", "pcap", "engine_records", "server_stamps")


def message_comp(kind: str, box: str, lane: str, source: str) -> str | None:
    """The run.json component a row speaks for in derive.message_links: a stamp's lane group (BOXES), else the lane's
    thread (sdk, eth0, http). None for rows of other sources (the ie-run/2 rule took run.json rows only)."""
    if source not in MESSAGE_SOURCES:
        return None
    return BOXES[box][0] if kind == "component stamp" else lane.rsplit("/", 1)[-1]


class ServerStamps:
    source = "server_stamps"

    def __init__(self, ctx: Ctx):
        self.ctx, self.attributor = ctx, Attributor()
        self.rule = ctx.reg.event_rule("run_json", "component stamp")
        self.offset = ctx.reg.sources["run_json"]["iteration_from"]["offset"]
        self.first_loop: dict[str, int] = {}          # request id -> loop counter of its first scheduler stamp

    def feed(self, stamps: list[dict]) -> Rows:
        out, ctx = Rows(), self.ctx
        for s in stamps:
            rids = self.attributor.feed(s)            # every stamp: scheduler stamps carry the loop counter
            if s.get("box") not in BOXES:
                ctx.count(self.source, "stamps of a box with no row")
                continue
            if not rids:
                ctx.count(self.source, "stamps of no request (engine start-up)")
                continue
            box, name, pid = s["box"], s["name"], s.get("pid")
            lane = ctx.lane(f"server pid {pid}", s.get("thread"), pid=pid)
            loop = s.get("iter")
            it = loop + self.offset if isinstance(loop, int) else -1
            for rid in rids:
                if box == "scheduler" and isinstance(loop, int):
                    self.first_loop.setdefault(rid, loop)
                f = {"box": box, "request": request_short(rid), "iter": f"i{it}" if it >= 0 else "i-",
                     "short": slug(name), "name": name}
                out.add(start=s["t0"], end=s.get("t1") or s["t0"], lane=lane, kind="component stamp", name=name,
                        req=rid, iter=it, box=box, eid=ctx.eid(self.rule["eid"], **f), what=self.rule["what"].format(**f),
                        args={"box": box, "proc": s.get("proc"), "pid": pid, "thread": s.get("thread"),
                              "owner": BOXES[box][1], "stamp": s.get("data"), "cid": s.get("cid"),
                              "loop_iteration": loop, **({"iteration": it} if it >= 0 else {}),
                              "span_id": f"{rid}/stamp/{s['line']}"},
                        term=self.rule["term"], source=self.source, evidence=EVIDENCE, raw_file=FILE,
                        raw_ptr=f"line {s['line'] + 1}", span_id=f"{rid}/stamp/{s['line']}")
        return out

    def flush(self) -> Rows:
        return Rows()


def add_iteration(out: Rows, ctx: Ctx, it: int, start: int, end: int, lane: str, req, evidence: str) -> None:
    """One derived iteration row, the same live and final. It takes no part in time containment: the stamps it
    spans keep their own lane parents."""
    out.add(start=start, end=end, lane=lane, kind="iteration", name=f"iteration {it}", req=req, iter=it,
            eid=ctx.eid("iteration/derived/i{it}", it=it), what=f"The engine runs iteration {it}, from its scheduler stamp.",
            term="engine iteration (derived)", source="derived", evidence=evidence, contain=False)


class DerivedIterations:
    """Live: derived iteration rows from the stamp rows, written once the next two scheduler stamps are read (the end
    is bounded then; derive.ITERATION_RULE). The final import recomputes the end with the device rows."""

    def __init__(self, ctx: Ctx, rule_text: str):
        self.ctx, self.rule_text = ctx, rule_text
        self.start, self.lane, self.req, self.own = {}, {}, {}, defaultdict(lambda: float("-inf"))
        self.done: set[int] = set()

    def feed(self, rows: Rows) -> Rows:
        c = rows.cols
        for box, it, s, e, lane, rid in zip(c["box"], c["iter"], c["start"], c["end"], c["lane"], c["req"]):
            if it < 0:
                continue
            if box == "scheduler" and it not in self.start:
                self.start[it], self.lane[it], self.req[it] = s, lane, rid
            if box != INFERRED_ITERATION_BOX:
                self.own[it] = max(self.own[it], e)
        return self.ready(False)

    def flush(self) -> Rows:
        return self.ready(True)

    def ready(self, final: bool) -> Rows:
        out = Rows()
        known = sorted(self.start)
        for k, it in enumerate(known):
            if it in self.done:
                continue
            if not final and k + 2 >= len(known):
                break
            nxt = self.start[known[k + 1]] if k + 1 < len(known) else None
            own = self.own[it]
            end = max(self.start[it], min(own, nxt) if nxt is not None else own)
            self.done.add(it)
            add_iteration(out, self.ctx, it, self.start[it], int(end), self.lane[it], self.req[it], self.rule_text)
        return out
