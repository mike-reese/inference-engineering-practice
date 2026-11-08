"""Nsight Systems: trace/<name>.sqlite (the report's SQLite export), imported whole (import only).

Every NVTX range and mark, kernel, memcpy, memset, CUDA runtime call, synchronization, CUDA event, graph node event,
OS runtime call, profiler overhead range and diagnostic message is one row; GPU_METRICS rows are samples. Rows,
names, attributes and quirk flags as the ie-run/2 prototype (D1 canonical.py import_nsys, D2 quirks), kinds and
eids from registry nsys.json event_kinds.

Clock: the export's times are ns from TARGET_INFO_SESSION_START_TIME.utcEpochNs (UTC); run clock = utcEpochNs +
time - the run's wall offset (Ctx.wall_offset_ns).
Iteration: the executor's "_forward_step N" NVTX ranges, label + 1 (the /perf_metrics numbering). A kernel, copy or
memset takes the range its launch call started in; a runtime call the range it started in.
Request: the engine record whose first_iter..last_iter holds the iteration (engine_records.json).
Eid ordinals count in (start, table order), as the ie-run/2 importer did.
GPU metrics: values are integers in the export; GPC and SYS clock frequencies are stored as signed 32-bit Hz and wrap
negative above 2.147 GHz, so registry nsys.json samples.decode reads them as unsigned Hz and divides by 1e6 (MHz).
"""
from __future__ import annotations

import bisect
import re
import sqlite3
from pathlib import Path

import numpy as np

from .base import Ctx, Rows, request_short, slug

EVIDENCE = "Observed: Nsight Systems on the run clock (CLOCK_MONOTONIC)"
MEMCPY_KIND = {1: "host to device", 2: "device to host", 8: "device to device", 10: "peer to peer"}
NO_STREAM = 4294967295           # CUPTI_SYNCHRONIZATION_INVALID_VALUE: a sync record with no stream
NO_STREAM_THING = ("no stream (event and context syncs)",
                   "Observed: CUPTI streamId 0xFFFFFFFF (CUPTI_SYNCHRONIZATION_INVALID_VALUE) means the sync record "
                   "has no stream; cupti_activity.h: not valid for cuCtxSynchronize, cuEventSynchronize")
FORWARD_STEP = ("executor forward step (NVTX range)", "The executor runs one forward step: {name}.")
WORK = ("kernel", "memcpy", "memset")


def matches(m: dict, r: dict) -> bool:
    if "source" in m and r["source"] != m["source"]:
        return False
    if "track_prefix" in m and not (r["track"] or "").startswith(m["track_prefix"]):
        return False
    if "name_regex" in m and not re.search(m["name_regex"], r["name"] or ""):
        return False
    return True


class Nsys:
    source = "nsys"

    def __init__(self, ctx: Ctx, request_of):
        self.ctx, self.request_of = ctx, request_of
        self.kinds = ctx.reg.sources["nsys"]["event_kinds"]
        self.decode = ctx.reg.sources["nsys"]["samples"][0].get("decode", {})
        self.links: list[tuple[int, int]] = []           # (launch row, work row) in the returned Rows
        self.samples: dict[str, tuple[np.ndarray, np.ndarray]] = {}
        self.session_utc_ns: int | None = None

    def read(self, path: Path) -> Rows:
        ctx = self.ctx
        db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        s = dict(db.execute("select id, value from StringIds"))
        threads = dict(db.execute("select globalTid, nameId from ThreadNames"))
        procs = {g: n for g, _, n in db.execute("select globalPid, pid, name from PROCESSES")}
        self.session_utc_ns = int(db.execute("select utcEpochNs from TARGET_INFO_SESSION_START_TIME").fetchone()[0])
        base = self.session_utc_ns - ctx.wall_offset_ns
        raw = []                                          # D1 rows in table order

        def who(gtid=None, gpid=None, st=None):
            g = gtid if gtid is not None else gpid
            pid = (g >> 24) & 0xFFFFFF
            out = {"process": f"server pid {pid}", "pid": pid, "pname": procs.get(g & ~0xFFFFFF, "?"), "thread": None,
                   "tid": None, "kthread": None}
            if st is not None:
                out["thread"] = f"stream {st}"
            elif gtid is not None:
                tid, kname = gtid & 0xFFFFFF, s.get(threads.get(gtid), "?")
                out.update(thread=f"tid {tid} {kname}", tid=tid, kthread=kname)
            return out

        def track(gtid):
            pid, tid = (gtid >> 24) & 0xFFFFFF, gtid & 0xFFFFFF
            return f"proc/{pid}:{procs.get(gtid & ~0xFFFFFF, '?')}/thread/{tid}:{s.get(threads.get(gtid), '?')}"

        steps = []
        for start, end, text in db.execute("select start, end, coalesce(text, (select value from StringIds where "
                                            "id = textId)) from NVTX_EVENTS where end is not null"):
            if text and "_forward_step " in text:
                steps.append((start, end, int(text.split("_forward_step ")[1].split(":")[0]) + 1))
        steps.sort()
        starts = [x[0] for x in steps]

        def iteration(ns):
            i = bisect.bisect_right(starts, ns) - 1
            return steps[i][2] if i >= 0 and ns <= steps[i][1] else None

        launch = dict(db.execute("select correlationId, start from CUPTI_ACTIVITY_KIND_RUNTIME"))

        def add(source, trk, name, start, end, ident, corr=None, it=None, stream=None, **args):
            raw.append({"source": source, "track": trk, "name": name, "start": base + start,
                        "end": None if end is None else base + end, "corr": corr, "iter": it, "stream": stream,
                        "ident": ident, "args": args, "bytes": args.get("bytes"), "rel": start})

        for start, end, etype, text, tid, dom, cat, rng in db.execute(
                "select start, end, eventType, coalesce(text, (select value from StringIds where id = textId)), "
                "globalTid, domainId, category, rangeId from NVTX_EVENTS"):
            add("nvtx", track(tid) if tid else "nvtx/global", text or "", start, end, who(tid) if tid else None,
                it=iteration(start) if text and "_forward_step" in text else None, event_type=etype, domain=dom,
                category=cat, range_id=rng)
        for r in db.execute("""select start, end, deviceId, streamId, correlationId, shortName, demangledName, gridX,
                gridY, gridZ, blockX, blockY, blockZ, registersPerThread, staticSharedMemory, dynamicSharedMemory,
                graphNodeId, graphId, globalPid from CUPTI_ACTIVITY_KIND_KERNEL"""):
            add("kernel", f"gpu{r[2]}/stream/{r[3]}", s.get(r[5], "?"), r[0], r[1], who(gpid=r[18], st=r[3]), corr=r[4],
                it=iteration(launch[r[4]]) if r[4] in launch else None, stream=(r[2], r[3]), demangled=s.get(r[6]),
                grid=[r[7], r[8], r[9]], block=[r[10], r[11], r[12]], registers=r[13], shared_memory=r[14] + r[15],
                graph_node=r[16], graph=r[17])
        for start, end, dev, st, corr, size, kind, gp in db.execute(
                "select start, end, deviceId, streamId, correlationId, bytes, copyKind, globalPid "
                "from CUPTI_ACTIVITY_KIND_MEMCPY"):
            add("memcpy", f"gpu{dev}/stream/{st}", MEMCPY_KIND.get(kind, f"copy {kind}"), start, end,
                who(gpid=gp, st=st), corr=corr, it=iteration(launch[corr]) if corr in launch else None,
                stream=(dev, st), bytes=size)
        for start, end, dev, st, corr, size, val, gp in db.execute(
                "select start, end, deviceId, streamId, correlationId, bytes, value, globalPid "
                "from CUPTI_ACTIVITY_KIND_MEMSET"):
            add("memset", f"gpu{dev}/stream/{st}", "memset", start, end, who(gpid=gp, st=st), corr=corr,
                it=iteration(launch[corr]) if corr in launch else None, stream=(dev, st), bytes=size, value=val)
        for start, end, tid, corr, name, ret in db.execute(
                "select start, end, globalTid, correlationId, nameId, returnValue from CUPTI_ACTIVITY_KIND_RUNTIME"):
            add("cuda_runtime", track(tid), s.get(name, "?"), start, end, who(tid), corr=corr, it=iteration(start),
                ret=ret)
        sync = dict(db.execute("select id, label from ENUM_CUPTI_SYNC_TYPE"))
        for start, end, dev, st, corr, kind, gp in db.execute(
                "select start, end, deviceId, streamId, correlationId, syncType, globalPid "
                "from CUPTI_ACTIVITY_KIND_SYNCHRONIZATION"):
            add("cuda_sync", f"gpu{dev}/stream/{st}", sync.get(kind, f"sync {kind}"), start, end, who(gpid=gp, st=st),
                stream=(dev, st), sync_corr=corr)
        for ts, dev, st, corr, eid, gp in db.execute(
                "select timestamp, deviceId, streamId, correlationId, eventId, globalPid "
                "from CUPTI_ACTIVITY_KIND_CUDA_EVENT"):
            add("cuda_event", f"gpu{dev}/stream/{st}", "cuda event", ts, None, who(gpid=gp, st=st), stream=(dev, st),
                event_id=eid, event_corr=corr)
        for start, end, tid, name, node in db.execute(
                "select start, end, globalTid, nameId, graphNodeId from CUDA_GRAPH_NODE_EVENTS"):
            add("cuda_graph", track(tid), s.get(name, "?"), start, end, who(tid), graph_node=node)
        for start, end, tid, name, ret, nest in db.execute(
                "select start, end, globalTid, nameId, returnValue, nestingLevel from OSRT_API"):
            add("osrt", track(tid), s.get(name, "?"), start, end, who(tid), ret=ret, nesting=nest)
        for start, end, tid, name, kind in db.execute(
                "select start, end, globalTid, nameId, overheadType from PROFILER_OVERHEAD"):
            add("profiler_overhead", track(tid), s.get(name, "?"), start, end, who(tid), overhead_type=kind)
        for ts, text, pid in db.execute("select timestamp, text, globalPid from DIAGNOSTIC_EVENT"):
            add("nsys_diagnostic", f"proc/{(pid >> 24) & 0xFFFFFF}:{procs.get(pid, '?')}", text, ts, None,
                who(gpid=pid))
        self._samples(db, base)
        db.close()
        return self._rows(raw)

    def _rows(self, raw: list[dict]) -> Rows:
        ctx, out = self.ctx, Rows()
        order = sorted(range(len(raw)), key=lambda i: (raw[i]["start"], i))
        by_corr: dict[int, dict] = {}
        for i in order:
            r = raw[i]
            ident = r["ident"]
            if ident is None:
                raise KeyError(f"nsys row {r['source']} {r['name']!r} at {r['rel']} ns has no thread (no lane rule)")
            hit = next((k for k in self.kinds if matches(k["match"], r)), None)
            if hit is None:
                raise KeyError(f"no registry nsys.json rule for source={r['source']!r} track={r['track']!r} "
                               f"name={r['name']!r}")
            quirk = []
            if r["stream"] is not None:
                dev, st = r["stream"]
                lane = ctx.stream_lane(dev, st, *((NO_STREAM_THING[0], {"stream_id": NO_STREAM,
                                                                        "rule": NO_STREAM_THING[1]})
                                                   if st == NO_STREAM else ()))
                if st == NO_STREAM:
                    quirk.append("stream_all")
            else:
                lane = ctx.lane(ident["process"], ident["thread"], ident["pid"], ident["tid"], ident["kthread"])
            end, kind_note = r["end"], None
            if r["source"] == "nvtx" and end is None:      # D2: no end by type (marks, names), or an open range
                kind_note = "open_ended" if r["args"].get("event_type") in (59, 60) else "no_end_by_type"
                quirk.append(kind_note)
            if ident["pid"] == 0:
                quirk.append("pid0")
            if r["rel"] < 0:
                quirk.append("negative")
            it = r["iter"]
            name = r["name"]
            f = {"name": name, "short": slug(name.split("(")[0] if r["source"] == "kernel" else name),
                 "lane": slug(lane, 48), "iter": f"i{it}" if it is not None else "i-", "box": "-",
                 "request": request_short(self.request_of(it)), "bytes": r["bytes"]}
            kind, term, what = hit["kind"], hit["term"], hit["what"].format(**f)
            if kind == "engine iteration":                 # the forward-step range: the iteration is derived now
                kind, term, what = "nvtx range", FORWARD_STEP[0], FORWARD_STEP[1].format(name=name)
            j = out.add(start=r["start"], end=end if end is not None else r["start"], lane=lane, kind=kind, name=name,
                        req=self.request_of(it), iter=it if it is not None else -1, eid=ctx.eid(hit["eid"], **f),
                        what=what, args=r["args"] or None, term=term, source=self.source, evidence=EVIDENCE,
                        corr=r["corr"], quirk=",".join(quirk) or None,
                        bytes=float(r["bytes"]) if r["bytes"] is not None else float("nan"),
                        demangled=r["args"].get("demangled") if r["source"] == "kernel" else None,
                        contain=r["stream"] is None)
            if r["corr"] is not None:
                by_corr.setdefault(r["corr"], {}).setdefault("launch" if r["source"] == "cuda_runtime" else "work",
                                                             []).append(j)
        for d in by_corr.values():
            for a in d.get("launch", []):
                for b in d.get("work", []):
                    self.links.append((a, b))
        return out

    def _samples(self, db, base: int) -> None:
        names = {(t, m): n for t, m, n in db.execute("select typeId, metricId, metricName from TARGET_INFO_GPU_METRICS")}
        rows = np.array(db.execute("select timestamp, typeId, metricId, value from GPU_METRICS").fetchall(), np.int64)
        if not len(rows):
            return
        for (t, m), name in names.items():
            sel = rows[(rows[:, 1] == t) & (rows[:, 2] == m)]
            v = sel[:, 3].astype(np.float64)
            rule = self.decode.get(name)
            if rule == "uint32 Hz to MHz":
                v = (sel[:, 3] & 0xFFFFFFFF).astype(np.float64) / 1e6
            elif rule is not None:
                raise KeyError(f"registry nsys.json samples.decode: unknown rule {rule!r} for {name!r}")
            self.samples[name] = (sel[:, 0] + base, v)
