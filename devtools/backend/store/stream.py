"""Live runs (COMMAND_CENTER_V3_DESIGN.md step 5): RunWatcher, the host run, the NVML sampler, and the stream socket.

RunWatcher. Every SCAN_S it looks for run folders ($REPO/reps/*/results/<run>/labels.json):
  - labels.json appears (the rep started): a live run opens. RunWriter in the store, RunSources (store/ingest.py)
    tailing the folder every POLL_S; NVML samples, Docker events and stats, the engine's Prometheus scrape and its
    iteration-stat reads from then on (each also kept in the run's capture/ for the final import).
  - run.json appears (the rep ended): the sources are read to the end, the writer seals and closes, and the final
    import (store/importer.py) writes the next generation. A generation frame then tells every browser to reload.
  - At start, a folder with labels.json and no run.json, written in the last FRESH_S, is reopened live (rebuilt from
    its files); one with run.json whose store manifest is still live gets its final import.
The host run ("host") is always open: NVML samples, Docker events and stats, engine scrapes between and during reps,
rolling HOST_KEEP_S.

WS /api/v3/stream?run=&have=   frames after seq `have` (the manifest's import.live.seq), then every new one:
  binary  a CCVB delta block (events, or one sample group); header seq, head_ns, wall_ns, mono_ns, dict_delta
  text    {"type": "seal" | "generation" | "status" | "reload", ...}
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

from aiohttp import WSMsgType, web

from .adapters.ncu import labels as read_labels
from .importer import CC_STORE, NVML_EVIDENCE
from .ingest import RunSources
from .live import SEAL_S, RunWriter, WriterBusy, mono_offset_ns
from .registry import Registry
from .schema import Manifest

REPO = Path(os.environ.get("REPO", "/repo"))
BACKEND = Path(__file__).resolve().parents[1]
POLL_S = 0.02            # stamp files and pcaps are read every 20 ms
SCAN_S = 1.0             # new run folders are looked for every second
FRESH_S = 600            # at start, only folders written in the last 10 minutes are reopened live
HOST_RUN = "host"
HOST_KEEP_S = 1800       # the host run holds the last 30 minutes of samples
QUEUE = 16384            # frames queued per browser; a browser that falls this far behind is dropped and reloads.
                         # The replay at connect is up to 20 s of frames (two seals): about 100 sample frames/s
                         # (NVML, docker stats) plus up to 50 event frames/s, so about 3000; the rest is headroom


class Live:
    def __init__(self, bus, registry: Registry | None = None, engine=None):
        self.bus, self.reg, self.engine = bus, registry or Registry.load(), engine
        self.runs: dict[str, dict] = {}          # run -> {writer, sources, dir, reads (engine reader_seqs held)}
        self.ended: dict[str, dict] = {}         # run -> the generation (or status) frame its browsers get
        self.host: RunWriter | None = None
        self.sampler = None
        self.status: dict = {"nvml": None}
        self.containers: dict[str, str] = {}     # container id (12) -> name
        self.seen: set[str] = set()              # run folders that existed at start or were already handled
        self.loop: asyncio.AbstractEventLoop | None = None
        if engine is not None:
            engine.raw_listeners.append(self.engine_read)

    # ------------------------------------------------------------------ writers
    def writer(self, run: str) -> RunWriter | None:
        if run == HOST_RUN:
            return self.host
        r = self.runs.get(run)
        return r["writer"] if r else None

    def writers(self) -> list[RunWriter]:
        """The host run and every rep run that still takes records."""
        return [w for w in [self.host, *(r["writer"] for r in self.runs.values() if not r.get("closing"))] if w]

    def open_run(self, run_dir: Path) -> None:
        run = run_dir.name
        st = (run_dir / "labels.json").stat()
        t0 = st.st_mtime_ns - mono_offset_ns()
        try:
            w = RunWriter(CC_STORE, run, self.reg, t0, {"run_dir": str(run_dir.relative_to(REPO)), "importer": None,
                                                        "live": "RunWatcher"},
                          run_dir=run_dir, stamped=read_labels(run_dir).get("stamps") is True)
        except WriterBusy as e:
            self.bus.publish("event", {"source": "devtools", "action": f"live run {run}: {e}"})
            return
        self.declare_clocks(w)
        self.runs[run] = {"writer": w, "sources": RunSources(run_dir, w.ctx), "dir": run_dir, "reads": set()}
        held = self.engine.raw_reads(run_id=run) if self.engine is not None else None
        for read in (held or {}).get("reads", []):     # reads the collector took before the folder was seen
            self.engine_read(run, read)
        self.bus.publish("event", {"source": "devtools", "action": f"live run {run} opened"})

    async def close_run(self, run: str) -> None:
        """The rep wrote run.json: read the sources to the end, seal and close, then the final import."""
        r = self.runs[run]
        w, src = r["writer"], r["sources"]
        got = await asyncio.to_thread(src.read, True)
        w.append(src.rows(got, final=True))
        w.gpu_reads(got["gpu"])
        r["closing"] = True                            # no more records: the writer is about to release the folder
        self.note(w, force=True)
        w.close({"why": "run.json written", "at_mono_ns": time.monotonic_ns()})
        frame = await self.final_import(run)
        del self.runs[run]
        self.ended[run] = frame
        w._publish(json.dumps(frame))
        w.subscribers.clear()

    async def final_import(self, run: str) -> dict:
        """store.importer in its own process: the import is pure Python for seconds (8 s for a timeline run) and, on a
        thread here, held the GIL so the NVML threads read up to 1.3 s late (measured 2026-11-08)."""
        t = time.perf_counter()
        p = await asyncio.create_subprocess_exec(sys.executable, "-m", "store.importer", run, cwd=BACKEND,
                                                 stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, err = await p.communicate()
        if p.returncode != 0:
            why = (err.decode(errors="replace").strip().splitlines() or [f"exit {p.returncode}"])[-1]
            self.bus.publish("event", {"source": "devtools", "action": f"final import {run}: {why}"})
            return {"type": "status", "status": "ended", "error": why}
        m = Manifest.load(CC_STORE / "runs" / run / "manifest.json")
        self.bus.publish("event", {"source": "devtools", "action": f"final import {run}: g{m.generation}"})
        return {"type": "generation", "generation": m.generation, "status": m.status, "t0_ns": m.t0_ns,
                "import_s": round(time.perf_counter() - t, 2)}

    # ------------------------------------------------------------------ samples
    def declare_clocks(self, w: RunWriter) -> None:
        """Every NVML clock in the writer's catalog from the start, so a browser that opens the run early lists them."""
        if not self.sampler:
            return
        for g in self.sampler.groups:
            w.sample_clock(g.name, g.metrics, "gpu0", {m: self.reg.metric_rules.get(m, {}).get("unit") for m in g.metrics},
                           NVML_EVIDENCE)
        w.write_manifest()

    def note(self, w: RunWriter, force: bool = False) -> None:
        """The sampler's counters (reads, empty GPM windows, errors with their times) go into the next manifest."""
        if self.sampler and (force or time.monotonic() - w.last_seal >= SEAL_S):   # right before a seal: one copy each
            w.notes["nvml_sampler"] = self.sampler.stats.snapshot()

    def nvml_record(self, rec: dict) -> None:
        """Sampler thread -> event loop: one NVML read to the host run and every live run."""
        self.loop.call_soon_threadsafe(self._nvml, rec)

    def _nvml(self, rec: dict) -> None:
        metrics = list(rec["values"])
        units = {m: self.reg.metric_rules.get(m, {}).get("unit") for m in metrics}
        for w in self.writers():
            c = w.clocks.get(rec["group"]) or w.sample_clock(rec["group"], metrics, "gpu0", units, NVML_EVIDENCE)
            w.add_samples(c, rec["mono_ns"], rec["values"], rec, "gpu")

    def start_sampler(self) -> None:
        from .nvml import NvmlSampler, registry_groups
        try:
            self.sampler = NvmlSampler(registry_groups(self.reg.metric_rules), self.nvml_record)
            self.status["gpu_name"] = self.sampler.n.nvmlDeviceGetName(self.sampler.h)
            self.status["nvml"] = {"groups": {g.name: g.period_ns / 1e6 for g in self.sampler.groups}}
        except Exception as e:                    # no NVML: the host run and live runs carry no GPU samples, and say so
            self.status["nvml"] = {"error": f"{type(e).__name__}: {e}"}
            self.bus.publish("event", {"source": "devtools", "action": f"NVML sampler: {e}"})

    async def bus_feed(self) -> None:
        """Docker events -> rows, Docker stats and engine scrapes -> samples, in the host run and every live rep run
        (an engine scrape goes to the rep run whose folder the engine mounts)."""
        q = self.bus.subscribe({"event", "stats", "containers", "engine_metrics"})
        while True:
            msg = await q.get()
            d = msg["data"]
            if msg["topic"] == "containers":
                self.containers = {c["id"]: c["name"] for c in d}
            elif msg["topic"] == "event" and isinstance(d, dict) and d.get("source") == "docker" and d.get("container"):
                t = int(d["time_ns"]) - mono_offset_ns() if d.get("time_ns") else msg["mono_ns"]
                for w in self.writers():
                    w.docker_event({"mono_ns": t, **d})
            elif msg["topic"] == "stats" and d and msg["key"] in self.containers:
                values = {f"docker.{k}": float(d[k]) for k in ("cpu_pct", "mem_bytes", "rx_rate", "tx_rate")
                          if isinstance(d.get(k), (int, float))}
                for w in self.writers():
                    w.docker_stats(self.containers[msg["key"]], msg["mono_ns"], values)
            elif msg["topic"] == "engine_metrics" and d:
                for w in self.writers():
                    if w is self.host or w.run == d.get("run_id"):
                        w.engine_metrics(d["container"], msg["mono_ns"], d["metrics"])

    def engine_read(self, run_id: str | None, read: dict) -> None:
        """The engine collector's raw /metrics read (iteration stats), for the rep run whose folder its engine
        mounts. Called on the loop thread by the collector (EngineCollector.raw_listeners), once per read."""
        r = self.runs.get(run_id or "")
        if r is None or r.get("closing") or read["reader_seq"] in r["reads"]:
            return
        r["reads"].add(read["reader_seq"])
        r["writer"].engine_read(read)

    # ------------------------------------------------------------------ watcher
    def folders(self) -> list[Path]:
        return [p.parent for p in REPO.glob("reps/*/results/*/labels.json")]

    async def run(self) -> None:
        self.loop = asyncio.get_running_loop()
        self.start_sampler()
        self.host = RunWriter(CC_STORE, HOST_RUN, self.reg, time.monotonic_ns(),
                              {"run_dir": None, "importer": None, "live": "host run (rolling)"}, keep_s=HOST_KEEP_S)
        self.declare_clocks(self.host)
        if self.sampler:
            self.sampler.start()
        feed = asyncio.create_task(self.bus_feed())
        try:
            await self.recover()
            last_scan = 0.0
            while True:
                if time.monotonic() - last_scan >= SCAN_S:
                    last_scan = time.monotonic()
                    for d in await asyncio.to_thread(self.folders):
                        if d.name in self.seen:
                            continue
                        self.seen.add(d.name)                 # labels.json appeared: the rep started
                        if (d / "run.json").exists():         # it also ended within one scan: import, no live rows
                            asyncio.create_task(self._import_only(d.name))
                        else:
                            self.open_run(d)
                for run, r in list(self.runs.items()):
                    if r.get("closing") is not None:
                        continue
                    if (r["dir"] / "run.json").exists():
                        r["closing"] = False                  # polled no more; close_run reads to the end
                        asyncio.create_task(self.close_run(run))
                        continue
                    w, src = r["writer"], r["sources"]
                    got = await asyncio.to_thread(src.read)
                    w.append(src.rows(got))
                    w.gpu_reads(got["gpu"])
                    self.note(w)
                    w.maybe_seal()
                self.note(self.host)
                self.host.maybe_seal()
                await asyncio.sleep(POLL_S)
        finally:
            feed.cancel()
            if self.sampler:
                self.sampler.close()

    async def _import_only(self, run: str) -> None:
        self.ended[run] = await self.final_import(run)

    async def recover(self) -> None:
        """Folders present at start: reopen a fresh one still running, import one that ended while the backend was
        down mid-run; every other folder is history and is never opened live."""
        now = time.time()
        for d in await asyncio.to_thread(self.folders):
            self.seen.add(d.name)
            p = CC_STORE / "runs" / d.name / "manifest.json"
            try:
                status = json.loads(p.read_bytes())["status"] if p.is_file() else None
            except ValueError:
                status = None
            if (d / "run.json").exists():
                if status == "live":                       # the backend stopped between the run's end and its import
                    self.ended[d.name] = await self.final_import(d.name)
            elif now - d.stat().st_mtime < FRESH_S:
                self.open_run(d)


# ---------------------------------------------------------------------- socket
async def stream(request: web.Request) -> web.WebSocketResponse:
    live: Live = request.app["live"]
    run = request.query.get("run", "")
    try:
        have = int(request.query.get("have", "0"))
    except ValueError:
        raise web.HTTPBadRequest(text="have must be an integer frame sequence") from None
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    w = live.writer(run)
    if w is None:
        await ws.send_str(json.dumps(live.ended.get(run) or {"type": "status", "status": "not live"}))
        await ws.close()
        return ws
    q: asyncio.Queue = asyncio.Queue(maxsize=QUEUE)
    w.subscribe(have, q)

    async def pump():
        while True:
            _, payload = await q.get()
            if isinstance(payload, bytes):
                await ws.send_bytes(payload)
            else:
                await ws.send_str(payload)
                if json.loads(payload).get("type") in ("generation", "reload"):
                    await ws.close()
                    return

    task = asyncio.create_task(pump())
    try:
        async for msg in ws:                    # the browser sends nothing; this ends when it goes away
            if msg.type == WSMsgType.ERROR:
                break
    finally:
        task.cancel()
        w.subscribers.discard(q)
    return ws


def add_routes(router) -> None:
    router.add_get("/api/v3/stream", stream)
