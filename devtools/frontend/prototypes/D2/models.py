"""D2 prototype: the neutral record set written in each event-model option, on the D1 store (Parquet + DuckDB).

  A  ie-run/1 extended in place: one `spans` table with v1's columns (id, level, component, name, start_ns, end_ns,
     request_id, attrs JSON, raw JSON). New facts go into attrs (pid, tid, thread names, parent span id, outgoing
     links, request shares). Samples stay spans named "sample". Things beyond the span: a topology document per run.
  B  ie-run/2: five record kinds as typed tables (things, events, links, samples, profiles). Events point at a
     thing (thread or GPU stream) and a parent event; links carry kind, rule, evidence and a weight (iteration share).
  C  Perfetto native (note, Observed: trace_processor v59.1 stores a debug annotation named "ie.key" as the arg
     "debug.ie_key": dots in annotation names become underscores): one protobuf trace per run (TrackEvent: process/thread tracks, child tracks for streams and
     stamp lanes, slices, flows by flow id, counter tracks), loaded by trace_processor; its slice, flow and args
     tables are exported to Parquet. Each slice carries our event key as a debug annotation so coverage can be checked.
  D  OpenTelemetry: resources (one per process), spans (trace = the root of the parent chain, span links with
     attributes), metrics (gauge points). Times converted to Unix ns with the run's client anchor pair.
Every option starts from the same neutral rows (ingest.py + fixtures.py); `key` is a stable source key (the run.json
span id where one exists, else source/neutral id) so a results file can point at an event in any option.
Usage: python models.py [A B C D]   -> /mnt/ie-data/cc-v2-proto/d2/<option>/ and bench/d2_models.json
"""
import json
import struct
import sys
import time
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path("/mnt/ie-data/cc-v2-proto/d2")
NEU, FIX = ROOT / "neutral", ROOT / "fixtures"
TP_BIN = "/mnt/ie-data/cc-v2-proto/bin/trace_processor_shell"
RESULTS = Path(__file__).resolve().parents[4] / "reps/I02A-L1_streamed_latency/results"


def con():
    c = duckdb.connect()
    c.execute("SET temp_directory='/mnt/ie-data/cc-v2-proto/duckdb_tmp'")
    c.execute(f"""CREATE VIEW ev AS
        SELECT *, coalesce(json_extract_string(args, '$.span_id'), source || '/' || id) AS key
          FROM read_parquet('{NEU}/events.parquet')
        UNION ALL BY NAME
        SELECT *, source || '/' || id AS key FROM read_parquet('{FIX}/shares_events.parquet')""")
    c.execute(f"""CREATE VIEW ln AS SELECT *, NULL::DOUBLE AS weight FROM read_parquet('{NEU}/links.parquet')
        UNION ALL BY NAME SELECT * FROM read_parquet('{FIX}/shares_links.parquet')""")
    c.execute(f"""CREATE VIEW sm AS SELECT run, CASE WHEN track LIKE 'gpu0/%' THEN run || '|gpu0' END AS thing_id,
        metric, ts_ns, value, NULL AS unit, 'Observed: ' || track AS evidence, synthetic
        FROM read_parquet('{NEU}/samples.parquet')
        UNION ALL BY NAME SELECT run, thing_id, metric, ts_ns, value, unit, evidence, synthetic
        FROM read_parquet('{FIX}/board_samples.parquet')""")
    c.execute(f"CREATE VIEW fx_things AS SELECT * FROM read_parquet('{FIX}/things.parquet')")
    return c


def size(d):
    return sum(p.stat().st_size for p in Path(d).rglob("*") if p.is_file())


# ---------------------------------------------------------------- B: ie-run/2
def build_B(c, d):
    lanes = c.execute("""SELECT run, process, thread, any_value(pid), any_value(host_pid), any_value(pname),
        any_value(tid), any_value(kthread), any_value(pythread), bool_or(stream IS NOT NULL)
        FROM ev GROUP BY ALL""").fetchall()
    things = {}

    def thing(run, tid_, parent, kind, name, attrs, evidence):
        things[f"{run}|{tid_}"] = {"run": run, "id": f"{run}|{tid_}", "parent_id": f"{run}|{parent}" if parent else None,
                                   "kind": kind, "name": name, "attrs": json.dumps(attrs), "evidence": evidence}

    worker = dict(c.execute("""SELECT run, any_value(process) FROM ev WHERE iteration IS NOT NULL
        AND process LIKE 'server pid%' GROUP BY run HAVING count(DISTINCT process) = 1""").fetchall())
    for run, proc, thr, pid, hpid, pname, tid, kth, pyth, is_stream in lanes:
        thing(run, "host", None, "host", "this machine", {}, "Observed")
        top = "host"
        if proc.startswith("server") or proc == "pytorch profiler":
            thing(run, "server-1", "host", "container", "server-1 (trtllm-serve)", {}, "Observed: topology.json")
            top = "server-1"
        elif proc == "client":
            thing(run, "client-1", "host", "container", "client-1 (Locust)", {}, "Observed: topology.json")
            top = "client-1"
        pa_ = {"container_pid": pid, "host_pid": hpid, "name": pname}
        ev_ = ("Observed: PID in the container's namespace" if pid is not None else
               "Unavailable: the source records no PID")
        ev_ += "; host PID Observed (Docker State.Pid of PID 1)" if hpid else "; host PID Unavailable"
        if proc == "server (no pid recorded)" and run in worker:
            pa_["inferred_process"] = f"{run}|{worker[run]}"
            ev_ += f"; Inferred: runs in {worker[run]} (the only server process with iterations in this run)"
        thing(run, proc, top, "process" if proc not in ("network",) else "interface", proc, pa_, ev_)
        if is_stream:
            thing(run, "gpu0", "host", "gpu", "GPU 0", {}, "Observed")
            thing(run, f"gpu0|{proc}|{thr}", "gpu0", "stream", thr, {"owner_process": f"{run}|{proc}"},
                  "Observed: CUPTI stream id" + ("; 4294967295 = not one stream" if thr.endswith("4294967295") else ""))
        else:
            kind = "thread" if (tid is not None or pyth is not None) else "component (no thread id recorded)"
            thing(run, f"{proc}|{thr}", proc, kind, thr, {"tid": tid, "kernel_thread_name": kth,
                                                          "python_thread_name": pyth},
                  "Observed" if tid is not None or pyth else "Unavailable: the source records no thread")
    for r in c.execute("SELECT * FROM fx_things").fetchall():
        things[r[1]] = dict(zip(["run", "id", "parent_id", "kind", "name", "attrs", "evidence"], r))
    pq.write_table(pa.Table.from_pylist(list(things.values())), d / "things.parquet")
    c.execute(f"""COPY (SELECT id, run, key,
        CASE WHEN stream IS NOT NULL THEN run || '|gpu0|' || process || '|' || thread
             ELSE run || '|' || process || '|' || thread END AS thing_id,
        parent_id, parent_rule, kind, source AS category, name, start_ns, end_ns, iteration, request_id, corr,
        bytes, args, quirk, code_origin, code_where, code_evidence, synthetic
        FROM ev ORDER BY start_ns) TO '{d}/events.parquet' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)""")
    c.execute(f"""COPY (SELECT run, from_id, to_id, kind, rule, split_part(rule, ':', 1) AS evidence, weight, synthetic
        FROM ln ORDER BY from_id) TO '{d}/links.parquet' (FORMAT parquet, COMPRESSION zstd)""")
    c.execute(f"COPY (SELECT * FROM sm ORDER BY ts_ns) TO '{d}/samples.parquet' (FORMAT parquet, COMPRESSION zstd)")
    c.execute(f"COPY (SELECT * FROM read_parquet('{NEU}/profiles.parquet')) TO '{d}/profiles.parquet' (FORMAT parquet)")


# ---------------------------------------------------------------- A: ie-run/1 extended in place
def build_A(c, d):
    c.execute(f"""COPY (
      WITH outl AS (SELECT l.from_id, list({{'to': e.key, 'kind': l.kind, 'rule': l.rule}}) AS links
                    FROM ln l JOIN ev e ON e.id = l.to_id WHERE l.kind <> 'serves' GROUP BY l.from_id),
           shr AS (SELECT l.from_id, list({{'request_id': e.request_id, 'share': l.weight}}) AS requests
                   FROM ln l JOIN ev e ON e.id = l.to_id WHERE l.kind = 'serves' GROUP BY l.from_id)
      SELECT e.run, e.key AS id,
        CASE WHEN e.source = 'run.json' THEN split_part(e.track, '/', 1)
             WHEN e.source IN ('kernel', 'memcpy', 'memset', 'cuda_sync', 'cuda_event') THEN 'hardware'
             ELSE 'server' END AS level,
        CASE WHEN e.source = 'run.json' THEN split_part(e.track, '/', 2)
             WHEN e.source IN ('kernel', 'memset', 'cuda_sync', 'cuda_event') THEN 'gpu'
             WHEN e.source = 'memcpy' THEN 'pcie' ELSE e.source END AS component,
        e.name, e.start_ns, CASE WHEN e.kind = 'span' THEN e.end_ns END AS end_ns, e.request_id,
        json_merge_patch(coalesce(e.args, '{{}}'), to_json({{pid: e.pid, tid: e.tid, process: e.process,
            thread: e.thread, kthread: e.kthread, pythread: e.pythread, host_pid: e.host_pid,
            iteration: e.iteration, correlation: e.corr, bytes: e.bytes, parent: p.key, parent_rule: e.parent_rule,
            quirk: e.quirk, code_origin: e.code_origin, code_where: e.code_where, code_evidence: e.code_evidence,
            synthetic: e.synthetic, links: o.links, requests: s.requests}})) AS attrs,
        NULL AS raw
      FROM ev e LEFT JOIN ev p ON p.id = e.parent_id LEFT JOIN outl o ON o.from_id = e.id
        LEFT JOIN shr s ON s.from_id = e.id
      UNION ALL
      SELECT run, run || '/' || replace(split_part(evidence, ' ', 2), '/', ':') || '/sample/' || ts_ns, 'hardware',
             'gpu', 'sample', ts_ns, NULL, NULL, json_group_object(metric, value), NULL
        FROM sm GROUP BY run, evidence, ts_ns
      ORDER BY start_ns) TO '{d}/spans.parquet' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)""")
    c.execute(f"""COPY (SELECT run, json_group_array(json_object('id', id, 'parent', parent_id, 'kind', kind,
        'name', name, 'attrs', attrs, 'evidence', evidence)) AS topology FROM fx_things GROUP BY run)
        TO '{d}/topology.parquet' (FORMAT parquet)""")
    c.execute(f"COPY (SELECT * FROM read_parquet('{NEU}/profiles.parquet')) TO '{d}/profiles.parquet' (FORMAT parquet)")


# ---------------------------------------------------------------- D: OpenTelemetry
def build_D(c, d):
    off = {}
    for run in c.execute("SELECT DISTINCT run FROM ev").fetchall():
        run = run[0]
        src = run if not run.startswith("fixture") else "I02A-TRACE-timeline_20261103T185837Z_e08b8b"
        joins = json.loads((RESULTS / src / "run.json").read_text())["topology"].get("clock_joins", {})
        off[run] = next((v for k, v in joins.items() if k.endswith("-measured")), next(iter(joins.values()), None))
    rows = c.execute("SELECT id, parent_id FROM ev").fetchall()
    par = dict(rows)
    root = {}
    for i, _ in rows:
        chain = []
        x = i
        while x is not None and x not in root:
            chain.append(x)
            x = par.get(x)
        r = root[x] if x is not None else chain[-1]
        for y in chain:
            root[y] = r
    c.execute("CREATE TEMP TABLE roots(id BIGINT, root BIGINT)")
    c.executemany("INSERT INTO roots VALUES (?, ?)", list(root.items())) if len(root) < 1000 else \
        c.register("roots_df", pa.table({"id": list(root.keys()), "root": list(root.values())}))
    if len(root) >= 1000:
        c.execute("INSERT INTO roots SELECT * FROM roots_df")
    c.execute("CREATE TEMP TABLE offs(run VARCHAR, off BIGINT)")
    c.executemany("INSERT INTO offs VALUES (?, ?)", list(off.items()))
    c.execute(f"""COPY (SELECT DISTINCT run || '|' || process AS resource_id, run,
        to_json({{'service.name': CASE WHEN process LIKE 'server%' THEN 'trtllm-serve' ELSE process END,
                  'process.pid': pid, 'process.executable.name': pname, 'host.name': 'this machine',
                  'ie.host_pid': host_pid, 'ie.run': run}}) AS attributes FROM ev)
        TO '{d}/resources.parquet' (FORMAT parquet)""")
    hexid = "lpad(to_hex({x}), 16, '0')"
    c.execute(f"""COPY (
      WITH lk AS (
        SELECT CASE WHEN kind = 'serves' THEN from_id ELSE to_id END AS on_id,
               list({{'trace_id': lpad(to_hex(r.root), 32, '0'), 'span_id': {hexid.format(x="CASE WHEN kind = 'serves' THEN to_id ELSE from_id END")},
                      'attributes': {{'ie.link.kind': kind, 'ie.link.rule': rule, 'ie.share': weight,
                                      'ie.link.direction': CASE WHEN kind = 'serves' THEN 'to' ELSE 'from' END}}}}) AS links
          FROM ln JOIN roots r ON r.id = CASE WHEN kind = 'serves' THEN to_id ELSE from_id END GROUP BY 1)
      SELECT e.run, lpad(to_hex(r.root), 32, '0') AS trace_id, {hexid.format(x="e.id")} AS span_id,
        CASE WHEN e.parent_id IS NOT NULL THEN {hexid.format(x="e.parent_id")} END AS parent_span_id,
        e.name, 'INTERNAL' AS span_kind, e.source AS scope_name,
        e.start_ns + o.off AS start_time_unix_nano, coalesce(e.end_ns, e.start_ns) + o.off AS end_time_unix_nano,
        e.run || '|' || e.process AS resource_id,
        to_json({{'thread.id': e.tid, 'thread.name': coalesce(e.pythread, e.kthread, e.thread),
                  'ie.key': e.key, 'ie.instant': e.kind = 'instant', 'ie.iteration': e.iteration,
                  'ie.request_id': e.request_id, 'ie.correlation': e.corr, 'ie.bytes': e.bytes, 'ie.quirk': e.quirk,
                  'ie.code_origin': e.code_origin, 'ie.code_where': e.code_where,
                  'ie.parent_rule': e.parent_rule, 'ie.args': e.args, 'ie.synthetic': e.synthetic}}) AS attributes,
        lk.links
      FROM ev e JOIN roots r ON r.id = e.id JOIN offs o ON o.run = e.run LEFT JOIN lk ON lk.on_id = e.id
      ORDER BY start_time_unix_nano) TO '{d}/spans.parquet' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)""")
    c.execute(f"""COPY (SELECT s.run || '|host' AS resource_id, s.run, s.metric AS name, s.unit, 'gauge' AS type,
        to_json({{'hw.id': coalesce(s.thing_id, s.run || '|gpu0'), 'hw.type': CASE WHEN s.thing_id LIKE '%link%'
                  THEN 'pcie_link' ELSE 'gpu' END, 'ie.evidence': s.evidence}}) AS attributes,
        s.ts_ns + o.off AS time_unix_nano, s.value FROM sm s JOIN offs o ON o.run = s.run ORDER BY 7)
        TO '{d}/metrics.parquet' (FORMAT parquet, COMPRESSION zstd)""")
    # hardware tree: OTel's hardware conventions (Development) give hw.id, hw.type, hw.parent on metric points;
    # a component with no metric has no record to carry it, so it becomes a resource of its own
    c.execute(f"""COPY (SELECT id AS resource_id, run, to_json({{'hw.id': id, 'hw.parent': parent_id, 'hw.type': kind,
        'hw.name': name, 'ie.attrs': attrs, 'ie.evidence': evidence}}) AS attributes FROM fx_things)
        TO '{d}/hw_resources.parquet' (FORMAT parquet)""")
    (d / "clock_offsets.json").write_text(json.dumps(off, indent=1))


# ---------------------------------------------------------------- C: Perfetto TrackEvent protobuf
def varint(n):
    out = bytearray()
    n &= (1 << 64) - 1
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def fv(f, n):  # varint field
    return varint(f << 3) + varint(n)


def fb(f, b):  # length-delimited field
    if isinstance(b, str):
        b = b.encode()
    return varint((f << 3) | 2) + varint(len(b)) + b


def f64(f, n):  # fixed64
    return varint((f << 3) | 1) + struct.pack("<Q", n)


def fd(f, x):  # double
    return varint((f << 3) | 1) + struct.pack("<d", x)


SEQ = 1


def packet(body):
    return fb(1, body + fv(10, SEQ))


def track(uuid, name=None, parent=None, pid=None, tid=None, pname=None, tname=None, counter=False):
    b = fv(1, uuid)
    if name:
        b += fb(2, name)
    if parent:
        b += fv(5, parent)
    if tid is not None:
        b += fb(4, fv(1, pid) + fv(2, tid) + (fb(5, tname) if tname else b""))
    elif pid is not None:
        b += fb(3, fv(1, pid) + (fb(6, pname) if pname else b""))
    if counter:
        b += fb(8, b"")
    return packet(fb(60, b))


def annot(name, v):
    if isinstance(v, bool):
        return fb(4, fb(10, name) + fv(2, int(v)))
    if isinstance(v, int):
        return fb(4, fb(10, name) + fv(4, v))
    if isinstance(v, float):
        return fb(4, fb(10, name) + fd(5, v))
    return fb(4, fb(10, name) + fb(6, str(v)))


def tevent(ts, typ, trk, name=None, cat=None, annots=(), flows=(), term=()):
    b = fv(9, typ) + fv(11, trk)
    if name is not None:
        b += fb(23, name)
    if cat:
        b += fb(22, cat)
    for k, v in annots:
        if v is not None:
            b += annot(k, v)
    for f in flows:
        b += f64(47, f)
    for f in term:
        b += f64(48, f)
    return packet(fv(8, ts) + fb(11, b))


def build_C(c, d):
    import subprocess
    import os
    runs = [r[0] for r in c.execute("SELECT DISTINCT run FROM ev ORDER BY 1").fetchall()]
    if os.environ.get("C_RUNS"):  # a quick check on a subset of runs
        runs = [r for r in runs if r in os.environ["C_RUNS"].split(",")]
    stats = {}
    out_s, out_f, out_sh = [], [], []
    for run in runs:
        t0 = time.perf_counter()
        ev = c.execute("""SELECT id, key, kind, source, name, start_ns, end_ns, process, thread, pid, tid, stream,
            iteration, request_id, corr, bytes, quirk, code_origin, code_where FROM ev WHERE run = ?
            ORDER BY start_ns, coalesce(end_ns, start_ns) DESC""", [run]).fetchall()
        lk = c.execute("SELECT from_id, to_id, kind, weight FROM ln WHERE run = ?", [run]).fetchall()
        smp = c.execute("SELECT coalesce(thing_id, 'gpu0') || ' ' || metric, ts_ns, value FROM sm WHERE run = ? "
                        "ORDER BY ts_ns", [run]).fetchall()
        flows_out, flows_in, share = {}, {}, {}
        for k, (a, b, kind, w) in enumerate(lk, start=1):
            flows_out.setdefault(a, []).append(k)
            flows_in.setdefault(b, []).append(k)
            if kind == "serves":
                share.setdefault(a, []).append((b, w))
        uuids, pk = {}, []
        nxt = iter(range(1, 1 << 40)).__next__

        def lane_track(proc, thr, pid, tid, stream, sub):
            key = (proc, thr, sub)
            if key in uuids:
                return uuids[key]
            if pid is not None and ("p", proc) not in uuids:
                uuids[("p", proc)] = nxt()
                pk.append(track(uuids[("p", proc)], pid=pid, pname=proc))
            u = nxt()
            if sub == 0 and tid is not None and stream is None:
                pk.append(track(u, pid=pid, tid=tid, tname=thr))
            else:
                parent = uuids.get(("p", proc)) if sub == 0 else lane_track(proc, thr, pid, tid, stream, 0)
                label = (thr if pid is not None else f"{proc} / {thr}") + (f" (overlap {sub})" if sub else "")
                pk.append(track(u, name=label, parent=parent))
            uuids[key] = u
            return u

        # pack each lane's events into nested sub-tracks: a slice must nest inside the one open on its track
        stacks, placed, spilled = {}, [], 0
        for e in ev:
            eid, key, kind, src, name, s, en, proc, thr, pid, tid, stream = e[:12]
            en = s if en is None else en
            lane = stacks.setdefault((proc, thr), [])
            sub = 0
            while True:
                if sub == len(lane):
                    lane.append([])
                st = lane[sub]
                while st and st[-1] <= s:
                    st.pop()
                if not st or en <= st[-1]:
                    break
                sub += 1
            if sub:
                spilled += 1
            if kind != "instant" and en > s:
                lane[sub].append(en)
            placed.append((e, lane_track(proc, thr, pid, tid, stream, sub)))
        evts = []
        for e, trk in placed:
            eid, key, kind, src, name, s, en, *_ = e
            ann = [("ie.key", key), ("ie.iteration", e[12]), ("ie.request_id", e[13]), ("ie.correlation", e[14]),
                   ("ie.bytes", e[15]), ("ie.quirk", e[16]), ("ie.code_origin", e[17]), ("ie.code_where", e[18])]
            ann += [(f"ie.share.{b}", w) for b, w in share.get(eid, [])]
            fo, fi = flows_out.get(eid, ()), flows_in.get(eid, ())
            if kind == "instant" or en is None or en == s:
                evts.append((s, 1, 0, tevent(s, 3, trk, name, src, ann, fo, fi)))
            else:
                evts.append((s, 1, -en, tevent(s, 1, trk, name, src, ann, fo, fi)))
                evts.append((en, 0, -s, tevent(en, 2, trk)))
        ctr = {}
        for name, ts, v in smp:
            if name not in ctr:
                ctr[name] = nxt()
                pk.append(track(ctr[name], name=name, counter=True))
            evts.append((ts, 2, 0, tevent(ts, 4, ctr[name]) [:-0] if False else
                         packet(fv(8, ts) + fb(11, fv(9, 4) + fv(11, ctr[name]) + fd(44, v)))))
        evts.sort(key=lambda x: (x[0], x[1], x[2]))
        f = d / f"{run.replace('/', '_')}.pftrace"
        with open(f, "wb") as fh:
            fh.write(packet(fv(13, 1) + fv(87, 1)))  # sequence start: incremental state cleared
            fh.write(b"".join(pk))
            fh.write(b"".join(x[3] for x in evts))
        enc = time.perf_counter() - t0
        t1 = time.perf_counter()
        q = lambda sql: subprocess.run([TP_BIN, "-q", "/dev/stdin", str(f)], input=sql, capture_output=True,
                                       text=True).stdout
        csv = q("""SELECT s.id, s.ts, s.dur, s.depth, s.parent_id, s.track_id,
            extract_arg(s.arg_set_id, 'debug.ie_key') AS key, s.name, s.category,
            extract_arg(s.arg_set_id, 'debug.ie_iteration') AS iteration,
            extract_arg(s.arg_set_id, 'debug.ie_code_origin') AS code_origin,
            coalesce(t.name, th.name) AS track_name, th.tid, p.pid, p.name AS process_name
            FROM slice s JOIN track t ON t.id = s.track_id
            LEFT JOIN thread_track tt ON tt.id = s.track_id LEFT JOIN thread th USING (utid)
            LEFT JOIN track t1 ON t1.id = t.parent_id
            LEFT JOIN thread th1 ON th1.utid = (SELECT utid FROM thread_track WHERE id = t1.id)
            LEFT JOIN process p ON p.upid = coalesce(th.upid, th1.upid, extract_arg(t.dimension_arg_set_id, 'upid'),
                 (SELECT pt.upid FROM process_track pt WHERE pt.id = t.parent_id),
                 (SELECT pt.upid FROM process_track pt WHERE pt.id = t1.parent_id));""")
        shares_csv = q("""SELECT s.id, a.key, a.real_value FROM slice s JOIN args a USING (arg_set_id)
            WHERE a.key GLOB 'debug.ie_share_*';""")
        n_counter = q("SELECT count(*) AS n FROM counter;").strip().splitlines()[-1]
        flows = q("SELECT f.slice_out, f.slice_in FROM flow f;")
        st = q("SELECT name, idx, severity, value FROM stats WHERE value > 0 AND severity IN ('error', 'data_loss');")
        load = time.perf_counter() - t1
        import csv as csvmod
        import io
        nul = lambda v: None if v in ("", "[NULL]") else v
        sl = list(csvmod.reader(io.StringIO(csv)))[1:]
        sid_key = {int(x[0]): x[6] for x in sl}
        for x in sl:
            out_s.append({"run": run, "slice_id": int(x[0]), "ts": int(x[1]), "dur": int(x[2]), "depth": int(x[3]),
                          "parent_slice": int(x[4]) if nul(x[4]) else None, "track_id": int(x[5]), "key": x[6],
                          "name": x[7], "category": x[8], "iteration": int(x[9]) if nul(x[9]) else None,
                          "code_origin": nul(x[10]), "track_name": x[11], "tid": int(x[12]) if nul(x[12]) else None,
                          "pid": int(x[13]) if nul(x[13]) else None, "process_name": nul(x[14])})
        for x in list(csvmod.reader(io.StringIO(shares_csv)))[1:]:
            out_sh.append({"run": run, "slice_id": int(x[0]), "arg": x[1], "value": float(x[2])})
        fl = [tuple(int(v) for v in l.split(",")) for l in flows.strip().splitlines()[1:]]
        for a, b in fl:
            out_f.append({"run": run, "slice_out": a, "slice_in": b, "key_out": sid_key.get(a), "key_in": sid_key.get(b)})
        stats[run] = {"events": len(ev), "slices": len(sl), "flows_written": len(lk), "flows_loaded": len(fl),
                      "spilled_to_overlap_tracks": spilled, "tracks": len(uuids) + len(ctr), "encode_s": round(enc, 1),
                      "counters_written": len(smp), "counters_loaded": int(n_counter),
                      "load_s": round(load, 1), "bytes": f.stat().st_size,
                      "tp_errors": [l for l in st.strip().splitlines()[1:]]}
        print(run, stats[run], flush=True)
    pq.write_table(pa.Table.from_pylist(out_s), d / "slices.parquet", compression="zstd")
    pq.write_table(pa.Table.from_pylist(out_f), d / "flows.parquet", compression="zstd")
    pq.write_table(pa.Table.from_pylist(out_sh), d / "share_args.parquet", compression="zstd")
    (d / "load_stats.json").write_text(json.dumps(stats, indent=1))


BUILD = {"A": build_A, "B": build_B, "C": build_C, "D": build_D}


def main(opts):
    out_p = Path("/mnt/ie-data/cc-v2-proto/bench/d2_builds.json")
    out = json.loads(out_p.read_text()) if out_p.exists() else {}
    for o in opts:
        d = ROOT / o
        d.mkdir(parents=True, exist_ok=True)
        for p in d.glob("*"):
            p.unlink()
        c = con()
        t = time.perf_counter()
        BUILD[o](c, d)
        out[o] = {"build_s": round(time.perf_counter() - t, 1), "bytes": size(d),
                  "files": {p.name: p.stat().st_size for p in sorted(d.glob("*"))}}
        print(o, out[o], flush=True)
    out_p.write_text(json.dumps(out, indent=1))


if __name__ == "__main__":
    main(sys.argv[1:] or ["A", "B", "C", "D"])
