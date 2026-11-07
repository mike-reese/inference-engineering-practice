"""D1 prototype: can live events be appended while a view queries? (throwaway; works on copies of the real stores)

Writer: one process appends batches of 1,000 events (copies of real events shifted past the run's end, labeled
synthetic, source "live-test") every 50 ms for 5 s. Reader: this process runs the iteration-66 window query in a
loop during the writes, and once more at the end to check it sees the appended rows.
Usage: python live.py -> /mnt/ie-data/cc-v2-proto/bench/live.json
"""
import json
import multiprocessing as mp
import shutil
import sqlite3
import statistics
import time
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from bench import targets
from stores import CANON, EV_COLS, ORIGIN, STORES, make

LIVE = Path("/mnt/ie-data/cc-v2-proto/live")
BATCH, PERIOD, SECONDS = 1000, 0.05, 5.0
SHIFT = 60_000_000_000  # 60 s after the source events: past every real event


def batch(k):
    ev = pq.read_table(CANON / "real_events.parquet").slice(50_000, BATCH)
    n = ev.num_rows
    cols = {c: ev[c] for c in ev.column_names}
    cols["id"] = pa.array(range(5 * 10**9 + k * n, 5 * 10**9 + (k + 1) * n), pa.int64())
    cols["start_ns"] = pc.add(ev["start_ns"], SHIFT + k * 1_000_000)
    cols["end_ns"] = pc.add(ev["end_ns"], SHIFT + k * 1_000_000)
    cols["source"] = pa.array(["live-test"] * n)
    cols["synthetic"] = pa.array([True] * n)
    return pa.table(cols, schema=ev.schema)


def stats(xs):
    return {"median_ms": round(statistics.median(xs), 3), "min_ms": round(min(xs), 3), "max_ms": round(max(xs), 3),
            "n": len(xs)} if xs else None


def writer_sqlite(path, q):
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=NORMAL")
    lat, k, end = [], 0, time.time() + SECONDS
    while time.time() < end:
        rows = list(zip(*[batch(k).column(c).to_pylist() for c in EV_COLS]))
        t = time.perf_counter()
        with db:
            db.executemany(f"INSERT INTO events({','.join(EV_COLS)}) VALUES ({','.join('?' * len(EV_COLS))})", rows)
            db.executemany("INSERT INTO events_time VALUES (?,?,?)", [(r[0], r[6] - ORIGIN, r[7] - ORIGIN) for r in rows])
        lat.append((time.perf_counter() - t) * 1000)
        k += 1
        time.sleep(PERIOD)
    q.put({"batches": k, "commit": stats(lat)})


def writer_parquet(d, q):
    lat, k, end = [], 0, time.time() + SECONDS
    while time.time() < end:
        b = batch(k)
        t = time.perf_counter()
        tmp = d / f".tmp_{k}.parquet"
        pq.write_table(b, tmp)
        tmp.rename(d / f"events_live_{k:05d}.parquet")  # atomic rename: a reader never sees a half-written file
        lat.append((time.perf_counter() - t) * 1000)
        k += 1
        time.sleep(PERIOD)
    q.put({"batches": k, "write_part": stats(lat)})


def reader_loop(store, t, proc):
    lat = []
    while proc.is_alive():
        x = time.perf_counter()
        store.window(*t["iteration66"])
        lat.append((time.perf_counter() - x) * 1000)
    return lat


def live_rows(store):
    return len(store.window(0, 2**62, sources=["live-test"]))


def main():
    t = targets("real")
    out = {}
    LIVE.mkdir(parents=True, exist_ok=True)
    ctx = mp.get_context("spawn")

    # B: SQLite in WAL mode, one writer process, this process reading
    src = STORES / "real" / "B_run.sqlite"
    dst = LIVE / "B_run.sqlite"
    for stale in (dst, Path(f"{dst}-wal"), Path(f"{dst}-shm")):
        stale.unlink(missing_ok=True)  # a WAL left from an earlier test would corrupt the fresh copy
    shutil.copy(src, dst)
    b = make("B", "real")
    b.path = dst
    b.open()
    idle = [0.0] * 0
    for _ in range(20):
        x = time.perf_counter()
        b.window(*t["iteration66"])
        idle.append((time.perf_counter() - x) * 1000)
    q = ctx.Queue()
    p = ctx.Process(target=writer_sqlite, args=(str(dst), q))
    p.start()
    busy = reader_loop(b, t, p)
    w = q.get()
    p.join()
    out["B"] = {"mechanism": "SQLite WAL: one writer process, readers in other processes see each commit",
                "reader_idle": stats(idle), "reader_during_writes": stats(busy), "writer": w,
                "rows_visible_after": live_rows(b), "rows_written": w["batches"] * BATCH}
    b.close()

    # C: Parquet part files, DuckDB reading a glob
    d = LIVE / "C_parquet"
    shutil.rmtree(d, ignore_errors=True)
    shutil.copytree(STORES / "real" / "C_parquet", d)
    c = make("C", "real")
    c.dir = d
    c.open()
    idle = []
    for _ in range(20):
        x = time.perf_counter()
        c.window(*t["iteration66"])
        idle.append((time.perf_counter() - x) * 1000)
    q = ctx.Queue()
    p = ctx.Process(target=writer_parquet, args=(d, q))
    p.start()
    busy = reader_loop(c, t, p)
    w = q.get()
    p.join()
    after = []
    for _ in range(20):
        x = time.perf_counter()
        c.window(*t["iteration66"])
        after.append((time.perf_counter() - x) * 1000)
    out["C"] = {"mechanism": "a new immutable Parquet part per batch (atomic rename); readers glob events*.parquet",
                "reader_idle": stats(idle), "reader_during_writes": stats(busy),
                "reader_after_parts": stats(after), "parts": w["batches"], "writer": w,
                "rows_visible_after": live_rows(c), "rows_written": w["batches"] * BATCH}
    c.close()
    # DuckDB's own database file: a second process cannot open it while a writer holds it.
    dbf = LIVE / "C_native.duckdb"
    dbf.unlink(missing_ok=True)
    con = duckdb.connect(str(dbf))
    con.execute("CREATE TABLE x(a INT)")
    q = ctx.Queue()
    p = ctx.Process(target=open_readonly, args=(str(dbf), q))
    p.start()
    p.join()
    out["C"]["native_duckdb_file_second_process"] = q.get()
    con.close()

    # A: one JSON file: an append is a rewrite of the whole file; every reader reloads it
    a = make("A", "real").open()
    rw = []
    for _ in range(3):
        x = time.perf_counter()
        with open(LIVE / "A_run.json", "w") as f:
            json.dump(a.doc, f, separators=(",", ":"))
        rw.append((time.perf_counter() - x) * 1000)
    out["A"] = {"mechanism": "rewrite the whole file, then every reader reloads it", "rewrite": stats(rw)}
    a.close()

    # D: the Python TraceProcessor loads one finished trace; it has no append call
    from perfetto.trace_processor import TraceProcessor
    out["D"] = {"mechanism": "no append: reload the whole trace (TraceProcessor methods: "
                             + ", ".join(m for m in dir(TraceProcessor) if not m.startswith("_")) + ")"}
    Path("/mnt/ie-data/cc-v2-proto/bench").mkdir(parents=True, exist_ok=True)
    Path("/mnt/ie-data/cc-v2-proto/bench/live.json").write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))


def open_readonly(path, q):
    try:
        duckdb.connect(path, read_only=True).execute("SELECT 1")
        q.put("opened read-only")
    except Exception as e:  # noqa: BLE001 - the error text is the observation
        q.put(f"{type(e).__name__}: {str(e).splitlines()[0][:200]}")


if __name__ == "__main__":
    main()
