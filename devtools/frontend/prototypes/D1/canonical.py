"""D1 prototype: full import of the five saved I02A runs into one canonical table set (throwaway).

Canonical records (the same rows go into every store option):
  events   one row per span or instant: id, run, kind, source, track, name, start_ns, end_ns, corr, request_id,
           iteration, synthetic, args (JSON text)
  samples  one row per counter value: run, track, metric, ts_ns, value, synthetic
  profiles one row per off-clock table row (Nsight Compute): run, profile, row, data (JSON text)

Times are CLOCK_MONOTONIC ns, as in ie-run/1. The Nsight Systems export is imported whole (every NVTX range and
mark, kernel, memcpy, memset, CUDA runtime call, synchronization, CUDA event, graph node event, OSRT call, profiler
overhead range and GPU metrics sample), not the adapter's allow-list. run.json spans are imported for every run; the
timeline run's run.json spans that came from Nsight ("nsys/..." ids) are left out because the full import replaces
them. gpu.csv samples ("gpu/sample" spans) become samples.

Usage: python canonical.py   -> writes /mnt/ie-data/cc-v2-proto/canonical/real_{events,samples,profiles}.parquet
"""
import bisect
import json
import sqlite3
import sys
import time
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

REPO = Path(__file__).resolve().parents[4]
RESULTS = REPO / "reps/I02A-L1_streamed_latency/results"
RUNS = ["I02A-TRACE-timeline_20261103T185837Z_e08b8b", "I02A-TRACE-code_20261103T170709Z_0ac2db",
        "I02A-TRACE-kernels_20261103T181509Z_52744d", "I02A-TRACE-components_20261104T142238Z_0b249c",
        "I02A-TRACE-live_20261103T185532Z_1c1629"]
TIMELINE = RUNS[0]
OUT = Path("/mnt/ie-data/cc-v2-proto/canonical")

EVENT_SCHEMA = pa.schema([("id", pa.int64()), ("run", pa.string()), ("kind", pa.string()), ("source", pa.string()),
                          ("track", pa.string()), ("name", pa.string()), ("start_ns", pa.int64()),
                          ("end_ns", pa.int64()), ("corr", pa.int64()), ("request_id", pa.string()),
                          ("iteration", pa.int64()), ("synthetic", pa.bool_()), ("args", pa.string()),
                          ("process", pa.string()), ("thread", pa.string()), ("pid", pa.int64()),
                          ("host_pid", pa.int64()), ("pname", pa.string()), ("tid", pa.int64()),
                          ("kthread", pa.string()), ("pythread", pa.string()), ("bytes", pa.int64())])
LINK_SCHEMA = pa.schema([("run", pa.string()), ("from_id", pa.int64()), ("to_id", pa.int64()), ("kind", pa.string()),
                         ("rule", pa.string()), ("synthetic", pa.bool_())])
SAMPLE_SCHEMA = pa.schema([("run", pa.string()), ("track", pa.string()), ("metric", pa.string()),
                           ("ts_ns", pa.int64()), ("value", pa.float64()), ("synthetic", pa.bool_())])
PROFILE_SCHEMA = pa.schema([("run", pa.string()), ("profile", pa.string()), ("row", pa.int64()), ("data", pa.string())])
MEMCPY_KIND = {1: "host to device", 2: "device to host", 8: "device to device", 10: "peer to peer"}


class Rows:
    def __init__(self, schema):
        self.schema, self.cols = schema, {f.name: [] for f in schema}

    def add(self, **kw):
        for k, v in self.cols.items():
            v.append(kw.get(k))

    def table(self):
        if "process" in self.cols:  # every event names a process and a thread, so lanes never need a null branch
            self.cols["process"] = [p or "(no process)" for p in self.cols["process"]]
            self.cols["thread"] = [t or "(process-wide)" for t in self.cols["thread"]]
        return pa.table(self.cols, schema=self.schema)


def nsys_base(run_json: dict) -> int:
    """Nsight session-relative ns -> CLOCK_MONOTONIC ns, read back from the adapter's own NVTX span ids."""
    bases = {s["start_ns"] - int(s["id"].split("/")[2]) for s in run_json["spans"] if s["id"].startswith("nsys/nvtx/")}
    if len(bases) != 1:
        sys.exit(f"inconsistent Nsight clock bases in run.json: {sorted(bases)[:5]}")
    return bases.pop()


def import_nsys(path: Path, run: str, base: int, records: dict, ev: Rows, sm: Rows, links: Rows, next_id,
                host_pid) -> dict:
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    s = dict(db.execute("select id, value from StringIds"))
    threads = dict(db.execute("select globalTid, nameId from ThreadNames"))
    procs = {g: n for g, _, n in db.execute("select globalPid, pid, name from PROCESSES")}

    def thread(gtid):
        pid, tid = (gtid >> 24) & 0xFFFFFF, gtid & 0xFFFFFF
        return f"proc/{pid}:{procs.get(gtid & ~0xFFFFFF, '?')}/thread/{tid}:{s.get(threads.get(gtid), '?')}"

    def stream(dev, st):
        return f"gpu{dev}/stream/{st}"

    def who(gtid=None, gpid=None, st=None):
        """Process and thread identity. Nsight PIDs/TIDs are the server container's namespace (nsys ran inside it)."""
        g = gtid if gtid is not None else gpid
        pid = (g >> 24) & 0xFFFFFF
        pname = procs.get(g & ~0xFFFFFF, "?")
        out = {"process": f"server pid {pid}", "pid": pid, "pname": pname,
               "host_pid": host_pid if pid == 1 else None}
        if st is not None:
            out["thread"] = f"stream {st}"
        elif gtid is not None:
            tid, kname = gtid & 0xFFFFFF, s.get(threads.get(gtid), "?")
            out.update(thread=f"tid {tid} {kname}", tid=tid, kthread=kname)
        return out

    counts = {}

    def add(source, track, name, start, end, corr=None, it=None, ident=None, **args):
        counts[source] = counts.get(source, 0) + 1
        instant = end is None
        eid = next_id()
        if corr is not None:
            by_corr.setdefault(corr, {}).setdefault("launch" if source == "cuda_runtime" else "work", []).append(eid)
        ev.add(**(ident or {}), bytes=args.get("bytes"), id=eid, run=run, kind="instant" if instant else "span", source=source, track=track, name=name,
               start_ns=base + start, end_ns=base + (start if instant else end), corr=corr,
               request_id=request_of(it), iteration=it, synthetic=False,
               args=json.dumps(args, separators=(",", ":")) if args else None)

    # Iterations: the executor's numbered _forward_step ranges (label + 1 = /perf_metrics iteration, as nsys.py).
    steps = []
    for start, end, text, tid in db.execute("select start, end, coalesce(text, (select value from StringIds "
                                            "where id = textId)), globalTid from NVTX_EVENTS where end is not null"):
        if text and "_forward_step " in text:
            steps.append((start, end, int(text.split("_forward_step ")[1].split(":")[0]) + 1))
    steps.sort()
    starts = [x[0] for x in steps]

    def iteration(ns):
        i = bisect.bisect_right(starts, ns) - 1
        return steps[i][2] if i >= 0 and ns <= steps[i][1] else None

    windows = [(rid, r["perf_metrics"]["first_iter"], r["perf_metrics"]["last_iter"]) for rid, r in records.items()]

    def request_of(it):
        return next((rid for rid, a, b in windows if it is not None and a <= it <= b), None)

    launch = dict(db.execute("select correlationId, start from CUPTI_ACTIVITY_KIND_RUNTIME"))
    by_corr = {}

    for start, end, etype, text, tid, dom, cat, rng in db.execute(
            "select start, end, eventType, coalesce(text, (select value from StringIds where id = textId)), "
            "globalTid, domainId, category, rangeId from NVTX_EVENTS"):
        add("nvtx", thread(tid) if tid else "nvtx/global", text or "", start, end, ident=who(tid) if tid else None,
            it=iteration(start) if text and "_forward_step" in text else None, event_type=etype, domain=dom,
            category=cat, range_id=rng)
    for r in db.execute("""select start, end, deviceId, streamId, correlationId, shortName, demangledName, gridX,
            gridY, gridZ, blockX, blockY, blockZ, registersPerThread, staticSharedMemory, dynamicSharedMemory,
            graphNodeId, graphId, globalPid from CUPTI_ACTIVITY_KIND_KERNEL"""):
        it = iteration(launch[r[4]]) if r[4] in launch else None
        add("kernel", stream(r[2], r[3]), s.get(r[5], "?"), r[0], r[1], corr=r[4], it=it,
            ident=who(gpid=r[18], st=r[3]), demangled=s.get(r[6]),
            grid=[r[7], r[8], r[9]], block=[r[10], r[11], r[12]], registers=r[13], shared_memory=r[14] + r[15],
            graph_node=r[16], graph=r[17])
    for start, end, dev, st, corr, size, kind, gp in db.execute("select start, end, deviceId, streamId, correlationId, "
                                                                "bytes, copyKind, globalPid from CUPTI_ACTIVITY_KIND_MEMCPY"):
        it = iteration(launch[corr]) if corr in launch else None
        add("memcpy", stream(dev, st), MEMCPY_KIND.get(kind, f"copy {kind}"), start, end, corr=corr, it=it,
            ident=who(gpid=gp, st=st),
            bytes=size)
    for start, end, dev, st, corr, size, val, gp in db.execute("select start, end, deviceId, streamId, correlationId, "
                                                               "bytes, value, globalPid from CUPTI_ACTIVITY_KIND_MEMSET"):
        it = iteration(launch[corr]) if corr in launch else None
        add("memset", stream(dev, st), "memset", start, end, corr=corr, it=it, ident=who(gpid=gp, st=st), bytes=size, value=val)
    for start, end, tid, corr, name, ret in db.execute(
            "select start, end, globalTid, correlationId, nameId, returnValue from CUPTI_ACTIVITY_KIND_RUNTIME"):
        add("cuda_runtime", thread(tid), s.get(name, "?"), start, end, corr=corr, it=iteration(start), ident=who(tid),
            ret=ret)
    sync = dict(db.execute("select id, label from ENUM_CUPTI_SYNC_TYPE"))
    for start, end, dev, st, corr, kind, gp in db.execute("select start, end, deviceId, streamId, correlationId, "
                                                          "syncType, globalPid from CUPTI_ACTIVITY_KIND_SYNCHRONIZATION"):
        add("cuda_sync", stream(dev, st), sync.get(kind, f"sync {kind}"), start, end, ident=who(gpid=gp, st=st),
            sync_corr=corr)
    for ts, dev, st, corr, eid, gp in db.execute("select timestamp, deviceId, streamId, correlationId, eventId, "
                                                 "globalPid from CUPTI_ACTIVITY_KIND_CUDA_EVENT"):
        add("cuda_event", stream(dev, st), "cuda event", ts, None, ident=who(gpid=gp, st=st), event_id=eid,
            event_corr=corr)
    for start, end, tid, name, node in db.execute("select start, end, globalTid, nameId, graphNodeId "
                                                  "from CUDA_GRAPH_NODE_EVENTS"):
        add("cuda_graph", thread(tid), s.get(name, "?"), start, end, ident=who(tid), graph_node=node)
    for start, end, tid, name, ret, nest in db.execute("select start, end, globalTid, nameId, returnValue, "
                                                       "nestingLevel from OSRT_API"):
        add("osrt", thread(tid), s.get(name, "?"), start, end, ident=who(tid), ret=ret, nesting=nest)
    for start, end, tid, name, kind in db.execute("select start, end, globalTid, nameId, overheadType "
                                                  "from PROFILER_OVERHEAD"):
        add("profiler_overhead", thread(tid), s.get(name, "?"), start, end, ident=who(tid), overhead_type=kind)
    for ts, text, pid in db.execute("select timestamp, text, globalPid from DIAGNOSTIC_EVENT"):
        add("nsys_diagnostic", f"proc/{(pid >> 24) & 0xFFFFFF}:{procs.get(pid, '?')}", text, ts, None,
            ident=who(gpid=pid))
    metric = {(t, m): n for t, m, n in db.execute("select typeId, metricId, metricName from TARGET_INFO_GPU_METRICS")}
    n = 0
    for ts, t, m, v in db.execute("select timestamp, typeId, metricId, value from GPU_METRICS"):
        sm.add(run=run, track="gpu0/metrics", metric=metric[(t, m)], ts_ns=base + ts, value=float(v), synthetic=False)
        n += 1
    counts["gpu_metrics (samples)"] = n
    n_links = 0
    for corr, d in by_corr.items():
        for a in d.get("launch", []):
            for b in d.get("work", []):
                links.add(run=run, from_id=a, to_id=b, kind="cuda launch", synthetic=False,
                          rule="Observed: CUPTI correlationId, runtime call -> GPU work")
                n_links += 1
    counts["links: cuda launch"] = n_links
    not_imported = {t: db.execute(f'select count(*) from "{t}"').fetchone()[0] for t in ("OSRT_CALLCHAINS",)}
    return {"imported": counts, "not imported (stack frames, not events)": not_imported}


def run_json_identity(sp: dict, host_pid) -> dict:
    """Stamps carry the container PID and the Python thread name; other run.json sources carry no process."""
    a = sp["attrs"]
    if "pid" in a and "thread" in a:
        return {"process": f"server pid {a['pid']}", "pid": a["pid"], "pname": a.get("proc"),
                "host_pid": host_pid if a["pid"] == 1 else None, "thread": a["thread"], "pythread": a["thread"]}
    root = {"client": "client", "network": "network"}.get(sp["level"], f"{sp['level']} (no pid recorded)")
    return {"process": root, "thread": sp["component"]}


def server_host_pid(run: str):
    """Docker State.Pid of the server container: the host PID of the container's PID 1 (topology.json)."""
    topo = json.loads((RESULTS / run / "topology.json").read_text())
    return next((c["State"]["Pid"] for c in topo["containers"] if c["Name"].endswith("server-1")), None)


def stamp_links(run: str, rows: list, links: Rows) -> int:
    """Cross-process hops in run.json: ZMQ send -> receive (stamps) and response headers server -> wire -> client.
    Pairing is Calculated: same request id, same message direction, k-th send to k-th receive."""
    by = {}
    for eid, sp in rows:
        by.setdefault((sp["request_id"], sp["component"], sp["name"]), []).append((sp["start_ns"], eid))
    n = 0
    for (rid, comp, name), sends in by.items():
        if rid is None:
            continue
        pairs = []
        if comp == "ipc" and name.startswith("ZMQ send"):
            pairs = [(sends, by.get((rid, "ipc", name.replace("send", "receive")), []), "zmq")]
        elif comp == "http" and name == "response headers":
            wire = by.get((rid, "eth0", "response headers"), [])
            pairs = [(sends, wire, "network"), (wire, by.get((rid, "sdk", "response headers"), []), "network")]
        for a, b, kind in pairs:
            for (_, x), (_, y) in zip(sorted(a), sorted(b)):
                links.add(run=run, from_id=x, to_id=y, kind=kind, synthetic=False,
                          rule="Calculated: same request id and message, k-th send -> k-th receive")
                n += 1
    return n


def import_run_json(run: str, ev: Rows, sm: Rows, pr: Rows, links: Rows, next_id, skip_nsys: bool) -> dict:
    j = json.loads((RESULTS / run / "run.json").read_text())
    host_pid = server_host_pid(run)
    n_ev = n_sm = 0
    kept = []
    for sp in j["spans"]:
        if skip_nsys and sp["id"].startswith("nsys/"):
            continue
        if sp["name"] == "sample" and sp["id"].startswith("gpu/sample/"):
            for k, v in sp["attrs"].items():
                if isinstance(v, (int, float)):
                    sm.add(run=run, track="gpu0/nvidia-smi", metric=k, ts_ns=sp["start_ns"], value=float(v),
                           synthetic=False)
                    n_sm += 1
            continue
        attrs = dict(sp["attrs"])
        it = attrs.pop("iteration", None)
        attrs["span_id"] = sp["id"]
        eid = next_id()
        kept.append((eid, sp))
        ev.add(**run_json_identity(sp, host_pid), bytes=attrs.get("bytes") if isinstance(attrs.get("bytes"), int)
               else None, id=eid, run=run, kind="instant" if sp["end_ns"] is None else "span",
               source="run.json",
               track=f"{sp['level']}/{sp['component']}", name=sp["name"], start_ns=sp["start_ns"],
               end_ns=sp["end_ns"] if sp["end_ns"] is not None else sp["start_ns"], corr=None,
               request_id=sp["request_id"], iteration=it if isinstance(it, int) else None, synthetic=False,
               args=json.dumps(attrs, separators=(",", ":"), default=str))
        n_ev += 1
    n_pr = 0
    for name, table in j.get("profiles", {}).items():
        rows = table if isinstance(table, list) else [{"key": k, "value": v} for k, v in table.items()]
        for i, row in enumerate(rows):
            pr.add(run=run, profile=name, row=i, data=json.dumps(row, default=str))
            n_pr += 1
    n_links = stamp_links(run, kept, links)
    return {"run.json events": n_ev, "run.json samples": n_sm, "profile rows": n_pr, "links": n_links}, j


def main():
    t = time.perf_counter()
    OUT.mkdir(parents=True, exist_ok=True)
    ev, sm, pr, ln = Rows(EVENT_SCHEMA), Rows(SAMPLE_SCHEMA), Rows(PROFILE_SCHEMA), Rows(LINK_SCHEMA)
    counter = iter(range(1, 1 << 62))
    next_id = counter.__next__
    report = {}
    for run in RUNS:
        stats, j = import_run_json(run, ev, sm, pr, ln, next_id, skip_nsys=run == TIMELINE)
        if run == TIMELINE:
            records = json.loads((RESULTS / run / "engine_records.json").read_text())
            stats["nsys"] = import_nsys(RESULTS / run / "trace/timeline.sqlite", run, nsys_base(j), records, ev, sm,
                                        ln, next_id, server_host_pid(run))
        report[run] = stats
    tables = {"events": ev.table(), "samples": sm.table(), "profiles": pr.table(), "links": ln.table()}
    tables["events"] = tables["events"].sort_by([("start_ns", "ascending")])
    tables["samples"] = tables["samples"].sort_by([("ts_ns", "ascending")])
    for k, tb in tables.items():
        pq.write_table(tb, OUT / f"real_{k}.parquet")
    report["totals"] = {k: v.num_rows for k, v in tables.items()}
    report["seconds"] = round(time.perf_counter() - t, 2)
    print(json.dumps(report, indent=1))
    (OUT / "real_report.json").write_text(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
