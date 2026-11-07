"""D2 prototype: one neutral record set from the five saved I02A runs, read by every model option (throwaway).

Starts from D1's canonical import (every run.json span and every Nsight table, D1/canonical.py) and adds:
  - the code run's PyTorch profiler trace in full (trace/torch_trace.json: Python frames, CPU ops, CUDA runtime and
    driver calls, kernels, copies, memsets), replacing the 18,093 kernel/copy spans torch_trace.py put in run.json;
    clock: monotonic = baseTimeNanoseconds + ts_us * 1000 - offset, offset read back from run.json's own torch spans;
  - links: CUDA launch -> GPU work by PyTorch's CUPTI "correlation" (Observed);
  - a parent for each event, with the rule that gave it:
      "Observed: Python parent id"            torch Python frames
      "Calculated: time containment on one thread"   every other event on a CPU thread or a stamp lane
    GPU work on a stream gets no parent (it is reached from its launch through a link);
  - quirk flags (the Nsight quirks D1 found), kept as data, not repaired:
      open_ended      NVTX range rows (push/pop, start/end) with no end: kind "open", end_ns null (none found)
      no_end_by_type  NVTX marks, category names and domain creation: instants by type, not open ranges
      stream_all      GPU rows on stream 4294967295 (-1 stored unsigned: synchronization not tied to one stream)
      pid0            rows whose globalPid decodes to PID 0 (Nsight diagnostic messages)
      negative        rows that started before the Nsight session's zero (graph node creation at startup)
  - kernel code origin (code run): "model code" when a Python frame "nn.Module: ..." encloses the launch, with the
    module path; else "engine code" with the innermost tensorrt_llm frame (Observed: the trace has with_modules=1 and
    with_stack=1).
Output: /mnt/ie-data/cc-v2-proto/d2/neutral/{events,links,samples,profiles}.parquet + report.json
"""
import bisect
import json
import re
import sys
import time
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

D1 = Path(__file__).resolve().parent.parent / "D1"
sys.path.insert(0, str(D1))
from canonical import (EVENT_SCHEMA, LINK_SCHEMA, PROFILE_SCHEMA, RESULTS, RUNS, SAMPLE_SCHEMA,  # noqa: E402
                       Rows, import_run_json)
# The measured runs the I02A results file cites (run.json only: no profiler); imported with D1's own run.json reader
MEASURED = ["I02A_20261103T164324Z_348959", "I02A_20261103T172804Z_a3ca9a", "I02A_20261103T172929Z_0e5d39"]
MEASURED_ID0 = 3 * 10**9

CANON = Path("/mnt/ie-data/cc-v2-proto/canonical")
OUT = Path("/mnt/ie-data/cc-v2-proto/d2/neutral")
CODE = RUNS[1]
NEUTRAL_SCHEMA = pa.schema(list(EVENT_SCHEMA) + [
    ("parent_id", pa.int64()), ("parent_rule", pa.string()), ("device", pa.int64()), ("stream", pa.int64()),
    ("quirk", pa.string()), ("code_origin", pa.string()), ("code_where", pa.string()),
    ("code_evidence", pa.string())])
TORCH_ID0 = 10**9  # torch events get ids from here: D1's ids stay as they are


def torch_events(report):
    run = CODE
    rj = json.loads((RESULTS / run / "run.json").read_text())
    data = json.loads((RESULTS / run / "trace" / "torch_trace.json").read_text())
    base = int(data["baseTimeNanoseconds"])
    events = [e for e in data["traceEvents"] if e.get("ph") == "X"]
    copies = [e for e in events if e.get("cat") == "gpu_memcpy"]
    offs = {base + int(copies[int(s["id"].split("/")[2])]["ts"] * 1000) - s["start_ns"]
            for s in rj["spans"] if s["id"].startswith("torch/memcpy/")}
    if len(offs) != 1:
        sys.exit(f"torch clock offset not unique: {sorted(offs)[:5]}")
    off = offs.pop()

    def mono(ts):
        return base + int(ts * 1000) - off

    host_pid = None  # torch PID 317 is not the container's PID 1: its host PID was not recorded
    tnames = {(m["pid"], m["tid"]): m["args"]["name"] for m in data["traceEvents"]
              if m.get("ph") == "M" and m.get("name") == "thread_name"}
    rows, eid = [], TORCH_ID0
    by_py, launch_by_corr, work_by_corr = {}, {}, {}
    labels = json.loads((RESULTS / run / "labels.json").read_text())
    first_iter = int(str(labels.get("profile_range", "1-0")).split("-")[0])
    records = json.loads((RESULTS / run / "engine_records.json").read_text())
    windows = [(rid, r["perf_metrics"]["first_iter"], r["perf_metrics"]["last_iter"]) for rid, r in records.items()]
    for e in events:
        cat, a = e.get("cat"), e.get("args", {}) or {}
        if cat == "Trace" or e["pid"] == -1:
            src = "torch_profiler"
            ident = {"process": "pytorch profiler", "thread": "(process-wide)"}
        elif e["pid"] == 0:  # GPU rows: pid 0 = device 0, tid = stream
            src = {"kernel": "kernel", "gpu_memcpy": "memcpy", "gpu_memset": "memset"}.get(cat, cat)
            ident = {"process": "server pid 317", "pid": 317, "pname": "python", "thread": f"stream {e['tid']}"}
        else:
            src = {"python_function": "python", "cpu_op": "cpu_op", "cuda_runtime": "cuda_runtime",
                   "cuda_driver": "cuda_driver"}.get(cat, cat)
            ident = {"process": f"server pid {e['pid']}", "pid": e["pid"], "pname": "python",
                     "thread": f"tid {e['tid']}", "tid": e["tid"], "host_pid": host_pid,
                     "kthread": None, "pythread": None, "torch_thread_label": tnames.get((e["pid"], e["tid"]))}
        start = mono(e["ts"])
        end = mono(e["ts"] + e.get("dur", 0))
        r = {**{k: v for k, v in ident.items() if k != "torch_thread_label"}, "id": eid, "run": run, "kind": "span",
             "source": src, "track": f"torch/{e['pid']}/{e['tid']}", "name": e["name"], "start_ns": start,
             "end_ns": end, "corr": a.get("correlation"), "request_id": None, "iteration": None,
             "synthetic": False, "bytes": a.get("bytes"),
             "args": json.dumps({k: v for k, v in a.items() if k not in ("correlation", "bytes")} |
                                ({"thread_label": ident["torch_thread_label"]} if ident.get("torch_thread_label") else {}),
                                separators=(",", ":")),
             "device": 0 if e["pid"] == 0 else None, "stream": e["tid"] if e["pid"] == 0 else None,
             "_py": a.get("Python id"), "_pyparent": a.get("Python parent id"), "_cat": cat}
        if cat == "python_function":
            by_py[a.get("Python id")] = r
        if cat in ("cuda_runtime", "cuda_driver") and "correlation" in a:
            launch_by_corr[a["correlation"]] = r
        if cat in ("kernel", "gpu_memcpy", "gpu_memset") and "correlation" in a:
            work_by_corr.setdefault(a["correlation"], []).append(r)
        rows.append(r)
        eid += 1
    # Python parents (Observed), then time containment for the rest of each CPU thread
    for r in rows:
        if r["_cat"] == "python_function" and r["_pyparent"] in by_py:
            r["parent_id"], r["parent_rule"] = by_py[r["_pyparent"]]["id"], "Observed: Python parent id"
    contain([r for r in rows if r["stream"] is None and r["process"] != "pytorch profiler"], skip_set=True)
    # iterations: the executor's _forward_step frames (as torch_trace.py), numbered from labels.profile_range
    steps = sorted((r["start_ns"], r["end_ns"]) for r in rows if r["_cat"] == "python_function"
                   and "py_executor.py" in r["name"] and r["name"].endswith(": _forward_step"))
    ss = [s for s, _ in steps]

    def it_of(ns):
        i = bisect.bisect_right(ss, ns) - 1
        return first_iter + i if i >= 0 and ns <= steps[i][1] else None

    by_id = {r["id"]: r for r in rows}
    links = []
    origin = {"model code": 0, "engine code": 0, "no launch": 0}
    for corr, works in work_by_corr.items():
        ln = launch_by_corr.get(corr)
        for w in works:
            if ln is None:
                origin["no launch"] += 1
                continue
            links.append({"run": run, "from_id": ln["id"], "to_id": w["id"], "kind": "cuda launch",
                          "rule": "Observed: CUPTI correlation (PyTorch profiler), launch call -> GPU work",
                          "synthetic": False})
            w["iteration"] = ln["iteration"] = it_of(ln["start_ns"])
            # walk up from the launch: the first nn.Module frame makes it model code
            p, mod, eng = ln, None, None
            chain = []
            while p is not None:
                n = p["name"]
                if n.startswith("nn.Module: "):
                    chain.append(n[11:])
                    mod = mod or n
                elif eng is None and p["_cat"] == "python_function" and "tensorrt_llm" in n:
                    eng = n
                p = by_id.get(p.get("parent_id"))
            if mod:
                w["code_origin"], w["code_where"] = "model code", "/".join(reversed(chain))
                w["code_evidence"] = "Observed: nn.Module range encloses the launch (with_modules=1)"
            else:
                w["code_origin"], w["code_where"] = "engine code", eng
                w["code_evidence"] = "Observed: Python stack of the launch (with_stack=1), no nn.Module range"
            origin[w["code_origin"]] += 1
    for r in rows:
        if r["iteration"] is None and r["stream"] is None and r["_cat"] in ("cpu_op", "cuda_runtime", "cuda_driver"):
            r["iteration"] = it_of(r["start_ns"])
        it = r["iteration"]
        r["request_id"] = next((rid for rid, a, b in windows if it is not None and a <= it <= b), None)
    report["torch"] = {"events": len(rows), "clock_offset_ns": off, "links": len(links), "kernel_origin": origin,
                       "by_source": count([r["source"] for r in rows]),
                       "with_parent": sum(r.get("parent_id") is not None for r in rows)}
    for r in rows:
        for k in ("_py", "_pyparent", "_cat"):
            r.pop(k)
    return rows, links


def count(xs):
    c = {}
    for x in xs:
        c[x] = c.get(x, 0) + 1
    return dict(sorted(c.items(), key=lambda kv: -kv[1]))


def contain(rows, skip_set=False):
    """Parent = the innermost span on the same lane whose interval contains this row (ties: longer one is outer).
    Rows that already carry a parent keep it. Returns the number of rows that cross a sibling (not nested)."""
    lanes, crossing = {}, 0
    for r in rows:
        lanes.setdefault((r["run"], r["process"], r["thread"]), []).append(r)
    for lane in lanes.values():
        lane.sort(key=lambda r: (r["start_ns"], -(r["end_ns"] if r["end_ns"] is not None else r["start_ns"])))
        stack = []
        for r in lane:
            end = r["end_ns"] if r["end_ns"] is not None else r["start_ns"]
            while stack and (stack[-1]["end_ns"] if stack[-1]["end_ns"] is not None else 2**62) < r["start_ns"]:
                stack.pop()
            while stack and (stack[-1]["end_ns"] if stack[-1]["end_ns"] is not None else 2**62) < end:
                crossing += 1  # partial overlap: the open span cannot contain this row
                stack.pop()
            if stack and r.get("parent_id") is None:
                r["parent_id"], r["parent_rule"] = stack[-1]["id"], "Calculated: time containment on one thread"
            if r["kind"] != "instant" and (r["end_ns"] is None or r["end_ns"] > r["start_ns"]):
                stack.append(r)
    return crossing


def add_q(q, x):
    return x if not q else f"{q},{x}"


def main():
    t0 = time.perf_counter()
    OUT.mkdir(parents=True, exist_ok=True)
    report = {}
    ev = pq.read_table(CANON / "real_events.parquet").to_pylist()
    before = len(ev)
    ev = [r for r in ev if not (r["run"] == CODE and r["args"] and '"span_id":"torch/' in r["args"])]
    report["run.json torch spans replaced"] = before - len(ev)
    mev, msm, mpr, mln = Rows(EVENT_SCHEMA), Rows(SAMPLE_SCHEMA), Rows(PROFILE_SCHEMA), Rows(LINK_SCHEMA)
    nid = iter(range(MEASURED_ID0, MEASURED_ID0 + 10**8)).__next__
    for run in MEASURED:
        report.setdefault("measured runs added", {})[run] = import_run_json(run, mev, msm, mpr, mln, nid, False)[0]
    ev += mev.table().to_pylist()
    extra = {"links": mln.table(), "samples": msm.table(), "profiles": mpr.table()}
    for r in ev:
        a = json.loads(r["args"]) if r["args"] else {}
        r.update(parent_id=None, parent_rule=None, device=None, stream=None, quirk=None, code_origin=None,
                 code_where=None, code_evidence=None)
        if r["source"] in ("kernel", "memcpy", "memset", "cuda_sync", "cuda_event"):
            r["device"] = 0
            r["stream"] = int(r["track"].rsplit("/", 1)[1])
            if r["stream"] == 4294967295:
                r["quirk"] = "stream_all"
        if r["source"] == "nvtx" and r["kind"] == "instant":
            # rows with no end: a range type (59 push/pop, 60 start/end) would be open-ended; marks (34),
            # category names (33) and domain creation (75) have no end by type
            r["quirk"] = "open_ended" if a.get("event_type") in (59, 60) else "no_end_by_type"
            if r["quirk"] == "open_ended":
                r["kind"], r["end_ns"] = "open", None
        if r["run"] == RUNS[0] and r["pid"] == 0:
            r["quirk"] = add_q(r["quirk"], "pid0")
    # negative session times: rows that start before the Nsight session's zero (D1's clock base)
    rj = json.loads((RESULTS / RUNS[0] / "run.json").read_text())
    base = {s["start_ns"] - int(s["id"].split("/")[2]) for s in rj["spans"] if s["id"].startswith("nsys/nvtx/")}.pop()
    for r in ev:
        if r["run"] == RUNS[0] and r["source"] not in ("run.json",) and r["start_ns"] < base:
            r["quirk"] = add_q(r["quirk"], "negative")
    report["crossing (not nested) on CPU and stamp lanes"] = contain([r for r in ev if r["stream"] is None])
    tr, tl = torch_events(report)
    ev += tr
    for r in ev:
        r.setdefault("parent_id", None)
        r.setdefault("parent_rule", None)
        for k in ("device", "stream", "quirk", "code_origin", "code_where", "code_evidence", "pid", "host_pid",
                  "pname", "tid", "kthread", "pythread"):
            r.setdefault(k, None)
    ev.sort(key=lambda r: r["start_ns"])
    tab = pa.Table.from_pylist(ev, schema=NEUTRAL_SCHEMA)
    pq.write_table(tab, OUT / "events.parquet", compression="zstd", row_group_size=100_000)
    ln = pq.read_table(CANON / "real_links.parquet").to_pylist() + extra["links"].to_pylist() + tl
    pq.write_table(pa.Table.from_pylist(ln, schema=LINK_SCHEMA), OUT / "links.parquet", compression="zstd")
    for k in ("samples", "profiles"):
        pq.write_table(pa.concat_tables([pq.read_table(CANON / f"real_{k}.parquet"), extra[k]]), OUT / f"{k}.parquet",
                       compression="zstd")
    con = duckdb.connect()
    e = f"read_parquet('{OUT}/events.parquet')"
    report["events"] = tab.num_rows
    report["links"] = len(ln)
    report["by_run"] = {r: dict(zip(["events", "with_parent", "quirk_rows"], v)) for r, *v in con.execute(
        f"SELECT run, count(*), count(parent_id), count(quirk) FROM {e} GROUP BY run").fetchall()}
    report["quirks"] = dict(con.execute(f"SELECT quirk, count(*) FROM {e} WHERE quirk IS NOT NULL GROUP BY 1").fetchall())
    report["seconds"] = round(time.perf_counter() - t0, 1)
    (OUT / "report.json").write_text(json.dumps(report, indent=1))
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
