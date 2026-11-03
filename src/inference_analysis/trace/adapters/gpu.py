"""Level 3: GPU counters sampled during the run (gpu.csv, written by rep.py's sampler).

Columns: monotonic_ns, then nvidia-smi's query fields (see GPU_FIELDS). Each line is stamped on read, on the
run's clock.
"""
import csv
from pathlib import Path

from ..schema import Run, Span
from .common import run_dir

GPU_FIELDS = ("utilization.gpu", "utilization.memory", "memory.used", "power.draw", "clocks.sm", "temperature.gpu",
              "pcie.link.gen.current")


def gpu_samples(path: Path, run: Run) -> None:
    file = str(path.relative_to(run_dir(path)))
    with path.open() as f:
        for i, row in enumerate(csv.reader(f)):
            ns, *values = row
            attrs = {}
            for key, value in zip(GPU_FIELDS, values):
                try:
                    attrs[key] = float(value)
                except ValueError:
                    attrs[key] = None
            run.spans.append(Span(f"gpu/sample/{i}", "hardware", "gpu", "sample", int(ns), None, None, attrs,
                                  {"file": file, "pointer": f"line {i + 1}"}))
