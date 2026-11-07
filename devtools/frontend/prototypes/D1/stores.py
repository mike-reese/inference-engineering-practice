"""D1 prototype: the four store options behind one query API shape (throwaway).

API, the same for every option (rows are tuples; ROW = (id, source, process, thread, name, start_ns, end_ns)):
  window(t0, t1, sources=None, track_like=None, process=None, thread=None) -> [ROW]
      every event that overlaps the closed interval [t0, t1]: start_ns <= t1 and end_ns >= t0
  lanes(t0, t1) -> {process: {thread: [ROW, ...]}}            the window grouped the way a lane view draws it
  state_at(t) -> [(process, thread, "active" | "last", name, start_ns, end_ns)]
      per (process, thread): the innermost span active at t (latest start), else the latest event starting at or
      before t ("waiting since")
  focus(t0, t1, process, thread=None) -> ([ROW], [(from_id, to_id, kind, other_process, other_thread, other_name,
      other_start_ns)])   the focus's events in the window plus only the links that cross its boundary
  gpu_busy(bucket_ns) -> [(bucket, kernel_ns)]   kernel time per bucket of (start_ns - ORIGIN); a kernel that crosses
      a bucket edge counts wholly in its start bucket (Calculated, same rule in every option)
  sample_avg(metric_like, bucket_ns) -> [(bucket, mean)]
Slicing (BI-style), intervals clipped at the slice edges [t0, t1]:
  slice_measure(t0, t1) -> [(process, iteration, source, clipped_ns, clipped_bytes, n)]  kernels and memcpys;
      a copy's bytes are prorated by the clipped fraction of its duration (Calculated)
  busy_union(t0, t1) -> (busy_ns, islands)   GPU busy as the UNION of kernel intervals (overlaps counted once)
  ratio(t0, t1) -> [(process, clipped_bytes, clipped_ns, bytes_per_s)]  memcpy throughput = sum(bytes)/sum(seconds)
  busy_buckets(t0, t1, bucket_ns) -> [(bucket, busy_ns)]  union busy time per bucket of (t - ORIGIN)
"""
import json
import sqlite3
import time
from pathlib import Path

import duckdb
import pyarrow.parquet as pq

ORIGIN = 319_100_000_000_000  # a fixed CLOCK_MONOTONIC ns origin before every timeline-run event and sample
CANON = Path("/mnt/ie-data/cc-v2-proto/canonical")
STORES = Path("/mnt/ie-data/cc-v2-proto/stores")
TP_BIN = "/mnt/ie-data/cc-v2-proto/bin/trace_processor_shell"
EV_COLS = ["id", "run", "kind", "source", "track", "name", "start_ns", "end_ns", "corr", "request_id", "iteration",
           "synthetic", "args", "process", "thread", "pid", "host_pid", "pname", "tid", "kthread", "pythread", "bytes"]
ROW = "id, source, process, thread, name, start_ns, end_ns"
NOPROC = "(no process)"


def batches(dataset, kind, size=200_000):
    yield from pq.ParquetFile(CANON / f"{dataset}_{kind}.parquet").iter_batches(batch_size=size)


def group_lanes(rows):
    out = {}
    for r in rows:
        out.setdefault(r[2], {}).setdefault(r[3], []).append(r)
    return out


def pick_state(active, latest):
    """active: rows spanning t; latest: {(p, th): row}. Innermost active span wins, else the latest event."""
    state = {}
    for r in sorted(active, key=lambda r: (r[5], -r[6])):
        if r[6] > r[5]:
            state[(r[2], r[3])] = (r[2], r[3], "active", r[4], r[5], r[6])
    for k, r in latest.items():
        if k not in state and r is not None:
            state[k] = (r[2], r[3], "last", r[4], r[5], r[6])
    return [state[k] for k in sorted(state, key=lambda k: (str(k[0]), str(k[1])))]


# ---------------------------------------------------------------- A: one JSON file, loaded whole
class JsonStore:
    name = "A"

    def __init__(self, dataset):
        self.path = STORES / dataset / "A_run.json"

    def build(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.path, "w") as f:
            f.write('{"schema":"d1-proto","events":[')
            first = True
            for b in batches(self.dataset, "events"):
                for r in b.to_pylist():
                    args = r.pop("args")
                    line = json.dumps(r, separators=(",", ":"))[:-1] + ',"args":' + (args or "null") + "}"
                    f.write(line if first else "," + line)
                    first = False
            for kind in ("samples", "links"):
                f.write(f'],"{kind}":[')
                first = True
                for b in batches(self.dataset, kind):
                    for r in b.to_pylist():
                        line = json.dumps(r, separators=(",", ":"))
                        f.write(line if first else "," + line)
                        first = False
            f.write('],"profiles":')
            f.write(json.dumps(pq.read_table(CANON / "real_profiles.parquet").to_pylist()
                               if self.dataset == "real" else []))
            f.write("}")

    def open(self):
        with open(self.path) as f:
            self.doc = json.load(f)
        return self

    @staticmethod
    def row(e):
        return (e["id"], e["source"], e["process"] or NOPROC, e["thread"], e["name"], e["start_ns"], e["end_ns"])

    def window(self, t0, t1, sources=None, track_like=None, process=None, thread=None):
        return [self.row(e) for e in self.doc["events"]
                if e["start_ns"] <= t1 and e["end_ns"] >= t0 and (sources is None or e["source"] in sources)
                and (track_like is None or track_like in e["track"])
                and (process is None or e["process"] == process) and (thread is None or e["thread"] == thread)]

    def lanes(self, t0, t1):
        return group_lanes(sorted(self.window(t0, t1), key=lambda r: (r[2], str(r[3]), r[5])))

    def state_at(self, t):
        active, latest = [], {}
        for e in self.doc["events"]:
            if e["start_ns"] <= t:
                r = self.row(e)
                if e["end_ns"] >= t:
                    active.append(r)
                k = (r[2], r[3])
                if k not in latest or (r[5], r[6]) > (latest[k][5], latest[k][6]):
                    latest[k] = r
        return pick_state(active, latest)

    def focus(self, t0, t1, process, thread=None):
        inside = self.window(t0, t1, process=process, thread=thread)
        ids = {r[0] for r in inside}
        touched = [(l["from_id"], l["to_id"], l["kind"]) for l in self.doc["links"]
                   if l["from_id"] in ids or l["to_id"] in ids]
        others = {o for a, b, _ in touched for o in (a, b) if o not in ids}
        by_id = {e["id"]: e for e in self.doc["events"] if e["id"] in others}
        out = []
        for a, b, k in touched:
            o = by_id.get(b if a in ids else a)
            if o and not (o["process"] == process and (thread is None or o["thread"] == thread)):
                out.append((a, b, k, o["process"], o["thread"], o["name"], o["start_ns"]))
        return inside, out

    def gpu_busy(self, bucket_ns):
        out = {}
        for e in self.doc["events"]:
            if e["source"] == "kernel":
                b = (e["start_ns"] - ORIGIN) // bucket_ns
                out[b] = out.get(b, 0) + e["end_ns"] - e["start_ns"]
        return sorted(out.items())

    def sample_avg(self, metric_like, bucket_ns):
        acc = {}
        for s in self.doc["samples"]:
            if metric_like in s["metric"] and s["track"].endswith("gpu0/metrics"):
                b = (s["ts_ns"] - ORIGIN) // bucket_ns
                a = acc.setdefault(b, [0.0, 0])
                a[0] += s["value"]
                a[1] += 1
        return [(b, v / n) for b, (v, n) in sorted(acc.items())]

    def _src(self, t0, t1, sources):
        return [e for e in self.doc["events"]
                if e["source"] in sources and e["start_ns"] <= t1 and e["end_ns"] >= t0]

    @staticmethod
    def _clip(e, t0, t1):
        c = min(e["end_ns"], t1) - max(e["start_ns"], t0)
        b = e["bytes"] * c / (e["end_ns"] - e["start_ns"]) if e["bytes"] is not None and e["end_ns"] > e[
            "start_ns"] else e["bytes"]
        return c, b

    def slice_measure(self, t0, t1):
        acc = {}
        for e in self._src(t0, t1, ("kernel", "memcpy")):
            c, b = self._clip(e, t0, t1)
            a = acc.setdefault((e["process"], e["iteration"], e["source"]), [0, None, 0])
            a[0] += c
            a[1] = b if a[1] is None else a[1] + (b or 0)
            a[2] += 1
        return [(*k, *v) for k, v in sorted(acc.items(), key=lambda kv: (kv[0][0], kv[0][1] or -1, kv[0][2]))]

    def ratio(self, t0, t1):
        acc = {}
        for e in self._src(t0, t1, ("memcpy",)):
            c, b = self._clip(e, t0, t1)
            a = acc.setdefault(e["process"], [0.0, 0])
            a[0] += b or 0
            a[1] += c
        return [(p, b, ns, b / (ns / 1e9)) for p, (b, ns) in sorted(acc.items()) if ns > 0]

    def _islands(self, t0, t1):
        out = []
        for s, e in sorted((max(x["start_ns"], t0), min(x["end_ns"], t1)) for x in self._src(t0, t1, ("kernel",))):
            if out and s <= out[-1][1]:
                out[-1][1] = max(out[-1][1], e)
            else:
                out.append([s, e])
        return out

    def busy_union(self, t0, t1):
        isl = self._islands(t0, t1)
        return (sum(e - s for s, e in isl), len(isl))

    def busy_buckets(self, t0, t1, bucket_ns):
        acc = {}
        for s, e in self._islands(t0, t1):
            b = (s - ORIGIN) // bucket_ns
            while True:
                lo, hi = ORIGIN + b * bucket_ns, ORIGIN + (b + 1) * bucket_ns
                acc[b] = acc.get(b, 0) + min(e, hi) - max(s, lo)
                if hi >= e:
                    break
                b += 1
        return sorted(acc.items())

    def close(self):
        self.doc = None


# ---------------------------------------------------------------- shared SQL for B and C
class SqlMixin:
    JOIN = "JOIN"  # SQLite: "CROSS JOIN" fixes the join order (no ANALYZE stats: it scanned 10 M links, 960 -> 1.5 ms)
    NOIDX = ""  # SQLite: "+" stops the planner using the lane index instead of the R*Tree (134 ms -> 10 ms, Observed)

    def window(self, t0, t1, sources=None, track_like=None, process=None, thread=None):
        sql, args = self.window_sql(t0, t1)
        if sources:
            sql += f" AND e.source IN ({','.join('?' * len(sources))})"
            args += list(sources)
        if track_like:
            sql += " AND e.track LIKE ?"
            args.append(f"%{track_like}%")
        if process is not None:
            sql += f" AND {self.NOIDX}e.process = ?"
            args.append(process)
        if thread is not None:
            sql += f" AND {self.NOIDX}e.thread = ?"
            args.append(thread)
        return self.rows(sql, args)

    def lanes(self, t0, t1):
        sql, args = self.window_sql(t0, t1)
        return group_lanes(self.rows(sql + " ORDER BY 3, 4, e.start_ns", args))

    def focus(self, t0, t1, process, thread=None):
        inside = self.window(t0, t1, process=process, thread=thread)
        if not inside:
            return inside, []
        ids = [r[0] for r in inside]
        self.temp_ids(ids)
        lo, hi = min(ids), max(ids)  # lets DuckDB prune link row groups by id (274 -> 58 ms per direction, Observed)
        same = "o.process = ?" + (" AND o.thread = ?" if thread is not None else "")
        key = [process] + ([thread] if thread is not None else [])
        sql = (f"SELECT l.from_id, l.to_id, l.kind, o.process, o.thread, o.name, o.start_ns FROM focus_ids f "
               f"{self.JOIN} links l ON l.from_id = f.id AND l.from_id BETWEEN {lo} AND {hi} {self.JOIN} events o ON o.id = l.to_id WHERE NOT ({same}) "
               f"UNION ALL "
               f"SELECT l.from_id, l.to_id, l.kind, o.process, o.thread, o.name, o.start_ns FROM focus_ids f "
               f"{self.JOIN} links l ON l.to_id = f.id AND l.to_id BETWEEN {lo} AND {hi} {self.JOIN} events o ON o.id = l.from_id WHERE NOT ({same})")
        return inside, self.rows(sql, key + key)


class SliceSql:
    """The four slicing queries in one SQL text per dialect: SQLite (B) and Perfetto (D, SQLite engine) use the
    scalar min()/max() and integer '/', DuckDB (C) least()/greatest() and '//'. Union = gaps-and-islands with
    window functions; buckets = a recursive CTE that walks each island across the buckets it touches."""
    LO, HI, DIV, TAB = "max", "min", "/", "events"

    def src(self, t0, t1, sources):
        return (f"SELECT process, iteration, source, start_ns, end_ns, bytes FROM {self.TAB} WHERE source IN "
                f"({','.join(repr(x) for x in sources)}) AND start_ns <= {t1} AND end_ns >= {t0}")

    def clip(self, t0, t1):
        return f"({self.HI}(end_ns, {t1}) - {self.LO}(start_ns, {t0}))"

    def slice_measure(self, t0, t1):
        c = self.clip(t0, t1)
        return self.rows(f"""SELECT process, iteration, source, SUM({c}) AS clipped_ns,
            SUM(CASE WHEN end_ns > start_ns THEN bytes * 1.0 * {c} / (end_ns - start_ns) ELSE bytes END) AS b,
            COUNT(*) AS n FROM ({self.src(t0, t1, ['kernel', 'memcpy'])}) GROUP BY process, iteration, source
            ORDER BY process, iteration, source""", [])

    def ratio(self, t0, t1):
        c = self.clip(t0, t1)
        return self.rows(f"""SELECT process, SUM(b) AS b, SUM(ns) AS ns, SUM(b) / (SUM(ns) / 1e9) AS bps FROM (
            SELECT process, {c} AS ns,
              CASE WHEN end_ns > start_ns THEN bytes * 1.0 * {c} / (end_ns - start_ns) ELSE bytes END AS b
            FROM ({self.src(t0, t1, ['memcpy'])})) GROUP BY process HAVING SUM(ns) > 0 ORDER BY process""", [])

    def islands(self, t0, t1):
        return f"""k AS (SELECT {self.LO}(start_ns, {t0}) AS s, {self.HI}(end_ns, {t1}) AS e
                     FROM ({self.src(t0, t1, ['kernel'])})),
          m AS (SELECT s, e, MAX(e) OVER (ORDER BY s, e ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS pe
                FROM k),
          g AS (SELECT s, e, SUM(CASE WHEN pe IS NULL OR s > pe THEN 1 ELSE 0 END)
                  OVER (ORDER BY s, e ROWS UNBOUNDED PRECEDING) AS isl FROM m),
          isl AS (SELECT MIN(s) AS s, MAX(e) AS e FROM g GROUP BY isl)"""

    def busy_union(self, t0, t1):
        r = self.rows(f"WITH {self.islands(t0, t1)} SELECT SUM(e - s) AS busy, COUNT(*) AS n FROM isl", [])[0]
        return (int(r[0] or 0), int(r[1]))

    def busy_buckets(self, t0, t1, bucket_ns):
        o, b = ORIGIN, bucket_ns
        return self.rows(f"""WITH RECURSIVE {self.islands(t0, t1)},
          bk(bk, s, e) AS (SELECT (s - {o}) {self.DIV} {b}, s, e FROM isl
                           UNION ALL SELECT bk + 1, s, e FROM bk WHERE (bk + 1) * {b} + {o} < e)
          SELECT bk, SUM({self.HI}(e, {o} + (bk + 1) * {b}) - {self.LO}(s, {o} + bk * {b})) AS busy
          FROM bk GROUP BY bk ORDER BY bk""", [])


# ---------------------------------------------------------------- B: SQLite per run, R*Tree time index
class SqliteStore(SliceSql, SqlMixin):
    name = "B"
    NOIDX = "+"
    JOIN = "CROSS JOIN"

    def __init__(self, dataset):
        self.path = STORES / dataset / "B_run.sqlite"

    def build(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for p in (self.path, Path(f"{self.path}-wal"), Path(f"{self.path}-shm")):
            p.unlink(missing_ok=True)
        db = sqlite3.connect(self.path)
        db.executescript(f"""
            PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF;
            CREATE TABLE events(id INTEGER PRIMARY KEY, {', '.join(c for c in EV_COLS[1:])});
            -- R*Tree over time, relative to ORIGIN: 32-bit float bounds rounded outward, a coarse superset;
            -- the exact integer check runs on the events row.
            CREATE VIRTUAL TABLE events_time USING rtree(id, lo, hi);
            CREATE TABLE samples(run, track, metric, ts_ns INTEGER, value REAL, synthetic);
            CREATE TABLE links(run, from_id INTEGER, to_id INTEGER, kind, rule, synthetic);
            CREATE TABLE profiles(run, profile, row INTEGER, data);
        """)
        q = ",".join("?" * len(EV_COLS))
        for b in batches(self.dataset, "events"):
            rows = list(zip(*[b.column(c).to_pylist() for c in EV_COLS]))
            db.executemany(f"INSERT INTO events({','.join(EV_COLS)}) VALUES ({q})", rows)
            db.executemany("INSERT INTO events_time VALUES (?,?,?)",
                           [(r[0], r[6] - ORIGIN, r[7] - ORIGIN) for r in rows])
        for kind, n in (("samples", 6), ("links", 6)):
            for b in batches(self.dataset, kind):
                db.executemany(f"INSERT INTO {kind} VALUES ({','.join('?' * n)})",
                               zip(*[b.column(c).to_pylist() for c in b.schema.names]))
        if self.dataset == "real":
            db.executemany("INSERT INTO profiles VALUES (?,?,?,?)",
                           [tuple(r.values()) for r in pq.read_table(CANON / "real_profiles.parquet").to_pylist()])
        db.executescript("""
            CREATE INDEX events_source_start ON events(source, start_ns);
            CREATE INDEX events_lane_start ON events(process, thread, start_ns);
            CREATE INDEX links_from ON links(from_id);
            CREATE INDEX links_to ON links(to_id);
            CREATE INDEX samples_metric_ts ON samples(metric, ts_ns);
            CREATE TABLE lanes AS SELECT DISTINCT process, thread FROM events;
            CREATE TABLE meta AS SELECT source, MAX(end_ns - start_ns) AS maxdur FROM events GROUP BY source;
            PRAGMA synchronous=NORMAL;
        """)
        db.commit()
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        db.close()

    def open(self, readonly=True):
        self.db = sqlite3.connect(f"file:{self.path}?mode={'ro' if readonly else 'rw'}", uri=True)
        self.db.execute("PRAGMA temp_store=MEMORY")
        self.maxdur = dict(self.db.execute("SELECT source, maxdur FROM meta"))
        return self

    def src(self, t0, t1, sources):
        """Index range on (source, start_ns): start_ns >= t0 - longest event of that source keeps it exact."""
        return " UNION ALL ".join(
            f"SELECT process, iteration, source, start_ns, end_ns, bytes FROM events WHERE source = '{x}' AND "
            f"start_ns BETWEEN {t0 - self.maxdur.get(x, 0)} AND {t1} AND end_ns >= {t0}" for x in sources)

    def rows(self, sql, args):
        return self.db.execute(sql, args).fetchall()

    def window_sql(self, t0, t1):
        return (f"SELECT e.id, e.source, coalesce(e.process, '{NOPROC}'), e.thread, e.name, e.start_ns, e.end_ns "
                f"FROM events_time r JOIN events e ON e.id = r.id "
                f"WHERE r.hi >= ? AND r.lo <= ? AND e.end_ns >= ? AND e.start_ns <= ?",
                [t0 - ORIGIN, t1 - ORIGIN, t0, t1])

    def temp_ids(self, ids):
        self.db.execute("CREATE TEMP TABLE IF NOT EXISTS focus_ids(id INTEGER PRIMARY KEY)")
        self.db.execute("DELETE FROM focus_ids")
        self.db.executemany("INSERT INTO focus_ids VALUES (?)", [(i,) for i in ids])

    def state_at(self, t):
        sql, args = self.window_sql(t, t)
        active = self.rows(sql, args)
        latest = {}
        for p, th in self.db.execute("SELECT process, thread FROM lanes").fetchall():
            r = self.db.execute(f"SELECT {ROW} FROM events INDEXED BY events_lane_start WHERE process IS ? AND "
                                f"thread IS ? AND start_ns <= ? ORDER BY start_ns DESC, end_ns DESC LIMIT 1",
                                (p, th, t)).fetchone()
            if r:
                r = (r[0], r[1], r[2] or NOPROC, *r[3:])
                latest[(r[2], r[3])] = r
        return pick_state(active, latest)

    def gpu_busy(self, bucket_ns):
        return self.rows("SELECT (start_ns - ?) / ? AS b, SUM(end_ns - start_ns) FROM events "
                         "WHERE source = 'kernel' GROUP BY b ORDER BY b", (ORIGIN, bucket_ns))

    def sample_avg(self, metric_like, bucket_ns):
        metrics = [m for (m,) in self.db.execute("SELECT DISTINCT metric FROM samples") if metric_like in m]
        return self.rows(f"SELECT (ts_ns - ?) / ? AS b, AVG(value) FROM samples WHERE metric IN "
                         f"({','.join('?' * len(metrics))}) AND track LIKE '%gpu0/metrics' GROUP BY b ORDER BY b",
                         [ORIGIN, bucket_ns, *metrics])

    def close(self):
        self.db.close()


# ---------------------------------------------------------------- C: DuckDB over Parquet
class DuckStore(SliceSql, SqlMixin):
    name = "C"
    LO, HI, DIV = "greatest", "least", "//"

    def __init__(self, dataset):
        self.dir = STORES / dataset / "C_parquet"

    def build(self):
        self.dir.mkdir(parents=True, exist_ok=True)
        for p in self.dir.glob("*.parquet"):
            p.unlink()
        con = duckdb.connect()
        con.execute("SET temp_directory='/mnt/ie-data/cc-v2-proto/duckdb_tmp'")
        for kind, key in (("events", "start_ns"), ("samples", "ts_ns"), ("links", "from_id")):
            con.execute(f"COPY (SELECT * FROM read_parquet('{CANON}/{self.dataset}_{kind}.parquet') ORDER BY {key}) "
                        f"TO '{self.dir}/{kind}.parquet' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)")
        if self.dataset == "real":
            con.execute(f"COPY (SELECT * FROM read_parquet('{CANON}/real_profiles.parquet')) "
                        f"TO '{self.dir}/profiles.parquet' (FORMAT parquet)")
        con.close()

    def open(self):
        self.con = duckdb.connect()
        self.con.execute(f"CREATE VIEW events AS SELECT * FROM read_parquet('{self.dir}/events*.parquet')")
        self.con.execute(f"CREATE VIEW samples AS SELECT * FROM read_parquet('{self.dir}/samples.parquet')")
        self.con.execute(f"CREATE VIEW links AS SELECT * FROM read_parquet('{self.dir}/links*.parquet')")
        return self

    def rows(self, sql, args):
        return self.con.execute(sql, args).fetchall()

    def window_sql(self, t0, t1):
        return (f"SELECT e.id, e.source, coalesce(e.process, '{NOPROC}'), e.thread, e.name, e.start_ns, e.end_ns "
                f"FROM events e WHERE e.start_ns <= ? AND e.end_ns >= ?", [t1, t0])

    def temp_ids(self, ids):
        self.con.execute("CREATE OR REPLACE TEMP TABLE focus_ids AS SELECT unnest(?::BIGINT[]) AS id", [ids])

    def state_at(self, t):
        sql, args = self.window_sql(t, t)
        active = self.rows(sql, args)
        latest = self.rows(f"SELECT arg_max(({ROW}), (start_ns, end_ns)) FROM events WHERE start_ns <= ? "
                           f"GROUP BY process, thread", [t])
        latest = {(r[2] or NOPROC, r[3]): (r[0], r[1], r[2] or NOPROC, *r[3:])
                  for r in (tuple(x[0].values()) if isinstance(x[0], dict) else tuple(x[0]) for x in latest)}
        return pick_state(active, latest)

    def gpu_busy(self, bucket_ns):
        return self.rows("SELECT (start_ns - ?) // ? AS b, SUM(end_ns - start_ns)::BIGINT FROM events "
                         "WHERE source = 'kernel' GROUP BY b ORDER BY b", [ORIGIN, bucket_ns])

    def sample_avg(self, metric_like, bucket_ns):
        return self.rows("SELECT (ts_ns - ?) // ? AS b, AVG(value) FROM samples WHERE contains(metric, ?) "
                         "AND track LIKE '%gpu0/metrics' GROUP BY b ORDER BY b", [ORIGIN, bucket_ns, metric_like])

    def close(self):
        self.con.close()


# ---------------------------------------------------------------- D: Perfetto trace processor over Chrome JSON
def us(ns):
    """ns -> exact decimal microseconds text for Chrome JSON (no float rounding in our writer)."""
    return f"{ns // 1000}.{ns % 1000:03d}"


SEP = " ¦ "  # thread track name = "<thread> ¦ <source>": one Perfetto thread per (thread, source) avoids misnesting


class PerfettoStore(SliceSql):
    name = "D"
    TAB = "ev"

    def rows(self, sql, args):
        return self.q(sql)

    def __init__(self, dataset):
        self.path = STORES / dataset / "D_trace.json"

    def build(self):
        """Chrome JSON: one pid per process, one tid per (process, thread, source); counters as "C"; every link as a
        v1 flow ("s" at the source event, "f" bound to the target) with a unique id."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        pids, tids, where = {}, {}, {}
        links = {}
        for b in batches(self.dataset, "links"):
            for a, z in zip(b.column("from_id").to_pylist(), b.column("to_id").to_pylist()):
                links.setdefault(a, []).append(z)

        def ids(process, thread, source):
            pid = pids.setdefault(process, len(pids) + 1)
            tid = tids.setdefault((process, thread, source), (pid, len(tids) + 1))[1]
            return pid, tid

        flow = 0
        pending = {}
        with open(self.path, "w") as f:
            f.write('{"displayTimeUnit":"ns","traceEvents":[\n')
            for b in batches(self.dataset, "events"):
                for r in b.to_pylist():
                    pid, tid = ids(r["process"], r["thread"], r["source"])
                    args = {"id": r["id"], "request_id": r["request_id"], "iteration": r["iteration"],
                            "corr": r["corr"], "synthetic": r["synthetic"], "bytes": r["bytes"]}
                    head = (f'{{"name":{json.dumps(r["name"])},"cat":"{r["source"]}","pid":{pid},"tid":{tid},'
                            f'"ts":{us(r["start_ns"])},')
                    a = json.dumps(args, separators=(",", ":"))
                    if r["args"]:
                        a = a[:-1] + ',"raw":' + r["args"] + "}"
                    if r["kind"] == "instant":
                        f.write(head + f'"ph":"i","s":"t","args":{a}}},\n')
                    else:
                        f.write(head + f'"ph":"X","dur":{us(r["end_ns"] - r["start_ns"])},"args":{a}}},\n')
                    if r["id"] in links:  # a link source: remember it; the "s" is written with its "f"
                        where[r["id"]] = (pid, tid, r["start_ns"])
                        for z in links.pop(r["id"]):
                            pending.setdefault(z, []).append(r["id"])
                    for src in pending.pop(r["id"], ()):  # sorted by time: a link's source comes first
                        flow += 1
                        sp, st, sts = where[src]
                        f.write(f'{{"ph":"s","id":{flow},"cat":"link","name":"link","pid":{sp},"tid":{st},'
                                f'"ts":{us(sts)}}},\n{{"ph":"f","bp":"e","id":{flow},"cat":"link","name":"link",'
                                f'"pid":{pid},"tid":{tid},"ts":{us(r["start_ns"])}}},\n')
            for b in batches(self.dataset, "samples"):
                for r in b.to_pylist():
                    pid, _ = ids(r["track"], "samples", "samples")
                    f.write(f'{{"name":{json.dumps(r["metric"])},"ph":"C","pid":{pid},"ts":{us(r["ts_ns"])},'
                            f'"args":{{"value":{r["value"]}}}}},\n')
            for process, pid in pids.items():
                f.write(f'{{"ph":"M","name":"process_name","pid":{pid},"args":{{"name":{json.dumps(process)}}}}},\n')
            for (process, thread, source), (pid, tid) in tids.items():
                f.write(f'{{"ph":"M","name":"thread_name","pid":{pid},"tid":{tid},'
                        f'"args":{{"name":{json.dumps(str(thread) + SEP + source)}}}}},\n')
            f.write('{"ph":"M","name":"process_name","pid":0,"args":{"name":"end"}}]}\n')
        self.flows_written = flow
        self.links_unwritten = sum(len(v) for v in links.values()) + sum(len(v) for v in pending.values())

    def open(self):
        from perfetto.trace_processor import TraceProcessor, TraceProcessorConfig
        self.tp = TraceProcessor(trace=str(self.path),
                                 config=TraceProcessorConfig(bin_path=TP_BIN, load_timeout=3600))
        self.tp.query(f"""CREATE PERFETTO TABLE ev AS
            SELECT s.id AS sid, extract_arg(s.arg_set_id, 'args.id') AS id, s.category AS source, p.name AS process,
              substr(t.name, 1, instr(t.name, '{SEP}') - 1) AS thread, s.name AS name, s.ts AS start_ns,
              s.ts + s.dur AS end_ns, extract_arg(s.arg_set_id, 'args.iteration') AS iteration,
              extract_arg(s.arg_set_id, 'args.bytes') AS bytes
            FROM slice s JOIN thread_track tt ON s.track_id = tt.id JOIN thread t USING (utid)
            JOIN process p USING (upid) ORDER BY s.ts""")
        self.tp.query("CREATE PERFETTO INDEX ev_sid ON ev(sid)")  # flow -> event joins in focus()
        return self

    def q(self, sql):
        return [tuple(r.__dict__.values()) for r in self.tp.query(sql)]

    @staticmethod
    def lit(v):
        return "NULL" if v is None else "'" + str(v).replace("'", "''") + "'"

    def window(self, t0, t1, sources=None, track_like=None, process=None, thread=None):
        sql = f"SELECT {ROW} FROM ev WHERE start_ns <= {t1} AND end_ns >= {t0}"
        if sources:
            sql += " AND source IN (" + ",".join(self.lit(x) for x in sources) + ")"
        if track_like:
            sql += f" AND thread GLOB '*{track_like}*'"
        if process is not None:
            sql += f" AND process = {self.lit(process)}"
        if thread is not None:
            sql += f" AND thread = {self.lit(thread)}"
        return self.q(sql)

    def lanes(self, t0, t1):
        return group_lanes(self.q(f"SELECT {ROW} FROM ev WHERE start_ns <= {t1} AND end_ns >= {t0} "
                                  f"ORDER BY process, thread, start_ns"))

    def state_at(self, t):
        active = self.window(t, t)
        latest = self.q(f"SELECT {ROW} FROM (SELECT *, row_number() OVER (PARTITION BY process, thread ORDER BY "
                        f"start_ns DESC, end_ns DESC) AS rn FROM ev WHERE start_ns <= {t}) WHERE rn = 1")
        return pick_state(active, {(r[2], r[3]): r for r in latest})

    def focus(self, t0, t1, process, thread=None):
        inside = self.window(t0, t1, process=process, thread=thread)
        same = f"o.process = {self.lit(process)}" + (f" AND o.thread = {self.lit(thread)}" if thread else "")
        cond = f"i.start_ns <= {t1} AND i.end_ns >= {t0} AND i.process = {self.lit(process)}" + (
            f" AND i.thread = {self.lit(thread)}" if thread else "")
        links = self.q(f"""
            SELECT i.id AS a, o.id AS b, 'link' AS k, o.process AS op, o.thread AS ot, o.name AS oname,
                   o.start_ns AS ostart FROM flow fl
              JOIN ev i ON i.sid = fl.slice_out JOIN ev o ON o.sid = fl.slice_in WHERE {cond} AND NOT ({same})
            UNION ALL
            SELECT o.id, i.id, 'link', o.process, o.thread, o.name, o.start_ns FROM flow fl
              JOIN ev i ON i.sid = fl.slice_in JOIN ev o ON o.sid = fl.slice_out WHERE {cond} AND NOT ({same})""")
        return inside, links

    def gpu_busy(self, bucket_ns):
        return self.q(f"SELECT (start_ns - {ORIGIN}) / {bucket_ns} AS b, SUM(end_ns - start_ns) AS busy FROM ev "
                      f"WHERE source = 'kernel' GROUP BY b ORDER BY b")

    def sample_avg(self, metric_like, bucket_ns):
        return self.q(f"SELECT (c.ts - {ORIGIN}) / {bucket_ns} AS b, AVG(c.value) AS v FROM counter c "
                      f"JOIN process_counter_track t ON c.track_id = t.id JOIN process p USING (upid) "
                      f"WHERE t.name GLOB '*{metric_like}*' AND p.name GLOB '*gpu0/metrics' GROUP BY b ORDER BY b")

    def close(self):
        self.tp.close()


OPTIONS = {"A": JsonStore, "B": SqliteStore, "C": DuckStore, "D": PerfettoStore}


def make(option, dataset):
    s = OPTIONS[option](dataset)
    s.dataset = dataset
    return s


def disk_bytes(store):
    p = getattr(store, "path", None) or store.dir
    files = [p] if p.is_file() else list(p.rglob("*"))
    return sum(x.stat().st_size for x in files if x.is_file())


if __name__ == "__main__":
    import sys
    opt, ds = sys.argv[1], sys.argv[2]
    s = make(opt, ds)
    t = time.perf_counter()
    s.build()
    print(json.dumps({"option": opt, "dataset": ds, "build_s": round(time.perf_counter() - t, 2),
                      "bytes": disk_bytes(s), "flows_written": getattr(s, "flows_written", None),
                      "links_unwritten": getattr(s, "links_unwritten", None)}))
