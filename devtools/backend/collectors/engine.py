"""Engine collector: each running engine's Prometheus counters, model and version, at its published port, and its
per-iteration stats when the engine was started with them.

Reads /prometheus/metrics, /version and /v1/models. Never /perf_metrics: each read drains the engine's buffer (K9),
and rep.py must be its only reader.
/metrics (iteration stats) drains the same way. The collector is its only reader, and reads it only from an engine
whose config.yaml sets `enable_iter_perf_stats: true` (the `live` run level). Each read waits about 2 s on the engine
(get_stats_async(2)) and returns every iteration since the previous read, so iterations arrive in ~2 s batches.
Each read is also kept in memory, unmodified, since the read consumes the engine's copy: one line per read
(raw_read), in reader order, failed and empty reads included. The devtools mount the repo read-only, so nothing is
written to the run folder: rep.py fetches the lines from GET /api/engine/iterations/raw?run_id=<run folder> and saves
them as engine_iterations_raw.jsonl. Bound: the last KEEP_READS reads per container (600: about 20 minutes at one
~2 s read; older reads are evicted and counted in `dropped`). Retention: RETAIN_S (600 s) after the container stops.
"""
import asyncio
import collections
import json
import os
import re
import time
from datetime import datetime, timezone

import aiohttp

KEEP_READS = 600  # raw /metrics reads per container
RETAIN_S = 600  # raw reads kept this long after their container stops
SAMPLE = re.compile(r"^([a-zA-Z_:][\w:]*)(\{[^}]*\})?\s+(\S+)")
KEEP = 1800  # samples per engine: 30 minutes at one per second
KEEP_ITERATIONS = 20000  # iteration stats per engine
ITER_STATS = re.compile(r"^enable_iter_perf_stats:\s*true\s*$", re.M)


def iteration(stat: dict) -> dict:
    """One engine iteration (IterationStats as /metrics returns it) -> the fields the Engine view draws.
    ns: the iteration's start (the stats' timestamp is taken as the step begins), µs resolution. The step time is the
    start-to-start interval to the next iteration: on run I02A-TRACE-live_20261103T185133Z_55cd9f its median, 3.99 ms,
    matched the engine's mean ITL from /perf_metrics, 4.06 ms.
    latency_ms is the engine's iterLatencyMS (median 7.50 ms there): the overlap scheduler records a step's stats after
    it has launched the next one, so it spans about two steps, plus any wait for work. It is not one step's time.
    iter is the engine's counter as the stats report it: at a request's end it can repeat (65, 65) and skip (64).
    queue_latency_ms keeps the engine's field name only: in 1.2.1 it is a running sum of time.time() differences in
    seconds (executor_request_queue.py:643-654), not one request's wait in ms."""
    ib, kv = stat.get("inflightBatchingStats") or {}, stat.get("kvCacheStats") or {}
    when = datetime.strptime(stat["timestamp"], "%m-%d-%Y %H:%M:%S.%f").replace(tzinfo=timezone.utc)  # container UTC
    return {"iter": stat["iter"], "ns": int(when.timestamp() * 1e6) * 1000, "latency_ms": stat.get("iterLatencyMS"),
            "scheduled": ib.get("numScheduledRequests"), "context_requests": ib.get("numContextRequests"),
            "context_tokens": ib.get("numCtxTokens"), "generation_requests": ib.get("numGenRequests"),
            "paused": ib.get("numPausedRequests"), "active": stat.get("numActiveRequests"),
            "new_active": stat.get("numNewActiveRequests"), "queued": stat.get("numQueuedRequests"),
            "completed": stat.get("numCompletedRequests"), "max_active": stat.get("maxNumActiveRequests"),
            "queue_latency_ms": stat.get("newActiveRequestsQueueLatencyMS"),
            "kv_used_blocks": kv.get("usedNumBlocks"), "kv_free_blocks": kv.get("freeNumBlocks"),
            "kv_max_blocks": kv.get("maxNumBlocks"), "tokens_per_block": kv.get("tokensPerBlock"),
            "kv_new_blocks": kv.get("allocNewBlocks"), "kv_reused_blocks": kv.get("reusedBlocks"),
            "kv_hit_rate": kv.get("cacheHitRate"), "gpu_mem_bytes": stat.get("gpuMemUsage")}


def parse_prometheus(text: str) -> dict[str, float]:
    """Prometheus text format -> {series: value}; series is the name plus its labels as written."""
    out = {}
    for line in text.splitlines():
        if line.startswith("#"):
            continue
        match = SAMPLE.match(line)
        if match:
            try:
                out[match.group(1) + (match.group(2) or "")] = float(match.group(3))
            except ValueError:
                pass
    return out


def published(container: dict, port: int) -> str | None:
    """127.0.0.1:<host port> that Docker publishes for the container's port (from 'ip:hostport->port/tcp')."""
    for mapping in container.get("ports", []):
        host, _, target = mapping.partition("->")
        if target == f"{port}/tcp":
            return host.replace("0.0.0.0", "127.0.0.1")
    return None


def host_path(source: str) -> str | None:
    """A host path under the repository -> the same file in the devtools container (/repo)."""
    repo_host, repo = os.environ.get("REPO_HOST"), os.environ.get("REPO", "/repo")
    if repo_host and source and source.startswith(repo_host):
        return repo + source[len(repo_host):]
    return None


def run_dir(c: dict) -> str | None:
    """The engine's run folder in this container: the host folder Compose mounts at /config."""
    for m in c.get("mounts", []):
        if m["destination"] == "/config":
            return host_path(m["source"])
    return None


def iter_stats_on(c: dict) -> bool:
    """The engine's config.yaml (mounted at /config) turns iteration stats on: the live run level."""
    local = run_dir(c)
    if local:
        try:
            return bool(ITER_STATS.search(open(f"{local}/config.yaml").read()))
        except OSError:
            return False
    return False


def raw_read(reader_seq: int, c: dict, start: tuple[int, int], end: tuple[int, int], status: int | None,
             body: str | None, response: list | None, error: str | None, first_seq: int | None) -> dict:
    """One /metrics read as saved: the response list exactly as returned (not turned into iterations, not
    deduplicated), or the body text when it is not a 200 JSON list. start/end are (wall ns, monotonic ns).
    first_seq is the Engine view's seq for the response's first entry."""
    return {"reader_seq": reader_seq, "container": c["name"], "container_id": c["id"],
            "read_start_ns": start[0], "read_end_ns": end[0], "read_start_mono_ns": start[1],
            "read_end_mono_ns": end[1], "status": status, "error": error,
            "empty": response == [] if response is not None else None,
            "entries": len(response) if response is not None else None, "first_seq": first_seq,
            "response": response, "body": body if response is None else None}


def now() -> tuple[int, int]:
    return time.time_ns(), time.monotonic_ns()


class EngineCollector:
    def __init__(self, bus):
        self.bus = bus
        self.history = {}  # container id -> deque of {ns, metrics}
        self.info = {}  # container id -> version, models, command, config
        self.iterations = {}  # container id -> deque of iteration(), for engines with iteration stats
        self.readers = {}  # container id -> the task reading its /metrics
        self.raw = {}  # container id -> {container, run_id, reads (deque of raw_read lines), dropped, reading, gone_ns}
        self.raw_listeners = []  # fn(run_id, line) per read, on the loop thread: the v3 live writer (store/stream.py)

    async def engines(self) -> list[dict]:
        state = self.bus.state.get(("containers", None))
        containers = state["data"] if state else []
        return [c for c in containers if c["service"] == "server" and c["state"] == "running"]

    async def scrape(self, session: aiohttp.ClientSession, c: dict) -> None:
        address = published(c, 8080)
        if address is None:
            return
        if c["id"] not in self.readers and iter_stats_on(c):
            # From the first sight of the container, before it is healthy: a rep's run can be over within seconds
            # of the health check passing, and the first read must already be waiting on the engine.
            self.readers[c["id"]] = asyncio.create_task(self.read_iterations(c, address))
        try:
            async with session.get(f"http://{address}/prometheus/metrics") as response:
                if response.status != 200:
                    return
                metrics = parse_prometheus(await response.text())
        except (aiohttp.ClientError, asyncio.TimeoutError):
            return  # still starting
        sample = {"ns": time.time_ns(), "metrics": metrics}
        self.history.setdefault(c["id"], collections.deque(maxlen=KEEP)).append(sample)
        folder = run_dir(c)
        self.bus.publish("engine_metrics", {"container": c["name"], "project": c["project"],
                                            "run_id": os.path.basename(folder) if folder else None, **sample},
                         key=c["id"])
        if c["id"] not in self.info and c.get("health") == "healthy":
            await self.describe(session, c, address)

    async def describe(self, session: aiohttp.ClientSession, c: dict, address: str) -> None:
        """The workload's fixed facts: engine version, model, command line, engine config."""
        info = {"container": c["name"], "project": c["project"], "command": c.get("command"), "address": address}
        for path in ("version", "v1/models"):
            try:
                async with session.get(f"http://{address}/{path}") as response:
                    info[path] = await response.json()
            except (aiohttp.ClientError, ValueError):
                info[path] = None
        for m in c.get("mounts", []):
            if m["destination"] == "/config":
                local = host_path(m["source"])
                try:
                    info["config"] = open(f"{local}/config.yaml").read() if local else None
                    info["run_dir"] = local
                except OSError:
                    info["config"] = None
            if m["destination"] == "/model":
                info["model_path"] = m["source"]
                info["model_revision"] = m["source"].rstrip("/").rsplit("/", 1)[-1]
        info["iter_stats"] = bool(info.get("config") and ITER_STATS.search(info["config"]))
        self.info[c["id"]] = info
        self.bus.publish("engine_info", info, key=c["id"])

    def keep_raw(self, cid: str, line: dict) -> None:
        """Append one read in reader order; a full buffer evicts its oldest read and counts it."""
        buffer = self.raw[cid]
        if len(buffer["reads"]) == buffer["reads"].maxlen:
            buffer["dropped"] += 1
        buffer["reads"].append(line)
        for fn in self.raw_listeners:
            fn(buffer["run_id"], line)

    def raw_reads(self, run_id: str | None = None, container: str | None = None) -> dict | None:
        """The raw reads of the engine for a run folder name (or a container name); the newest such engine."""
        found = [b for b in self.raw.values() if (run_id and b["run_id"] == run_id)
                 or (container and b["container"] == container)]
        if not found:
            return None
        b = max(found, key=lambda x: x["started_ns"])
        return {"run_id": b["run_id"], "container": b["container"], "reads": list(b["reads"]),
                "retained": len(b["reads"]), "dropped": b["dropped"], "reading": b["reading"]}

    def forget_raw(self) -> None:
        """Drop the raw reads of containers that stopped more than RETAIN_S ago."""
        cutoff = time.monotonic_ns() - RETAIN_S * 1_000_000_000
        for cid in [k for k, b in self.raw.items() if b["gone_ns"] is not None and b["gone_ns"] < cutoff]:
            del self.raw[cid]

    async def read_iterations(self, c: dict, address: str) -> None:
        """/metrics in a loop while the engine runs. Each read blocks ~2 s on the engine, so it has its own task.
        Until the server answers (model loading), a read fails and is retried every second.
        Every read, failed or empty included, is kept in self.raw (keep_raw) before it is published."""
        seq = 0  # arrival order: the view's key, since the engine's iter can repeat
        reads = 0  # reader sequence: one per /metrics read
        folder = run_dir(c)
        self.raw[c["id"]] = {"container": c["name"], "run_id": os.path.basename(folder) if folder else None,
                             "reads": collections.deque(maxlen=KEEP_READS), "dropped": 0, "reading": False,
                             "started_ns": time.monotonic_ns(), "gone_ns": None}
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            while c["id"] in {e["id"] for e in await self.engines()}:
                reads += 1
                start, status, body, stats, error = now(), None, None, None, None
                self.raw[c["id"]]["reading"] = True
                try:
                    async with session.get(f"http://{address}/metrics") as response:
                        status, body = response.status, await response.text()
                    stats = json.loads(body) if status == 200 else None
                except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as e:
                    error = f"{type(e).__name__}: {e}"
                self.raw[c["id"]]["reading"] = False
                self.keep_raw(c["id"], raw_read(reads, c, start, now(), status, body, stats, error,
                                                seq + 1 if stats else None))
                if stats is None:  # failed, or not a 200: retry in a second
                    await asyncio.sleep(1)
                    continue
                batch = []
                for stat in stats:  # the engine's order
                    seq += 1
                    batch.append({"seq": seq, **iteration(stat)})
                if batch:
                    self.iterations.setdefault(c["id"], collections.deque(maxlen=KEEP_ITERATIONS)).extend(batch)
                    self.bus.publish("engine_iterations", {"container": c["name"], "project": c["project"],
                                                           "read_ns": time.time_ns(), "iterations": batch},
                                     key=c["id"])
        self.raw[c["id"]].update(reading=False, gone_ns=time.monotonic_ns())
        self.readers.pop(c["id"], None)

    def targets(self, service: str, port: int) -> list[dict]:
        """Prometheus http_sd: every running container of a service, at its published port."""
        state = self.bus.state.get(("containers", None))
        out = []
        for c in state["data"] if state else []:
            address = published(c, port) if c["service"] == service and c["state"] == "running" else None
            if address:
                out.append({"targets": [address], "labels": {"project": c["project"], "container": c["name"]}})
        return out

    async def run(self) -> None:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=2)) as session:
            while True:
                await asyncio.gather(*(self.scrape(session, c) for c in await self.engines()))
                self.forget_raw()
                await asyncio.sleep(1)
