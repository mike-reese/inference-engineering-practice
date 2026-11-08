"""Engine rows and samples.

  engine_records.json          EngineRecords (import only: rep.py drains /perf_metrics after the run, K9). Per
                               request the six /perf_metrics timestamps and five spans of
                               src/inference_analysis/trace/adapters/engine.py engine(); native_records.json the
                               same way through unpaired(). Lane "server (no pid recorded)/<component>".
  engine_iterations_raw.jsonl  EngineIterations: the engine's /metrics reads (iteration stats), one row per read
  capture/engine_iterations_raw.jsonl  and one per returned iteration entry. Live, the devtools engine collector hands
                               each read to the writer (capture file); rep.py saves the same reads to the run folder
                               at the end. The import reads the run folder's file when there is one, else the
                               capture: one record format, one parser (src engine.py iterations(), as data).
  capture/engine.jsonl         EngineMetrics: the collector's Prometheus scrape (/prometheus/metrics, 1 Hz) as
                               samples. Series are summed over their label sets per registry kinds.json metric
                               (group "engine", field "series"); histogram buckets are not kept.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from .base import Ctx, Rows, request_short, slug
from .stamps import SRC  # noqa: F401
from inference_analysis.trace.adapters.engine import ACCUMULATOR, engine as engine_adapter, unpaired  # noqa: E402
from inference_analysis.trace.schema import Run  # noqa: E402

RECORDS = "engine_records.json"
NATIVE = "native_records.json"
ITER_FILE = "engine_iterations_raw.jsonl"
ITER_CAPTURE = "engine_iterations_raw"
EVIDENCE = "Observed: the engine's /perf_metrics records (engine_records.json), CLOCK_MONOTONIC seconds x 1e9"
ITER_EVIDENCE = ("Observed: the engine's /metrics reads (iteration stats); an entry's UTC timestamp moved to the run "
                 "clock with its read's own wall/monotonic pair")
PROCESS = "server (no pid recorded)"


def _rows(ctx: Ctx, spans, source: str, evidence: str) -> Rows:
    out = Rows()
    rule = ctx.reg.event_rule("run_json", "engine timestamp")
    for sp in spans:
        f = {"request": request_short(sp.request_id), "short": slug(sp.name), "name": sp.name}
        out.add(start=sp.start_ns, end=sp.end_ns if sp.end_ns is not None else sp.start_ns,
                lane=ctx.lane(PROCESS, sp.component), kind="engine timestamp", name=sp.name, req=sp.request_id,
                eid=ctx.eid(rule["eid"], **f), what=rule["what"].format(**f), args={**sp.attrs, "span_id": sp.id},
                term=rule["term"], source=source, evidence=evidence, raw_file=sp.raw["file"],
                raw_ptr=sp.raw["pointer"] or None, span_id=sp.id)
    return out


class EngineRecords:
    source = "engine_records"

    def __init__(self, ctx: Ctx):
        self.ctx = ctx
        self.windows: list[tuple[str, int, int]] = []    # (request id, first_iter, last_iter) per record

    def read(self, run_dir: Path) -> Rows:
        run = Run(run_id=self.ctx.run)
        if (run_dir / RECORDS).is_file():
            engine_adapter(run_dir / RECORDS, run)
            for rid, r in json.loads((run_dir / RECORDS).read_bytes()).items():
                self.windows.append((rid, r["perf_metrics"]["first_iter"], r["perf_metrics"]["last_iter"]))
        if (run_dir / NATIVE).is_file():
            unpaired(run_dir / NATIVE, run)
        return _rows(self.ctx, run.spans, self.source, EVIDENCE)

    def request_of(self, it: int | None) -> str | None:
        return next((rid for rid, a, b in self.windows if it is not None and a <= it <= b), None)


class EngineIterations:
    """One raw /metrics read per record (devtools collectors/engine.py raw_read, the lines of
    engine_iterations_raw.jsonl). Rows as src engine.py iterations()."""
    source = "engine_iterations"

    def __init__(self, ctx: Ctx, file: str):
        self.ctx, self.file = ctx, file
        self.rule = ctx.reg.event_rule("run_json", "engine timestamp")

    def feed(self, reads: list[dict]) -> Rows:
        out, ctx = Rows(), self.ctx
        lane = ctx.lane(PROCESS, "iterations")

        def add(name, start, end, attrs, ptr, sid):
            f = {"request": "-", "short": slug(name), "name": name}
            out.add(start=start, end=end, lane=lane, kind="engine timestamp", name=name, eid=ctx.eid(self.rule["eid"], **f),
                    what=self.rule["what"].format(**f), args={**attrs, "span_id": sid},
                    term="engine iteration stats (/metrics)", source=self.source, evidence=ITER_EVIDENCE,
                    raw_file=self.file, raw_ptr=ptr, span_id=sid)
        for read in reads:
            n, rs, entries = read["line"] + 1, read["reader_seq"], read.get("response")
            what = ("failed" if read.get("error") else f"status {read.get('status')}" if entries is None
                    else "empty" if not entries else f"{len(entries)} entries")
            add(f"/metrics read {rs}: {what}", read["read_start_mono_ns"], read["read_end_mono_ns"],
                {k: read.get(k) for k in ("reader_seq", "status", "error", "empty", "entries", "first_seq", "container")},
                f"line {n}", f"iterations/read/{rs}")
            offset = read["read_start_ns"] - read["read_start_mono_ns"]
            for i, stat in enumerate(entries or []):
                ib = stat.get("inflightBatchingStats") or {}
                when = datetime.strptime(stat["timestamp"], "%m-%d-%Y %H:%M:%S.%f").replace(tzinfo=timezone.utc)
                ns = int(when.timestamp() * 1e6) * 1000 - offset
                add(f"iteration {stat.get('iter')} (read {rs}, entry {i})", ns, ns,
                    {"iter": stat.get("iter"), "reader_seq": rs, "index": i,
                     "seq": read["first_seq"] + i if read.get("first_seq") else None, "timestamp": stat["timestamp"],
                     "active": stat.get("numActiveRequests"), "queued": stat.get("numQueuedRequests"),
                     "scheduled": ib.get("numScheduledRequests"), "context": ib.get("numContextRequests"),
                     "context_tokens": ib.get("numCtxTokens"), "generation": ib.get("numGenRequests"),
                     "paused": ib.get("numPausedRequests"), "max_active": stat.get("maxNumActiveRequests"),
                     "new_active": stat.get("numNewActiveRequests"), "completed": stat.get("numCompletedRequests"),
                     "kv": stat.get("kvCacheStats"),
                     "newActiveRequestsQueueLatencyMS": stat.get("newActiveRequestsQueueLatencyMS"),
                     "newActiveRequestsQueueLatencyMS_meaning": ACCUMULATOR},
                    f"line {n} /response/{i}", f"iterations/{rs}/{i}")
        return out

    def flush(self) -> Rows:
        return Rows()


def engine_series(metric_rules: dict) -> dict[str, str]:
    """Prometheus base name -> registry metric (kinds.json metrics, group "engine")."""
    return {r["series"]: m for m, r in metric_rules.items() if r.get("group") == "engine"}


def engine_values(metrics: dict[str, float], series: dict[str, str]) -> tuple[dict[str, float], int]:
    """A scrape {series with labels: value} -> {registry metric: sum over label sets}, and the series not kept."""
    out, dropped = {}, 0
    for k, v in metrics.items():
        m = series.get(k.split("{", 1)[0])
        if m is None:
            dropped += 1
            continue
        out[m] = out.get(m, 0.0) + v
    return out, dropped
