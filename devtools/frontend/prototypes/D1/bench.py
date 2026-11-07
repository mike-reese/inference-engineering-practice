"""D1 prototype benchmark: the same queries against every option; timings, result digests and demo rows.

Usage: python bench.py <dataset> <option> [<option> ...]   (dataset: real | synthetic | synthetic10)
Appends to /mnt/ie-data/cc-v2-proto/bench/<dataset>_<option>.json; collect.py merges them into results.json.
Timing: time.perf_counter around the Python call, result rows fully fetched. "open" = connect/load in a fresh
object, the OS file cache already warm. Repeats: up to N_WARM (or a 30 s budget, at least 3) per query.
"""
import hashlib
import json
import os
import statistics
import sys
import time
from pathlib import Path

import duckdb

from stores import CANON, disk_bytes, make

OUT = Path("/mnt/ie-data/cc-v2-proto/bench")
TIMELINE = "I02A-TRACE-timeline_20261103T185837Z_e08b8b"
COMPONENTS = "I02A-TRACE-components_20261104T142238Z_0b249c"
N_WARM, N_OPEN, BUDGET = 20, 5, 30.0


def targets(dataset):
    c = duckdb.connect()
    ev = f"read_parquet('{CANON}/real_events.parquet')"
    it = c.execute(f"SELECT start_ns, end_ns FROM {ev} WHERE run = ? AND name LIKE '%_forward_step 65:%'",
                   [TIMELINE]).fetchone()
    send = c.execute(f"SELECT start_ns FROM {ev} WHERE request_id = ? AND name = 'send'",
                     [f"{TIMELINE}-measured"]).fetchone()[0]
    req = c.execute(f"SELECT min(start_ns), max(end_ns) FROM {ev} WHERE request_id = ?",
                    [f"{TIMELINE}-measured"]).fetchone()
    off, pre = 0, ""
    if dataset.startswith("synthetic"):
        rule = json.loads((CANON / "synthetic_rule.json").read_text())
        k = 250 if dataset == "synthetic" else 25
        d = rule["D_ns"]
        off = (k // 8) * d + (k % 8) * d // 8
        pre = f"syn/slot{k % 8}/"
        req = (rule["T0_ns"], rule["T0_ns"] + d)
    t = {"iteration66": (it[0] + off, it[1] + off), "1ms": (it[0] + off + 10_000_000, it[0] + off + 11_000_000),
         "request": (req[0] + off, req[1] + off), "proc": pre + "server pid 403", "thread": "tid 1030 python",
         "state_t": it[0] + off + 10_000_000, "zmq": (send + off, it[1] + off + 20_000_000)}
    if dataset == "real":
        csend = c.execute(f"SELECT start_ns FROM {ev} WHERE request_id = ? AND name = 'send'",
                          [f"{COMPONENTS}-measured"]).fetchone()[0]
        t["components"] = {"send": csend, "handoff": (csend + 5_400_000, csend + 7_100_000),
                           "state_t": csend + 6_000_000}
        t["timeline_handoff"] = (send + 5_400_000, send + 7_100_000)
    return t


def digest(x):
    return hashlib.sha1(json.dumps(x, default=str).encode()).hexdigest()[:12]


def norm_rows(rows):
    return sorted((r[5], r[6], r[4], r[2], r[3], r[1]) for r in rows)


def g9(v):
    return None if v is None else (int(v) if isinstance(v, int) else float(f"{float(v):.9g}"))


RUN_ALL = (0, 2**62)


def norm(name, res):
    if name in ("slice_measure", "ratio", "busy_union") or name.startswith("busy_"):
        if isinstance(res, tuple):
            return [g9(x) for x in res]
        return sorted((tuple(g9(x) if not isinstance(x, str) else x for x in r) for r in res), key=repr)
    if name in ("lanes",):
        return {p: {t: norm_rows(v) for t, v in th.items()} for p, th in res.items()}
    if name.startswith("focus"):
        ins, links = res
        return norm_rows(ins), sorted((l[6], l[5], l[3], l[4]) for l in links)
    if name == "state_at":
        return sorted(res)
    if name in ("gpu_busy",):
        return [(int(b), int(v)) for b, v in res]
    if name == "sample_avg":
        return [(int(b), round(float(v), 6)) for b, v in res]
    return norm_rows(res)


def size_of(name, res):
    if name.startswith("busy_union"):
        return list(res)
    if name == "lanes":
        return sum(len(v) for th in res.values() for v in th.values())
    if name.startswith("focus"):
        return [len(res[0]), len(res[1])]
    return len(res)


def timed(fn, n=N_WARM):
    times, res = [], None
    start = time.perf_counter()
    while len(times) < n and (len(times) < 3 or time.perf_counter() - start < BUDGET):
        t = time.perf_counter()
        res = fn()
        times.append((time.perf_counter() - t) * 1000)
    return res, {"median_ms": round(statistics.median(times), 3), "min_ms": round(min(times), 3),
                 "max_ms": round(max(times), 3), "n": len(times)}


def rss_mb(store):
    """Peak resident memory of whatever holds the loaded data (this process, or trace_processor_shell)."""
    pid = store.tp.subprocess.pid if hasattr(store, "tp") else os.getpid()
    for line in open(f"/proc/{pid}/status"):
        if line.startswith("VmHWM"):
            return round(int(line.split()[1]) / 1024)


def run(dataset, option):
    t = targets(dataset)
    probe = make(option, dataset)
    out = {"dataset": dataset, "option": option, "disk_bytes": disk_bytes(probe), "targets": t}
    n_open = 1 if (dataset != "real" and option in "AD") else (3 if option in "AD" else N_OPEN)
    opens = []
    for _ in range(n_open):
        s = make(option, dataset)
        t0 = time.perf_counter()
        s.open()
        opens.append((time.perf_counter() - t0) * 1000)
        if _ < n_open - 1:
            s.close()
    out["open"] = {"median_ms": round(statistics.median(opens), 3), "min_ms": round(min(opens), 3),
                   "max_ms": round(max(opens), 3), "n": n_open}
    out["peak_rss_mb"] = rss_mb(s)
    q = {
        "window_1ms": lambda: s.window(*t["1ms"]),
        "window_iteration": lambda: s.window(*t["iteration66"]),
        "window_request": lambda: s.window(*t["request"]),
        "window_process_thread": lambda: s.window(*t["iteration66"], process=t["proc"], thread=t["thread"]),
        "lanes": lambda: s.lanes(*t["iteration66"]),
        "state_at": lambda: s.state_at(t["state_t"]),
        "focus_thread": lambda: s.focus(*t["iteration66"], t["proc"], t["thread"]),
        "gpu_busy": lambda: s.gpu_busy(10_000_000),
        "sample_avg": lambda: s.sample_avg("SMs Active", 10_000_000),
        "slice_measure": lambda: s.slice_measure(*t["request"]),
        "busy_union": lambda: s.busy_union(*t["request"]),
        "busy_union_run": lambda: s.busy_union(*RUN_ALL),
        "ratio": lambda: s.ratio(*t["request"]),
        "busy_1ms": lambda: s.busy_buckets(*t["request"], 1_000_000),
        "busy_10ms": lambda: s.busy_buckets(*t["request"], 10_000_000),
        "busy_10ms_run": lambda: s.busy_buckets(*RUN_ALL, 10_000_000),
    }
    out["queries"] = {}
    for name, fn in q.items():
        res, timing = timed(fn)
        out["queries"][name] = {**timing, "rows": size_of(name, res), "digest": digest(norm(name, res))}
        print(dataset, option, name, out["queries"][name], flush=True)
    if dataset == "real":
        ct = t["components"]
        zmq = s.window(*t["zmq"], sources=["osrt"], track_like="ZMQbg/IO")
        out["demo"] = {
            "iteration66_by_source": count_by(s.window(*t["iteration66"]), 1),
            "zmq_osrt": [list(r) for r in norm_rows(zmq)],
            "components_lanes": {p: {th: [list(x) for x in norm_rows(v)] for th, v in d.items()}
                                 for p, d in s.lanes(*ct["handoff"]).items()},
            "components_state": [list(x) for x in s.state_at(ct["state_t"])
                                 if x[0] in ("server pid 1", "server pid 304", "client", "network")
                                 and x[4] >= ct["send"] - 1_000_000_000],
            "components_focus_304": [[list(x) for x in norm_rows(f)] if i == 0 else sorted(list(l) for l in f)
                                     for i, f in enumerate(s.focus(*ct["handoff"], "server pid 304"))],
            "slice_iteration66": [list(map(g9, r[1:2])) + [r[0], r[2]] + list(map(g9, r[3:]))
                                  for r in s.slice_measure(*t["iteration66"])],
            "ratio_request": [[r[0]] + [g9(x) for x in r[1:]] for r in s.ratio(*t["request"])],
            "busy_union_vs_sum_iteration66": [g9(s.busy_union(*t["iteration66"])[0]),
                                              sum(r[3] for r in s.slice_measure(*t["iteration66"])
                                                  if r[2] == "kernel")],
            "busy_1ms_iteration66": [[int(b), int(v)] for b, v in s.busy_buckets(*t["iteration66"], 1_000_000)],
            "timeline_handoff_lanes": {p: {th: len(v) for th, v in d.items()}
                                       for p, d in s.lanes(*t["timeline_handoff"]).items()
                                       if p in ("server pid 211", "server pid 403")},
        }
        out["demo_digest"] = {k: digest(v) for k, v in out["demo"].items()}
        _, out["queries"]["focus_process_components"] = timed(lambda: s.focus(*ct["handoff"], "server pid 304"))
        _, out["queries"]["lanes_components"] = timed(lambda: s.lanes(*ct["handoff"]))
        _, out["queries"]["state_at_components"] = timed(lambda: s.state_at(ct["state_t"]))
    s.close()
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{dataset}_{option}.json").write_text(json.dumps(out, indent=1, default=str))


def count_by(rows, i):
    c = {}
    for r in rows:
        c[r[i]] = c.get(r[i], 0) + 1
    return sorted(c.items())


if __name__ == "__main__":
    for opt in sys.argv[2:]:
        run(sys.argv[1], opt)
