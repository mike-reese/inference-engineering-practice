"""The final import: a run folder -> the next ie-run/3 generation (COMMAND_CENTER.md section 6 "Live and replay are
one path"). Reads the run folder and the run's capture/ files in the store; nothing from prototypes/ or ie-run/2.

Every source is read by its adapter (store/adapters), the parser the live writer feeds as the files grow, so a row
the live path wrote has the same eid in the final generation:
  client/<request id>.json, client/client_stamps.jsonl   client rows (adapters/client.py)
  trace/server_stamps.jsonl                             component stamps (adapters/stamps.py)
  <run>_s<n>.pcap                                        network frames, every TCP frame (adapters/wire.py)
  engine_records.json, native_records.json              engine timestamps (adapters/engine.py)
  engine_iterations_raw.jsonl (or capture/)             engine iteration stats (adapters/engine.py)
  trace/*.sqlite                                        Nsight Systems rows and GPU metrics (adapters/nsys.py)
  trace/torch_trace.json                                PyTorch profiler rows (adapters/torch.py)
  capture/docker.jsonl                                  container events and startup spans (adapters/docker.py)
  server_s<n>.log                                       engine startup phases (adapters/server_log.py)
  gpu.csv; capture/gpu.jsonl, docker-stats.jsonl, engine.jsonl   samples (nvidia-smi, NVML, Docker stats, Prometheus)
  run.json spans prometheus/*                           samples-prometheus, the rep's own scrapes (adapters/prometheus.py)
  trackers/*.jsonl, gpu_apps.jsonl                      host, NVMe, uncore and GPU process samples, process starts
                                                        (adapters/trackers.py)
  the kernels-level run's trace/kernels.csv, sections.csv        Nsight Compute headline counters (adapters/ncu.py)
  $CC_STORE/probe/inventory.json                        host and GPU things (store/probe.py, probed once)
  the reference run's rows in the store                 inferred module rows (store/modules.py, registry modules.json)
Then the derivations of derive.py: containment parents, cause links, tiers, derived iterations, iterations, requests,
component boxes, depth, decoder layers.

Guard: every run.json span of a source these adapters read (client, wire, engine, stamps, nvidia-smi samples) must
come out as a row or a sample with the same span id; otherwise the import stops and names the span. run.json spans
of nsys and the PyTorch profiler are superseded by the full imports above (counted, not matched).

Clock: one t0 per run across its generations (live and final). A run the live writer opened takes the t0 and the
UTC - CLOCK_MONOTONIC offset it recorded at open (capture/clock.json); any other run keeps the t0 of its previous
generation, or the earliest row's start on a first import. The offset for UTC sources (pcap, nsys, PyTorch) is the
live writer's, else the anchor pair of the first client record (sorted by name), as src clock_offset.

Idempotent: a run whose inputs signature (its files, capture/ files, the probe, registry and code, and the store
generation of a run it reads: the timeline run of a kernels-level run, the reference of module inference) matches its
manifest is skipped. The run's lock (live.run_lock) is held while importing. Generation g+1 is written to
g<n>.tmp/, renamed to g<n>/, and the manifest is replaced last. The previous generation stays and older ones are
deleted, so a live run's g0 stays beside its first final generation (store-check compares their eids).

Usage: python -m store.importer [--all | RUN ...] [--force]
Env: CC_STORE (the store root), REPO (the checkout whose reps/*/results/ hold run folders).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import resource
import shutil
import sys
import time
from pathlib import Path

import duckdb
import numpy as np

from . import derive, modules, probe
from .adapters.base import Ctx, LineTail, Rows, slug
from .adapters.client import STAMPS_FILE, ClientRecords, ClientStamps
from .adapters.docker import CAPTURE as DOCKER_CAPTURE, DockerEvents
from .adapters.engine import ITER_CAPTURE, ITER_FILE, EngineIterations, EngineRecords, engine_series, engine_values
from .adapters.gpu import FILE as GPU_CSV, TRACK as GPU_TRACK, CsvTail, parse as parse_gpu
from .adapters.ncu import NcuHeadline, labels as read_labels, profile_run_for, timeline_run_for
from .adapters.nsys import FORWARD_STEP, Nsys
from .adapters.prometheus import series as prometheus_series
from .adapters.server_log import ServerLog
from .adapters.stamps import (FILE as STAMPS, INFERRED_ITERATION_BOX, MESSAGE_SOURCES, SRC, ServerStamps,
                              add_iteration, message_comp)
from .adapters.torch import Torch
from inference_analysis.trace.adapters.torch_trace import forward_stamps  # noqa: E402
from .adapters.trackers import Trackers
from .adapters.wire import PcapReader, Wire
from .registry import Registry
from .schema import (BLOCK_ROWS, COLD, COLUMNS, DEVICE_TIER, METRIC_DTYPE, NONE16, SPINE_MAX_TIER, TIERS, Manifest,
                     encode, etag, write_atomic)

CC_STORE = Path(os.environ.get("CC_STORE", "/mnt/ie-data/cc/store"))
HERE = Path(__file__).resolve().parent
CODE = ["schema.py", "registry.py", "derive.py", "importer.py", "modules.py", "probe.py",
        *(f"adapters/{p.name}" for p in sorted((HERE / "adapters").glob("*.py")))]
SRC_CODE = ["schema.py", *(f"adapters/{x}.py" for x in ("client", "common", "components", "engine", "gpu", "wire"))]
FACT_FILES = ("labels.json", "config.yaml", "basis.json", "topology.json", "latency.json", "perf_metrics.json",
              "efficiency.json")
CLOCK = "capture/clock.json"
SERVER_LOG = re.compile(r"server_s\d+\.log")
NVML_CAPTURE = "capture/gpu.jsonl"
NVML_EVIDENCE = ("Observed: NVML (nvidia-ml-py) read by the devtools backend while the run was live (store/nvml.py), "
                 "CLOCK_MONOTONIC at the read's return; capture/gpu.jsonl of the run in the store")
DOCKER_STATS = "capture/docker-stats.jsonl"
DOCKER_EVIDENCE = "Observed: Docker Engine stats stream (one document a second), CLOCK_MONOTONIC at receipt"
ENGINE_CAPTURE = "capture/engine.jsonl"
ENGINE_EVIDENCE = ("Observed: the engine's /prometheus/metrics, scraped once a second by the devtools engine "
                   "collector, CLOCK_MONOTONIC at receipt; series summed over their label sets")
ENGINE_PROCESS = "server"     # the engine's samples sit on its container (registry lanes: process prefix "server")
GPU_GROUP = re.sub(r"[^A-Za-z0-9]+", "-", GPU_TRACK).strip("-")   # gpu.csv samples: group samples-gpu0-nvidia-smi
SUPERSEDED = ("nsys/", "torch/", "ncu/")
# The observer whose clock stamps a metric input row (D13's Metrics tab "clock"), by the row's adapter source; any other
# source is its own observer. A sample input's observer is its sample group (one clock per group, 6.3).
OBSERVER = {"client_records": "client", "client_stamps": "client", "pcap": "wire", "engine_records": "engine"}
ROW_GROUP = 4096


class ImportStop(RuntimeError):
    """The run cannot be imported without guessing. The message names the row, span or input."""


def find_run_dir(repo: Path, run: str) -> Path:
    hits = sorted(repo.glob(f"reps/*/results/{run}"))
    if len(hits) != 1:
        raise ImportStop(f"{run}: expected one run folder under {repo}/reps/*/results/, found {len(hits)}")
    return hits[0]


# ---------------------------------------------------------------------- clock
def clock(run_dir: Path, root: Path) -> dict:
    """{wall_offset_ns, t0_ns (None: not fixed yet), rule}."""
    p = root / CLOCK
    if p.is_file():
        c = json.loads(p.read_bytes())
        return {"wall_offset_ns": int(c["wall_offset_ns"]), "t0_ns": int(c["t0_ns"]),
                "rule": f"{CLOCK}: t0 and UTC - CLOCK_MONOTONIC offset the live writer recorded at open"}
    for f in sorted((run_dir / "client").glob("*.json")):
        try:
            rec = json.loads(f.read_bytes())
        except ValueError:
            continue
        if isinstance(rec, dict) and "anchor_pair" in rec:
            a = rec["anchor_pair"]
            return {"wall_offset_ns": int(a["utc_ns"]) - int(a["monotonic_ns"]), "t0_ns": None,
                    "rule": f"anchor pair of client/{f.name}, the first client record by name (src clock_offset)"}
    raise ImportStop(f"{run_dir.name}: no {CLOCK} and no client record with an anchor pair: the UTC sources (pcap, "
                     "nsys, PyTorch) cannot be put on the run clock")


# ---------------------------------------------------------------------- signature, generations
def inputs_signature(run_dir: Path, root: Path, reg: Registry, profile_run: Path | None, tie: dict | None,
                     reference: dict | None) -> str:
    h = hashlib.sha256()
    paths = [p for p in sorted(run_dir.rglob("*")) if p.is_file() and (p.suffix != ".log" or SERVER_LOG.fullmatch(p.name))]
    paths += sorted((root / "capture").glob("*")) if (root / "capture").is_dir() else []
    paths += [probe.CACHE]
    if profile_run is not None:
        paths += [profile_run / f for f in ("labels.json", "prompt.json", "trace/kernels.csv", "trace/sections.csv")]
        h.update(profile_run.name.encode())
    if tie is not None:
        h.update(f"{tie['run']}\0{tie['generation']}".encode())
    if reference is not None:
        h.update(f"modules\0{reference['run']}\0{reference['generation']}".encode())
    for p in paths:
        if p.is_file():
            st = p.stat()
            h.update(f"{p}\0{st.st_size}\0{st.st_mtime_ns}\n".encode())
    h.update(reg.digest.encode())
    for f in CODE:
        h.update((HERE / f).read_bytes())
    for f in SRC_CODE:
        h.update((SRC / "inference_analysis" / "trace" / f).read_bytes())
    return h.hexdigest()[:20]


def import_run(run_dir: Path, reg: Registry, out_root: Path = CC_STORE, repo: Path | None = None,
               force: bool = False) -> Manifest | None:
    """The next generation of the run, or None when its inputs are unchanged. Raises ImportStop."""
    root = out_root / "runs" / run_dir.name
    from .live import WriterBusy, run_lock
    try:
        with run_lock(root):
            return _import(run_dir, root, reg, repo or run_dir.parents[3], force)
    except WriterBusy as e:
        raise ImportStop(f"{run_dir.name}: the run is being written live ({e})") from None


def timeline_tie(run_dir: Path, runs: Path) -> dict | None:
    """A kernels-level run's tie to its timeline run, as that run's import wrote it in the store: {run, generation,
    kernels (its manifest tools.ncu.kernels), event_eids (the tied kernel rows, in profile row order)}. None when the run
    has no timeline run, or that run's manifest does not tie this run's counters."""
    t = timeline_run_for(run_dir)
    mp = runs / t.name / "manifest.json" if t else None
    if mp is None or not mp.is_file():
        return None
    m = json.loads(mp.read_bytes())
    ncu = m.get("tools", {}).get("ncu") or {}
    if ncu.get("run") != run_dir.name or not ncu.get("kernels"):
        return None
    prof = runs / t.name / f"g{m['generation']}" / "profiles.parquet"
    eids = duckdb.sql(f"SELECT event_eid FROM read_parquet('{prof}') WHERE event_eid IS NOT NULL "
                      "GROUP BY profile_row, event_eid ORDER BY profile_row").fetchall()
    return {"run": t.name, "generation": m["generation"], "kernels": ncu["kernels"], "event_eids": [e for (e,) in eids]}


def module_reference(run_dir: Path, runs: Path, reg: Registry) -> dict | None:
    """The run whose module frames give this run its inferred modules (registry modules.json, by rep folder), as the
    store holds it: {run, generation}, generation None while it is not in the store. None for the reference itself
    and for a rep with no reference."""
    ref = reg.sources["modules"]["reference"].get(run_dir.parent.parent.name)
    if ref is None or ref == run_dir.name:
        return None
    mp = runs / ref / "manifest.json"
    return {"run": ref, "generation": json.loads(mp.read_bytes())["generation"] if mp.is_file() else None}


def load_references(root: Path, reg: Registry) -> list[modules.Reference]:
    """The reference run's distinct forward steps from its store generation: per device row with an iteration, in
    start order, its match key and the module forward() frames above its launch call (the python call place rule
    'module forward' of kinds.json)."""
    m = json.loads((root / "manifest.json").read_bytes())
    events = f"{root}/g{m['generation']}/events-*.parquet"
    t = duckdb.sql(f"SELECT kind, iter, parent, cause, name FROM read_parquet('{events}') ORDER BY id").fetchnumpy()
    names, kind_of = m["names"], {k["code"]: k["name"] for k in m["kinds"]}
    code = {v: k for k, v in kind_of.items()}
    rx = re.compile(reg.kind("python call").place["execution"]["match"])
    is_frame = (t["kind"] == code["python call"]) & np.array([bool(rx.match(x)) for x in names], bool)[t["name"]]
    device = [code[k.kind] for k in reg.kinds if k.tier == DEVICE_TIER]
    parent, cause = t["parent"], t["cause"]
    steps: dict[int, list] = {}
    for x in np.flatnonzero(np.isin(t["kind"], device) & (t["iter"] >= 0)).tolist():
        chain, p = [], parent[cause[x]] if cause[x] >= 0 else -1
        while p >= 0:
            if is_frame[p]:
                chain.append(int(p))
            p = parent[p]
        key = modules.match_key(kind_of[int(t["kind"][x])], names[t["name"][x]])
        steps.setdefault(int(t["iter"][x]), []).append((key, chain[::-1]))
    ids = sorted({f for rows in steps.values() for _, chain in rows for f in chain})
    eid = dict(duckdb.execute(f"SELECT id, eid FROM read_parquet('{events}') WHERE id IN (SELECT unnest(?))",
                              [ids]).fetchall())
    return modules.references(sorted(steps.items()), {f: (names[t["name"][f]], eid[f]) for f in ids})


def add_modules(src: Rows, ctx: Ctx, reg: Registry, reference: dict, runs: Path) -> tuple[list[int], dict]:
    """Inferred module rows (store/modules.py RULE) for the device rows of each forward step (their source
    iteration, as the reference's). Appends the rows to src and makes each the parent of the device rows it holds.
    Returns (per new row, its first device row) and the import stats."""
    c = src.cols
    device = {k.kind for k in reg.kinds if k.tier == DEVICE_TIER}
    steps: dict[int, list[int]] = {}
    for i, (k, it) in enumerate(zip(c["kind"], c["iter"])):
        if k in device and it >= 0:
            steps.setdefault(it, []).append(i)
    stats = {"rule": modules.EVIDENCE, "reference": reference, "rows": 0, "forward steps": len(steps)}
    if not steps:
        return [], stats
    if reference["generation"] is None:
        return [], stats | {"not inferred": f"the reference run {reference['run']} is not in the store; import it, "
                                            "then this run"}
    refs = load_references(runs / reference["run"], reg)
    if not refs:
        raise ImportStop(f"{ctx.run}: the module reference {reference['run']} has no forward step with device rows")
    short: dict[str, str] = {}

    def key(i: int) -> str:
        name = c["name"][i]
        if c["kind"][i] == "kernel":
            f = c["full_name"][i] or name
            name = short[f] if f in short else short.setdefault(f, derive.kernel_short_name(f))
        return modules.match_key(c["kind"][i], name)

    matches: dict[tuple, modules.Match] = {}
    first, shapes, held_rows = [], {}, 0
    for it, rows in sorted(steps.items()):
        rows.sort(key=lambda i: (c["start"][i], i))
        keys, lanes = tuple(key(i) for i in rows), tuple(c["lane"][i] for i in rows)
        m = matches.get((keys, lanes))
        if m is None:
            m = matches[keys, lanes] = modules.infer(refs, keys, lanes)
        row_of: dict[int, int] = {}
        for f, pos in m.frames:
            frame, held = m.reference.frames[f], [rows[p] for p in pos]
            up = frame.parent
            while up >= 0 and up not in row_of:
                up = m.reference.frames[up].parent
            base = frame.name.rsplit("/", 1)[-1].split(":")[0]
            row_of[f] = src.add(
                start=c["start"][held[0]], end=max(c["end"][i] for i in held), lane=c["lane"][held[0]],
                kind="inferred module", name=frame.name, req=c["req"][held[0]], iter=it,
                eid=ctx.eid("module/inferred/i{it}/{base}", it=it, base=slug(base)),
                what=f"The GPU runs {base} ({len(held)} device {'row' if len(held) == 1 else 'rows'}), matched to the "
                     "code run's module.",
                args={"reference": {"run": reference["run"], "iteration": m.reference.iteration, "eid": frame.eid},
                      "device rows": len(held)},
                term="module forward (inferred)", source="derived", evidence=modules.EVIDENCE,
                parent=row_of[up] if up >= 0 else -1, parent_rule=modules.PARENT_RULE if up >= 0 else None,
                contain=False)
            first.append(held[0])
            for i in held:
                c["parent"][i], c["parent_rule"][i] = row_of[f], modules.PARENT_RULE
        n_held = len({p for _, pos in m.frames for p in pos})
        held_rows += n_held
        shape = (m.reference.iteration, len(rows), m.pairs, len(m.frames), len(rows) - n_held)
        shapes[shape] = shapes.get(shape, 0) + 1
    return first, stats | {
        "rows": len(first), "device rows in forward steps": sum(len(r) for r in steps.values()),
        "device rows in a module": held_rows,
        "forward steps by shape": [{"reference iteration": a, "device rows": b, "pairs": p, "modules": q,
                                    "device rows in no module": u, "steps": k}
                                   for (a, b, p, q, u), k in sorted(shapes.items())]}


def _import(run_dir: Path, root: Path, reg: Registry, repo: Path, force: bool) -> Manifest | None:
    profile_run = profile_run_for(run_dir)
    tie = timeline_tie(run_dir, root.parent)
    reference = module_reference(run_dir, root.parent, reg)
    sig = inputs_signature(run_dir, root, reg, profile_run, tie, reference)
    old = Manifest.load(root / "manifest.json") if (root / "manifest.json").is_file() else None
    if old and old.inputs_sig == sig and not force:
        return None
    gen = (old.generation if old else 0) + 1
    for stale in root.glob("g*.tmp"):
        shutil.rmtree(stale)
    tmp = root / f"g{gen}.tmp"
    tmp.mkdir(parents=True)
    try:
        manifest = _build(run_dir, root, reg, repo, tmp, gen, sig, old, profile_run, tie, reference)
        os.replace(tmp, root / f"g{gen}")
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    write_atomic(root / "manifest.json", manifest.to_json())
    for d in root.glob("g*"):
        if d.is_dir() and d.name[1:].isdigit() and int(d.name[1:]) < gen - 1:
            shutil.rmtree(d)                   # the previous generation stays (a live run's g0 until its next import)
    return manifest


# ---------------------------------------------------------------------- sources
def read_sources(ctx: Ctx, run_dir: Path, root: Path, labels: dict, rj: dict,
                 notes: dict) -> tuple[Rows, list, dict, list]:
    """Every source's rows (concatenated in this order: the source order of equal starts), launch links, the
    request of an iteration (engine records), and sample series. rj: the run's run.json ({} without one)."""
    rows, links, series = Rows(), [], []

    def take(adapter, got: Rows) -> None:
        base = len(rows)
        rows.extend(got)
        for a, b in getattr(adapter, "links", []):
            links.append((base + a, base + b))

    cr = ClientRecords(ctx)
    take(cr, cr.feed(cr.read(run_dir)))
    if ctx.stamped:
        cs, tail = ClientStamps(ctx), LineTail(run_dir / STAMPS_FILE)
        take(cs, cs.feed(tail.read(final=True)))
        take(cs, cs.flush())
        notes["client stamps unreadable lines"] = tail.bad
    er = EngineRecords(ctx)
    take(er, er.read(run_dir))
    it_file = run_dir / ITER_FILE if (run_dir / ITER_FILE).is_file() else root / "capture" / f"{ITER_CAPTURE}.jsonl"
    if it_file.is_file():
        rel = ITER_FILE if it_file.parent == run_dir else f"capture/{ITER_CAPTURE}.jsonl"
        ei, tail = EngineIterations(ctx, rel), LineTail(it_file)
        take(ei, ei.feed(tail.read(final=True)))
        notes["engine iterations"] = {"file": rel, "unreadable lines": tail.bad}
    if (run_dir / STAMPS).is_file():
        ss, tail = ServerStamps(ctx), LineTail(run_dir / STAMPS)
        take(ss, ss.feed(tail.read(final=True)))
        notes["server stamps unreadable lines"] = tail.bad
        notes["stamp iteration offset"] = _offset_check(ss, er)
    w = Wire(ctx)
    for pcap in sorted(run_dir.glob("*.pcap")):
        take(w, w.feed([(pcap.name, k, utc, raw) for k, utc, raw in PcapReader(pcap).read()]))
    take(w, w.flush())
    dbs = sorted(run_dir.glob("trace/*.sqlite"))
    if len(dbs) > 1:
        raise ImportStop(f"{run_dir.name}: {len(dbs)} Nsight Systems exports in trace/; one report per run")
    nsys = None
    if dbs:
        nsys = Nsys(ctx, er.request_of)
        take(nsys, nsys.read(dbs[0]))
        rule = reg_samples(ctx.reg, "nsys")
        for name, (ts, v) in nsys.samples.items():
            m = re.search(rule["unit_from_name"], name)
            series.append({"track": rule["match"]["track"], "metric": name, "thing": rule["thing"],
                           "unit": m.group(1) if m else None, "evidence": rule["evidence"], "ts": ts, "values": v})
    if (run_dir / "trace" / "torch_trace.json").is_file():
        first = int(str(labels.get("profile_range") or "1-0").split("-")[0])
        torch = Torch(ctx, er.request_of, first, forward_stamps(run_dir / STAMPS))
        take(torch, torch.read(run_dir / "trace" / "torch_trace.json"))
        notes["torch"] = torch.stats
    de, dk = DockerEvents(ctx), root / "capture" / f"{DOCKER_CAPTURE}.jsonl"
    if dk.is_file():
        take(de, de.feed(LineTail(dk).read(final=True)))
        take(de, de.flush())
    sl = ServerLog(ctx, de.health)
    for log in sorted(p for p in run_dir.glob("server_s*.log") if SERVER_LOG.fullmatch(p.name)):
        take(sl, sl.read(log))
    if (run_dir / GPU_CSV).is_file():
        rule = reg_samples(ctx.reg, "run_json")
        reads = parse_gpu(CsvTail(run_dir / GPU_CSV).read(final=True))
        for m in rule["units"]:
            kept = [r for r in reads if m in r[2]]
            if kept:
                series.append({"track": rule["match"]["track"], "metric": m, "thing": rule["thing"],
                               "unit": rule["units"][m], "evidence": rule["evidence"],
                               "ts": np.array([r[1] for r in kept], np.int64),
                               "values": np.array([r[2][m] for r in kept], np.float64),
                               "spans": {f"gpu/sample/{r[0]}": k for k, r in enumerate(kept)}})
    series += prometheus_series(ctx, rj.get("spans", []))
    tr = Trackers(run_dir, ctx)
    got = tr.read(final=True)
    take(tr.procs, tr.rows(got))
    tracked = tr.samples(got)
    notes["trackers unreadable lines"] = tr.unreadable()
    notes["nsys session"] = None if nsys is None else nsys.session_utc_ns
    return rows, links, {"engine": er, "nsys": nsys, "trackers": (tr.clocks, tracked)}, series


def reg_samples(reg: Registry, source: str) -> dict:
    return reg.sources[source]["samples"][0]


def _offset_check(ss: ServerStamps, er: EngineRecords) -> dict:
    """The registry's fixed stamp iteration offset (loop + 1) against src's per-request one (first_iter - the loop
    counter of the request's first scheduler stamp), for every request with both."""
    first, off = ss.first_loop, ss.offset
    diff = {rid: a - first[rid] for rid, a, _ in er.windows if rid in first and a - first[rid] != off}
    return {"rule": f"iteration = loop counter + {off} (registry run_json.json iteration_from)",
            "requests checked": sum(rid in first for rid, _, _ in er.windows), "requests that differ": diff}


# ---------------------------------------------------------------------- samples
def sample_groups(series: list[dict], reg: Registry, pos_of: dict) -> tuple[list[dict], list[dict]]:
    """Series that share a source track and identical timestamps form one group (one samples block)."""
    by_key: dict[tuple, dict] = {}
    for s in sorted(series, key=lambda s: (s["metric"], s["thing"])):
        if s["evidence"] not in reg.sample_tracks:
            raise ImportStop(f"sample metric {s['metric']!r} has evidence {s['evidence']!r}, which no registry "
                             "samples rule declares")
        key = (s["track"], hashlib.sha256(s["ts"].astype(np.int64).tobytes()).hexdigest())
        g = by_key.setdefault(key, {"track": s["track"], "ts": s["ts"].astype(np.int64), "metrics": [], "values": [],
                                    "series": []})
        g["metrics"].append(s["metric"])
        g["values"].append(s["values"].astype(np.float64))
        g["series"].append(s)
    groups = sorted(by_key.values(), key=lambda g: (g["track"], g["metrics"][0]))
    per_track: dict[str, int] = {}
    for g in groups:
        per_track[g["track"]] = per_track.get(g["track"], 0) + 1
    catalog, seen = [], {}
    for g in groups:
        slug = re.sub(r"[^A-Za-z0-9]+", "-", g["track"]).strip("-")
        k = seen[slug] = seen.get(slug, -1) + 1
        g["name"] = f"samples-{slug}" + (f"-{k}" if per_track[g["track"]] > 1 else "")
        g["codes"] = []
        for s in g["series"]:
            rule = reg.metric_rules.get(s["metric"], {})
            catalog.append(_catalog(len(catalog), s["metric"], rule, s["unit"], pos_of.get(s["thing"], -1), g,
                                    s["evidence"]))
    return groups, catalog


def _catalog(code: int, metric: str, rule: dict, unit, thing: int, g: dict, evidence: str) -> dict:
    g["codes"].append(code)
    gaps = np.diff(g["ts"])
    return {"code": code, "metric": metric, "label": rule.get("label", metric), "unit": rule.get("unit", unit),
            "thing": thing, "group": g["name"], "sidebar": bool(rule.get("sidebar", False)),
            "source": rule.get("source", evidence), "period_ms": rule.get("period_ms"),
            "period_ns_measured": float(np.median(gaps)) if len(gaps) else None,
            "evidence": rule.get("evidence", evidence)}


def read_captures(root: Path, ctx: Ctx) -> tuple[dict, dict]:
    """The sample records the live writer captured, and the things they sit on (a container per Docker stats
    stream, the server container for the engine scrape)."""
    caps, stats = {}, {}
    for rel in (NVML_CAPTURE, DOCKER_STATS, ENGINE_CAPTURE):
        if (root / rel).is_file():
            tail = LineTail(root / rel)
            caps[rel] = tail.read(final=True)
            stats[rel] = {"records": len(caps[rel]), "unreadable lines": tail.bad}
    keep = {name: ctx.docker_container(name) for name in sorted({r["container"] for r in caps.get(DOCKER_STATS, [])})}
    if DOCKER_STATS in caps:
        caps[DOCKER_STATS] = [r for r in caps[DOCKER_STATS] if keep[r["container"]]]
        caps["docker things"] = {k: v for k, v in keep.items() if v}
    if caps.get(ENGINE_CAPTURE):
        caps["engine thing"] = ctx.container(ENGINE_PROCESS)
    return caps, stats


def capture_groups(caps: dict, stats: dict, reg: Registry, pos_of: dict, catalog: list) -> list[dict]:
    """Samples the live writer captured: NVML (one group per sampler clock), Docker stats (one per container),
    the engine's Prometheus scrape (one group). The same group names and metric order as the live writer."""
    groups = []

    def read(rel: str) -> list[dict]:
        return caps.get(rel, [])

    def group(name: str, recs: list, metrics: list[str], thing: str, evidence: str) -> None:
        recs = sorted(recs, key=lambda r: r[0])
        g = {"track": name, "name": f"samples-{name}", "ts": np.array([t for t, _ in recs], np.int64),
             "metrics": metrics, "codes": [],
             "values": [np.array([v.get(m, np.nan) for _, v in recs], np.float64) for m in metrics]}
        for m in metrics:
            catalog.append(_catalog(len(catalog), m, reg.metric_rules.get(m, {}), None, pos_of.get(thing, -1), g,
                                    evidence))
        groups.append(g)

    order = {grp: [m for m, r in reg.metric_rules.items() if r.get("group") == grp] for grp in ("nvml", "docker",
                                                                                                 "engine")}
    if NVML_CAPTURE in caps:
        by: dict[str, list] = {}
        for r in read(NVML_CAPTURE):
            by.setdefault(r["group"], []).append((int(r["mono_ns"]), r["values"]))
        for clk in sorted(by):
            seen = {m for _, v in by[clk] for m in v}
            group(clk, by[clk], [m for m in order["nvml"] if m in seen] + sorted(seen - set(order["nvml"])), "gpu0",
                  NVML_EVIDENCE)
    if DOCKER_STATS in caps:
        by = {}
        for r in read(DOCKER_STATS):
            by.setdefault(r["container"], []).append((int(r["mono_ns"]), r))
        for name in sorted(by):
            group(f"docker-{name}", by[name], order["docker"], caps["docker things"][name], DOCKER_EVIDENCE)
    if ENGINE_CAPTURE in caps:
        sr = engine_series(reg.metric_rules)
        recs, dropped = [], 0
        for r in read(ENGINE_CAPTURE):
            v, d = engine_values(r["metrics"], sr)
            recs.append((int(r["mono_ns"]), v))
            dropped = max(dropped, d)
        stats[ENGINE_CAPTURE]["series not kept per scrape (buckets, other families)"] = dropped
        if recs:
            group("engine", recs, order["engine"], caps["engine thing"], ENGINE_EVIDENCE)
    return groups


def column_groups(clocks: dict, samples: list, reg: Registry, pos_of: dict, catalog: list) -> list[dict]:
    """Samples of the column adapters (adapters/trackers.py): one group per clock in declaration order, each column a
    registry metric on its own thing; the same groups and catalog the live writer builds."""
    by: dict[str, list] = {}
    for clock, ns, values in samples:
        by.setdefault(clock, []).append((ns, values))
    groups = []
    for clock, cols in clocks.items():
        recs = by.get(clock)
        if not recs:
            continue
        g = {"track": clock, "name": f"samples-{clock}", "ts": np.array([t for t, _ in recs], np.int64),
             "metrics": [c.metric for c in cols], "codes": [],
             "values": [np.array([v.get(c.metric, np.nan) for _, v in recs], np.float64) for c in cols]}
        for c in cols:
            rule = reg.metric_rules[c.rule] | ({"label": c.label} if c.label else {})
            catalog.append(_catalog(len(catalog), c.metric, rule, None, pos_of[c.thing], g, rule["evidence"]))
        groups.append(g)
    return groups


# ---------------------------------------------------------------------- the generation
def _build(run_dir: Path, root: Path, reg: Registry, repo: Path, out: Path, gen: int, sig: str, old: Manifest | None,
           profile_run: Path | None, tie: dict | None, reference: dict | None) -> Manifest:
    t_start = time.perf_counter()
    run = run_dir.name
    labels = read_labels(run_dir)
    clk = clock(run_dir, root)
    ctx = Ctx(run, run_dir, reg, clk["wall_offset_ns"], stamped=labels.get("stamps") is True)
    notes: dict = {}
    rj = json.loads((run_dir / "run.json").read_bytes()) if (run_dir / "run.json").is_file() else {}
    try:
        src, launch, by, series = read_sources(ctx, run_dir, root, labels, rj, notes)
    except KeyError as e:
        raise ImportStop(f"{run}: {e.args[0]}") from None
    caps, cap_stats = read_captures(root, ctx)
    ctx.topology()
    c = src.cols
    m0 = len(src)
    if not m0:
        raise ImportStop(f"{run}: no rows from any source")

    kind0 = np.array(c["kind"], dtype=object)
    box0 = np.array(c["box"], dtype=object)
    iter0 = np.array(c["iter"], np.int64)
    start0 = np.array(c["start"], np.int64)
    end0 = np.array(c["end"], np.int64)
    back = np.flatnonzero(end0 < start0)
    if len(back):
        raise ImportStop(f"{run}: row {c['eid'][back[0]]} ({c['kind'][back[0]]}) ends before it starts")

    # Derived iterations: one per scheduler stamp (derive.ITERATION_RULE)
    own_kinds = ["component stamp"] + [k.kind for k in reg.kinds if k.tier == DEVICE_TIER]
    sched = np.flatnonzero((kind0 == "component stamp") & (box0 == "scheduler") & (iter0 >= 0))
    sched = sched[np.argsort(start0[sched], kind="stable")]
    it_num, it_start = iter0[sched], start0[sched]
    own0 = np.isin(kind0, own_kinds) & (box0 != INFERRED_ITERATION_BOX)
    try:
        it_end = derive.derived_iterations(it_num, it_start.astype(np.float64), iter0[own0],
                                           end0[own0].astype(np.float64)).astype(np.int64) if len(sched) else it_start
    except ValueError as e:
        raise ImportStop(f"{run}: {e}") from None
    for k, i in enumerate(sched.tolist()):
        v = int(it_num[k])
        add_iteration(src, ctx, v, int(it_start[k]), int(it_end[k]), c["lane"][i], c["req"][i], derive.ITERATION_RULE)
    m1 = len(src)

    # Inferred modules (store/modules.py RULE): each sorts just before the first device row it holds
    first_held, module_stats = add_modules(src, ctx, reg, reference, root.parent) if reference else ([], None)
    n = len(src)
    is_src = np.arange(n) < m0
    is_iteration = (np.arange(n) >= m0) & (np.arange(n) < m1)
    order_key = np.concatenate([2 * np.arange(m0) + 1, 2 * sched, 2 * np.array(first_held, np.int64)])
    start_abs = np.array(c["start"], np.int64)
    perm = np.lexsort((order_key, start_abs))
    inv = np.empty(n, np.int64)
    inv[perm] = np.arange(n)

    def col(name, dtype=object):
        a = np.array(c[name], dtype=dtype) if dtype is not object else _objects(c[name])
        return a[perm]

    start_abs = start_abs[perm]
    end_abs = np.array(c["end"], np.int64)[perm]
    is_src, is_iteration = is_src[perm], is_iteration[perm]
    kinds_s = col("kind")
    eid = col("eid")
    dup = len(eid) - len(set(eid.tolist()))
    if dup:
        seen, first_dup = set(), None
        for e in eid.tolist():
            if e in seen:
                first_dup = e
                break
            seen.add(e)
        raise ImportStop(f"{run}: {dup} duplicate eids, first {first_dup!r}")

    def describe(i: int) -> str:
        return "(none)" if i < 0 else f"{eid[i]} ({kinds_s[i]})"

    kind_code = {k.kind: k.code for k in reg.kinds}
    bad = [i for i, k in enumerate(kinds_s.tolist()) if k not in kind_code]
    if bad:
        raise ImportStop(f"{run}: kind {kinds_s[bad[0]]!r} is not in registry/kinds.json: row {eid[bad[0]]}")
    kind = np.array([kind_code[k] for k in kinds_s.tolist()], np.uint8)

    # Things: the probed inventory, the lanes the adapters named, the component map
    comp_things, box_key = component_things(reg)
    things = probe.inventory_things(reg, probe.load()) + [(k, *v) for k, v in ctx.things.items()] + comp_things
    keys = [t[0] for t in things]
    if len(set(keys)) != len(keys):
        raise ImportStop(f"{run}: thing keys repeat: {sorted({k for k in keys if keys.count(k) > 1})[:5]}")
    order, parent_pos, post = derive.euler(keys, [t[1] for t in things])
    things = [things[i] for i in order]
    pos_of = {t[0]: i for i, t in enumerate(things)}
    if len(things) >= NONE16:
        raise ImportStop(f"{run}: {len(things)} things do not fit the <u2 lane column")
    lane_s = col("lane")
    missing = [i for i, k in enumerate(lane_s.tolist()) if k not in pos_of]
    if missing:
        raise ImportStop(f"{run}: row {describe(missing[0])} sits on {lane_s[missing[0]]!r}, which is not a thing")
    lane = np.array([pos_of[k] for k in lane_s.tolist()], np.uint16)

    # Parents: the adapter's own (Observed: Python parent id; containment the PyTorch adapter did), then time
    # containment on one lane for the rows that take part
    p0 = np.array(c["parent"], np.int64)[perm]
    parent = np.where(p0 >= 0, inv[np.maximum(p0, 0)], -1)
    parent_rule = col("parent_rule")
    contain_mask = np.array(c["contain"], bool)[perm]
    parent, crossing = derive.contain(lane, start_abs, end_abs, contain_mask, parent)
    parent_rule[(parent_rule == None) & (parent >= 0)] = derive.CONTAIN_RULE  # noqa: E711
    parent = parent.astype(np.int32)

    # Links: launch (correlation id), messages (k-th send -> k-th receive), serves (iteration shares)
    source_s = col("source")
    req_own = col("req")
    name0 = col("name")
    links = [(int(inv[a]), int(inv[b]), "cuda launch", _launch_rule(source_s[inv[a]]), "Observed") for a, b in launch]
    comp_of = [message_comp(k, c["box"][j], ln, s) for k, j, ln, s in
               zip(kinds_s.tolist(), perm.tolist(), lane_s.tolist(), source_s.tolist())]
    msg = derive.message_links(req_own.tolist(), comp_of, name0.tolist())
    links += [(a, b, k, derive.MESSAGE_RULE, "Calculated") for a, b, k in msg]
    is_cause = np.array([reg.link_kind(x[2]).cause for x in links], bool)
    lf = np.array([x[0] for x in links], np.int64)
    lt = np.array([x[1] for x in links], np.int64)
    base = np.array([k.tier for k in reg.kinds], np.uint8)
    bump = np.array([k.nest_bump for k in reg.kinds], bool)
    try:
        cause = derive.causes(n, lf[is_cause], lt[is_cause])
        tier = derive.tiers(kind, parent, base, bump)
    except derive.RowError as e:
        raise ImportStop(f"{run}: {e.what}: row {describe(e.row)} (other {describe(e.other)})") from None

    # Iterations and requests
    src_iter = np.array(c["iter"], np.int64)[perm]
    d_rows = np.flatnonzero(is_iteration)                    # in start order
    term = col("term")
    loop_lanes = set(lane[(term == FORWARD_STEP[0])].tolist())
    on_loop = is_src & np.isin(lane, list(loop_lanes))
    window = derive.iteration_windows(start_abs[d_rows], end_abs[d_rows]) if len(d_rows) else end_abs[d_rows]
    it, it_stats = derive.iterations(src_iter, start_abs, on_loop, start_abs[d_rows], window,
                                     src_iter[d_rows], cause, base[kind] == DEVICE_TIER)
    box_s = col("box")
    if len(d_rows):
        own = is_src & ((np.isin(kinds_s, own_kinds) & (box_s != INFERRED_ITERATION_BOX))
                        | ((kinds_s == "nvtx range") & (src_iter >= 0)))
        before = end_abs[d_rows].copy()
        end_abs[d_rows] = derive.derived_iterations(src_iter[d_rows], start_abs[d_rows].astype(np.float64), it[own],
                                                    end_abs[own].astype(np.float64)).astype(np.int64)
        it_stats["derived iteration ends moved by the launching-call iteration and forward-step ranges"] = int(
            (before != end_abs[d_rows]).sum())
        it_stats["derived iterations ending after the next scheduler stamp"] = int(
            (end_abs[d_rows][:-1] > start_abs[d_rows][1:]).sum())
    it_req: dict[int, str] = {}                              # ie-run/2: request of an iteration, from run.json rows
    for i in np.flatnonzero(np.isin(source_s, list(MESSAGE_SOURCES)) & (src_iter >= 0)).tolist():
        if req_own[i]:
            it_req.setdefault(int(src_iter[i]), req_own[i])
    filled = 0
    for i in np.flatnonzero((req_own == None) & (src_iter >= 0)).tolist():  # noqa: E711
        r = it_req.get(int(src_iter[i]))
        if r:
            req_own[i], filled = r, filled + 1
    first: dict[str, int] = {}
    for i, r in enumerate(req_own.tolist()):
        if r and r not in first:
            first[r] = i
    requests = sorted(first, key=first.get)
    req_code = {r: i for i, r in enumerate(requests)}
    own_req = np.array([req_code.get(r, NONE16) for r in req_own.tolist()], np.uint16)
    sched_rows = np.flatnonzero(is_src & (kinds_s == "component stamp") & (box_s == "scheduler") & (src_iter >= 0))
    by_iteration = derive.request_of_iteration(src_iter[sched_rows], own_req[sched_rows])
    req = derive.requests(own_req, it, by_iteration)

    # Names, component boxes, depth, kernel layers
    name_s = name0.copy()
    layer = derive.layers(kind == reg.kind("kernel").code, it, name_s)
    full_name = col("full_name")
    krows = np.flatnonzero(kinds_s == "kernel")
    full_name[krows] = [f or x for f, x in zip(full_name[krows].tolist(), name_s[krows].tolist())]
    short_of = {f: derive.kernel_short_name(f) for f in set(full_name[krows].tolist())}
    name_s[krows] = [short_of[f] for f in full_name[krows].tolist()]
    names = sorted(set(name_s.tolist()))
    name_index = {x: k for k, x in enumerate(names)}
    name_code = np.fromiter((name_index[x] for x in name_s.tolist()), np.uint32, n)
    try:
        box = derive.boxes(reg.components["comp_rules"], [k.kind for k in reg.kinds], kind, [t[0] for t in things],
                           lane, names, name_code, box_s.astype(str), set(box_key))
    except derive.RowError as e:
        raise ImportStop(f"{run}: {e.what}: row {describe(e.row)}") from None
    comp_ix = np.array([NONE16 if b is None else pos_of[box_key[b]] for b in box.tolist()], np.uint16)
    fr = reg.dimensions["flow"]
    flow_names = fr["names"]
    sched_i = np.flatnonzero(is_src & (kinds_s == "component stamp") & (name_s == fr["stamp"]) & (src_iter >= 0))
    args_s = col("args")
    eng = np.flatnonzero(kinds_s == "engine timestamp")
    it_flow = derive.iteration_flows(src_iter[sched_i].tolist(),
                                     [(json.loads(a) if a else {}).get("stamp") or {} for a in args_s[sched_i].tolist()],
                                     name_s[eng].tolist(), fr["engine_names"]["prefill"], fr["engine_names"]["decode"],
                                     flow_names)
    named = np.full(n, derive.FLOW_NONE, np.uint8)
    for which in ("prefill", "decode"):
        rx = re.compile(fr["engine_names"][which])
        named[eng[[bool(rx.match(x)) for x in name_s[eng].tolist()]]] = flow_names.index(which)
    roles = process_roles(run, things, pos_of, lane, comp_ix)
    stream_box = np.array([b in fr["stream_out_boxes"] for b in box.tolist()], bool)
    stream_rx = re.compile(fr["stream_names"])
    stream_named = np.array([bool(stream_rx.match(x)) for x in names], bool)[name_code]
    flow = derive.flows(flow_names, it, it_flow, named, stream_box, stream_named,
                        np.isin(kinds_s, reg.execution_kinds("request")), req, start_abs)
    t0 = clk["t0_ns"] if clk["t0_ns"] is not None else old.t0_ns if old else int(start_abs.min())
    t0_rule = (clk["rule"] if clk["t0_ns"] is not None else "the previous generation's t0" if old
               else "the earliest row's start (first import)")
    start, end = (start_abs - t0).astype(np.float64), (end_abs - t0).astype(np.float64)
    try:
        depth = derive.depths(lane, start, end, parent)
    except derive.RowError as e:
        raise ImportStop(f"{run}: {e.what}: row {describe(e.row)}") from None
    nbytes = np.array(c["bytes"], np.float64)[perm]
    ids = np.arange(n, dtype=np.uint32)

    # Samples, run.json metrics (inputs by span id), guard
    groups, catalog = sample_groups(series, reg, pos_of)
    groups += capture_groups(caps, cap_stats, reg, pos_of, catalog)
    groups += column_groups(*by["trackers"], reg, pos_of, catalog)
    span_s = col("span_id")
    row_of_span = {s: i for i, s in enumerate(span_s.tolist()) if s}
    sample_of_span = {sid: [g["name"], k] for g in groups for s in g.get("series", [])
                      for sid, k in s.get("spans", {}).items()}
    guard = {"run.json spans": len(rj.get("spans", [])), "matched": 0, "superseded (nsys, PyTorch, ncu)": 0}
    for sp in rj.get("spans", []):
        sid = sp["id"]
        if sid.startswith(SUPERSEDED):
            guard["superseded (nsys, PyTorch, ncu)"] += 1
        elif sid in row_of_span or sid in sample_of_span:
            guard["matched"] += 1
        else:
            raise ImportStop(f"{run}: run.json span {sid!r} ({sp.get('component')}: {sp.get('name')!r}) has no row or "
                             "sample from the adapters")
    metrics, unresolved_inputs = [], 0
    for mt in rj.get("metrics", []):
        rows_in, samples_in, missing_in = [], [], []
        for sid in mt.get("inputs", []):
            if sid in row_of_span:
                rows_in.append(int(row_of_span[sid]))
            elif sid in sample_of_span:
                samples_in.append(sample_of_span[sid])
            else:
                missing_in.append(sid)
        unresolved_inputs += len(missing_in)
        seen = [OBSERVER.get(source_s[i], source_s[i]) for i in rows_in] + \
               [g.removeprefix("samples-") for g, _ in samples_in]
        metrics.append({**{k: v for k, v in mt.items() if k != "inputs"}, "clock": " → ".join(dict.fromkeys(seen)) or None,
                        "inputs": {"rows": rows_in, "samples": samples_in, "unresolved": missing_in}})
    facts, absent = {}, []
    for f in FACT_FILES:
        p, key = run_dir / f, f.rsplit(".", 1)[0]
        if p.is_file():
            facts[key] = {"source": f, "value": json.loads(p.read_bytes()) if f.endswith(".json") else p.read_text(),
                          **({"format": "yaml text"} if f.endswith(".yaml") else {})}
        elif key in rj:
            facts[key] = {"source": f"run.json {key}", "value": rj[key]}
        else:
            absent.append(f)
    facts["missing"] = absent

    # Serves: one link per (derived iteration, request), weight = the request's share of the iteration
    serves = iteration_shares(run, src, perm, inv, kinds_s, src_iter, d_rows, req, requests, reg)
    links += serves
    links.sort(key=lambda x: (start[x[0]], x[0], x[1]))

    # Nsight Compute headline counters (from the kernels-level run of this timeline run)
    profile_rows, ncu_meta = [], None
    if profile_run is not None:
        profile_rows, ncu_meta = ncu_profiles(ctx, profile_run, it, kind == reg.kind("kernel").code, start_abs,
                                              name0, eid)
    aux = {"metrics": metrics, "measures": reg.measures, "facts": facts, "unavailable": rj.get("unavailable", []),
           "sources": rj.get("sources", []), "ncu": ncu_meta,
           "clock": {"t0_ns": t0, "t0_rule": t0_rule, "wall_offset_ns": clk["wall_offset_ns"], "rule": clk["rule"]}}

    # Write: event blocks (CCVB + Parquet), links, samples, profiles, aux
    hot = {"id": ids, "start": start, "end": end, "lane": lane, "comp": comp_ix, "kind": kind, "tier": tier,
           "depth": depth, "req": req, "iter": it.astype(np.int32), "parent": parent, "cause": cause,
           "name": name_code, "bytes": nbytes, "layer": layer, "flow": flow}
    cold = {"eid": eid, "what": col("what"), "args": col("args"), "evidence": col("evidence"), "term": term,
            "source": source_s, "corr": col("corr"), "quirk": col("quirk"), "parent_rule": parent_rule,
            "raw_file": col("raw_file"), "raw_ptr": col("raw_ptr"), "code_origin": col("code_origin"),
            "code_where": col("code_where"), "full_name": full_name}
    del src, c
    con = duckdb.connect(config={"threads": 2})
    blocks = write_events(con, out, gen, hot, cold)
    blocks += write_links(con, out, gen, links, start, end, reg)
    blocks += write_samples(con, out, gen, groups, t0)
    if profile_rows:
        write_profiles(con, out, profile_rows)
    aux_bytes = json.dumps(aux, separators=(",", ":"), ensure_ascii=False, default=str).encode()
    (out / "aux.json").write_bytes(aux_bytes)

    tools = {}
    for tool, suffix, owner in (("nsys", "nsys-rep", run_dir), ("ncu", "ncu-rep", profile_run or run_dir)):
        reports = sorted(owner.glob(f"trace/*.{suffix}"))
        if len(reports) > 1:
            raise ImportStop(f"{owner.name}: {len(reports)} .{suffix} reports; the open-in-{tool} link names one")
        if reports:
            tools[tool] = {"run": owner.name, "path": str(reports[0].relative_to(owner))}
    if "nsys" in tools:
        utc = notes["nsys session"]
        tools["nsys"] |= {"session_start_ns": utc - clk["wall_offset_ns"] if utc is not None else None,
                          "evidence": "Calculated: TARGET_INFO_SESSION_START_TIME.utcEpochNs of the report's SQLite "
                                      "export minus the run's UTC - CLOCK_MONOTONIC offset; every nsys row's run-clock "
                                      "time is this plus its export time"}
    if "ncu" in tools and ncu_meta:
        tools["ncu"] |= {"kernels": ncu_meta, "counters": list(reg.ncu_headline),
                         "event_ids": sorted({r["event_id"] for r in profile_rows if r["event_id"] is not None})}
    if "ncu" in tools and tie:
        tools["ncu"]["timeline"] = tie

    kind_counts = {reg.kinds[k].kind: int(v) for k, v in enumerate(np.bincount(kind, minlength=len(reg.kinds))) if v}
    stats = {
        "rows": n, "kinds": kind_counts, "tier_counts": np.bincount(tier, minlength=len(TIERS)).tolist(),
        "sources": {k: int(v) for k, v in zip(*np.unique(source_s.astype(str), return_counts=True))},
        "adapters": ctx.stats, "notes": notes, "guard": guard,
        "derived iterations": {"rows": len(d_rows), "rule": derive.ITERATION_RULE},
        **({"modules": module_stats} if module_stats else {}),
        "iterations": it_stats, "request of an iteration filled (ie-run/2 rule)": filled,
        "parents": {"rows with a parent": int((parent >= 0).sum()), "crossing (not nested)": crossing},
        "causes": int((cause >= 0).sum()),
        "kernel names": {"rule": derive.SHORT_NAME_RULE, "rows": len(krows), "full names": len(short_of),
                         "short names": len(set(short_of.values()))},
        "flow": {"rule": derive.FLOW_RULE, **{nm: int((flow == c).sum()) for c, nm in enumerate(flow_names)},
                 "none": int((flow == derive.FLOW_NONE).sum())},
        "layers": {"kernels with a layer": int((layer >= 0).sum())}, "process roles": roles,
        "links": {k: int(v) for k, v in zip(*np.unique([x[2] for x in links], return_counts=True))} if links else {},
        "raw pointers": {"rows": int(sum(x is not None for x in cold["raw_file"]))},
        "metrics": {"rows": len(metrics), "unresolved inputs": unresolved_inputs},
        "samples": {g["name"]: len(g["ts"]) for g in groups}, "captures": cap_stats,
        "clock": aux["clock"], "rows before t0": int((start < 0).sum()),
        "depth max": int(depth.max()), "things": len(things), "seconds": round(time.perf_counter() - t_start, 2),
        "peak rss MiB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
    }
    return Manifest(
        run=run, generation=gen, status="final", t0_ns=int(t0), head_ns=float(end.max()), tiers=list(TIERS),
        kinds=[k.manifest() for k in reg.kinds],
        link_kinds=[{"code": k.code, "name": k.kind, "cause": k.cause, "label": k.label} for k in reg.link_kinds],
        things=[{"i": i, "key": t[0], "parent": parent_pos[i], "kind": t[2], "name": t[3], "pre": i, "post": post[i],
                 "attrs": t[4], "evidence": t[5]} for i, t in enumerate(things)],
        names=names, requests=requests, metrics=catalog, blocks=blocks,
        aux={"name": "aux.json", "bytes": len(aux_bytes), "etag": etag(aux_bytes)},
        source={"run_dir": str(run_dir.relative_to(repo)), "importer": "store.importer"}, tools=tools,
        inputs_sig=sig, import_stats=stats, dimensions={"ladders": reg.ladders, **reg.dimensions})


def _objects(values: list) -> np.ndarray:
    a = np.empty(len(values), dtype=object)
    a[:] = values
    return a


def _launch_rule(source: str) -> str:
    return ("Observed: CUPTI correlation (PyTorch profiler), launch call -> GPU work" if source == "torch_profiler"
            else "Observed: CUPTI correlationId, runtime call -> GPU work")


def iteration_shares(run, src, perm, inv, kinds_s, src_iter, d_rows, req, requests, reg) -> list[tuple]:
    """serves links (the ie-run/2 rule, registry run_json.json shares): per scheduler 'batch scheduled' stamp, each
    request's share of the iteration's tokens; prefill = the context chunk length, decode = 1 per request."""
    rule = reg.sources["run_json"]["shares"]
    c = src.cols
    it_row = {int(src_iter[i]): int(i) for i in d_rows.tolist()}
    req_row = {requests[req[i]]: int(i) for i in np.flatnonzero(kinds_s == "client request").tolist()
               if req[i] != NONE16}
    formula = reg.measures["iteration share"]["formula"]
    out = []
    for i in np.flatnonzero((kinds_s == "component stamp")).tolist():
        j = perm[i]
        if c["name"][j] != rule["stamp_name"] or c["source"][j] != "server_stamps":
            continue
        st = json.loads(c["args"][j]).get("stamp") or {}
        it = int(src_iter[i]) if src_iter[i] >= 0 else None
        ctx_ids = {q["cid"] for q in st.get("context", []) if isinstance(q, dict)}
        toks = {}
        for q in st.get("requests", []):
            if q["cid"] in ctx_ids or q.get("state", "").startswith("CONTEXT"):
                toks[q["cid"]] = (st.get("num_ctx_tokens") if len(ctx_ids) == 1 and st.get("num_ctx_tokens")
                                  else q.get("prompt_len"))
            else:
                toks[q["cid"]] = rule["generation_tokens"]
        tot = sum(toks.values()) or 1
        for cid, t in toks.items():
            rid = c["req"][j] if len(toks) == 1 else None
            if rid is None or it not in it_row or rid not in req_row:
                raise ImportStop(f"{run}: share of iteration {it} for request {rid!r} has no derived iteration or "
                                 "client request row (a batched iteration needs a rule for shares without a request)")
            out.append((it_row[it], req_row[rid], "serves", formula, rule["evidence"], t / tot))
    return out


def ncu_profiles(ctx: Ctx, profile_run: Path, it: np.ndarray, is_kernel: np.ndarray, start_abs: np.ndarray,
                 name0: np.ndarray, eid: np.ndarray) -> tuple[list[dict], dict]:
    nh = NcuHeadline(ctx)
    try:
        kernels, iteration = nh.read(profile_run)
    except KeyError as e:
        raise ImportStop(f"{ctx.run}: {e.args[0]}") from None
    rows = np.flatnonzero(is_kernel & (it == iteration))
    rows = rows[np.argsort(start_abs[rows], kind="stable")]
    ids, meta = nh.tie(kernels, [(int(i), name0[i]) for i in rows.tolist()])
    meta = {**meta, "iteration": iteration, "run": profile_run.name}
    keep, reg = ctx.reg.sources["ncu"]["keep_metrics"], ctx.reg.sources["ncu"]
    out = []
    for k, (kr, row) in enumerate(zip(kernels, ids)):
        for x, (v, unit, note) in sorted(kr["values"].items()):
            out.append({"profile": "ncu", "profile_run": profile_run.name, "profile_row": k,
                        "kernel_name": name0[row] if row is not None else kr["kernel_name"],
                        "event_id": row, "event_eid": eid[row] if row is not None else None,
                        "section": x.split("__")[0], "metric": x, "measure": keep.get(x, {}).get("measure"),
                        "unit": unit, "value": float(v),
                        "evidence": reg["evidence"] + ("; tie " + reg["tie"]["evidence"] if row is not None
                                                       else "; NOT tied: name mismatch"),
                        "unit_rule": note})
    return out, meta


# ---------------------------------------------------------------------- writers
def _block_header(table, name, band, gen, rows, t, tier_counts, metrics) -> dict:
    return {"table": table, "block": name, "band": band, "gen": gen, "rows": int(rows), "base_rows": 0,
            "t": [float(x) for x in t], "tier_counts": [int(x) for x in tier_counts], "dict_delta": {},
            "metrics": [int(x) for x in metrics]}


def _entry(info: dict, data: bytes) -> dict:
    return {"name": info["block"], "table": info["table"], "band": info["band"], "rows": info["rows"], "t": info["t"],
            "tier_counts": info["tier_counts"], "bytes": len(data), "etag": etag(data)}


def write_events(con, out: Path, gen: int, hot: dict, cold: dict) -> list[dict]:
    """Spine (tiers 0..2) and fine bands, BLOCK_ROWS rows per block, rows in (start, id) order in each."""
    tier, n = hot["tier"], len(hot["id"])
    band = np.where(tier <= SPINE_MAX_TIER, 0, 1)
    out_blocks = []
    cold_types = dict(COLD)
    for b, band_name in enumerate(("spine", "fine")):
        rows = np.flatnonzero(band == b)
        for k in range(0, len(rows), BLOCK_ROWS):
            r = rows[k:k + BLOCK_ROWS]
            name = f"{band_name}-{k // BLOCK_ROWS:04d}"
            info = _block_header("events", name, band_name, gen, len(r),
                                 [hot["start"][r].min(), hot["start"][r].max(), hot["end"][r].max()],
                                 np.bincount(tier[r], minlength=len(TIERS)).tolist(), [])
            data = encode(info, [(cc.name, cc.dtype, hot[cc.name][r]) for cc in COLUMNS["events"]])
            (out / f"{name}.ccvb").write_bytes(data)
            table = {cc.name: hot[cc.name][r] for cc in COLUMNS["events"]}
            for x, v in cold.items():
                table[x] = v[r]
            con.register("rows", table)
            sel = ", ".join([f'"{cc.name}"' for cc in COLUMNS["events"]] +
                            [f'CAST("{x}" AS {cold_types[x]}) AS "{x}"' for x in cold])
            con.execute(f"COPY (SELECT {sel} FROM rows) TO '{out}/events-{name}.parquet' "
                        f"(FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE {ROW_GROUP})")
            con.unregister("rows")
            out_blocks.append(_entry(info, data))
    assert sum(b["rows"] for b in out_blocks) == n
    return out_blocks


def write_links(con, out: Path, gen: int, links: list, start, end, reg: Registry) -> list[dict]:
    con.register("link_rows", {"from": np.array([x[0] for x in links], np.uint32),
                               "to": np.array([x[1] for x in links], np.uint32),
                               "kind": _objects([x[2] for x in links]),
                               "weight": np.array([x[5] if len(x) > 5 else np.nan for x in links], np.float64),
                               "rule": _objects([x[3] for x in links]), "evidence": _objects([x[4] for x in links])})
    con.execute(f"""COPY (SELECT "from", "to", CAST(kind AS VARCHAR) AS kind, nullif(weight, 'NaN'::DOUBLE) AS weight,
        CAST(rule AS VARCHAR) AS rule, CAST(evidence AS VARCHAR) AS evidence FROM link_rows)
        TO '{out}/links.parquet' (FORMAT parquet, COMPRESSION zstd)""")
    con.unregister("link_rows")
    keep = [x for x in links if not reg.link_kind(x[2]).cause]
    if not keep:
        return []
    fr = np.array([x[0] for x in keep], np.int64)
    to = np.array([x[1] for x in keep], np.int64)
    info = _block_header("links", "links", "links", gen, len(keep), [start[fr].min(), start[fr].max(), end[to].max()],
                         [0] * len(TIERS), [])
    data = encode(info, [("from", "<u4", fr), ("to", "<u4", to),
                         ("kind", "|u1", [reg.link_kind(x[2]).code for x in keep]),
                         ("weight", "<f4", [x[5] if len(x) > 5 and not np.isnan(x[5]) else 0.0 for x in keep])])
    (out / "links.ccvb").write_bytes(data)
    return [_entry(info, data)]


def write_samples(con, out: Path, gen: int, groups: list[dict], t0: int) -> list[dict]:
    blocks = []
    for g in groups:
        rel = (g["ts"] - t0).astype(np.float64)
        info = _block_header("samples", g["name"], "samples", gen, len(rel), [rel[0], rel[-1], rel[-1]],
                             [0] * len(TIERS), g["codes"])
        data = encode(info, [("ts", COLUMNS["samples"][0].dtype, rel)] +
                      [(f"m{j}", METRIC_DTYPE, v) for j, v in enumerate(g["values"])])
        (out / f"{g['name']}.ccvb").write_bytes(data)
        con.register("sample_rows", {"ts_ns": g["ts"], **dict(zip(g["metrics"], g["values"]))})
        con.execute(f"COPY sample_rows TO '{out}/{g['name']}.parquet' (FORMAT parquet, COMPRESSION zstd)")
        con.unregister("sample_rows")
        blocks.append({**_entry(info, data), "group": g["name"], "metrics": g["codes"]})
    return blocks


def write_profiles(con, out: Path, rows: list[dict]) -> None:
    cols = {k: _objects([r[k] for r in rows]) for k in rows[0]}
    cols["profile_row"] = np.array([r["profile_row"] for r in rows], np.int64)
    cols["value"] = np.array([r["value"] for r in rows], np.float64)
    cols["event_id"] = np.array([-1 if r["event_id"] is None else r["event_id"] for r in rows], np.int64)
    con.register("prof", cols)
    sel = ", ".join("profile_row" if k == "profile_row" else "value" if k == "value" else
                    'nullif(event_id, -1) AS event_id' if k == "event_id" else f'CAST("{k}" AS VARCHAR) AS "{k}"'
                    for k in rows[0])
    con.execute(f"""COPY (SELECT {sel} FROM prof ORDER BY event_id, profile_row, metric)
        TO '{out}/profiles.parquet' (FORMAT parquet, COMPRESSION zstd)""")
    con.unregister("prof")


ROLE_RULE = ("Calculated: a process boundary of the component map (components.json) is the process whose lanes carry "
             "the rows of its boxes; processes with no pid recorded take no role")


def process_roles(run: str, things: list[tuple], pos_of: dict, lane: np.ndarray, comp: np.ndarray) -> dict:
    """attrs.role of each process thing: {boundary, name, rule}. Returns process key -> boundary key."""
    kind_of, parent_of = {t[0]: t[2] for t in things}, {t[0]: t[1] for t in things}

    def process_of(key):
        while key is not None and kind_of.get(key) != "process":
            key = parent_of.get(key)
        return key
    seen: dict[str, set] = {}
    for ln, cx in set(zip(lane.tolist(), comp.tolist())):
        if cx == NONE16:
            continue
        bound = things[cx][1]
        proc = process_of(things[ln][0])
        if things[pos_of[bound]][4].get("kind") != "process" or proc is None or \
                things[pos_of[proc]][4].get("pid") is None:
            continue
        seen.setdefault(proc, set()).add(bound)
    out = {}
    for proc, bounds in sorted(seen.items()):
        if len(bounds) > 1:
            raise ImportStop(f"{run}: process {proc} carries the rows of two process boundaries {sorted(bounds)}")
        b = bounds.pop()
        things[pos_of[proc]][4]["role"] = {"boundary": b, "name": things[pos_of[b]][3], "rule": ROLE_RULE}
        out[proc] = b
    return out


def component_things(reg: Registry) -> tuple[list[tuple], dict]:
    """The component map under host/components (registry components.json): things as (key, parent key, kind, name,
    attrs, evidence), and box key -> thing key."""
    comp = reg.components
    bound_key = {}
    for b in comp["bounds"]:
        path, cur = [], b
        while cur:
            path.insert(0, cur["key"])
            cur = next((x for x in comp["bounds"] if x["key"] == cur["parent"]), None)
        bound_key[b["key"]] = "host/components/" + "/".join(path)
    things = [("host/components", "host", "component map", "component map (v1 components_map.js)",
               {"size": comp["size"], "edges": comp["edges"], "drives": comp["drives"]}, "registry/components.json")]
    for b in comp["bounds"]:
        things.append((bound_key[b["key"]], bound_key[b["parent"]] if b["parent"] else "host/components", "boundary",
                       b["label"], {k: b[k] for k in ("key", "kind", "x", "y", "w", "h")}, "registry/components.json"))
    box_key = {b["key"]: f"{bound_key[b['bound']]}/{b['key']}" for b in comp["boxes"]}
    for b in comp["boxes"]:
        things.append((box_key[b["key"]], bound_key[b["bound"]], "component", b["label"],
                       {k: b[k] for k in ("key", "owner", "x", "y", "w", "h")}, "registry/components.json"))
    return things, box_key


# ---------------------------------------------------------------------- CLI
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("runs", nargs="*")
    ap.add_argument("--all", action="store_true", help="every run of the store (except the rolling host run)")
    ap.add_argument("--force", action="store_true", help="write a new generation even when the inputs are unchanged")
    a = ap.parse_args()
    repo, reg = Path(os.environ.get("REPO", "/repo")), Registry.load()
    runs = sorted(p.name for p in (CC_STORE / "runs").iterdir() if (p / "manifest.json").is_file()
                  and p.name != "host") if a.all else a.runs
    # a module reference imports first and a kernels-level run last: the runs that tie to them read them from the store
    refs = set(reg.sources["modules"]["reference"].values())
    runs.sort(key=lambda r: (r not in refs, any(read_labels(d).get("trace") == "kernels"
                                                for d in repo.glob(f"reps/*/results/{r}"))))
    failed = []
    for run in runs:
        t = time.perf_counter()
        try:
            m = import_run(find_run_dir(repo, run), reg, force=a.force)
        except ImportStop as e:
            failed.append(f"{run} ({e})")
            print(f"STOP {run}: {e}", file=sys.stderr, flush=True)
            continue
        took = time.perf_counter() - t
        print(f"{run}: unchanged ({took:.2f} s)" if m is None else
              f"{run}: g{m.generation}, {m.import_stats['rows']} rows, tiers {m.import_stats['tier_counts']}, "
              f"{took:.2f} s, peak RSS {m.import_stats['peak rss MiB']} MiB", flush=True)
    sys.exit(f"{len(failed)} runs stopped: {'; '.join(failed)}" if failed else 0)


if __name__ == "__main__":
    main()
