"""Devtools backend: one process, one port, every view, and the API iectl and agents use."""
import asyncio
import json
import os
from pathlib import Path

import aiohttp
from aiohttp import web

import runs
import store_v2
from bus import Bus
from store import serve as store_v3
from store import stream as store_v3_stream
from collectors.components import ComponentsCollector
from collectors.docker import DockerCollector
from collectors.engine import EngineCollector
from collectors.gpu import GpuCollector
from collectors.logs import LogCollector
from collectors.records import RecordsCollector

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"
PROXIES = {"grafana": "http://127.0.0.1:7730", "prometheus": "http://127.0.0.1:7790",
           "runner": "http://127.0.0.1:7701"}  # the host runner (scripts/runner.py), started by make devtools


async def live(request: web.Request) -> web.StreamResponse:
    """Server-sent events: the current picture first, then every message as it is published.
    ?topics=a,b limits the stream (iectl wait uses it)."""
    response = web.StreamResponse(headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache"})
    await response.prepare(request)
    bus = request.app["bus"]
    topics = set(request.query["topics"].split(",")) if "topics" in request.query else None
    queue = bus.subscribe(topics)
    try:
        while True:
            message = await queue.get()
            await response.write(f"data: {json.dumps(message)}\n\n".encode())
    except ConnectionResetError:
        pass  # the tab closed
    finally:
        bus.unsubscribe(queue)
    return response


async def snapshot(request: web.Request) -> web.Response:
    """The same picture as JSON, for iectl and agents. ?topics=a,b limits it."""
    data = request.app["bus"].snapshot()
    if "topics" in request.query:
        wanted = set(request.query["topics"].split(","))
        data["state"] = {k: v for k, v in data["state"].items() if k in wanted}
    return web.json_response(data)


async def logs(request: web.Request) -> web.Response:
    """One container's log lines, optionally between two times (ns since the epoch). ?container= is an id or a name."""
    query = request.query
    collector = request.app["logs"]
    cid = collector.resolve(query["container"])
    until = int(query["until"]) if "until" in query else None
    lines = collector.history(cid, int(query.get("since", 0)), until)
    if "grep" in query:
        lines = [line for line in lines if query["grep"].lower() in line["line"].lower()]
    if "tail" in query:
        lines = lines[-int(query["tail"]):]
    return web.json_response(lines)


async def log_sources(request: web.Request) -> web.Response:
    return web.json_response(list(request.app["logs"].sources.values()))


async def phase_lines(request: web.Request) -> web.Response:
    """The raw log lines of one lifecycle phase. Exact ns stay here: JavaScript numbers cannot hold them."""
    collector = request.app["logs"]
    cid = collector.resolve(request.query["container"])
    return web.json_response(collector.phase_lines(cid, int(request.query["index"])))


async def lifecycles(request: web.Request) -> web.Response:
    collector = request.app["logs"]
    return web.json_response([{"id": cid, **collector.sources[cid], "marks": life.marks}
                              for cid, life in collector.lifecycles.items() if cid in collector.sources])


async def gpu_history(request: web.Request) -> web.Response:
    return web.json_response(list(request.app["gpu"].history))


async def engine_history(request: web.Request) -> web.Response:
    """Every engine's counters over time; ?match= keeps the series whose name contains it."""
    match = request.query.get("match", "")
    out = {}
    for cid, samples in request.app["engine"].history.items():
        out[cid] = [{"ns": s["ns"], "metrics": {k: v for k, v in s["metrics"].items() if match in k}}
                    for s in samples]
    return web.json_response(out)


async def engine_iterations(request: web.Request) -> web.Response:
    """Every iteration the engines with iteration stats reported (live runs), per container id."""
    return web.json_response({cid: list(its) for cid, its in request.app["engine"].iterations.items()})


async def engine_iterations_raw(request: web.Request) -> web.Response:
    """The collector's raw /metrics reads for one run folder (?run_id=) or server container (?container=), in
    reader order, for rep.py to save as engine_iterations_raw.jsonl. Read-only: nothing is drained or written."""
    run_id, container = request.query.get("run_id"), request.query.get("container")
    if not run_id and not container:
        return web.json_response({"error": "give run_id=<run folder name> or container=<server container name>"},
                                 status=400)
    data = request.app["engine"].raw_reads(run_id, container)
    if data is None:
        return web.json_response({"error": f"no engine with iteration stats known for "
                                  f"{'run ' + run_id if run_id else 'container ' + container}: start the run's server "
                                  "with enable_iter_perf_stats: true while the devtools run, and fetch within "
                                  "10 minutes of its stop"}, status=404)
    return web.json_response(data)


async def component_stamps(request: web.Request) -> web.Response:
    """Every component stamp held, per run (?run= for one): what the Components tab starts from."""
    if request.query.get("saved"):  # v2 scene: any saved run, read from disk (?saved=<run id>)
        return web.json_response(await asyncio.to_thread(request.app["components"].saved, request.query["saved"]))
    return web.json_response(request.app["components"].history(request.query.get("run")))


async def prometheus_targets(request: web.Request) -> web.Response:
    return web.json_response(request.app["engine"].targets(request.query["service"], int(request.query["port"])))


async def run_list(request: web.Request) -> web.Response:
    return web.json_response(request.app["bus"].snapshot()["state"].get("run", {}))


async def run_detail(request: web.Request) -> web.Response:
    try:
        data = await asyncio.to_thread(runs.run_json, request.match_info["run_id"])
    except KeyError:
        raise web.HTTPNotFound(text=f"no run {request.match_info['run_id']}")
    return web.json_response(data)


async def run_spans(request: web.Request) -> web.Response:
    q = request.query
    data = await asyncio.to_thread(runs.spans, request.match_info["run_id"], q.get("request"), q.get("level"),
                                   q.get("component"), q.get("name"), int(q.get("limit", 500)))
    return web.json_response(data)


async def run_raw(request: web.Request) -> web.Response:
    q = request.query
    return web.json_response(await asyncio.to_thread(runs.raw, request.match_info["run_id"], q["file"],
                                                     q.get("pointer", "")))


async def run_source(request: web.Request) -> web.Response:
    q = request.query
    try:
        return web.json_response(await asyncio.to_thread(runs.source, request.match_info["run_id"], q["file"],
                                                         int(q["line"])))
    except OSError:
        raise web.HTTPNotFound(text="source not copied for this run (TRACE=code copies it)")


async def run_file(request: web.Request) -> web.FileResponse:
    """Download one file of a run (the pcap for Wireshark, the Nsight reports for the Nsight UIs)."""
    run = runs.find_run(request.match_info["run_id"])
    path = runs.safe_path(run, request.query["path"])
    return web.FileResponse(path, headers={"Content-Disposition": f'attachment; filename="{path.name}"'})


async def requests_list(request: web.Request) -> web.Response:
    return web.json_response(request.app["bus"].snapshot()["state"].get("request", {}))


async def proxy(request: web.Request) -> web.StreamResponse:
    """Grafana and Prometheus as subcomponents: same origin, so they open inside the devtools."""
    target = PROXIES[request.match_info["service"]] + request.rel_url.raw_path_qs
    headers = {k: v for k, v in request.headers.items() if k.lower() not in ("host", "content-length")}
    try:
        return await forward(request, target, headers)
    except aiohttp.ClientConnectorError:
        raise web.HTTPBadGateway(text=f"{request.match_info['service']} is not answering at {target}: "
                                      f"start it with make devtools (or make runner for the runner)")


async def forward(request: web.Request, target: str, headers: dict) -> web.StreamResponse:
    async with request.app["http"].request(request.method, target, headers=headers, data=await request.read(),
                                           allow_redirects=False) as upstream:
        response = web.StreamResponse(status=upstream.status, headers={
            k: v for k, v in upstream.headers.items()
            if k.lower() not in ("content-length", "transfer-encoding", "connection")})  # body passed as is
        await response.prepare(request)
        async for chunk in upstream.content.iter_chunked(65536):
            await response.write(chunk)
        return response


async def index(request: web.Request) -> web.FileResponse:
    return web.FileResponse(FRONTEND / "index.html")


async def collectors(app: web.Application):
    bus = app["bus"]
    app["gpu"], app["logs"], app["engine"] = GpuCollector(bus), LogCollector(bus), EngineCollector(bus)
    app["components"] = ComponentsCollector(bus)
    app["live"] = store_v3_stream.Live(bus, engine=app["engine"])   # command center v3: RunWatcher, host run, NVML
    app["http"] = aiohttp.ClientSession(auto_decompress=False)
    tasks = [asyncio.create_task(c.run()) for c in
             (DockerCollector(bus), app["gpu"], app["logs"], app["engine"], RecordsCollector(bus),
              app["components"], app["live"])]
    yield
    for task in tasks:
        task.cancel()
    await app["http"].close()


@web.middleware
async def revalidate(request: web.Request, handler):
    """The page and its modules: the browser must check the ETag on every load (a 304 when unchanged).
    Without it, Chromium reused a cached app.js older than index.html, and the newer tabs fell back to infra."""
    response = await handler(request)
    if request.path == "/" or request.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


def make_app() -> web.Application:
    app = web.Application(client_max_size=64 * 1024 ** 2, middlewares=[revalidate])
    app["bus"] = Bus()
    app.cleanup_ctx.append(collectors)
    r = app.router
    r.add_get("/", index)
    r.add_get("/api/live", live)
    r.add_get("/api/snapshot", snapshot)
    r.add_get("/api/logs", logs)
    r.add_get("/api/logs/sources", log_sources)
    r.add_get("/api/gpu/history", gpu_history)
    r.add_get("/api/lifecycle", lifecycles)
    r.add_get("/api/lifecycle/lines", phase_lines)
    r.add_get("/api/engine/history", engine_history)
    r.add_get("/api/engine/iterations", engine_iterations)
    r.add_get("/api/engine/iterations/raw", engine_iterations_raw)
    r.add_get("/api/prometheus/targets", prometheus_targets)
    r.add_get("/api/components", component_stamps)
    r.add_get("/api/requests", requests_list)
    r.add_get("/api/runs", run_list)
    r.add_get("/api/runs/{run_id}", run_detail)
    r.add_get("/api/runs/{run_id}/spans", run_spans)
    r.add_get("/api/runs/{run_id}/raw", run_raw)
    r.add_get("/api/runs/{run_id}/source", run_source)
    r.add_get("/api/runs/{run_id}/file", run_file)
    r.add_route("*", "/{service:grafana|prometheus|runner}{tail:(/.*)?}", proxy)
    store_v2.add_routes(r)  # command center v2 store (DuckDB over Parquet, ie-run/2); additive
    store_v3.add_routes(r)  # command center v3 store (ie-run/3: CCVB blocks + detail); additive until cutover
    store_v3_stream.add_routes(r)  # command center v3 live frames (WS /api/v3/stream)
    r.add_static("/static", FRONTEND)
    return app


if __name__ == "__main__":
    web.run_app(make_app(), host=os.environ.get("DEVTOOLS_HOST", "127.0.0.1"),
                port=int(os.environ.get("DEVTOOLS_PORT", "7700")))
