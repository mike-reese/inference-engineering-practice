"""The live sources of one run folder (COMMAND_CENTER.md 6.5): each file is tailed as the rep writes it
and fed to its adapter, the same parser the importer reads the whole file with (store/adapters). So every row the live
writer holds comes back from the final import with the same eid.

  client/<request id>.json      ClientRecords, as each request ends (the request row, tier 0; response headers; all
                                client rows of a run with no client stamps)
  client/client_stamps.jsonl    ClientStamps (stamped runs)
  trace/server_stamps.jsonl     ServerStamps, then DerivedIterations (one per scheduler stamp, once bounded)
  <run>_s<n>.pcap               Wire: every TCP frame; a connection's frames wait for its request headers only
  gpu.csv                       nvidia-smi samples (adapters/gpu.py)
  trackers/*.jsonl, gpu_apps.jsonl   host, NVMe, uncore and GPU process samples, process starts (adapters/trackers.py)
Engine records (/perf_metrics), nsys, the PyTorch profiler and ncu exist only after the rep: the final import adds
them. Engine iteration stats, Docker and NVML come through the backend's collectors (stream.Live), not the folder.

read() does the file I/O (run it off the event loop); rows() feeds the adapters (on the loop, which owns the Ctx).
"""
from __future__ import annotations

from pathlib import Path

from . import derive
from .adapters.base import Ctx, LineTail, Rows
from .adapters.client import STAMPS_FILE, ClientRecords, ClientStamps
from .adapters.gpu import FILE as GPU_CSV, CsvTail, parse as parse_gpu
from .adapters.stamps import FILE as STAMPS, DerivedIterations, ServerStamps
from .adapters.trackers import Trackers
from .adapters.wire import PcapReader, Wire


class RunSources:
    def __init__(self, run_dir: Path, ctx: Ctx):
        self.dir, self.ctx = run_dir, ctx
        self.records = ClientRecords(ctx)
        self.client_stamps = ClientStamps(ctx) if ctx.stamped else None
        self.client_tail = LineTail(run_dir / STAMPS_FILE)
        self.stamps, self.stamp_tail = ServerStamps(ctx), LineTail(run_dir / STAMPS)
        self.derived = DerivedIterations(ctx, derive.ITERATION_RULE)
        self.wire, self.pcaps = Wire(ctx), {}
        self.gpu = CsvTail(run_dir / GPU_CSV)
        self.trackers = Trackers(run_dir, ctx)

    def read(self, final: bool = False) -> dict:
        for p in sorted(self.dir.glob("*.pcap")):
            self.pcaps.setdefault(p.name, PcapReader(p))
        return {"records": self.records.read(self.dir),
                "client_stamps": self.client_tail.read(final) if self.client_stamps else [],
                "stamps": self.stamp_tail.read(final),
                "frames": [(name, k, utc, raw) for name, r in sorted(self.pcaps.items()) for k, utc, raw in r.read()],
                "gpu": parse_gpu(self.gpu.read(final)), "trackers": self.trackers.read(final)}

    def rows(self, got: dict, final: bool = False) -> Rows:
        out = Rows()
        out.extend(self.records.feed(got["records"]))
        if self.client_stamps:
            out.extend(self.client_stamps.feed(got["client_stamps"]))
        stamps = self.stamps.feed(got["stamps"])
        out.extend(stamps)
        out.extend(self.derived.feed(stamps))
        out.extend(self.wire.feed(got["frames"]))
        out.extend(self.trackers.rows(got["trackers"]))
        if final:
            if self.client_stamps:
                out.extend(self.client_stamps.flush())
            out.extend(self.wire.flush())
            out.extend(self.derived.flush())
        return out
