"""RunWriter: the one writer of a run folder in the ie-run/3 store while the run is live (COMMAND_CENTER.md section 6
step 5, "Live and replay are one path").

Rows arrive from the adapters (store/ingest.py tails the run folder; stream.Live hands over Docker, engine and NVML
records) and leave as the same CCVB blocks the importer writes: every append is one delta block (events or one sample
group) pushed to the stream subscribers, and every SEAL_S seconds (or BLOCK_ROWS rows) the unsealed rows are written
as immutable blocks with Parquet twins in g0/ and the manifest is replaced. A browser that loads the manifest and then
subscribes with have=<sealed seq> holds every row once. Eids are the adapters' own, so the final import gives every
live row back with the same eid.

Clock: a rep run's t0 and UTC - CLOCK_MONOTONIC offset are fixed at open and kept in capture/clock.json; the final
import reads them, so live and final rows share one t0 (a reopened run reuses the file).

Live rows and the final generation differ by rule, not by format:
  - id follows arrival order (a delta's rows are in (start, id) order; the total order stays (start, id)).
  - In a delta, tier is the kind's base tier, parent and cause are -1, and depth is greedy packing per lane.
  - At each seal (at most SEAL_S after a row arrives) parent, cause, tier and depth are derived over every held row
    by the importer's rules (derive.contain on the lanes that got rows, derive.message_links, derive.tiers,
    derive.depths). The seal frame carries the rows whose values changed (`derived`), and a sealed block holding such
    a row is rewritten under a new name, so the manifest and the browser agree.
  - Iterations, requests of an iteration, layers, serves links and calculated metrics come with the final import.

One writer per run folder: the lock file runs/<run>/.writer.lock is held with flock for the writer's life, and
store.importer takes the same lock, so an import never reads a half-written live run.
"""
from __future__ import annotations

import fcntl
import json
import math
import shutil
import time
from contextlib import contextmanager
from pathlib import Path

import duckdb
import numpy as np

from . import derive, probe
from .adapters.base import Ctx, Rows
from .adapters.docker import CAPTURE as DOCKER_CAPTURE, DockerEvents
from .adapters.engine import ITER_CAPTURE, EngineIterations, engine_series, engine_values
from .adapters.stamps import message_comp
from .importer import DOCKER_EVIDENCE, ENGINE_EVIDENCE, ENGINE_PROCESS, GPU_GROUP, component_things
from .registry import Registry
from .schema import BLOCK_ROWS, COLD, COLUMNS, METRIC_DTYPE, NONE16, SPINE_MAX_TIER, TIERS, Manifest, encode, etag, \
    write_atomic

SEAL_S = 10.0                  # the design's bound: a live row is in a sealed block at most 10 s after it arrives
LIVE_GEN = 0                   # the live rows are generation 0; the final import writes generation 1
KEEP_SEALS = 2                 # frames since the second-to-last seal are kept for subscribers that load late
ROTATE_BYTES = 64 * 2 ** 20    # a rolling run's capture file is renamed to <name>.prev.jsonl past this size
CLOCK = "capture/clock.json"
HOT = COLUMNS["events"]
COLD_TEXT = tuple(name for name, _ in COLD)


class WriterBusy(RuntimeError):
    """Another process or writer holds the run folder."""


@contextmanager
def run_lock(root: Path, wait: bool = False):
    """flock on runs/<run>/.writer.lock: one writer per run folder (live writer or import)."""
    root.mkdir(parents=True, exist_ok=True)
    f = open(root / ".writer.lock", "a+")
    try:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | (0 if wait else fcntl.LOCK_NB))
        except BlockingIOError:
            raise WriterBusy(f"{root.name}: another writer holds {root / '.writer.lock'}") from None
        yield
    finally:
        f.close()


def mono_offset_ns() -> int:
    """wall - monotonic now: converts a wall-clock time (file mtime, Docker timeNano) to the run clock."""
    return time.time_ns() - time.monotonic_ns()


class _Grow:
    """A numpy column with amortized append."""

    def __init__(self, dtype: str):
        self.a, self.n = np.empty(1024, np.dtype(dtype)), 0

    def extend(self, v: np.ndarray) -> None:
        need = self.n + len(v)
        if need > len(self.a):
            b = np.empty(max(need, 2 * len(self.a)), self.a.dtype)
            b[:self.n] = self.a[:self.n]
            self.a = b
        self.a[self.n:need] = v
        self.n = need

    def view(self) -> np.ndarray:
        return self.a[:self.n]


class SampleClock:
    """One sample group (one shared clock): catalog codes and the samples held. Each seal rewrites the group as one
    block under a new name (blocks are immutable), so a browser loads one block per group, not one per seal."""

    def __init__(self, name: str, metrics: list[str], codes: list[int]):
        self.name, self.metrics, self.codes = name, metrics, codes
        self.ts: list[int] = []
        self.values: list[list[float]] = [[] for _ in metrics]
        self.sealed = 0           # samples held at the last seal
        self.dropped = 0          # samples older than the rolling window (host run)
        self.dropped_since_seal = False
        self.block: str | None = None


class RunWriter:
    """The writer of one live run. All methods run on the event loop thread (the NVML threads hand records over with
    call_soon_threadsafe). publish(frame) is called with every outgoing frame: (seq, bytes | str).

    run_dir: the rep's run folder (None for the rolling host run). t0_ns: the run's t0 when no capture/clock.json
    holds one yet (a rep run: labels.json's write time; the host run: now)."""

    def __init__(self, store: Path, run: str, registry: Registry, t0_ns: int, source: dict,
                 run_dir: Path | None = None, stamped: bool = False, keep_s: float | None = None):
        self.root, self.run, self.reg = store / "runs" / run, run, registry
        self.source, self.keep_ns = source, int(keep_s * 1e9) if keep_s else None
        self._lock_cm = run_lock(self.root)
        self._lock_cm.__enter__()
        self.dir = self.root / f"g{LIVE_GEN}"
        shutil.rmtree(self.dir, ignore_errors=True)          # the run folder's files are the truth: rebuild from them
        self.dir.mkdir(parents=True)
        (self.root / "capture").mkdir(exist_ok=True)
        if keep_s:                                           # a rolling run starts a new capture; one previous is kept
            for f in (self.root / "capture").glob("*.jsonl"):
                if not f.name.endswith(".prev.jsonl"):
                    f.replace(f.with_name(f.stem + ".prev.jsonl"))
        self.clock = self._clock(int(t0_ns), run_dir is not None)
        self.t0 = self.clock["t0_ns"]
        self.ctx = Ctx(run, run_dir, registry, self.clock["wall_offset_ns"], stamped=stamped)
        self.docker = DockerEvents(self.ctx)
        self.engine_iterations = EngineIterations(self.ctx, f"capture/{ITER_CAPTURE}.jsonl")
        self.engine_series = engine_series(registry.metric_rules)
        self.metric_order = {g: [m for m, r in registry.metric_rules.items() if r.get("group") == g]
                             for g in ("docker", "engine")}
        self.kind_code = {k.kind: k.code for k in registry.kinds}
        self.base_tier = np.array([k.tier for k in registry.kinds], np.uint8)
        self.nest_bump = np.array([k.nest_bump for k in registry.kinds], bool)
        self.hot = {c.name: _Grow(c.dtype) for c in HOT}
        self.cold: dict[str, list] = {k: [] for k in COLD_TEXT}
        self.own_parent = _Grow("<i8")                         # the adapter's own parent (an Observed id), -1 none
        self.contain = _Grow("|b1")                            # takes part in time containment
        self.row_block = _Grow("<i4")                          # sealed rows: index into block_names
        self.block_names: list[str] = []
        self.block_rows: dict[str, np.ndarray] = {}            # sealed event block -> its row ids
        self.msg: list[tuple] = []                             # (request, component, name) per row, message links
        self.links: list[tuple[int, int, str]] = []            # the message links of the last seal
        self.derived_to = 0                                    # rows up to here took part in a seal's derivation
        self.derive_notes: dict = {}
        self.duplicates = 0
        self.n = self.sealed = 0
        self.names: list[str] = []
        self.name_ix: dict[str, int] = {}
        self.requests: list[str] = []
        self.req_ix: dict[str, int] = {}
        self.things: list[tuple] = []
        self.thing_ix: dict[str, int] = {}
        self.pre: list[int] = []
        self.post: list[int] = []
        self.parent_pos: list[int] = []
        self.eid_row: dict[str, int] = {}
        self.lane_ends: dict[int, list[float]] = {}           # lane -> per sub-row, the latest end placed on it
        self.clocks: dict[str, SampleClock] = {}
        self.catalog: list[dict] = []
        self.blocks: list[dict] = []
        self.frames: list[tuple[int, object]] = []
        self.seal_seqs: list[int] = [0]
        self.keep_from = 0                                     # frames with seq > keep_from are held
        self.stale: list[str] = []
        self.subscribers: set = set()
        self.seq = 0
        self.seal_no = 0
        self.last_seal = time.monotonic()
        self.things_dirty = self.catalog_dirty = False
        self.ended: dict | None = None
        self.notes: dict = {}                                  # set by the owner (Live): the NVML sampler's counters
        self.capture = {}
        self.capture_lines: dict[str, int] = {}                # capture file -> lines written (the next line number)
        comp_things, self.box_key = component_things(registry)
        for t in probe.inventory_things(registry, probe.load()) + comp_things:
            self.thing(*t)
        self.things_dirty = False
        self.aux_bytes = json.dumps({
            "metrics": [], "measures": registry.measures,
            "facts": {"missing": [], "live": {"source": source}},
            "unavailable": [{"what": "calculated metrics, serves links, iterations of untagged rows, kernel layers, "
                                     "engine records, Nsight Systems, PyTorch profiler and Nsight Compute rows",
                             "why": "they need run.json or files the rep writes at its end; the final import (next "
                                    "generation) adds them"}],
            "sources": [], "ncu": None, "clock": self.clock}, separators=(",", ":")).encode()
        (self.dir / "aux.json").write_bytes(self.aux_bytes)
        con = duckdb.connect()
        con.execute(f"""COPY (SELECT 0::UINTEGER AS "from", 0::UINTEGER AS "to", ''::VARCHAR AS kind,
            NULL::DOUBLE AS weight, ''::VARCHAR AS rule, ''::VARCHAR AS evidence WHERE false)
            TO '{self.dir}/links.parquet' (FORMAT parquet)""")
        self.write_manifest()

    def _clock(self, t0_ns: int, keep: bool) -> dict:
        """The run's t0 and wall offset: from capture/clock.json when this run was opened before (a backend
        restart reopens it), else fixed now and, for a rep run, written there for the final import."""
        p = self.root / CLOCK
        if keep and p.is_file():
            return json.loads(p.read_bytes())
        c = {"t0_ns": t0_ns, "wall_offset_ns": mono_offset_ns(), "opened_mono_ns": time.monotonic_ns(),
             "rule": ("t0: the rep's labels.json write time on CLOCK_MONOTONIC (its mtime minus the offset)" if keep
                      else "t0: the backend's start on CLOCK_MONOTONIC (the rolling host run)")
                     + "; wall_offset_ns: UTC - CLOCK_MONOTONIC read by the live writer at open"}
        if keep:
            write_atomic(p, json.dumps(c, indent=1).encode())
        return c

    # ------------------------------------------------------------------ dictionaries
    def sync_things(self) -> None:
        """Things the adapters named since the last append (Ctx.things: lanes, processes, containers)."""
        for key, (parent, kind, name, attrs, evidence) in self.ctx.things.items():
            if key not in self.thing_ix:
                self.thing(key, parent, kind, name, attrs, evidence)

    def thing(self, key: str, parent: str | None, kind: str, name: str, attrs: dict | None = None,
              evidence: str = "") -> int:
        """The index of a thing, added when new. Indexes never change; pre/post are recomputed (DFS by key)."""
        i = self.thing_ix.get(key)
        if i is not None:
            return i
        if len(self.things) >= NONE16:
            raise ValueError(f"{self.run}: more than {NONE16 - 1} things do not fit the <u2 lane column")
        i = self.thing_ix[key] = len(self.things)
        self.things.append((key, parent, kind, name, attrs or {}, evidence))
        order, parent_pos, post = derive.euler([t[0] for t in self.things], [t[1] for t in self.things])
        self.pre, self.post, self.parent_pos = [0] * len(order), [0] * len(order), [-1] * len(order)
        for pos, ti in enumerate(order):
            self.pre[ti] = pos
        for pos, ti in enumerate(order):
            self.post[ti] = post[pos]
            self.parent_pos[ti] = order[parent_pos[pos]] if parent_pos[pos] >= 0 else -1
        self.things_dirty = True
        return i

    def _code(self, table: list, index: dict, value: str) -> int:
        i = index.get(value)
        if i is None:
            i = index[value] = len(table)
            table.append(value)
        return i

    def things_json(self) -> list[dict]:
        return [{"i": i, "key": t[0], "parent": self.parent_pos[i], "kind": t[2], "name": t[3], "pre": self.pre[i],
                 "post": self.post[i], "attrs": t[4], "evidence": t[5]} for i, t in enumerate(self.things)]

    # ------------------------------------------------------------------ events
    def append(self, rows: Rows) -> None:
        """Adapter rows (store/adapters: absolute CLOCK_MONOTONIC ns, lane = thing key, the adapter's eid). A row whose
        eid is already held is a duplicate read: dropped and counted."""
        if not len(rows):
            return
        self.sync_things()
        c = rows.cols
        fresh, seen = [], set()
        for i, e in enumerate(c["eid"]):
            if e in self.eid_row or e in seen:
                self.duplicates += 1
            else:
                fresh.append(i)
                seen.add(e)
        if not fresh:
            return
        rows_ix = sorted(fresh, key=lambda i: c["start"][i])         # stable: equal starts keep emission order
        n0, k = self.n, len(rows_ix)
        at = {i: n0 + j for j, i in enumerate(rows_ix)}
        names0, reqs0 = len(self.names), len(self.requests)
        pick = lambda f: [c[f][i] for i in rows_ix]                   # noqa: E731
        start_abs, end_abs = np.array(pick("start"), np.int64), np.array(pick("end"), np.int64)
        start = (start_abs - self.t0).astype(np.float64)
        end = (np.maximum(end_abs, start_abs) - self.t0).astype(np.float64)
        lane_keys, kinds, names_s, reqs = pick("lane"), pick("kind"), pick("name"), pick("req")
        lane = np.array([self.thing_ix[x] for x in lane_keys], np.uint16)
        kind = np.array([self.kind_code[x] for x in kinds], np.uint8)
        name = np.array([self._code(self.names, self.name_ix, x) for x in names_s], np.uint32)
        req = np.array([NONE16 if not r else self._code(self.requests, self.req_ix, r) for r in reqs], np.uint16)
        box_s = pick("box")
        box = derive.boxes(self.reg.components["comp_rules"], [x.kind for x in self.reg.kinds], kind,
                           [t[0] for t in self.things], lane, self.names, name,
                           np.array([b or "" for b in box_s], dtype=object), set(self.box_key))
        comp = np.array([NONE16 if b is None else self.thing_ix[self.box_key[b]] for b in box.tolist()], np.uint16)
        depth = np.array([self._pack(int(lane[i]), start[i], end[i]) for i in range(k)], np.uint16)
        cols = {"id": np.arange(n0, n0 + k, dtype=np.uint32), "start": start, "end": end, "lane": lane, "comp": comp,
                "kind": kind, "tier": self.base_tier[kind], "depth": depth, "req": req,
                "iter": np.array(pick("iter"), np.int32), "parent": np.full(k, -1, np.int32),
                "cause": np.full(k, -1, np.int32), "name": name, "bytes": np.array(pick("bytes"), np.float64),
                "layer": np.full(k, -1, np.int16)}
        for col in HOT:
            self.hot[col.name].extend(cols[col.name])
        self.own_parent.extend(np.array([at.get(p, -1) if p >= 0 else -1 for p in pick("parent")], np.int64))
        self.contain.extend(np.array(pick("contain"), bool))
        sources = pick("source")
        self.msg += [(r, message_comp(kd, b, ln, s), nm) for r, kd, b, ln, s, nm in
                     zip(reqs, kinds, box_s, lane_keys, sources, names_s)]
        for j, i in enumerate(rows_ix):
            self.eid_row[c["eid"][i]] = n0 + j
        for f in COLD_TEXT:
            self.cold[f] += pick(f)
        self.n += k
        dd = {}
        if len(self.names) > names0:
            dd["names"] = {"from": names0, "add": self.names[names0:]}
        if len(self.requests) > reqs0:
            dd["requests"] = {"from": reqs0, "add": self.requests[reqs0:]}
        self._dicts(dd)
        info = {"table": "events", "block": "live", "band": "live", "gen": LIVE_GEN, "rows": k, "base_rows": n0,
                "t": [float(start.min()), float(start.max()), float(end.max())],
                "tier_counts": np.bincount(cols["tier"], minlength=len(TIERS)).tolist(), "dict_delta": dd,
                "metrics": [], **self._stamp()}
        self._publish(encode(info, [(c.name, c.dtype, cols[c.name]) for c in HOT]))

    def _pack(self, lane: int, s: float, e: float) -> int:
        """Greedy sub-row: the lowest sub-row whose rows all end at or before s; an instant occupies none."""
        ends = self.lane_ends.setdefault(lane, [])
        d = next((k for k, last in enumerate(ends) if last <= s), len(ends))
        if e > s:
            if d == len(ends):
                ends.append(e)
            else:
                ends[d] = max(ends[d], e)
        return min(d, 0xFFFF)

    def _dicts(self, dd: dict) -> None:
        if self.things_dirty:
            dd["things"] = self.things_json()
            self.things_dirty = False
        if self.catalog_dirty:
            dd["metrics"] = self.catalog
            self.catalog_dirty = False

    def _stamp(self) -> dict:
        """Times of the frame: the run-clock head and the writer's wall and monotonic ns at encode."""
        mono, wall = time.monotonic_ns(), time.time_ns()
        return {"seq": self.seq + 1, "head_ns": float(mono - self.t0), "wall_ns": wall, "mono_ns": mono}

    def _publish(self, payload) -> None:
        self.seq += 1
        self.frames.append((self.seq, payload))
        for q in list(self.subscribers):
            if q.full():
                self.subscribers.discard(q)                 # a stuck browser reloads; the writer never waits
                continue
            q.put_nowait((self.seq, payload))

    # ------------------------------------------------------------------ samples
    def sample_clock(self, clock: str, metrics: list[str], thing: str, units: dict, evidence: str) -> SampleClock:
        c = self.clocks.get(clock)
        if c is not None:
            return c
        codes = []
        for m in metrics:
            rule = self.reg.metric_rules.get(m, {})
            codes.append(len(self.catalog))
            self.catalog.append({"code": len(self.catalog), "metric": m, "label": rule.get("label", m),
                                 "unit": rule.get("unit", units.get(m)), "thing": self.thing_ix.get(thing, -1),
                                 "group": f"samples-{clock}", "sidebar": bool(rule.get("sidebar", False)),
                                 "source": rule.get("source", evidence), "period_ms": rule.get("period_ms"),
                                 "period_ns_measured": None, "evidence": evidence})
        c = self.clocks[clock] = SampleClock(clock, metrics, codes)
        self.catalog_dirty = True
        return c

    def add_samples(self, clock: SampleClock, mono_ns: int, values: dict, raw: dict | None, capture: str) -> None:
        """One read of one clock: kept, appended to capture/<capture>.jsonl (raw) and pushed as a samples delta."""
        if raw is not None:
            self._capture(capture, raw)
        clock.ts.append(int(mono_ns))
        for j, m in enumerate(clock.metrics):
            clock.values[j].append(float(values.get(m, math.nan)))
        rel = float(mono_ns - self.t0)
        dd = {}
        self._dicts(dd)
        info = {"table": "samples", "block": f"samples-{clock.name}", "band": "samples", "gen": LIVE_GEN, "rows": 1,
                "base_rows": 0, "t": [rel, rel, rel], "tier_counts": [0] * len(TIERS), "dict_delta": dd,
                "metrics": clock.codes, "group": f"samples-{clock.name}", **self._stamp()}
        self._publish(encode(info, [("ts", COLUMNS["samples"][0].dtype, np.array([rel]))] +
                             [(f"m{j}", METRIC_DTYPE, np.array([v[-1]])) for j, v in enumerate(clock.values)]))

    def _capture(self, name: str, rec: dict) -> int:
        """Append one record to capture/<name>.jsonl. Returns its 0-based line, the number LineTail gives it when
        the importer reads the file (so a row's raw pointer is the same live and final)."""
        f = self.capture.get(name)
        if f is not None and self.keep_ns and f.tell() > ROTATE_BYTES:
            f.close()
            p = self.root / "capture" / f"{name}.jsonl"
            p.replace(p.with_name(f"{name}.prev.jsonl"))
            f, self.capture_lines[name] = None, 0
        if f is None:
            p = self.root / "capture" / f"{name}.jsonl"
            if name not in self.capture_lines:                 # a reopened run appends to its earlier capture
                self.capture_lines[name] = sum(1 for _ in p.open("rb")) if p.is_file() else 0
            f = self.capture[name] = open(p, "a", buffering=1)
        f.write(json.dumps(rec, separators=(",", ":")) + "\n")
        line = self.capture_lines[name]
        self.capture_lines[name] = line + 1
        return line

    # ------------------------------------------------------------------ collector records
    def docker_event(self, rec: dict) -> None:
        """One Docker event {mono_ns, container, action, ...}: captured, then a row through adapters/docker.py (the
        importer reads the capture through the same adapter)."""
        line = self._capture(DOCKER_CAPTURE, rec)
        self.append(self.docker.feed([{**rec, "line": line}]))

    def docker_stats(self, name: str, mono_ns: int, values: dict) -> None:
        thing = self.ctx.thing(f"host/{name}", "host", "container", name, {}, "Observed: Docker Engine API")
        self.sync_things()
        c = self.sample_clock(f"docker-{name}", self.metric_order["docker"], thing, {}, DOCKER_EVIDENCE)
        self.add_samples(c, mono_ns, values, {"mono_ns": mono_ns, "container": name, **values}, "docker-stats")

    def engine_metrics(self, container: str, mono_ns: int, metrics: dict) -> None:
        """One /prometheus/metrics scrape: the registry's engine series (summed over label sets) as samples; the
        whole scrape is captured."""
        values, _ = engine_values(metrics, self.engine_series)
        thing = self.ctx.container(ENGINE_PROCESS)
        self.sync_things()
        c = self.sample_clock("engine", self.metric_order["engine"], thing, {}, ENGINE_EVIDENCE)
        self.add_samples(c, mono_ns, values, {"mono_ns": mono_ns, "container": container, "metrics": metrics}, "engine")

    def engine_read(self, read: dict) -> None:
        """One raw /metrics read of the engine collector (iteration stats): captured, then rows through
        adapters/engine.py EngineIterations."""
        line = self._capture(ITER_CAPTURE, read)
        self.append(self.engine_iterations.feed([{**read, "line": line}]))

    def gpu_reads(self, reads: list[tuple[int, int, dict]]) -> None:
        """nvidia-smi lines of the rep's gpu.csv (adapters/gpu.py parse): the group samples-gpu0-nvidia-smi."""
        if not reads:
            return
        rule = self.reg.sources["run_json"]["samples"][0]
        c = self.sample_clock(GPU_GROUP, sorted(rule["units"]), rule["thing"], rule["units"], rule["evidence"])
        for _, ns, values in reads:
            self.add_samples(c, ns, values, None, "")

    # ------------------------------------------------------------------ sealing
    def maybe_seal(self) -> None:
        if self.n - self.sealed >= BLOCK_ROWS or time.monotonic() - self.last_seal >= SEAL_S:
            self.seal()

    def seal(self) -> None:
        """Derive parent, cause, tier and depth over the held rows; write the unsealed rows, and every sealed block
        holding a row whose values changed, as immutable blocks (CCVB + Parquet); replace the manifest."""
        self.last_seal = time.monotonic()
        wrote, stale = False, []
        changed = self._derive() if self.n > self.derived_to else np.zeros(0, np.int64)
        old = changed[changed < self.sealed]
        redo = sorted(set(self.row_block.view()[old].tolist()))
        if self.n > self.sealed or redo:
            ids = [self.block_rows.pop(self.block_names[b]) for b in redo] + [np.arange(self.sealed, self.n)]
            gone = {self.block_names[b] for b in redo}
            self.blocks = [b for b in self.blocks if b["name"] not in gone]
            stale += sorted(gone)
            self._seal_events(np.concatenate(ids))
            self.sealed = self.n
            wrote = True
        patch = None
        if len(changed):
            h = {k: self.hot[k].view()[changed] for k in ("parent", "cause", "tier", "depth")}
            patch = {"ids": changed.tolist(), **{k: v.tolist() for k, v in h.items()}}
        for c in self.clocks.values():
            if self.keep_ns:
                self._roll(c)
            if len(c.ts) != c.sealed or c.dropped_since_seal:
                stale += [c.block] if c.block else []
                self._seal_samples(c)
                wrote = True
        if wrote:
            self.seal_no += 1
            self.seal_seqs.append(self.seq)
            self.write_manifest()
            self._unlink(self.stale)                        # replaced one seal ago: no manifest names them now
            self.stale = stale
            self.keep_from = self.seal_seqs[-KEEP_SEALS] if len(self.seal_seqs) >= KEEP_SEALS else 0
            self.frames = [f for f in self.frames if f[0] > self.keep_from]
            self._publish(json.dumps({"type": "seal", "seq": self.seq + 1, "generation": LIVE_GEN,
                                      "sealed_rows": self.sealed, "blocks": [b["name"] for b in self.blocks],
                                      **({"derived": patch} if patch else {})}))

    def _unlink(self, names: list[str]) -> None:
        """The files of replaced blocks: <name>.ccvb, and events-<name>.parquet (events) or <name>.parquet (samples)."""
        for name in names:
            for f in (f"{name}.ccvb", f"events-{name}.parquet", f"{name}.parquet"):
                (self.dir / f).unlink(missing_ok=True)

    def _derive(self) -> np.ndarray:
        """The importer's derivations over the held rows (rows of other lanes keep their values): containment parents
        on the lanes that got rows since the last seal, message links (ZMQ, network) as causes, tiers, depths on those
        lanes. Writes the new values into the hot columns; returns the ids whose parent, cause, tier or depth changed."""
        n = self.n
        h = {k: self.hot[k].view() for k in ("lane", "start", "end", "kind", "tier", "depth", "parent", "cause")}
        lane, start, end, kind = h["lane"], h["start"], h["end"], h["kind"]
        touched = np.isin(lane, np.unique(lane[self.derived_to:n]))
        own = self.own_parent.view()
        parent = np.where(touched, own, h["parent"]).astype(np.int64)
        parent, crossing = derive.contain(lane, start, end, touched & self.contain.view(), parent)
        order = np.lexsort((np.arange(n), start)).tolist()
        mi = [i for i in order if self.msg[i][1] is not None and self.msg[i][0]]
        links = derive.message_links([self.msg[i][0] for i in mi], [self.msg[i][1] for i in mi],
                                     [self.msg[i][2] for i in mi])
        self.links = [(mi[a], mi[b], k) for a, b, k in links]
        cause_links = [x for x in self.links if self.reg.link_kind(x[2]).cause]
        notes = {"crossing (not nested)": crossing}
        try:
            cause = derive.causes(n, np.array([x[0] for x in cause_links], np.int64),
                                  np.array([x[1] for x in cause_links], np.int64))
        except derive.RowError as e:
            cause, notes["causes kept from the last seal"] = h["cause"].copy(), f"{e.what}: row {self.cold['eid'][e.row]}"
        try:
            tier = derive.tiers(kind, parent, self.base_tier, self.nest_bump)
        except derive.RowError as e:
            tier, notes["tiers kept from the last seal"] = h["tier"].copy(), f"{e.what}: row {self.cold['eid'][e.row]}"
        depth = h["depth"].copy()
        on = np.flatnonzero(touched)
        local = np.full(n, -1, np.int64)
        local[on] = np.arange(len(on))
        sub_parent = np.where(parent[on] >= 0, local[np.maximum(parent[on], 0)], -1)
        try:
            depth[on] = derive.depths(lane[on], start[on], end[on], sub_parent)
        except derive.RowError as e:
            notes["depths kept from the last seal"] = f"{e.what}: row {self.cold['eid'][int(on[e.row])]}"
        changed = np.flatnonzero((parent != h["parent"]) | (cause != h["cause"]) | (tier != h["tier"]) |
                                 (depth != h["depth"]))
        for i in changed.tolist():
            if parent[i] >= 0 and own[i] < 0:
                self.cold["parent_rule"][i] = derive.CONTAIN_RULE
            elif parent[i] < 0 and own[i] < 0:
                self.cold["parent_rule"][i] = None
        h["parent"][:] = parent
        h["cause"][:] = cause
        h["tier"][:] = tier
        h["depth"][:] = depth
        self.derived_to, self.derive_notes = n, notes
        return changed

    def _seal_events(self, ids: np.ndarray) -> None:
        """Rows (new, and those of rewritten blocks) as blocks of this seal: per band, in (start, id) order."""
        hot = {c.name: self.hot[c.name].view() for c in HOT}
        ids = ids[np.lexsort((ids, hot["start"][ids]))]
        band = np.where(hot["tier"][ids] <= SPINE_MAX_TIER, 0, 1)
        for b, band_name in enumerate(("spine", "fine")):
            rows = ids[band == b]
            chunks = range(0, len(rows), BLOCK_ROWS)
            for k in chunks:
                part = rows[k:k + BLOCK_ROWS]
                name = f"live-{band_name}-{self.seal_no:04d}" + (f"-{k // BLOCK_ROWS}" if len(chunks) > 1 else "")
                self._write_block(name, band_name, part, hot)

    def _write_block(self, name: str, band: str, rows: np.ndarray, hot: dict) -> None:
        cols = {k: v[rows] for k, v in hot.items()}
        info = {"table": "events", "block": name, "band": band, "gen": LIVE_GEN, "rows": len(rows), "base_rows": 0,
                "t": [float(cols["start"].min()), float(cols["start"].max()), float(cols["end"].max())],
                "tier_counts": np.bincount(cols["tier"], minlength=len(TIERS)).tolist(), "dict_delta": {},
                "metrics": []}
        data = encode(info, [(c.name, c.dtype, cols[c.name]) for c in HOT])
        (self.dir / f"{name}.ccvb").write_bytes(data)
        ids = rows.tolist()
        cold = {k: np.array([self.cold[k][i] for i in ids], dtype=object) for k in COLD_TEXT}
        con = duckdb.connect()
        con.register("rows", {**cols, **cold})
        sel = ", ".join([f'"{c.name}"' for c in HOT] + [f'CAST("{k}" AS {t}) AS "{k}"' for k, t in COLD])
        con.execute(f"""COPY (SELECT {sel} FROM rows ORDER BY start, id) TO '{self.dir}/events-{name}.parquet'
            (FORMAT parquet, COMPRESSION zstd)""")
        self.blocks.append(_entry(info, data))
        self.block_names.append(name)
        self.block_rows[name] = rows
        need = int(rows.max()) + 1 - self.row_block.n
        if need > 0:
            self.row_block.extend(np.full(need, -1, np.int32))
        self.row_block.view()[rows] = len(self.block_names) - 1

    def _seal_samples(self, c: SampleClock) -> None:
        ts = np.array(c.ts, np.int64)
        vals = [np.array(v, np.float64) for v in c.values]
        rel = (ts - self.t0).astype(np.float64)
        name = f"samples-{c.name}.{self.seal_no:04d}"
        self.blocks = [b for b in self.blocks if b["name"] != c.block]
        if not len(ts):
            c.block, c.sealed, c.dropped_since_seal = None, 0, False
            return
        info = {"table": "samples", "block": name, "band": "samples", "gen": LIVE_GEN, "rows": len(ts), "base_rows": 0,
                "t": [float(rel[0]), float(rel[-1]), float(rel[-1])], "tier_counts": [0] * len(TIERS),
                "dict_delta": {}, "metrics": c.codes}
        data = encode(info, [("ts", COLUMNS["samples"][0].dtype, rel)] +
                      [(f"m{j}", METRIC_DTYPE, v) for j, v in enumerate(vals)])
        (self.dir / f"{name}.ccvb").write_bytes(data)
        con = duckdb.connect()
        con.register("rows", {"ts_ns": ts, **dict(zip(c.metrics, vals))})
        con.execute(f"COPY rows TO '{self.dir}/{name}.parquet' (FORMAT parquet, COMPRESSION zstd)")
        self.blocks.append({**_entry(info, data), "group": f"samples-{c.name}", "metrics": c.codes})
        c.block, c.sealed, c.dropped_since_seal = name, len(c.ts), False
        gaps = np.diff(ts)
        for code in c.codes:
            self.catalog[code]["period_ns_measured"] = float(np.median(gaps)) if len(gaps) else None

    def _roll(self, c: SampleClock) -> None:
        """Rolling run (host): samples older than keep_ns before now leave memory and the next block. Event rows
        stay (ids are dense from 0; the host run's rows are container events, a few per rep)."""
        k = int(np.searchsorted(np.array(c.ts, np.int64), time.monotonic_ns() - self.keep_ns))
        if k:
            c.ts, c.values = c.ts[k:], [v[k:] for v in c.values]
            c.dropped += k
            c.sealed = max(0, c.sealed - k)
            c.dropped_since_seal = True

    # ------------------------------------------------------------------ manifest
    def manifest(self, status: str = "live") -> Manifest:
        kinds = np.bincount(self.hot["kind"].view()[:self.sealed], minlength=len(self.reg.kinds))
        return Manifest(
            run=self.run, generation=LIVE_GEN, status=status, t0_ns=self.t0,
            head_ns=float(time.monotonic_ns() - self.t0), tiers=list(TIERS),
            kinds=[{"code": k.code, "name": k.kind, "tier": k.tier, "nest_bump": k.nest_bump, "derived": k.derived,
                    "color": k.color, "label": k.label, "home": k.home} for k in self.reg.kinds],
            link_kinds=[{"code": k.code, "name": k.kind, "cause": k.cause, "label": k.label}
                        for k in self.reg.link_kinds],
            things=self.things_json(), names=list(self.names), requests=list(self.requests), metrics=self.catalog,
            blocks=list(self.blocks), aux={"name": "aux.json", "bytes": len(self.aux_bytes), "etag": etag(self.aux_bytes)},
            source=self.source, tools={}, inputs_sig="live",
            import_stats={"rows": self.sealed, "kinds": {self.reg.kinds[k].kind: int(c) for k, c in enumerate(kinds) if c},
                          "tier_counts": np.bincount(self.hot["tier"].view()[:self.sealed], minlength=len(TIERS)).tolist(),
                          "live": {"seq": self.seq, "sealed_rows": self.sealed, "rows": self.n, "seal_s": SEAL_S,
                                   "rule": "id = arrival order. A delta row has the kind's base tier, parent and cause "
                                           "-1 and greedy depth; each seal derives parent (time containment), cause "
                                           "(ZMQ and network message links), tier and depth by the importer's rules",
                                   "derivation": {**self.derive_notes, "message links": len(self.links),
                                                  "rows with a parent": int((self.hot["parent"].view() >= 0).sum()),
                                                  "rows with a cause": int((self.hot["cause"].view() >= 0).sum())},
                                   "duplicate rows dropped": self.duplicates, "clock": self.clock,
                                   "samples": {c.name: {"held": len(c.ts), "dropped": c.dropped}
                                               for c in self.clocks.values()},
                                   **self.notes,
                                   **({"ended": self.ended} if self.ended else {})}})

    def write_manifest(self) -> None:
        write_atomic(self.root / "manifest.json", self.manifest().to_json())

    # ------------------------------------------------------------------ readers
    def subscribe(self, have: int, q) -> None:
        """Queue every frame after `have` (the manifest's import.live.seq), then a caught_up frame, then every later
        one. A browser whose manifest is older than the frames kept gets a reload frame."""
        if have < self.keep_from:
            q.put_nowait((self.seq, json.dumps({"type": "reload", "why": f"frames after seq {have} are no longer held"})))
            return
        for seq, payload in self.frames:
            if seq > have:
                q.put_nowait((seq, payload))
        # the browser builds its views after this frame: they start from everything the writer holds
        q.put_nowait((self.seq, json.dumps({"type": "caught_up", "seq": self.seq})))
        self.subscribers.add(q)

    def detail(self, ids: list[int]) -> list[dict]:
        out = []
        h = {c.name: self.hot[c.name].view() for c in HOT}

        def brief(j: int) -> dict:
            return {"id": j, "kind": self.reg.kinds[h["kind"][j]].kind, "tier": int(h["tier"][j]),
                    "name": self.names[h["name"][j]], "start": float(h["start"][j]), "end": float(h["end"][j])}
        for i in ids:
            if not 0 <= i < self.n:
                raise ValueError(f"row id {i} is outside 0..{self.n - 1}")
            g = {k: v[i].item() for k, v in h.items()}
            c = {k: self.cold[k][i] for k in COLD_TEXT}
            chain, p = [], g["parent"]
            while p >= 0:
                chain.append(brief(p))
                p = int(h["parent"][p])
            out.append({
                "id": i, "eid": c["eid"], "kind": self.reg.kinds[g["kind"]].kind, "tier": g["tier"],
                "name": self.names[g["name"]], "start": g["start"], "end": g["end"], "lane": self.things[g["lane"]][0],
                "comp": None if g["comp"] == NONE16 else self.things[g["comp"]][0],
                "req": None if g["req"] == NONE16 else self.requests[g["req"]], "iter": None if g["iter"] < 0 else g["iter"],
                "depth": g["depth"], "bytes": None if math.isnan(g["bytes"]) else g["bytes"], "what": c["what"],
                "args": json.loads(c["args"]) if c["args"] else None, "evidence": c["evidence"], "term": c["term"],
                "source": c["source"], "corr": c["corr"], "quirk": c["quirk"], "parent_rule": c["parent_rule"],
                "layer": None, "code": None,
                "raw": {"file": c["raw_file"], "pointer": c["raw_ptr"]} if c["raw_file"] else None,
                "parents": chain, "cause": brief(g["cause"]) if g["cause"] >= 0 else None,
                "links": [{"from": a, "to": b, "kind": k, "weight": None, "rule": derive.MESSAGE_RULE,
                           "evidence": "Calculated"} for a, b, k in self.links if i in (a, b)],
                "metrics": [], "counters": None, "open": {"nsys": None, "ncu": None}, "live": True})
        return out

    def resolve(self, eids: list[str]) -> list[int]:
        return [self.eid_row[e] for e in eids if e in self.eid_row]

    def raw_target(self, i: int) -> tuple[str | None, str, str] | None:
        """(run folder relative to REPO or None, file, pointer); a capture/ file sits in the store run's folder."""
        f, p = self.cold["raw_file"][i], self.cold["raw_ptr"][i]
        return (self.source.get("run_dir"), f, p) if f else None

    def close(self, ended: dict) -> None:
        """Seal what is held, write the manifest with why the run ended, release the run folder."""
        self.ended = ended
        self.seal()
        self.write_manifest()
        self._unlink(self.stale)         # no later seal deletes them; g0 stays beside the final generation as is
        self.stale = []
        for f in self.capture.values():
            f.close()
        self._lock_cm.__exit__(None, None, None)


def _entry(info: dict, data: bytes) -> dict:
    return {"name": info["block"], "table": info["table"], "band": info["band"], "rows": info["rows"], "t": info["t"],
            "tier_counts": info["tier_counts"], "bytes": len(data), "etag": etag(data)}
