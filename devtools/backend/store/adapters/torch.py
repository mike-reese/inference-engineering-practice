"""PyTorch profiler: trace/torch_trace.json (TLLM_TORCH_PROFILE_TRACE, Kineto), every complete event (ph "X") one
row (import only). Rows, attributes, parents and code origin as the ie-run/2 prototype (D2 ingest.py torch_events);
kinds and eids from registry torch_profiler.json.

Clock: baseTimeNanoseconds + ts (us) is UTC; run clock = that - the run's wall offset (Ctx.wall_offset_ns).
Parents: a Python frame's "Python parent id" (Observed); every other CPU row by time containment on its thread
(derive.contain). GPU rows have none: they are reached from their launch call through a cuda launch link
(CUPTI correlation). Iteration: the executor's _forward_step Python frames in start order, numbered from labels.json
profile_range; GPU work and its launch call take the frame the launch started in. Code origin of GPU work: "model
code" when an nn.Module frame encloses its launch (the module path), else "engine code" with the innermost
tensorrt_llm frame.

A million-row trace (342 MB of JSON for the code-level run): the traceEvents array is read one event at a time
(events()), each event turned into compact columns and dropped, so the parsed document is never held; the devtools
container's 3 GiB would not hold it.
"""
from __future__ import annotations

import codecs
import json
import re
from array import array
from pathlib import Path

import numpy as np

from .base import Ctx, Rows, request_short, slug
from ..derive import contain

EVIDENCE = "Observed: PyTorch profiler (CUPTI), UTC moved to CLOCK_MONOTONIC with the run's wall offset"
SOURCE = {"python_function": "python", "cpu_op": "cpu_op", "cuda_runtime": "cuda_runtime",
          "cuda_driver": "cuda_driver", "kernel": "kernel", "gpu_memcpy": "memcpy", "gpu_memset": "memset"}
GPU_CATS = ("kernel", "gpu_memcpy", "gpu_memset")
LAUNCH_CATS = ("cuda_runtime", "cuda_driver")
CHUNK = 8 << 20
BASE = re.compile(rb'"baseTimeNanoseconds"\s*:\s*(\d+)')
TRACE_EVENTS = re.compile(rb'"traceEvents"\s*:\s*\[')


def events(path: Path):
    """(baseTimeNanoseconds, iterator over the traceEvents objects), reading the file in CHUNK pieces."""
    f = path.open("rb")
    buf = f.read(CHUNK)
    while not TRACE_EVENTS.search(buf):
        more = f.read(CHUNK)
        if not more:
            raise ValueError(f"{path}: no traceEvents array")
        buf += more
    head = TRACE_EVENTS.search(buf)
    base = BASE.search(buf, 0, head.start())
    if base is None:
        raise ValueError(f"{path}: no baseTimeNanoseconds before traceEvents")
    dec, utf8 = json.JSONDecoder(), codecs.getincrementaldecoder("utf-8")()

    def gen():
        text, pos, done = utf8.decode(buf[head.end():]), 0, False
        with f:
            while True:
                while pos < len(text) and text[pos] in " \t\r\n,":
                    pos += 1
                if pos < len(text) and text[pos] == "]":
                    return
                try:
                    obj, pos = dec.raw_decode(text, pos)
                except ValueError:                           # the object runs past the text read so far
                    if done:
                        raise
                    more = f.read(CHUNK)
                    done = not more
                    text, pos = text[pos:] + utf8.decode(more, final=done), 0
                    continue
                yield obj
    return int(base.group(1)), gen()


class Torch:
    source = "torch_profiler"

    def __init__(self, ctx: Ctx, request_of, first_iter: int):
        self.ctx, self.request_of, self.first_iter = ctx, request_of, first_iter
        self.kinds = ctx.reg.sources["torch_profiler"]["event_kinds"]
        self.links: list[tuple[int, int]] = []
        self.stats: dict = {}

    def read(self, path: Path) -> Rows:
        utc_base, stream = events(path)
        base = utc_base - self.ctx.wall_offset_ns
        tnames = {}
        start, end, pid, tid = array("q"), array("q"), array("q"), array("q")
        pyid, pyparent, corr = array("q"), array("q"), array("q")
        cat, name, args, nbytes = [], [], [], []
        strings: dict[str, str] = {}                         # one str object per distinct category and name
        for e in stream:
            ph = e.get("ph")
            if ph == "M":
                if e.get("name") == "thread_name":
                    tnames[(e["pid"], e["tid"])] = e["args"]["name"]
                continue
            if ph != "X":
                continue
            a = e.get("args") or {}
            c = e.get("cat")
            trace = c == "Trace" or e["pid"] == -1 or not isinstance(e["pid"], int)
            c = "Trace" if trace else c
            if c not in SOURCE and c != "Trace":
                raise KeyError(f"torch_trace.json event {e.get('name')!r}: category {c!r} has no registry rule")
            cat.append(strings.setdefault(c, c))
            name.append(strings.setdefault(e["name"], e["name"]))
            p, t = (-1, -1) if trace else (e["pid"], e["tid"])
            pid.append(p)
            tid.append(t)
            start.append(base + int(e["ts"] * 1000))
            end.append(base + int((e["ts"] + e.get("dur", 0)) * 1000))
            pyid.append(a["Python id"] if a.get("Python id") is not None else -1)
            pyparent.append(a["Python parent id"] if a.get("Python parent id") is not None else -1)
            corr.append(a["correlation"] if a.get("correlation") is not None else -1)
            nbytes.append(a.get("bytes"))
            args.append(json.dumps({k: v for k, v in a.items() if k not in ("correlation", "bytes")},
                                   separators=(",", ":")))
        # thread labels (metadata events, written after the X events): CPU rows only, as D2 did
        for k in range(len(args)):
            label = tnames.get((pid[k], tid[k])) if pid[k] not in (0, -1) else None
            if label:
                a = args[k]
                args[k] = a[:-1] + ("," if a != "{}" else "") + '"thread_label":' + json.dumps(label) + "}"
        n = len(args)
        np_ = lambda x: np.frombuffer(x, np.int64).copy() if n else np.zeros(0, np.int64)   # noqa: E731
        return self._rows(n, np_(start), np_(end), np_(pid), np_(tid), np_(pyid), np_(pyparent), np_(corr), cat,
                          name, args, nbytes)

    def _rows(self, n, start, end, pid, tid, pyid, pyparent, corr, cat, name, args, nbytes) -> Rows:
        ctx = self.ctx
        cat = np.array(cat, dtype=object)
        is_py, is_gpu = cat == "python_function", np.isin(cat, GPU_CATS)
        is_launch, is_prof = np.isin(cat, LAUNCH_CATS), cat == "Trace"
        parent = np.full(n, -1, np.int64)
        rule = np.full(n, None, dtype=object)
        py_rows = np.flatnonzero(is_py)
        by_py = dict(zip(pyid[py_rows].tolist(), py_rows.tolist()))
        for i in py_rows.tolist():
            p = by_py.get(int(pyparent[i]))
            if p is not None:
                parent[i], rule[i] = p, "Observed: Python parent id"
        cpu = ~is_gpu & ~is_prof
        lane_key = pid * (1 << 32) + tid
        parent, crossing = contain(lane_key, start, end, cpu, parent)
        rule[(rule == None) & (parent >= 0)] = "Calculated: time containment on one thread"  # noqa: E711
        steps = sorted((int(start[i]), int(end[i])) for i in py_rows.tolist()
                       if "py_executor.py" in name[i] and name[i].endswith(": _forward_step"))
        ss = np.array([x for x, _ in steps], np.int64)
        se = np.array([y for _, y in steps], np.int64)

        def it_of(ns: np.ndarray) -> np.ndarray:
            i = np.searchsorted(ss, ns, side="right") - 1
            ok = (i >= 0) & (ns <= se[np.maximum(i, 0)])
            return np.where(ok, self.first_iter + i, -1)

        it = np.full(n, -1, np.int64)
        launch_of = {}
        for i in np.flatnonzero(is_launch & (corr >= 0)).tolist():
            launch_of[int(corr[i])] = i                      # the last launch call of a correlation id wins (D2)
        code_origin, code_where = np.full(n, None, dtype=object), np.full(n, None, dtype=object)
        origin = {"model code": 0, "engine code": 0, "no launch": 0}
        work = np.flatnonzero(is_gpu & (corr >= 0))
        ln = np.array([launch_of.get(int(c), -1) for c in corr[work].tolist()], np.int64)
        origin["no launch"] = int((ln < 0).sum())
        has = ln >= 0
        w_it = it_of(start[ln[has]])
        it[work[has]] = w_it
        it[ln[has]] = w_it
        self.links = list(zip(ln[has].tolist(), work[has].tolist()))
        chain_of: dict[int, tuple] = {}
        for w, l in zip(work[has].tolist(), ln[has].tolist()):
            if l not in chain_of:
                p, mod, eng, chain = l, None, None, []
                while p >= 0:
                    nm = name[p]
                    if nm.startswith("nn.Module: "):
                        chain.append(nm[11:])
                        mod = mod or nm
                    elif eng is None and cat[p] == "python_function" and "tensorrt_llm" in nm:
                        eng = nm
                    p = int(parent[p])
                chain_of[l] = ("model code", "/".join(reversed(chain))) if mod else ("engine code", eng)
            code_origin[w], code_where[w] = chain_of[l]
            origin[chain_of[l][0]] += 1
        fill = (it < 0) & np.isin(cat, ("cpu_op",) + LAUNCH_CATS)
        it[fill] = it_of(start[fill])
        self.stats = {"events": n, "links": len(self.links), "kernel origin": origin, "crossing (not nested)": crossing,
                      "with a parent": int((parent >= 0).sum())}

        out, order = Rows(), np.lexsort((np.arange(n), start))
        row_of = np.empty(n, np.int64)
        row_of[order] = np.arange(n)
        rules, whats = {}, {}
        for i in order.tolist():
            c = cat[i]
            src = "torch_profiler" if c == "Trace" else SOURCE[c]
            if c == "Trace":
                lane = ctx.lane("pytorch profiler", None)
            elif c in GPU_CATS:
                lane = ctx.stream_lane(0, int(tid[i]))
            else:
                lane = ctx.lane(f"server pid {pid[i]}", f"tid {tid[i]}", pid=int(pid[i]), tid=int(tid[i]))
            hit = rules.get(src)
            if hit is None:
                hit = rules[src] = next(r for r in self.kinds if r["match"]["source"] == src)
            v = int(it[i])
            req = self.request_of(v if v >= 0 else None)
            nm = name[i]
            f = {"name": nm, "short": slug(nm.split("(")[0] if src == "kernel" else nm), "lane": slug(lane, 48),
                 "iter": f"i{v}" if v >= 0 else "i-", "box": "-", "request": request_short(req), "bytes": nbytes[i]}
            b = nbytes[i]
            out.add(start=int(start[i]), end=int(end[i]), lane=lane, kind=hit["kind"], name=nm, req=req, iter=v,
                    eid=ctx.eid(hit["eid"], **f), args=args[i], term=hit["term"],
                    what=whats.get((src, nm, lane, b)) or whats.setdefault((src, nm, lane, b), hit["what"].format(**f)),
                    source=self.source, evidence=EVIDENCE, corr=int(corr[i]) if corr[i] >= 0 else None,
                    parent=int(row_of[parent[i]]) if parent[i] >= 0 else -1, parent_rule=rule[i],
                    code_origin=code_origin[i], code_where=code_where[i],
                    bytes=float(b) if isinstance(b, (int, float)) else float("nan"), contain=False)
            args[i] = None
        self.links = [(int(row_of[a]), int(row_of[b])) for a, b in self.links]
        return out
