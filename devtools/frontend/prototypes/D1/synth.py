"""D1 prototype: SYNTHETIC scale set. Tests storage and query scale only, never mechanism.

Rule (printed on every run):
  1. Template: every event of the real timeline run (full Nsight import + run.json) whose start lies in
     [T0, T0 + D), where T0 = the measured request's client send and D = the end of the last kernel, copy or memset
     attributed to that request minus T0, rounded up to 1 ms. Samples: every timeline-run sample in the same window.
     The 9.4 s between the last decode iteration and the final token event in that run (cause not established;
     Inferred: the profiler stopping after iteration 129) is outside the template.
  2. Requests k = 0..499 at concurrency 8: slot = k mod 8, wave = k div 8, offset_k = wave * D + slot * D / 8.
     Request k is the template shifted by offset_k. Its tracks are prefixed "syn/slot<slot>/" (so eight copies never
     share a thread or stream) and its processes "syn/slot<slot>/<process>", request_id = "syn-<k>", iteration = 1000 * k + template iteration.
  3. Links: every real link whose two ends are both template events is copied into each request.
  4. Samples: the template window's samples tiled every D from T0 until the last request ends, on "syn/gpu0/...".
  5. Every record has synthetic = true and run = "SYNTHETIC-I02A-x500-c8".

Usage: python synth.py -> /mnt/ie-data/cc-v2-proto/canonical/synthetic_{events,samples}.parquet (sorted by time)
"""
import json
import time
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from canonical import EVENT_SCHEMA, LINK_SCHEMA, OUT, TIMELINE

RUN = "SYNTHETIC-I02A-x500-c8"
N, CONC = 500, 8


def main():
    t = time.perf_counter()
    ev = pq.read_table(OUT / "real_events.parquet")
    sm = pq.read_table(OUT / "real_samples.parquet")
    ev = ev.filter(pc.equal(ev["run"], TIMELINE))
    sm = sm.filter(pc.equal(sm["run"], TIMELINE))
    measured = f"{TIMELINE}-measured"
    t0 = ev.filter(pc.and_(pc.equal(ev["request_id"], measured), pc.equal(ev["name"], "send")))["start_ns"][0].as_py()
    gpu = ev.filter(pc.and_(pc.equal(ev["request_id"], measured),
                            pc.is_in(ev["source"], pa.array(["kernel", "memcpy", "memset"]))))
    d = -(-(pc.max(gpu["end_ns"]).as_py() - t0) // 1_000_000) * 1_000_000
    tpl = ev.filter(pc.and_(pc.greater_equal(ev["start_ns"], t0), pc.less(ev["start_ns"], t0 + d)))
    stpl = sm.filter(pc.and_(pc.greater_equal(sm["ts_ns"], t0), pc.less(sm["ts_ns"], t0 + d)))
    ln = pq.read_table(OUT / "real_links.parquet")
    pos = {eid: i for i, eid in enumerate(tpl["id"].to_pylist())}
    tl = [(pos[a], pos[b], k) for a, b, k in zip(*(ln[c].to_pylist() for c in ("from_id", "to_id", "kind")))
          if a in pos and b in pos]
    last_offset = ((N - 1) // CONC) * d + ((N - 1) % CONC) * d // CONC
    tiles = -(-(last_offset + d) // d)
    rule = {"run": RUN, "T0_ns": t0, "D_ns": d, "requests": N, "concurrency": CONC,
            "offset_k": "(k // 8) * D + (k % 8) * D / 8", "template_events": tpl.num_rows,
            "template_samples": stpl.num_rows, "template_links": len(tl), "links": N * len(tl), "sample_tiles": tiles,
            "events": N * tpl.num_rows, "samples": tiles * stpl.num_rows,
            "duration_s": round((last_offset + d) / 1e9, 3)}
    print(__doc__.split("Usage")[0])
    print(json.dumps(rule, indent=1))

    tmp = OUT / "synthetic_events_unsorted.parquet"
    with pq.ParquetWriter(tmp, EVENT_SCHEMA) as w:
        n = tpl.num_rows
        for k in range(N):
            off = (k // CONC) * d + (k % CONC) * d // CONC
            slot = k % CONC
            w.write_table(pa.table({
                "id": pa.array(range(10**9 + k * n, 10**9 + (k + 1) * n), pa.int64()),
                "run": pa.array([RUN] * n), "kind": tpl["kind"], "source": tpl["source"],
                "track": pc.binary_join_element_wise(f"syn/slot{slot}", tpl["track"], "/"),
                "name": tpl["name"], "start_ns": pc.add(tpl["start_ns"], off), "end_ns": pc.add(tpl["end_ns"], off),
                "corr": tpl["corr"], "request_id": pa.array([f"syn-{k:03d}"] * n),
                "iteration": pc.add(tpl["iteration"], 1000 * k), "synthetic": pa.array([True] * n),
                "args": tpl["args"],
                "process": pc.binary_join_element_wise(f"syn/slot{slot}", tpl["process"], "/"),
                **{c: tpl[c] for c in ("thread", "pid", "host_pid", "pname", "tid", "kthread", "pythread", "bytes")}},
                schema=EVENT_SCHEMA))
    with pq.ParquetWriter(OUT / "synthetic_links.parquet", LINK_SCHEMA) as w:
        base = [10**9 + k * tpl.num_rows for k in range(N)]
        w.write_table(pa.table({"run": [RUN] * (N * len(tl)),
                                "from_id": [b + a for b in base for a, _, _ in tl],
                                "to_id": [b + x for b in base for _, x, _ in tl],
                                "kind": [k for _ in base for _, _, k in tl],
                                "rule": ["synthetic copy of a real link"] * (N * len(tl)),
                                "synthetic": [True] * (N * len(tl))}, schema=LINK_SCHEMA))
    stmp = OUT / "synthetic_samples_unsorted.parquet"
    with pq.ParquetWriter(stmp, sm.schema) as w:
        for i in range(tiles):
            w.write_table(pa.table({"run": pa.array([RUN] * stpl.num_rows),
                                    "track": pc.binary_join_element_wise("syn", stpl["track"], "/"),
                                    "metric": stpl["metric"], "ts_ns": pc.add(stpl["ts_ns"], i * d),
                                    "value": stpl["value"], "synthetic": pa.array([True] * stpl.num_rows)},
                                   schema=sm.schema))
    con = duckdb.connect()
    con.execute("SET temp_directory='/mnt/ie-data/cc-v2-proto/duckdb_tmp'")
    con.execute(f"COPY (SELECT * FROM read_parquet('{tmp}') ORDER BY start_ns) TO '{OUT}/synthetic_events.parquet'")
    con.execute(f"COPY (SELECT * FROM read_parquet('{stmp}') ORDER BY ts_ns) TO '{OUT}/synthetic_samples.parquet'")
    tmp.unlink()
    stmp.unlink()
    rule["seconds"] = round(time.perf_counter() - t, 1)
    (OUT / "synthetic_rule.json").write_text(json.dumps(rule, indent=1))
    print(f"wrote {rule['events']:,} synthetic events and {rule['samples']:,} synthetic samples "
          f"in {rule['seconds']} s")


if __name__ == "__main__" and "--subset" not in __import__("sys").argv:
    main()


def subset(n=50):
    """synthetic10: the first n synthetic requests (k < n), their links, and the samples up to their end. Labeled
    synthetic; used where the full set cannot be loaded (option A holds the whole file in memory)."""
    rule = json.loads((OUT / "synthetic_rule.json").read_text())
    d, t0 = rule["D_ns"], rule["T0_ns"]
    end = t0 + ((n - 1) // CONC) * d + ((n - 1) % CONC) * d // CONC + d
    con = duckdb.connect()
    con.execute(f"COPY (SELECT * FROM read_parquet('{OUT}/synthetic_events.parquet') WHERE request_id < 'syn-{n:03d}'"
                f" ORDER BY start_ns) TO '{OUT}/synthetic10_events.parquet'")
    con.execute(f"COPY (SELECT * FROM read_parquet('{OUT}/synthetic_links.parquet') WHERE from_id < "
                f"{10**9 + n * rule['template_events']}) TO '{OUT}/synthetic10_links.parquet'")
    con.execute(f"COPY (SELECT * FROM read_parquet('{OUT}/synthetic_samples.parquet') WHERE ts_ns < {end}) "
                f"TO '{OUT}/synthetic10_samples.parquet'")
    counts = {k: con.execute(f"SELECT count(*) FROM '{OUT}/synthetic10_{k}.parquet'").fetchone()[0]
              for k in ("events", "links", "samples")}
    print(f"synthetic10 = first {n} synthetic requests:", counts)
    (OUT / "synthetic10_rule.json").write_text(json.dumps({"requests": n, **counts}))


if __name__ == "__main__" and "--subset" in __import__("sys").argv:
    subset()
