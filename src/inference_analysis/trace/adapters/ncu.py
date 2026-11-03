"""Kernel level: Nsight Compute's per-kernel counters for one profiled iteration (trace/kernels.csv, exported by
rep.py with `ncu --import ... --page raw --csv`). Nsight Compute replays each kernel many times with caches flushed,
so its kernels have no time on the run's clock: they go in run.profiles, not in spans.
"""
import csv
import io
from pathlib import Path

from ..schema import Run
from .common import run_dir
from .nsys import layer_of

METRICS = {  # ncu metric -> (our name, unit)
    "gpu__time_duration.sum": ("duration", "us"),
    "dram__bytes_read.sum": ("dram_read_bytes", "byte"),
    "dram__bytes_write.sum": ("dram_write_bytes", "byte"),
    "dram__bytes_op_read.sum": ("dram_read_bytes", "byte"),  # the name this GPU reports (probe, 2026-11-02)
    "dram__bytes_op_write.sum": ("dram_write_bytes", "byte"),
    "lts__t_bytes.sum": ("l2_bytes", "byte"),
    "l1tex__t_bytes.sum": ("l1_bytes", "byte"),
    "dram__throughput.avg.pct_of_peak_sustained_elapsed": ("dram_pct_of_peak", "%"),
    "sm__throughput.avg.pct_of_peak_sustained_elapsed": ("sm_pct_of_peak", "%"),
    "sm__inst_executed_pipe_tensor.sum": ("tensor_instructions", ""),
    "smsp__sass_thread_inst_executed_op_ffma_pred_on.sum": ("ffma", ""),
    "launch__registers_per_thread": ("registers_per_thread", ""),
    "launch__shared_mem_per_block": ("shared_memory", "byte"),
}
SCALE = {"byte": 1, "Kbyte": 1e3, "Mbyte": 1e6, "Gbyte": 1e9, "KB": 1e3, "MB": 1e6, "GB": 1e9,
         "us": 1, "usecond": 1, "ns": 1e-3, "nsecond": 1e-3, "ms": 1e3, "msecond": 1e3}


def ncu(path: Path, run: Run) -> None:
    root = run_dir(path)
    rows = list(csv.reader(io.StringIO(path.read_text())))
    header, units, body = rows[0], rows[1], rows[2:]
    kernels = []
    for row in body:
        cell = dict(zip(header, row))
        k = {"id": int(cell["ID"]), "name": cell["Kernel Name"], "grid": cell.get("Grid Size"),
             "block": cell.get("Block Size")}
        for metric, (name, unit) in METRICS.items():
            if metric in cell and cell[metric] not in ("", "n/a"):
                value = float(cell[metric].replace(",", ""))
                k[name] = value * SCALE.get(units[header.index(metric)], 1) if unit in ("byte", "us") else value
        sass = root / "trace" / "sass" / f"{k['id']}.txt"
        k["sass_file"] = str(sass.relative_to(root)) if sass.exists() else None
        kernels.append(k)
    for k, layer in zip(kernels, layer_of([k["name"] for k in kernels])):
        k["layer"] = layer
    total = sum(k.get("dram_read_bytes", 0) for k in kernels)
    run.profiles["ncu"] = {"file": str(path.relative_to(root)), "iteration": run.labels.get("profile_range"),
                           "kernels": kernels, "dram_read_bytes": total,
                           "note": "one iteration, each kernel replayed with caches flushed; not on the run clock"}
