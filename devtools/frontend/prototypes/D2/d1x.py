"""D2 prototype, part 1: the two additions the owner required with D1's option C (throwaway).

1. Per-lane "last event before t" checkpoints, built at import. Rule: a checkpoint time g sits on a fixed grid
   (ORIGIN + k * CP_NS) and exists only where at least one event starts in the grid cell (g - CP_NS, g]. At each
   checkpoint the file holds, for every lane (process, thread) seen so far, the latest event that started at or before
   g ("last" rows), and every span with start <= g <= end ("open" rows). state_at(t) reads one checkpoint, the last
   one at or before t, plus the events that started after it and at or before t. Proof that nothing is missed: an
   event that starts in (g*, t] is read directly; a span active at t that started at or before g* is open at g*.
   Setting: DuckDB's parquet_metadata_cache is on, so a file footer is parsed once, not on every query.
2. Links sorted by to_id, so an inbound link lookup prunes row groups the way the outbound one already did.
   Variant measured beside it: both link files carry the far endpoint's lane, name and start ("denormalized"), so
   a focus needs no join back to the 19 M-row events file.

Files go beside the D1 store, in /mnt/ie-data/cc-v2-proto/d2/c_index/<dataset>/ (the D1 store's events*/links*
globs stay untouched).
Usage: python d1x.py build <dataset>   |   python d1x.py bench <dataset>   -> bench/d1x_<dataset>.json
"""
import bisect
import json
import statistics
import sys
import time
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "D1"))
from bench import digest, norm, targets  # noqa: E402
from stores import NOPROC, ORIGIN, ROW, STORES, DuckStore, make, pick_state  # noqa: E402

CP_NS = 10_000_000  # checkpoint grid: 10 ms (a chosen value: at most 10 ms of events are read past a checkpoint)
IDX = Path("/mnt/ie-data/cc-v2-proto/d2/c_index")
OUT = Path("/mnt/ie-data/cc-v2-proto/bench")


def build(ds):
    d = IDX / ds
    d.mkdir(parents=True, exist_ok=True)
    ev = f"read_parquet('{STORES / ds / 'C_parquet' / 'events.parquet'}')"
    ln = f"read_parquet('{STORES / ds / 'C_parquet' / 'links.parquet'}')"
    con = duckdb.connect()
    con.execute("SET temp_directory='/mnt/ie-data/cc-v2-proto/duckdb_tmp'")
    t0 = time.perf_counter()
    o, c = ORIGIN, CP_NS
    con.execute(f"""CREATE TEMP TABLE e AS SELECT id, source, coalesce(process, '{NOPROC}') AS process, thread, name,
        start_ns, end_ns, {o} + ((start_ns - {o} + {c} - 1) // {c}) * {c} AS g FROM {ev}""")
    con.execute("CREATE TEMP TABLE cps AS SELECT DISTINCT g FROM e")
    con.execute(f"""CREATE TEMP TABLE lc AS SELECT process, thread, g, arg_max({{'id': id, 'source': source, 'process': process, 'thread': thread, 'name': name, 'start_ns': start_ns, 'end_ns': end_ns}}, (start_ns, end_ns)) AS r
        FROM e GROUP BY process, thread, g""")
    con.execute(f"""COPY (
        SELECT cps.g AS cp_ns, 'last' AS kind, lc.r.id AS id, lc.r.source AS source, lc.r.process AS process,
               lc.r.thread AS thread, lc.r.name AS name, lc.r.start_ns AS start_ns, lc.r.end_ns AS end_ns
          FROM (SELECT DISTINCT process, thread FROM lc) lanes CROSS JOIN cps
          ASOF JOIN lc ON lc.process = lanes.process AND lc.thread = lanes.thread AND cps.g >= lc.g
        UNION ALL
        SELECT cps.g, 'open', e.id, e.source, e.process, e.thread, e.name, e.start_ns, e.end_ns
          FROM e JOIN cps ON cps.g >= e.start_ns AND cps.g <= e.end_ns WHERE e.end_ns > e.start_ns
        ORDER BY cp_ns) TO '{d}/checkpoints.parquet' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 20000)""")
    t_cp = time.perf_counter() - t0
    t0 = time.perf_counter()
    con.execute(f"COPY (SELECT * FROM {ln} ORDER BY to_id) TO '{d}/links_to.parquet' "
                f"(FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)")
    t_lt = time.perf_counter() - t0
    t0 = time.perf_counter()
    end = "o.process AS o_process, o.thread AS o_thread, o.name AS o_name, o.start_ns AS o_start"
    con.execute(f"""COPY (SELECT l.from_id, l.to_id, l.kind, {end} FROM {ln} l JOIN e o ON o.id = l.to_id
        ORDER BY l.from_id) TO '{d}/links_from_denorm.parquet' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)""")
    con.execute(f"""COPY (SELECT l.from_id, l.to_id, l.kind, {end} FROM {ln} l JOIN e o ON o.id = l.from_id
        ORDER BY l.to_id) TO '{d}/links_to_denorm.parquet' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)""")
    t_dn = time.perf_counter() - t0
    n_cp = con.execute(f"SELECT count(*), count(DISTINCT cp_ns), sum((kind = 'open')::INT) "
                       f"FROM read_parquet('{d}/checkpoints.parquet')").fetchone()
    out = {"dataset": ds, "cp_ns": CP_NS, "build_s": {"checkpoints": round(t_cp, 2), "links_to": round(t_lt, 2),
                                                       "links_denorm": round(t_dn, 2)},
           "checkpoint_rows": n_cp[0], "checkpoint_times": n_cp[1], "open_rows": n_cp[2],
           "bytes": {p.name: p.stat().st_size for p in d.glob("*.parquet")}}
    (d / "build.json").write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))


class DuckStore2(DuckStore):
    """D1's option C plus the checkpoints and the to_id-sorted links."""
    name = "C+"

    def open(self, denorm=False):
        super().open()
        self.con.execute("SET parquet_metadata_cache=true")  # keep each file's footer parsed between queries
        d = IDX / self.dataset
        self.cp = f"read_parquet('{d}/checkpoints.parquet')"
        self.cps = [r[0] for r in self.con.execute(f"SELECT DISTINCT cp_ns FROM {self.cp} ORDER BY 1").fetchall()]
        self.lt = f"read_parquet('{d}/links_to.parquet')"
        self.denorm = denorm
        self.ldf, self.ldt = (f"read_parquet('{d}/links_from_denorm.parquet')",
                              f"read_parquet('{d}/links_to_denorm.parquet')")
        return self

    def state_at(self, t):
        i = bisect.bisect_right(self.cps, t) - 1
        g = self.cps[i] if i >= 0 else ORIGIN - 1
        snap = self.rows(f"SELECT kind, id, source, process, thread, name, start_ns, end_ns FROM {self.cp} "
                         f"WHERE cp_ns = ?", [g]) if i >= 0 else []
        delta = self.rows(f"SELECT {ROW} FROM events WHERE start_ns > ? AND start_ns <= ?", [g, t])
        delta = [(r[0], r[1], r[2] or NOPROC, *r[3:]) for r in delta]
        active = [r[1:] for r in snap if r[0] == "open" and r[7] >= t] + [r for r in delta if r[6] >= t]
        latest = {}
        for r in [r[1:] for r in snap if r[0] == "last"] + delta:
            k = (r[2], r[3])
            if k not in latest or (r[5], r[6]) > (latest[k][5], latest[k][6]):
                latest[k] = r
        return pick_state(active, latest)

    def focus(self, t0, t1, process, thread=None):
        inside = self.window(t0, t1, process=process, thread=thread)
        if not inside:
            return inside, []
        ids = [r[0] for r in inside]
        self.temp_ids(ids)
        lo, hi = min(ids), max(ids)
        same = "o.process = ?" + (" AND o.thread = ?" if thread is not None else "")
        key = [process] + ([thread] if thread is not None else [])
        if self.denorm:
            q = lambda f, col: (f"SELECT l.from_id, l.to_id, l.kind, l.o_process, l.o_thread, l.o_name, l.o_start "
                                f"FROM focus_ids f JOIN {f} l ON l.{col} = f.id AND l.{col} BETWEEN {lo} AND {hi} "
                                f"WHERE NOT ({same.replace('o.', 'l.o_')})")
            return inside, self.rows(q(self.ldf, "from_id") + " UNION ALL " + q(self.ldt, "to_id"), key + key)
        sql = (f"SELECT l.from_id, l.to_id, l.kind, o.process, o.thread, o.name, o.start_ns FROM focus_ids f "
               f"JOIN links l ON l.from_id = f.id AND l.from_id BETWEEN {lo} AND {hi} JOIN events o ON o.id = l.to_id "
               f"WHERE NOT ({same}) UNION ALL "
               f"SELECT l.from_id, l.to_id, l.kind, o.process, o.thread, o.name, o.start_ns FROM focus_ids f "
               f"JOIN {self.lt} l ON l.to_id = f.id AND l.to_id BETWEEN {lo} AND {hi} JOIN events o ON o.id = l.from_id "
               f"WHERE NOT ({same})")
        return inside, self.rows(sql, key + key)


def timed(fn, n=20, budget=30.0):
    xs, res, s = [], None, time.perf_counter()
    while len(xs) < n and (len(xs) < 3 or time.perf_counter() - s < budget):
        a = time.perf_counter()
        res = fn()
        xs.append((time.perf_counter() - a) * 1000)
    return res, {"median_ms": round(statistics.median(xs), 3), "min_ms": round(min(xs), 3),
                 "max_ms": round(max(xs), 3), "n": len(xs)}


def scrub(store, t0, t1, steps=200):
    """A cursor dragged across [t0, t1]: one state_at per step, each timed once (warm file cache)."""
    xs = []
    for k in range(steps):
        t = t0 + (t1 - t0) * k // (steps - 1)
        a = time.perf_counter()
        store.state_at(t)
        xs.append((time.perf_counter() - a) * 1000)
    xs.sort()
    return {"median_ms": round(statistics.median(xs), 3), "p95_ms": round(xs[int(0.95 * len(xs)) - 1], 3),
            "max_ms": round(xs[-1], 3), "min_ms": round(xs[0], 3), "n": steps}


def bench(ds):
    t = targets(ds)
    before = make("C", ds).open()
    cached = make("C", ds).open()
    cached.con.execute("SET parquet_metadata_cache=true")
    after = DuckStore2(ds)
    after.dataset = ds
    after.open()
    dn = DuckStore2(ds)
    dn.dataset = ds
    dn.open(denorm=True)
    out = {"dataset": ds, "queries": {}, "match": {}}
    cases = {"state_at": lambda s: s.state_at(t["state_t"]),
             "focus_thread": lambda s: s.focus(*t["iteration66"], t["proc"], t["thread"])}
    if ds == "real":
        ct = t["components"]
        cases["state_at_components"] = lambda s: s.state_at(ct["state_t"])
        cases["focus_process_components"] = lambda s: s.focus(*ct["handoff"], "server pid 304")
    for name, fn in cases.items():
        q = {}
        dg = {}
        for label, s in (("before (D1 C)", before), ("D1 C + metadata cache", cached), ("after", after),
                         ("after, denormalized links", dn)):
            if name.startswith("state") and label.endswith("denormalized links"):
                continue
            res, q[label] = timed(lambda: fn(s))
            dg[label] = digest(norm("focus" if name.startswith("focus") else "state_at", res))
            print(ds, name, label, q[label], dg[label], flush=True)
        out["queries"][name] = q
        out["match"][name] = len(set(dg.values())) == 1
        out.setdefault("digests", {})[name] = dg
    r0, r1 = t["request"]
    out["scrub_request"] = {"window": [r0, r1], "before (D1 C)": scrub(before, r0, r1, 200 if ds == "real" else 60),
                            "D1 C + metadata cache": scrub(cached, r0, r1, 200 if ds == "real" else 60),
                            "after": scrub(after, r0, r1, 200)}
    print(ds, "scrub", out["scrub_request"], flush=True)
    # every scrub position must give the same state as the D1 query
    mism = sum(digest(norm("state_at", before.state_at(x))) != digest(norm("state_at", after.state_at(x)))
               for x in [r0 + (r1 - r0) * k // 39 for k in range(40)])
    out["scrub_mismatches_of_40"] = mism
    out["build"] = json.loads((IDX / ds / "build.json").read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"d1x_{ds}.json").write_text(json.dumps(out, indent=1))
    print("mismatches", mism)


if __name__ == "__main__":
    {"build": build, "bench": bench}[sys.argv[1]](sys.argv[2])
