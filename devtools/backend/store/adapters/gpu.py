"""nvidia-smi samples: gpu.csv (rep.py's sampler: one line per read, CLOCK_MONOTONIC ns then src GPU_FIELDS), the
sample group of track gpu0/nvidia-smi (registry run_json.json samples). The live writer tails the file as it grows
(base.LineTail reads lines; parse() turns them into samples) and the importer reads it whole through the same parse,
so live and final samples are the same reads. A value nvidia-smi could not give ("[N/A]") is no sample of that
metric. Span ids gpu/sample/<line> as src gpu_samples, so run.json metric inputs resolve to sample indexes.
"""
from __future__ import annotations

import csv
from pathlib import Path

from .stamps import SRC  # noqa: F401  (puts src/ on sys.path)
from inference_analysis.trace.adapters.gpu import GPU_FIELDS  # noqa: E402

FILE = "gpu.csv"
TRACK = "gpu0/nvidia-smi"


def parse(lines: list[tuple[int, str]]) -> list[tuple[int, int, dict[str, float]]]:
    """(0-based line, text) -> (line, monotonic ns, {metric: value}) per readable line."""
    out = []
    for n, text in lines:
        row = next(csv.reader([text]), None)
        if not row:
            continue
        try:
            ns = int(row[0])
        except ValueError:
            continue
        values = {}
        for key, v in zip(GPU_FIELDS, row[1:]):
            try:
                values[key] = float(v)
            except ValueError:
                pass
        out.append((n, ns, values))
    return out


class CsvTail:
    """A text file read from where the last read stopped, as (0-based line, text); a line still being written stays
    for the next read (final=True reads it)."""

    def __init__(self, path: Path):
        self.path, self.offset, self.rest, self.line = path, 0, b"", 0

    def read(self, final: bool = False) -> list[tuple[int, str]]:
        try:
            with self.path.open("rb") as f:
                f.seek(self.offset)
                data = f.read()
        except OSError:
            return []
        self.offset += len(data)
        lines = (self.rest + data).split(b"\n")
        self.rest = b"" if final else lines.pop()
        out = []
        for raw in lines:
            n, self.line = self.line, self.line + 1
            if raw.strip():
                out.append((n, raw.decode(errors="replace").rstrip("\r")))
        return out
