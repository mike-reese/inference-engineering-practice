"""Import saved runs into the command center v2 store: D1 option C (DuckDB over Parquet) with D2 option B records
(ie-run/2: things, events, links, samples, profiles), one folder per run under /mnt/ie-data/cc-v2-proto/store_v2/runs.

Rows come from the frozen D1/D2 import code: D1/canonical.py reads run.json and the Nsight Systems SQLite export in
full, and D2/ingest.py adds parents (Python parent id, or time containment on one thread) and CUDA launch links.
For runs D2 already imported (the eight saved I02A runs) the D2 neutral tables are read as they are.

Nothing here knows an event kind, a field, a unit or a measure by name: registry/*.json (one file per source) maps
the neutral rows to ie-run/2 kinds, stable descriptive ids (eid), one ASD-STE100 sentence (what), units and
measures. A row no registry rule claims stops the import (exit 1) and names the row.

Also built per run, as frozen D1 requires: per-lane checkpoints (latest event at or before each 10 ms grid time) and
the links file twice (sorted by from_id and by to_id), each link carrying the other end's lane, name and start.

Usage: python import_v2.py RUN [RUN ...] [--ncu NCU_RUN]   (bulk output on /mnt/ie-data)
"""
import argparse
import bisect
import csv
import io
import json
import re
import subprocess
import sys
import time
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

HERE = Path(__file__).resolve().parent
PROTO = HERE.parent.parent
sys.path.insert(0, str(PROTO / "D1"))
sys.path.insert(0, str(PROTO / "D2"))
from canonical import (EVENT_SCHEMA, LINK_SCHEMA, PROFILE_SCHEMA, RESULTS, SAMPLE_SCHEMA, Rows,  # noqa: E402
                       import_nsys, import_run_json, nsys_base, server_host_pid)
from ingest import contain  # noqa: E402

STORE = Path("/mnt/ie-data/cc-v2-proto/store_v2")
NEUTRAL = Path("/mnt/ie-data/cc-v2-proto/d2/neutral")
DEVQUERY = Path("/home/mike/Work/Code/Personal/inference-engineering-fundamentals/explainers/I01C_gpu_dataflow/devquery.json")
CP_NS = 10_000_000  # checkpoint grid (D1): at most 10 ms of events are read past a checkpoint


def registries():
    regs = [json.loads(p.read_text()) for p in sorted((HERE / "registry").glob("*.json"))]
    return sorted(regs, key=lambda r: r["order"])


# ------------------------------------------------------------------ neutral rows (frozen D1/D2 code)
def neutral_new(run):
    """D1 canonical import (run.json + full Nsight export) and D2 enrichment for a run D2 did not import."""
    ev, sm, pr, ln = Rows(EVENT_SCHEMA), Rows(SAMPLE_SCHEMA), Rows(PROFILE_SCHEMA), Rows(LINK_SCHEMA)
    nid = iter(range(1, 1 << 62)).__next__
    has_nsys = (RESULTS / run / "trace/timeline.sqlite").is_file()
    stats, j = import_run_json(run, ev, sm, pr, ln, nid, skip_nsys=has_nsys)
    if has_nsys:
        records = json.loads((RESULTS / run / "engine_records.json").read_text())
        stats["nsys"] = import_nsys(RESULTS / run / "trace/timeline.sqlite", run, nsys_base(j), records, ev, sm, ln,
                                    nid, server_host_pid(run))
    rows = ev.table().to_pylist()
    for r in rows:
        r.update(parent_id=None, parent_rule=None, device=None, stream=None, quirk=None, code_origin=None,
                 code_where=None, code_evidence=None)
        if r["track"].startswith("gpu"):
            r["device"], r["stream"] = 0, int(r["track"].rsplit("/", 1)[1])
            if r["stream"] == 4294967295:
                r["quirk"] = "stream_all"
    stats["crossing (not nested)"] = contain([r for r in rows if r["stream"] is None])
    return rows, ln.table().to_pylist(), sm.table().to_pylist(), stats


def neutral_saved(run):
    c = duckdb.connect()
    q = lambda t: c.execute(f"SELECT * FROM read_parquet('{NEUTRAL}/{t}.parquet') WHERE run = ?", [run]).to_arrow_table().to_pylist()
    return q("events"), q("links"), q("samples"), {"from": "D2 neutral tables"}


# ------------------------------------------------------------------ registry mapping
def slug(s, n=72):
    s = re.sub(r"[^A-Za-z0-9_.:+-]+", "-", str(s)).strip("-")
    return s[:n] or "-"


def matches(m, r, a):
    if "source" in m and r["source"] != m["source"]:
        return False
    if "track_prefix" in m and not (r["track"] or "").startswith(m["track_prefix"]):
        return False
    if "process_prefix" in m and not (r["process"] or "").startswith(m["process_prefix"]):
        return False
    if "thread" in m and r["thread"] != m["thread"]:
        return False
    if "box" in m and not (a.get("box") and (m["box"] == "*" or a["box"] == m["box"])):
        return False
    if "name_regex" in m and not re.search(m["name_regex"], r["name"] or ""):
        return False
    return True


def lane_of(r):
    """The thing an event sits on: a GPU stream, or a thread of a process."""
    if r["stream"] is not None:
        return f"gpu{r['device'] or 0}/stream {r['stream']}"
    return f"{r['process']}/{r['thread']}"


def request_short(rid):
    return rid.rsplit("-", 1)[-1] if rid else "-"


# ------------------------------------------------------------------ things
def build_things(run, lanes, regs, inv):
    lane_rules = [x for reg in regs for x in reg.get("lanes", [])]
    out = {}

    def add(i, parent, kind, name, attrs=None, evidence=None):
        out.setdefault(i, {"run": run, "id": i, "parent_id": parent, "kind": kind, "name": name,
                           "attrs": json.dumps(attrs or {}, default=str), "evidence": evidence})
    for t in inv:
        add(t["id"], t.get("parent"), t["kind"], t["name"], t.get("attrs"), t["evidence"])
    for lane, (proc, thread, pid, tid, kthread) in sorted(lanes.items()):
        if lane.startswith("gpu"):
            g = lane.split("/")[0]
            add(lane, g, "stream", lane.split("/")[1], {}, "Observed: CUPTI stream id")
            continue
        rule = next((x for x in lane_rules if proc.startswith(x["process_prefix"])), None)
        if rule is None:
            sys.exit(f"no lane rule (registry 'lanes') for process {proc!r}")
        cont = f"host/{rule['container']}"
        add(cont, "host", "container" if rule["container"] != "network" else "network", rule["container_name"], {},
            "Observed: topology.json (docker inspect)")
        pthing = f"{cont}/{proc}"
        add(pthing, cont, "process", proc, {"pid": pid}, "Observed" if pid is not None else "Observed (no pid recorded)")
        add(lane, pthing, "thread", thread, {"tid": tid, "kernel_thread_name": kthread},
            "Observed" if tid is not None or thread else "Observed (no thread id recorded)")
    return list(out.values())


def inventory_things(regs):
    reg = next(r for r in regs if r["source"] == "inventory")
    p = json.loads((STORE / "probe/inventory.json").read_text())
    dq = json.loads(DEVQUERY.read_text())
    g, cpu = p["gpu"], p["cpu"]
    v = {"board_name": p["board"]["board_name"], "cpu_name": cpu["Model name"], "cores": int(cpu["Core(s) per socket"]),
         "threads": int(cpu["Core(s) per socket"]) * int(cpu["Thread(s) per core"]), "l1d": cpu["L1d cache"],
         "l2": cpu["L2 cache"], "l3": cpu["L3 cache"], "max_mhz": cpu.get("CPU max MHz"),
         "ram_gib": round(int(p["memory"]["MemTotal"].split()[1]) / 2**20, 1), "nvme_model": p["nvme"][0]["model"],
         "nvme_link": f"{p['nvme'][0]['link']['current_link_speed']} x{p['nvme'][0]['link']['current_link_width']}",
         "gpu_name": g["name"], "gpu_gen": g["pcie.link.gen.current"], "gpu_width": g["pcie.link.width.current"],
         "gpu_width_max": g["pcie.link.width.max"], "cc": f"{dq['cc_major']}.{dq['cc_minor']}", "sms": dq["sms"],
         "l2_bytes": dq["l2_bytes"], "l2_mib": dq["l2_bytes"] // 2**20, "vram_bytes": dq["total_mem_bytes"],
         "vram_gib": round(dq["total_mem_bytes"] / 2**30, 1), "bus_bits": dq["bus_bits"],
         "memory_controllers": dq["bus_bits"] // 32, "copy_engines": dq["copy_engines"],
         "smem_per_sm": dq["smem_per_sm"], "regs_per_sm": dq["regs_per_sm"],
         "max_threads_per_sm": dq["max_threads_per_sm"], "clocks_max_sm": g.get("clocks.max.sm")}
    out = []
    for t in reg["things"]:
        n = v[t["repeat"]] if "repeat" in t else None
        for i in range(n) if n is not None else [None]:
            f = dict(v, i=i)
            out.append({"id": t["id"].format(**f), "parent": t.get("parent"), "kind": t["kind"], "name": t["name"].format(**f),
                        "attrs": {k: v[k] for k in t.get("attrs", [])} | t.get("attrs_fixed", {}),
                        "evidence": t["evidence"]})
    return out


# ------------------------------------------------------------------ iteration shares
def iteration_shares(rows, reg):
    rule = reg["shares"]
    out = []
    for r in rows:
        if r["source"] != "run.json" or r["name"] != rule["stamp_name"]:
            continue
        st = json.loads(r["args"]).get("stamp") or {}
        it = r["iteration"]
        ctx = {q["cid"] for q in st.get("context", []) if isinstance(q, dict)}
        toks = {}
        for q in st.get("requests", []):
            if q["cid"] in ctx or q.get("state", "").startswith("CONTEXT"):
                toks[q["cid"]] = st.get("num_ctx_tokens") if len(ctx) == 1 and st.get("num_ctx_tokens") else q.get("prompt_len")
            else:
                toks[q["cid"]] = rule["generation_tokens"]
        tot = sum(toks.values()) or 1
        for cid, t in toks.items():
            out.append({"iteration": int(it) if it is not None else None, "cid": cid, "request_id": r["request_id"] if len(toks) == 1 else None,
                        "tokens": t, "iteration_tokens": tot, "share": t / tot, "stamp_event_id": r["id"],
                        "evidence": rule["evidence"]})
    return out


# ------------------------------------------------------------------ Nsight Compute rows tied to the timeline kernels
def ncu_rows(ncu_run, events, reg):
    rep = RESULTS / ncu_run / "trace/kernels.ncu-rep"
    cache = STORE / "probe" / f"ncu_{ncu_run}.csv"
    if not cache.is_file():
        txt = subprocess.run(["ncu", "--import", str(rep), "--csv", "--page", "raw"], capture_output=True, text=True,
                             check=True).stdout
        cache.write_text(txt)
    rd = list(csv.reader(io.StringIO(cache.read_text())))
    head, units, body = rd[0], rd[1], rd[2:]
    labels = json.loads((RESULTS / ncu_run / "labels.json").read_text())
    it = int(labels["profile_range"].split("-")[0])
    tl = sorted((e for e in events if e["kind"] == "kernel" and e["iteration"] == it), key=lambda e: e["start_ns"])
    keep, kall = reg["keep_metrics"], reg.get("keep_all_numeric")
    name_col = head.index("Kernel Name")
    out, matched, mismatched = [], 0, 0
    for k, row in enumerate(body):
        kname = row[name_col]
        ev = tl[k] if k < len(tl) else None
        ok = ev is not None and (ev["name"] in kname or kname.startswith(ev["name"]) or ev["name"].split("<")[0] in kname)
        matched += ok
        mismatched += not ok
        for col, (h, u) in enumerate(zip(head, units)):
            if h not in keep and not kall:
                continue
            try:
                val = float(row[col].replace(",", ""))
            except ValueError:
                continue
            meta = keep.get(h, {})
            out.append({"profile": "ncu", "profile_run": ncu_run, "profile_row": k, "kernel_name": ev["name"] if ok else kname,
                        "event_id": ev["id"] if ok else None, "event_eid": ev["eid"] if ok else None,
                        "section": h.split("__")[0], "metric": h, "measure": meta.get("measure"),
                        "unit": meta.get("unit") or u or None, "value": val,
                        "evidence": reg["evidence"] + ("; tie " + reg["tie"]["evidence"] if ok else "; NOT tied: name mismatch")})
    return out, {"ncu_kernels": len(body), "timeline_kernels_in_iteration": len(tl), "tied": matched,
                 "not_tied": mismatched, "iteration": it, "rule": reg["tie"]["rule"], "evidence": reg["tie"]["evidence"]}


# ------------------------------------------------------------------ main
def import_run(run, ncu_run, regs, inv):
    t0 = time.perf_counter()
    is_saved = duckdb.connect().execute(f"SELECT count(*) FROM read_parquet('{NEUTRAL}/events.parquet') WHERE run = ?",
                                        [run]).fetchone()[0] > 0
    rows, links, samples, stats = neutral_saved(run) if is_saved else neutral_new(run)
    kinds = [(reg, k) for reg in regs for k in reg.get("event_kinds", [])]
    # iteration from the stamp's executor loop counter where the run.json adapter left none (registry iteration_from)
    itf = next((r["iteration_from"] for r in regs if "iteration_from" in r), None)
    stats["iteration_from"] = {"filled": 0, "checked": 0, "disagree": 0}
    for r in rows:
        if itf and r["source"] == "run.json" and r["args"]:
            a = json.loads(r["args"])
            lp = a.get(itf["field"])
            if lp is not None and str(lp).isdigit():
                v = int(lp) + itf["offset"]
                if r["iteration"] is None:
                    r["iteration"] = v
                    stats["iteration_from"]["filled"] += 1
                else:
                    stats["iteration_from"]["checked"] += 1
                    stats["iteration_from"]["disagree"] += r["iteration"] != v
    # request per iteration from the scheduler stamps (Observed), for rows that have an iteration but no request
    it_req = {}
    for r in rows:
        if r["source"] == "run.json" and r["request_id"] and r["iteration"] is not None:
            it_req.setdefault(int(r["iteration"]), r["request_id"])
    # order: by start; ordinals {n} count in that order, so the same data gives the same eid
    rows.sort(key=lambda r: (r["start_ns"], r["id"]))
    seen, out = {}, []
    for r in rows:
        a = json.loads(r["args"]) if r["args"] else {}
        if r["iteration"] is None and a.get("iteration") is not None and str(a["iteration"]).isdigit():
            r["iteration"] = int(a["iteration"])
        if r["request_id"] is None and r["iteration"] in it_req:
            r["request_id"] = it_req[r["iteration"]]
        hit = next(((reg, k) for reg, k in kinds if matches(k["match"], r, a)), None)
        if hit is None:
            sys.exit(f"{run}: no registry rule for source={r['source']!r} track={r['track']!r} process={r['process']!r} "
                     f"thread={r['thread']!r} name={r['name']!r}")
        reg, k = hit
        lane = lane_of(r)
        f = {"name": r["name"], "short": slug(r["name"].split("(")[0] if r["source"] == "kernel" else r["name"]),
             "lane": slug(lane, 48), "iter": f"i{r['iteration']}" if r["iteration"] is not None else "i-",
             "box": a.get("box", "-"), "request": request_short(r["request_id"]), "bytes": r.get("bytes")}
        prefix = k["eid"].replace("#{n}", "").format(**f)
        n = seen[prefix] = seen.get(prefix, -1) + 1
        eid = k["eid"].format(**f, n=n) if "{n}" in k["eid"] else (prefix if n == 0 else f"{prefix}#{n}")
        out.append({"id": r["id"], "eid": eid, "what": k["what"].format(**f), "thing_id": lane,
                    "parent_id": r.get("parent_id"), "parent_rule": r.get("parent_rule"), "kind": k["kind"],
                    "term": k["term"], "source": reg["source"], "name": r["name"], "start_ns": r["start_ns"],
                    "end_ns": None if r["kind"] == "instant" else r["end_ns"], "iteration": r["iteration"],
                    "request_id": r["request_id"], "corr": r["corr"], "bytes": r.get("bytes"), "args": r["args"],
                    "quirk": r.get("quirk"), "code_origin": r.get("code_origin"), "code_where": r.get("code_where"),
                    "evidence": reg["evidence"]})
    lanes = {}
    for r in rows:
        lanes.setdefault(lane_of(r), (r["process"], r["thread"], r.get("pid"), r.get("tid"), r.get("kthread")))
    things = build_things(run, lanes, regs, inv)
    # shares, and 'serves' links: iteration (engine iteration event) -> client request, weight = share
    rj = next(r for r in regs if r["source"] == "run_json")
    shares = iteration_shares(rows, rj)
    it_ev = {e["iteration"]: e["id"] for e in out if e["kind"] == "engine iteration"}
    req_ev = {e["request_id"]: e["id"] for e in out if e["kind"] == "client request"}
    for s in shares:
        if s["iteration"] in it_ev and s["request_id"] in req_ev:
            links.append({"run": run, "from_id": it_ev[s["iteration"]], "to_id": req_ev[s["request_id"]], "kind": "serves",
                          "rule": rj["measures"][0]["formula"], "synthetic": False, "weight": s["share"]})
    d = STORE / "runs" / run
    d.mkdir(parents=True, exist_ok=True)
    ev_t = pa.Table.from_pylist(out).sort_by([("start_ns", "ascending")])
    pq.write_table(ev_t, d / "events.parquet", compression="zstd", row_group_size=50_000)
    pq.write_table(pa.Table.from_pylist(things), d / "things.parquet", compression="zstd")
    for l in links:
        l.setdefault("weight", None)
        l.setdefault("evidence", l["rule"].split(":")[0] if l.get("rule") else None)
    lschema = pa.schema([("run", pa.string()), ("from_id", pa.int64()), ("to_id", pa.int64()), ("kind", pa.string()),
                         ("rule", pa.string()), ("synthetic", pa.bool_()), ("weight", pa.float64()), ("evidence", pa.string())])
    pq.write_table(pa.Table.from_pylist(links, schema=lschema), d / "links_raw.parquet", compression="zstd")
    samp_rules = [(reg, s) for reg in regs for s in reg.get("samples", [])]
    srows = []
    for s in samples:
        reg, rule = next(((reg, x) for reg, x in samp_rules if x["match"]["track"] == s["track"]), (None, None))
        if rule is None:
            sys.exit(f"{run}: no registry sample rule for track {s['track']!r}")
        if "units" in rule:
            unit = rule["units"].get(s["metric"])
        else:
            m = re.search(rule["unit_from_name"], s["metric"])
            unit = m.group(1) if m else None
        srows.append({"thing_id": rule["thing"], "metric": s["metric"], "ts_ns": s["ts_ns"], "value": s["value"],
                      "unit": unit, "evidence": rule["evidence"]})
    if srows:
        pq.write_table(pa.Table.from_pylist(srows).sort_by([("ts_ns", "ascending")]), d / "samples.parquet", compression="zstd")
    if shares:
        pq.write_table(pa.Table.from_pylist(shares), d / "shares.parquet", compression="zstd")
    ncu_meta = None
    if ncu_run:
        nreg = next(r for r in regs if r["source"] == "ncu")
        prow, ncu_meta = ncu_rows(ncu_run, out, nreg)
        pq.write_table(pa.Table.from_pylist(prow), d / "profiles.parquet", compression="zstd")
    # D1 requirements: links sorted by from_id and by to_id (denormalized), per-lane checkpoints
    c = duckdb.connect()
    c.execute("SET temp_directory='/mnt/ie-data/cc-v2-proto/duckdb_tmp'")
    E, L = f"read_parquet('{d}/events.parquet')", f"read_parquet('{d}/links_raw.parquet')"
    for name, key, other in (("links_from", "from_id", "to_id"), ("links_to", "to_id", "from_id")):
        c.execute(f"""COPY (SELECT l.from_id, l.to_id, l.kind, l.rule, l.evidence, l.weight,
                f.thing_id AS from_thing, f.name AS from_name, f.start_ns AS from_start, f.eid AS from_eid,
                t.thing_id AS to_thing, t.name AS to_name, t.start_ns AS to_start, t.eid AS to_eid
            FROM {L} l JOIN {E} f ON f.id = l.from_id JOIN {E} t ON t.id = l.to_id ORDER BY l.{key})
            TO '{d}/{name}.parquet' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 50000)""")
    t_lo, t_hi = c.execute(f"SELECT min(start_ns), max(coalesce(end_ns, start_ns)) FROM {E}").fetchone()
    c.execute(f"""COPY (WITH g AS (SELECT {t_lo} + i * {CP_NS} AS cp_ns FROM range(0, ({t_hi} - {t_lo}) // {CP_NS} + 2) r(i))
            SELECT g.cp_ns, e.thing_id, arg_max(e.id, e.start_ns) AS id FROM g JOIN {E} e ON e.start_ns <= g.cp_ns
            GROUP BY g.cp_ns, e.thing_id ORDER BY g.cp_ns) TO '{d}/checkpoints.parquet'
            (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 20000)""")
    counts = {t: c.execute(f"SELECT count(*) FROM read_parquet('{d}/{t}.parquet')").fetchone()[0]
              for t in ("events", "things", "links_from", "checkpoints", "samples", "profiles", "shares")
              if (d / f"{t}.parquet").is_file()}
    dup = c.execute(f"SELECT count(*) - count(DISTINCT eid) FROM {E}").fetchone()[0]
    if dup:
        sys.exit(f"{run}: {dup} duplicate eids")
    meta = {"run": run, "title": f"I02A {run.split('_')[0]} {run[-6:]}", "t0_ns": t_lo, "t1_ns": t_hi,
            "checkpoint_ns": CP_NS, "counts": counts, "import": stats,
            "kinds": dict(c.execute(f"SELECT kind, count(*) FROM {E} GROUP BY 1 ORDER BY 2 DESC").fetchall()),
            "evidence": {"times": "Observed: CLOCK_MONOTONIC ns (run clock)",
                         "parents": "Observed (Python parent id) or Calculated (time containment on one thread)",
                         "request per iteration": "Observed: scheduler stamps carry the request and the iteration"},
            "ncu": ncu_meta, "registries": regs,
            "measures": {m["measure"]: m | {"source": r["source"]} for r in regs for m in r.get("measures", [])},
            "seconds": round(time.perf_counter() - t0, 1)}
    (d / "meta.json").write_text(json.dumps(meta, indent=1, default=str))
    (d / "links_raw.parquet").unlink()
    print(json.dumps({k: meta[k] for k in ("run", "counts", "kinds", "ncu", "seconds")}, indent=1, default=str))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("runs", nargs="+")
    ap.add_argument("--ncu", help="Nsight Compute run whose kernels are tied to the (first) run's kernels")
    a = ap.parse_args()
    regs = registries()
    inv = inventory_things(regs)
    for i, run in enumerate(a.runs):
        import_run(run, a.ncu if i == 0 else None, regs, inv)


if __name__ == "__main__":
    main()
