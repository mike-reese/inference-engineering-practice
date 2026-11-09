"""Command center v2 store API (additive; v1 endpoints are unchanged).

The store is D1 option C (DuckDB over Parquet) holding D2 option B records (ie-run/2), one folder per run:
  <STORE_V2>/runs/<run>/meta.json            run facts, time origin, the registries and measure catalog it was built with
  <STORE_V2>/runs/<run>/things.parquet       containment tree (stable ids)
  <STORE_V2>/runs/<run>/events.parquet       spans and instants, sorted by start_ns; eid = stable descriptive id
  <STORE_V2>/runs/<run>/links_from.parquet   links sorted by from_id, each with the other end's lane, name and start
  <STORE_V2>/runs/<run>/links_to.parquet     the same links sorted by to_id (D1 requirement)
  <STORE_V2>/runs/<run>/checkpoints.parquet  per-lane "last event at or before g" on a fixed grid (D1 requirement)
  <STORE_V2>/runs/<run>/samples.parquet      counter time series
  <STORE_V2>/runs/<run>/profiles.parquet     off-clock tables (Nsight Compute: one row per kernel and metric)
  <STORE_V2>/runs/<run>/shares.parquet       iteration shares per request (formula in meta.json measures)
Every query is read-only and parameterized; results are columnar JSON: {"columns": [...], "rows": [[...], ...]}.
"""
import asyncio
import json
import os
import threading
from pathlib import Path

from aiohttp import web

ROOT = Path(os.environ.get("STORE_V2", "/store_v2"))
_local = threading.local()


def _con():
    """One DuckDB connection per worker thread (connections are not shared across threads)."""
    c = getattr(_local, "con", None)
    if c is None:
        import duckdb  # imported here: the v1 backend starts even where duckdb is missing
        c = duckdb.connect(config={"memory_limit": "384MB", "threads": 2})
        _local.con = c
    return c


def _run_dir(run: str) -> Path:
    d = (ROOT / "runs" / run).resolve()
    if d.parent != (ROOT / "runs").resolve() or not (d / "meta.json").is_file():
        raise web.HTTPNotFound(text=f"run {run!r} is not in the v2 store")
    return d


def _table(d: Path, name: str) -> str:
    p = d / f"{name}.parquet"
    if not p.is_file():
        raise web.HTTPNotFound(text=f"{name} is not in this run")
    return f"read_parquet('{p}')"


def _query(sql: str, params: list) -> dict:
    cur = _con().execute(sql, params)
    cols = [c[0] for c in cur.description]
    return {"columns": cols, "rows": [list(r) for r in cur.fetchall()]}


async def _json(fn, *args) -> web.Response:
    out = await asyncio.get_running_loop().run_in_executor(None, fn, *args)
    return web.json_response(out, dumps=lambda o: json.dumps(o, separators=(",", ":"), default=str))


def _ints(q, key, default=None):
    return int(q[key]) if key in q else default


def _list(q, key):
    return [x for x in q.get(key, "").split(",") if x]


async def runs(request: web.Request) -> web.Response:
    out = []
    for d in sorted((ROOT / "runs").glob("*/meta.json")) if (ROOT / "runs").is_dir() else []:
        m = json.loads(d.read_text())
        out.append({k: m.get(k) for k in ("run", "title", "t0_ns", "t1_ns", "counts", "evidence")})
    return web.json_response({"store": str(ROOT), "runs": out})


async def meta(request: web.Request) -> web.Response:
    """Run facts plus the registries (event kinds, fields, measures) and the measure catalog with formulas."""
    d = _run_dir(request.match_info["run"])
    return web.json_response(json.loads((d / "meta.json").read_text()))


async def things(request: web.Request) -> web.Response:
    d = _run_dir(request.match_info["run"])
    return await _json(_query, f"SELECT * FROM {_table(d, 'things')} ORDER BY id", [])


async def events(request: web.Request) -> web.Response:
    """Events overlapping [t0, t1] (ns, run clock). Optional: thing=a,b (lane ids, prefix match with *), kind=a,b,
    iteration=n, min_dur=ns, cols=a,b, limit (default 200000)."""
    d, q = _run_dir(request.match_info["run"]), request.query
    where, params = ["start_ns <= ?", "coalesce(end_ns, start_ns) >= ?"], [_ints(q, "t1", 2**62), _ints(q, "t0", 0)]
    th = _list(q, "thing")
    if th:
        where.append("(" + " OR ".join("thing_id LIKE ?" for _ in th) + ")")
        params += [t.replace("*", "%") for t in th]
    kinds = _list(q, "kind")
    if kinds:
        where.append(f"kind IN ({','.join('?' * len(kinds))})")
        params += kinds
    if "iteration" in q:
        where.append("iteration = ?")
        params.append(int(q["iteration"]))
    if "min_dur" in q:
        where.append("coalesce(end_ns, start_ns) - start_ns >= ?")
        params.append(int(q["min_dur"]))
    allowed = {"id", "eid", "what", "thing_id", "parent_id", "kind", "name", "start_ns", "end_ns", "iteration",
               "request_id", "corr", "bytes", "args", "evidence", "parent_rule", "code_origin", "code_where"}
    cols = [c for c in _list(q, "cols") if c in allowed] or ["id", "eid", "thing_id", "parent_id", "kind", "name",
                                                              "start_ns", "end_ns", "iteration", "request_id"]
    sql = (f"SELECT {', '.join(cols)} FROM {_table(d, 'events')} WHERE {' AND '.join(where)} "
           f"ORDER BY start_ns LIMIT ?")
    return await _json(_query, sql, params + [_ints(q, "limit", 200_000)])


async def event(request: web.Request) -> web.Response:
    """One event by numeric id or stable eid, with its parent chain (innermost first)."""
    d, key = _run_dir(request.match_info["run"]), request.match_info["key"]
    ev = _table(d, "events")
    col = "id" if key.lstrip("-").isdigit() else "eid"
    val = int(key) if col == "id" else key

    def work():
        one = _query(f"SELECT * FROM {ev} WHERE {col} = ?", [val])
        if not one["rows"]:
            raise web.HTTPNotFound(text=f"event {key!r}")
        chain = _query(f"""WITH RECURSIVE up(id, depth) AS (SELECT parent_id, 1 FROM {ev} WHERE {col} = ?
            UNION ALL SELECT e.parent_id, depth + 1 FROM up JOIN {ev} e ON e.id = up.id WHERE up.id IS NOT NULL
            AND depth < 64) SELECT e.id, e.eid, e.what, e.kind, e.name, e.start_ns, e.end_ns FROM up JOIN {ev} e
            ON e.id = up.id ORDER BY depth""", [val])
        return {"event": one, "parents": chain}
    return await _json(work)


async def links(request: web.Request) -> web.Response:
    """Links into and out of one event (id), each with the other end's lane, name and start (denormalized files)."""
    d, q = _run_dir(request.match_info["run"]), request.query
    i = int(q["id"])
    sql = (f"SELECT 'out' AS dir, * FROM {_table(d, 'links_from')} WHERE from_id = ? UNION ALL "
           f"SELECT 'in' AS dir, * FROM {_table(d, 'links_to')} WHERE to_id = ?")
    return await _json(_query, sql, [i, i])


async def links_window(request: web.Request) -> web.Response:
    """Links whose source event starts in [t0, t1]; kind=a,b optional."""
    d, q = _run_dir(request.match_info["run"]), request.query
    where, params = ["from_start <= ?", "from_start >= ?"], [_ints(q, "t1", 2**62), _ints(q, "t0", 0)]
    kinds = _list(q, "kind")
    if kinds:
        where.append(f"kind IN ({','.join('?' * len(kinds))})")
        params += kinds
    sql = f"SELECT * FROM {_table(d, 'links_from')} WHERE {' AND '.join(where)} LIMIT 200000"
    return await _json(_query, sql, params)


async def state(request: web.Request) -> web.Response:
    """Each lane's active or latest event at t: one checkpoint read plus the events since that checkpoint."""
    d, q = _run_dir(request.match_info["run"]), request.query
    t = int(q["t"])
    m = json.loads((d / "meta.json").read_text())
    g = m["t0_ns"] + (t - m["t0_ns"]) // m["checkpoint_ns"] * m["checkpoint_ns"]
    ev, cp = _table(d, "events"), _table(d, "checkpoints")
    sql = f"""WITH c AS (SELECT thing_id, id FROM {cp} WHERE cp_ns = (SELECT max(cp_ns) FROM {cp} WHERE cp_ns <= ?)),
        cand AS (SELECT e.* FROM c JOIN {ev} e ON e.id = c.id
                 UNION ALL SELECT * FROM {ev} WHERE start_ns > ? AND start_ns <= ?)
        SELECT thing_id, arg_max(id, start_ns) AS id, arg_max(eid, start_ns) AS eid, arg_max(name, start_ns) AS name,
               max(start_ns) AS start_ns, arg_max(end_ns, start_ns) AS end_ns,
               arg_max(coalesce(end_ns, start_ns), start_ns) >= ? AS active
        FROM cand WHERE start_ns <= ? GROUP BY thing_id ORDER BY thing_id"""
    return await _json(_query, sql, [g, g, t, t, t])


async def samples(request: web.Request) -> web.Response:
    """Counter values in [t0, t1]; metric=a,b; bins=n averages into n equal time bins (min, mean, max per bin)."""
    d, q = _run_dir(request.match_info["run"]), request.query
    t0, t1 = _ints(q, "t0", 0), _ints(q, "t1", 2**62)
    ms = _list(q, "metric")
    mw = f"AND metric IN ({','.join('?' * len(ms))})" if ms else ""
    sm = _table(d, "samples")
    if "bins" in q:
        n = max(1, min(4096, int(q["bins"])))
        sql = (f"SELECT metric, thing_id, unit, floor((ts_ns - ?) * ? / greatest(? - ?, 1))::BIGINT AS bin, "
               f"min(value), avg(value), max(value) FROM {sm} WHERE ts_ns BETWEEN ? AND ? {mw} "
               f"GROUP BY ALL ORDER BY metric, bin")
        return await _json(_query, sql, [t0, n, t1, t0, t0, t1] + ms)
    sql = f"SELECT metric, thing_id, unit, ts_ns, value FROM {sm} WHERE ts_ns BETWEEN ? AND ? {mw} ORDER BY ts_ns"
    return await _json(_query, sql, [t0, t1] + ms)


async def profiles(request: web.Request) -> web.Response:
    """Off-clock rows (Nsight Compute) tied to one event (event=id) or to a kernel name (name=)."""
    d, q = _run_dir(request.match_info["run"]), request.query
    pr = _table(d, "profiles")
    if "event" in q:
        return await _json(_query, f"SELECT * FROM {pr} WHERE event_id = ? ORDER BY section, metric", [int(q["event"])])
    return await _json(_query, f"SELECT * FROM {pr} WHERE kernel_name = ? ORDER BY profile_row, section, metric "
                               "LIMIT 20000", [q["name"]])


async def shares(request: web.Request) -> web.Response:
    """Iteration shares per request (iteration=n optional); the formula is meta.json measures['iteration share']."""
    d, q = _run_dir(request.match_info["run"]), request.query
    sh = _table(d, "shares")
    if "iteration" in q:
        return await _json(_query, f"SELECT * FROM {sh} WHERE iteration = ? ORDER BY request_id", [int(q["iteration"])])
    return await _json(_query, f"SELECT * FROM {sh} ORDER BY iteration, request_id", [])


def add_routes(router) -> None:
    router.add_get("/api/v2/runs", runs)
    router.add_get("/api/v2/runs/{run}/meta", meta)
    router.add_get("/api/v2/runs/{run}/things", things)
    router.add_get("/api/v2/runs/{run}/events", events)
    router.add_get("/api/v2/runs/{run}/events/{key}", event)
    router.add_get("/api/v2/runs/{run}/links", links)
    router.add_get("/api/v2/runs/{run}/links/window", links_window)
    router.add_get("/api/v2/runs/{run}/state", state)
    router.add_get("/api/v2/runs/{run}/samples", samples)
    router.add_get("/api/v2/runs/{run}/profiles", profiles)
    router.add_get("/api/v2/runs/{run}/shares", shares)
