"""/api/v3: the ie-run/3 store over HTTP (COMMAND_CENTER_V3_DESIGN.md, Retrieval).

GET /api/v3/runs                              {runs: [...]}, newest run first
GET /api/v3/runs/{run}/manifest               manifest.json; ETag, no-cache (revalidate: a new generation replaces it)
GET /api/v3/runs/{run}/blocks/{gen}/{name}    a CCVB block, or aux.json; immutable, ETag = the manifest's etag
GET /api/v3/runs/{run}/detail?ids=1,2         {rows: [...]}, at most 256 ids; ?eids=<eid> (one eid per parameter,
                                              eids are free text) resolves stable eids to rows
GET /api/v3/runs/{run}/raw?id=                the row's raw record from the run folder
WS  /api/v3/stream?run=&have=                 live frames (store/stream.py)

A live run's detail, resolve and raw are answered by its writer (every row is in its memory, sealed or not).
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path

from aiohttp import web

import runs
from . import detail
from .schema import etag

CC_STORE = Path(os.environ.get("CC_STORE", "/mnt/ie-data/cc/store"))
REPO = Path(os.environ.get("REPO", "/repo"))
SAFE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
STAMP = re.compile(r"(\d{8}T\d{6}Z)")
_manifests: dict[str, tuple[tuple, bytes, str, dict]] = {}   # run -> (stat key, bytes, etag, parsed)


def _manifest(run: str) -> tuple[bytes, str, dict]:
    if not SAFE.match(run):
        raise web.HTTPBadRequest(text=f"run {run!r} is not a run name")
    path = CC_STORE / "runs" / run / "manifest.json"
    try:
        st = path.stat()
    except FileNotFoundError:
        raise web.HTTPNotFound(text=f"run {run!r} is not in the ie-run/3 store") from None
    key = (st.st_mtime_ns, st.st_size)
    hit = _manifests.get(run)
    if not hit or hit[0] != key:
        data = path.read_bytes()
        hit = _manifests[run] = (key, data, etag(data), json.loads(data))
    return hit[1], hit[2], hit[3]


def _cached(request: web.Request, data: bytes, tag: str, content_type: str, cache: str) -> web.Response:
    quoted = f'"{tag}"'
    headers = {"ETag": quoted, "Cache-Control": cache}
    if quoted in request.headers.get("If-None-Match", ""):
        return web.Response(status=304, headers=headers)
    return web.Response(body=data, content_type=content_type, headers=headers)


async def run_list(request: web.Request) -> web.Response:
    out = []
    for d in (CC_STORE / "runs").iterdir() if (CC_STORE / "runs").is_dir() else []:
        if (d / "manifest.json").is_file():
            _, _, m = _manifest(d.name)
            out.append({"run": m["run"], "generation": m["generation"], "status": m["status"], "t0_ns": m["t0_ns"],
                        "head_ns": m["head_ns"], "rows": m["import"].get("rows"),
                        "tier_counts": m["import"].get("tier_counts"),
                        "bytes": sum(b["bytes"] for b in m["blocks"]) + m["aux"]["bytes"]})
    out.sort(key=lambda r: (s.group(1) if (s := STAMP.search(r["run"])) else "", r["run"]), reverse=True)
    return web.json_response({"runs": out})


async def manifest(request: web.Request) -> web.Response:
    data, tag, _ = _manifest(request.match_info["run"])
    return _cached(request, data, tag, "application/json", "no-cache")


async def block(request: web.Request) -> web.Response:
    run, name = request.match_info["run"], request.match_info["name"]
    _, _, m = _manifest(run)
    gen = request.match_info["gen"]
    if not gen.isdigit() or not SAFE.match(name):
        raise web.HTTPBadRequest(text=f"generation {gen!r} or block {name!r} is malformed")
    if int(gen) == m["generation"]:
        entry = m["aux"] if name == "aux.json" else next((b for b in m["blocks"] if b["name"] == name), None)
        if entry is None:
            raise web.HTTPNotFound(text=f"{run} g{gen} has no block {name!r}")
        tag = entry["etag"]
    else:
        tag = None                         # the previous generation is kept for readers mid-swap; hash on demand
    path = CC_STORE / "runs" / run / f"g{gen}" / (name if name == "aux.json" else f"{name}.ccvb")
    try:
        data = await asyncio.get_running_loop().run_in_executor(None, path.read_bytes)
    except FileNotFoundError:
        raise web.HTTPNotFound(text=f"{run} has no g{gen}/{path.name} (generations older than the previous one are "
                               "deleted)") from None
    return _cached(request, data, tag or etag(data), "application/json" if name == "aux.json" else
                   "application/octet-stream", "public, max-age=31536000, immutable")


async def _in_thread(fn, *args):
    try:
        return await asyncio.get_running_loop().run_in_executor(None, fn, *args)
    except KeyError as e:
        raise web.HTTPNotFound(text=f"run {e.args[0]!r} is not in the ie-run/3 store") from None
    except ValueError as e:
        raise web.HTTPBadRequest(text=str(e)) from None


def _detail(run: str, ids: list[int], eids: list[str]) -> list[dict]:
    g = detail.generation(CC_STORE, run)
    return g.detail(ids + [i for i in g.resolve(eids) if i not in ids] if eids else ids)


def _writer(request: web.Request, run: str):
    live = request.app.get("live")
    return live.writer(run) if live else None


def _live_detail(w, ids: list[int], eids: list[str]) -> list[dict]:
    if len(ids) + len(eids) > detail.MAX_IDS:
        raise web.HTTPBadRequest(text=f"{len(ids) + len(eids)} ids; at most {detail.MAX_IDS} per request")
    try:
        return w.detail(ids + [i for i in w.resolve(eids) if i not in ids])
    except ValueError as e:
        raise web.HTTPBadRequest(text=str(e)) from None


async def detail_rows(request: web.Request) -> web.Response:
    run = request.match_info["run"]
    _manifest(run)
    text = request.query.get("ids", "")
    try:
        ids = [int(x) for x in text.split(",") if x] if text else []
    except ValueError:
        raise web.HTTPBadRequest(text=f"ids={text!r}: expected comma-separated row ids") from None
    w = _writer(request, run)
    rows = _live_detail(w, ids, request.query.getall("eids", [])) if w else \
        await _in_thread(_detail, run, ids, request.query.getall("eids", []))
    return web.json_response({"rows": rows}, dumps=lambda o: json.dumps(o, separators=(",", ":"), default=str))


def _raw_in(run: str, target: tuple) -> dict:
    """A row's raw record: capture/ files (written by the live writer) sit in the store run's folder, every other
    file in the rep's run folder."""
    run_dir, file, pointer = target
    if file.startswith("capture/"):
        return runs.raw_in(CC_STORE / "runs" / run, file, pointer)
    if run_dir is None:
        raise FileNotFoundError(file)
    return runs.raw_in(REPO / run_dir, file, pointer)


def _raw(run: str, i: int) -> dict:
    target = detail.generation(CC_STORE, run).raw_target(i)
    if target is None:
        return {"id": i, "raw": None, "note": "this row has no raw pointer (nsys rows: see open.nsys in detail)"}
    return {"id": i, **_raw_in(run, target)}


async def raw(request: web.Request) -> web.Response:
    run = request.match_info["run"]
    _manifest(run)
    try:
        i = int(request.query["id"])
    except (KeyError, ValueError):
        raise web.HTTPBadRequest(text="raw needs ?id=<row id>") from None
    w = _writer(request, run)
    try:
        if w:
            target = w.raw_target(i) if 0 <= i < w.n else None
            out = {"id": i, "raw": None, "note": "this live row has no raw pointer"} if target is None else \
                {"id": i, **await asyncio.to_thread(_raw_in, run, target)}
        else:
            out = await _in_thread(_raw, run, i)
    except PermissionError as e:
        raise web.HTTPForbidden(text=f"raw file {e.args[0]!r} is outside the run folder") from None
    except FileNotFoundError as e:
        raise web.HTTPNotFound(text=f"the raw file of row {i} is not in the run folder: {e.filename}") from None
    return web.json_response(out, dumps=lambda o: json.dumps(o, default=str))


def add_routes(router) -> None:
    router.add_get("/api/v3/runs", run_list)
    router.add_get("/api/v3/runs/{run}/manifest", manifest)
    router.add_get("/api/v3/runs/{run}/blocks/{gen}/{name}", block)
    router.add_get("/api/v3/runs/{run}/detail", detail_rows)
    router.add_get("/api/v3/runs/{run}/raw", raw)
