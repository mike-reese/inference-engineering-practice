"""D2 prototype: coverage and model-level queries for each option, on DuckDB over the option's Parquet files.

Coverage (Observed counts): events kept, events with a process identity (a PID), events with a parent, links kept
with their endpoints, links that keep their rule/evidence, iteration shares, samples, profile rows, things.
Queries (median of up to 20 repeats, warm file cache), each checked against option B's answer:
  lanes    the timeline run's iteration-66 window grouped by process and thread (row count, lane count)
  chain    code run, iteration 70: every kernel with its launch call, the CPU op around the launch, model/engine code
  shares   fixture (SYNTHETIC): kernel time per request through the iteration shares; expected from fixtures.py
  ref      results file -> event: resolve the key of the measured run's first token event, return its start time
  graph    timeline run, iteration 70: CUDA graph launches -> node kernels, with graph id and batch size
Output: /mnt/ie-data/cc-v2-proto/bench/d2_bench.json
"""
import json
import statistics
import time
from pathlib import Path

import duckdb

ROOT = Path("/mnt/ie-data/cc-v2-proto/d2")
NEU = ROOT / "neutral"
TL = "I02A-TRACE-timeline_20261103T185837Z_e08b8b"
CODE = "I02A-TRACE-code_20261103T170709Z_0ac2db"
MAIN = "I02A_20261103T164324Z_348959"
KEY = f"{MAIN}-measured/client/event/1"
FIXR = "fixture/shares"


def timed(fn, n=20, budget=20.0):
    xs, res, s = [], None, time.perf_counter()
    while len(xs) < n and (len(xs) < 3 or time.perf_counter() - s < budget):
        a = time.perf_counter()
        res = fn()
        xs.append((time.perf_counter() - a) * 1000)
    return res, {"median_ms": round(statistics.median(xs), 3), "min_ms": round(min(xs), 3),
                 "max_ms": round(max(xs), 3), "n": len(xs)}


def views(c, o):
    d = ROOT / o
    for p in d.glob("*.parquet"):
        c.execute(f"CREATE VIEW {o}_{p.stem} AS SELECT * FROM read_parquet('{p}')")


def main():
    c = duckdb.connect()
    c.execute("SET parquet_metadata_cache=true")
    for o in "ABCD":
        views(c, o)
    it66 = c.execute(f"""SELECT start_ns, end_ns FROM B_events WHERE run = '{TL}' AND category = 'nvtx'
        AND name LIKE '[Executor] _forward_step 65:%'""").fetchone()
    off = json.loads((ROOT / "D" / "clock_offsets.json").read_text())
    out = {"coverage": {}, "queries": {}}
    n = c.execute("SELECT count(*), count(pid), count(parent_id) FROM read_parquet('" + str(NEU) +
                  "/events.parquet')").fetchone()
    nf = c.execute(f"SELECT count(*), count(pid), count(parent_id) FROM read_parquet('{ROOT}/fixtures/shares_events.parquet')").fetchone()
    nl = c.execute(f"SELECT (SELECT count(*) FROM read_parquet('{NEU}/links.parquet')) + "
                   f"(SELECT count(*) FROM read_parquet('{ROOT}/fixtures/shares_links.parquet'))").fetchone()[0]
    out["neutral"] = {"events": n[0] + nf[0], "with_pid": n[1] + nf[1], "with_parent": n[2] + nf[2], "links": nl}
    cov = out["coverage"]
    cov["A"] = dict(zip(["events", "with_pid", "with_parent", "links", "links_with_rule", "shares", "samples"],
        c.execute("""SELECT count(*) FILTER (name <> 'sample'),
            count(*) FILTER (name <> 'sample' AND json_extract_string(attrs, '$.pid') IS NOT NULL),
            count(*) FILTER (json_extract_string(attrs, '$.parent') IS NOT NULL),
            sum(coalesce(json_array_length(attrs->'links'), 0)),
            sum(coalesce(json_array_length(json_extract(attrs, '$.links[*].rule')), 0)),
            sum(coalesce(json_array_length(attrs->'requests'), 0)),
            sum(CASE WHEN name = 'sample' THEN len(json_keys(attrs)) ELSE 0 END) FROM A_spans""").fetchone()))
    cov["A"].update(profiles=c.execute("SELECT count(*) FROM A_profiles").fetchone()[0],
                    things="topology document per run (JSON); no thing ids on spans")
    cov["B"] = dict(zip(["events", "with_pid", "with_parent", "links", "links_with_rule", "shares", "samples"],
        c.execute("""SELECT (SELECT count(*) FROM B_events),
            (SELECT count(*) FROM B_events e JOIN B_things t ON t.id = e.thing_id
               JOIN B_things p ON p.id = coalesce(json_extract_string(t.attrs, '$.owner_process'), t.parent_id)
               WHERE json_extract(p.attrs, '$.container_pid') IS NOT NULL
                 AND json_extract(p.attrs, '$.container_pid') <> 'null'),
            (SELECT count(parent_id) FROM B_events), (SELECT count(*) FROM B_links),
            (SELECT count(rule) FROM B_links), (SELECT count(weight) FROM B_links),
            (SELECT count(*) FROM B_samples)""").fetchone()))
    cov["B"].update(profiles=c.execute("SELECT count(*) FROM B_profiles").fetchone()[0],
                    things=c.execute("SELECT count(*) FROM B_things").fetchone()[0])
    cst = json.loads((ROOT / "C" / "load_stats.json").read_text())
    cov["C"] = dict(zip(["events", "with_pid", "with_parent"],
        c.execute("SELECT count(*), count(pid), count(parent_slice) FROM C_slices").fetchone()))
    agree = c.execute(f"""WITH ne AS (SELECT e.key, p.key AS pkey FROM (SELECT *, coalesce(json_extract_string(args,
            '$.span_id'), source || '/' || id) AS key FROM read_parquet('{NEU}/events.parquet')) e
            LEFT JOIN (SELECT id, coalesce(json_extract_string(args, '$.span_id'), source || '/' || id) AS key
                       FROM read_parquet('{NEU}/events.parquet')) p ON p.id = e.parent_id)
        SELECT count(*) FILTER (ne.pkey IS NOT NULL AND ne.pkey = ps.key),
               count(*) FILTER (ne.pkey IS NOT NULL AND ps.key IS NULL),
               count(*) FILTER (ne.pkey IS NOT NULL AND ps.key IS NOT NULL AND ne.pkey <> ps.key)
        FROM C_slices s JOIN ne ON ne.key = s.key LEFT JOIN C_slices ps ON ps.run = s.run AND ps.slice_id = s.parent_slice
        """).fetchone()
    exact = c.execute(f"""WITH nl AS (SELECT a.key AS ka, b.key AS kb FROM (SELECT from_id, to_id FROM
            read_parquet('{NEU}/links.parquet') UNION ALL SELECT from_id, to_id FROM
            read_parquet('{ROOT}/fixtures/shares_links.parquet')) l
          JOIN (SELECT id, coalesce(json_extract_string(args, '$.span_id'), source || '/' || id) AS key FROM
                read_parquet('{NEU}/events.parquet') UNION ALL SELECT id, source || '/' || id FROM
                read_parquet('{ROOT}/fixtures/shares_events.parquet')) a ON a.id = l.from_id
          JOIN (SELECT id, coalesce(json_extract_string(args, '$.span_id'), source || '/' || id) AS key FROM
                read_parquet('{NEU}/events.parquet') UNION ALL SELECT id, source || '/' || id FROM
                read_parquet('{ROOT}/fixtures/shares_events.parquet')) b ON b.id = l.to_id)
        SELECT count(*) FROM C_flows f SEMI JOIN nl ON nl.ka = f.key_out AND nl.kb = f.key_in""").fetchone()[0]
    cov["C"].update(parent_agrees_with_neutral=agree[0], parent_missing=agree[1], parent_differs=agree[2],
                    links=sum(v["flows_loaded"] for v in cst.values()), links_exact=exact, links_with_rule=0,
                    shares=c.execute("SELECT count(*) FROM C_share_args").fetchone()[0],
                    samples=sum(v["counters_loaded"] for v in cst.values()), profiles=0,
                    spilled_to_overlap_tracks=sum(v["spilled_to_overlap_tracks"] for v in cst.values()),
                    tp_errors={k: v["tp_errors"] for k, v in cst.items() if v["tp_errors"]},
                    things="track tree only (names, no typed attributes)")
    cov["D"] = dict(zip(["events", "with_pid", "with_parent", "links", "links_with_rule", "shares", "samples"],
        c.execute("""SELECT (SELECT count(*) FROM D_spans),
            (SELECT count(*) FROM D_spans s JOIN D_resources r USING (resource_id)
               WHERE json_extract(r.attributes, '$."process.pid"') IS NOT NULL
                 AND json_extract(r.attributes, '$."process.pid"') <> 'null'),
            (SELECT count(parent_span_id) FROM D_spans),
            (SELECT sum(coalesce(len(links), 0)) FROM D_spans),
            (SELECT count(*) FROM (SELECT unnest(links) AS l FROM D_spans) WHERE l.attributes."ie.link.rule" IS NOT NULL),
            (SELECT count(*) FROM (SELECT unnest(links) AS l FROM D_spans) WHERE l.attributes."ie.share" IS NOT NULL),
            (SELECT count(*) FROM D_metrics)""").fetchone()))
    cov["D"].update(profiles=0, things=c.execute("SELECT count(*) FROM D_hw_resources").fetchone()[0])
    print(json.dumps(cov, indent=1, default=str), flush=True)

    # ------------------------------------------------------------ queries
    t0, t1 = it66
    o = off[TL]
    Q = {
        "lanes": {
            "A": lambda: c.execute(f"""SELECT attrs->>'process' p, attrs->>'thread' t, count(*) FROM A_spans WHERE run = '{TL}'
                AND name <> 'sample' AND start_ns <= {t1} AND coalesce(end_ns, start_ns) >= {t0} GROUP BY 1, 2""").fetchall(),
            "B": lambda: c.execute(f"""SELECT p.name, t.name, count(*) FROM B_events e JOIN B_things t ON t.id = e.thing_id
                JOIN B_things p ON p.id = coalesce(json_extract_string(t.attrs, '$.owner_process'), t.parent_id)
                WHERE e.run = '{TL}' AND e.start_ns <= {t1} AND coalesce(e.end_ns, e.start_ns) >= {t0} GROUP BY 1, 2""").fetchall(),
            "C": lambda: c.execute(f"""SELECT coalesce(process_name, '?'), track_name, count(*) FROM C_slices WHERE run = '{TL}'
                AND ts <= {t1} AND ts + greatest(dur, 0) >= {t0} GROUP BY 1, 2""").fetchall(),
            "D": lambda: c.execute(f"""SELECT resource_id || ' ' || coalesce(attributes->>'thread.id', '') || ' ' || coalesce(attributes->>'thread.name', ''), count(*) AS n0, count(*) FROM D_spans WHERE run = '{TL}'
                AND start_time_unix_nano <= {t1 + o} AND end_time_unix_nano >= {t0 + o} GROUP BY 1""").fetchall()},
        "chain": {
            "A": lambda: c.execute(f"""WITH l AS (SELECT la.id AS lid, la.name AS lname, la.attrs->>'parent' AS op,
                    unnest(json_extract_string(la.attrs, '$.links[*].to')) AS kid FROM A_spans la
                    WHERE la.run = '{CODE}' AND la.component IN ('cuda_runtime', 'cuda_driver')
                      AND (la.attrs->>'iteration')::INT = 70)
                SELECT k.name, l.lname, op.name, k.attrs->>'code_origin' FROM l JOIN A_spans k ON k.id = l.kid
                LEFT JOIN A_spans op ON op.id = l.op WHERE k.component = 'gpu'""").fetchall(),
            "B": lambda: c.execute(f"""SELECT k.name, la.name, op.name, k.code_origin FROM B_events k
                JOIN B_links l ON l.to_id = k.id JOIN B_events la ON la.id = l.from_id
                LEFT JOIN B_events op ON op.id = la.parent_id
                WHERE k.run = '{CODE}' AND k.category = 'kernel' AND k.iteration = 70""").fetchall(),
            "C": lambda: c.execute(f"""SELECT k.name, la.name, op.name, k.code_origin FROM C_slices k
                JOIN C_flows f ON f.run = k.run AND f.slice_in = k.slice_id
                JOIN C_slices la ON la.run = k.run AND la.slice_id = f.slice_out
                LEFT JOIN C_slices op ON op.run = k.run AND op.slice_id = la.parent_slice
                WHERE k.run = '{CODE}' AND k.category = 'kernel' AND k.iteration = 70""").fetchall(),
            "D": lambda: c.execute(f"""WITH k AS (SELECT name, attributes->>'ie.code_origin' AS co, unnest(links) AS l
                    FROM D_spans WHERE run = '{CODE}' AND scope_name = 'kernel' AND (attributes->>'ie.iteration')::INT = 70)
                SELECT k.name, la.name, op.name, k.co FROM k JOIN D_spans la ON la.span_id = k.l.span_id
                LEFT JOIN D_spans op ON op.span_id = la.parent_span_id""").fetchall()},
        "shares": {
            "A": lambda: c.execute(f"""WITH it AS (SELECT (attrs->>'iteration')::INT AS i,
                    unnest(json_extract_string(attrs, '$.requests[*].request_id')) AS r,
                    unnest(json_extract(attrs, '$.requests[*].share')::DOUBLE[]) AS w FROM A_spans
                    WHERE run = '{FIXR}' AND json_extract(attrs, '$.requests') IS NOT NULL
                      AND json_extract_string(attrs, '$.requests') <> 'null'),
                k AS (SELECT (attrs->>'iteration')::INT AS i, sum(end_ns - start_ns) AS ns FROM A_spans
                    WHERE run = '{FIXR}' AND component = 'gpu' AND name <> 'sample' AND id LIKE 'kernel/%' GROUP BY 1)
                SELECT r, sum(ns * w) FROM it JOIN k USING (i) GROUP BY r ORDER BY r""").fetchall(),
            "B": lambda: c.execute(f"""WITH k AS (SELECT iteration, sum(end_ns - start_ns) AS ns FROM B_events
                    WHERE run = '{FIXR}' AND category = 'kernel' GROUP BY 1)
                SELECT r.request_id, sum(k.ns * s.weight) FROM B_links s JOIN B_events it ON it.id = s.from_id
                JOIN B_events r ON r.id = s.to_id JOIN k ON k.iteration = it.iteration
                WHERE s.kind = 'serves' GROUP BY 1 ORDER BY 1""").fetchall(),
            "C": lambda: c.execute(f"""WITH k AS (SELECT iteration, sum(dur) AS ns FROM C_slices
                    WHERE run = '{FIXR}' AND category = 'kernel' GROUP BY 1)
                SELECT r.name, sum(k.ns * a.value) FROM C_share_args a
                JOIN C_slices it ON it.run = a.run AND it.slice_id = a.slice_id
                JOIN C_slices r ON r.run = a.run AND r.key = 'request/' || split_part(a.arg, '_', 3)
                JOIN k ON k.iteration = it.iteration WHERE a.run = '{FIXR}' GROUP BY 1 ORDER BY 1""").fetchall(),
            "D": lambda: c.execute(f"""WITH it AS (SELECT (attributes->>'ie.iteration')::INT AS i, unnest(links) AS l
                    FROM D_spans WHERE run = '{FIXR}'),
                k AS (SELECT (attributes->>'ie.iteration')::INT AS i, sum(end_time_unix_nano - start_time_unix_nano) AS ns
                    FROM D_spans WHERE run = '{FIXR}' AND scope_name = 'kernel' GROUP BY 1)
                SELECT r.attributes->>'ie.request_id', sum(k.ns * it.l.attributes."ie.share") FROM it
                JOIN D_spans r ON r.span_id = it.l.span_id JOIN k USING (i)
                WHERE it.l.attributes."ie.link.kind" = 'serves' GROUP BY 1 ORDER BY 1""").fetchall()},
        "ref": {
            "A": lambda: c.execute(f"SELECT start_ns FROM A_spans WHERE id = '{KEY}'").fetchall(),
            "B": lambda: c.execute(f"SELECT start_ns FROM B_events WHERE key = '{KEY}'").fetchall(),
            "C": lambda: c.execute(f"SELECT ts FROM C_slices WHERE key = '{KEY}'").fetchall(),
            "D": lambda: c.execute(f"""SELECT start_time_unix_nano - {off[MAIN]} FROM D_spans
                WHERE attributes->>'ie.key' = '{KEY}'""").fetchall()},
        "graph": {
            "A": lambda: c.execute(f"""WITH l AS (SELECT la.id, unnest(json_extract_string(la.attrs, '$.links[*].to')) AS kid
                    FROM A_spans la WHERE la.run = '{TL}' AND la.name LIKE 'cudaGraphLaunch%' AND (la.attrs->>'iteration')::INT = 70)
                SELECT l.id, (k.attrs->>'graph')::INT, count(*) FROM l JOIN A_spans k ON k.id = l.kid GROUP BY 1, 2""").fetchall(),
            "B": lambda: c.execute(f"""SELECT la.id, json_extract(k.args, '$.graph')::INT AS g, count(*),
                    any_value(json_extract(t.attrs, '$.batch_size')) FROM B_events la JOIN B_links l ON l.from_id = la.id
                JOIN B_events k ON k.id = l.to_id
                LEFT JOIN B_things t ON t.id = la.run || '|gpu0|graph ' || json_extract(k.args, '$.graph')::INT
                WHERE la.run = '{TL}' AND la.name LIKE 'cudaGraphLaunch%' AND la.iteration = 70 GROUP BY 1, 2""").fetchall(),
            "C": lambda: c.execute(f"""SELECT la.slice_id, count(*) FROM C_slices la JOIN C_flows f ON f.run = la.run
                AND f.slice_out = la.slice_id WHERE la.run = '{TL}' AND la.name LIKE 'cudaGraphLaunch%'
                AND la.iteration = 70 GROUP BY 1""").fetchall(),
            "D": lambda: c.execute(f"""WITH k AS (SELECT unnest(links) AS l FROM D_spans WHERE run = '{TL}' AND scope_name = 'kernel')
                SELECT la.span_id, count(*) FROM k JOIN D_spans la ON la.span_id = k.l.span_id
                WHERE la.name LIKE 'cudaGraphLaunch%' AND (la.attributes->>'ie.iteration')::INT = 70 GROUP BY 1""").fetchall()},
    }
    exp = json.loads((ROOT / "fixtures" / "expected.json").read_text())

    def summary(name, res):
        if name == "lanes":
            return {"rows": sum(r[2] for r in res), "lanes": len(res)}
        if name == "chain":
            org = {}
            for r in res:
                org[r[3]] = org.get(r[3], 0) + 1
            return {"kernels": len(res), "with_op": sum(r[2] is not None for r in res), "origin": org}
        if name == "shares":
            return {"by_request_ns": [round(float(r[1])) for r in res],
                    "expected_ns": [round(v) for v in exp["kernel_ns_by_request"].values()]}
        if name == "ref":
            return {"start_ns": res[0][0] if res else None}
        if name == "graph":
            return {"launches": len(res), "kernels": [r[2] if len(r) > 2 else r[1] for r in res],
                    "graph_and_batch": [list(r[1:2]) + list(r[3:]) for r in res] if res and len(res[0]) > 2 else None}

    for name, per in Q.items():
        out["queries"][name] = {}
        for opt, fn in per.items():
            try:
                res, tm = timed(fn)
                out["queries"][name][opt] = {**tm, "result": summary(name, res)}
            except Exception as e:  # noqa: BLE001 - the failure is the observation
                out["queries"][name][opt] = {"error": f"{type(e).__name__}: {str(e)[:300]}"}
            print(name, opt, out["queries"][name][opt], flush=True)
    Path("/mnt/ie-data/cc-v2-proto/bench/d2_bench.json").write_text(json.dumps(out, indent=1, default=str))


if __name__ == "__main__":
    main()
