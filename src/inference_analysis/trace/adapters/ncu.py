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
    details = root / "trace" / "sections.csv"
    by_kernel = sections(details) if details.exists() else {}
    for k in kernels:
        k.update(headline(by_kernel.get(k["id"])))
    total = sum(k.get("dram_read_bytes", 0) for k in kernels)
    run.profiles["ncu"] = {"file": str(path.relative_to(root)), "iteration": run.labels.get("profile_range"),
                           "kernels": kernels, "dram_read_bytes": total, "graphs": run.labels.get("graphs"),
                           "sections_file": str(details.relative_to(root)) if details.exists() else None,
                           "note": "one iteration, each kernel replayed with caches flushed at base clocks; "
                                   "not on the run clock"}


# The values the kernel strip shows from the sections (display names as ncu prints them), when collected.
HEADLINE = {("Occupancy", "Achieved Occupancy"): "occupancy_achieved_pct",
            ("Occupancy", "Theoretical Occupancy"): "occupancy_theoretical_pct",
            ("Launch Statistics", "Waves Per SM"): "waves_per_sm",
            ("Warp State Statistics", "Warp Cycles Per Issued Instruction"): "cycles_per_issue"}


def sections(path: Path) -> dict[int, dict]:
    """trace/sections.csv (`ncu --page details --csv --print-details all`): one row per metric or rule finding.
    Rows without a rule finding stop after "Metric Value" (17 of 21 columns).
    Returns kernel id -> {"sections": [{name, items: [{label, metrics: [{name, unit, value}]}]}],
    "rules": [{section, name, type, description, speedup_type, speedup}]}, in the file's order."""
    out = {}
    with path.open(newline="") as f:
        for row in csv.DictReader(f):
            # Skip what is not a metric or rule row: ncu prints the NUMA affinity table (5 columns, its "GPU ID"
            # looks like a kernel ID) and an NVLink note per kernel into the same output.
            if not row.get("ID", "").isdigit() or (row.get("Metric Value") is None and row.get("Rule Name") is None):
                continue
            kernel = out.setdefault(int(row["ID"]), {"sections": [], "rules": []})
            section = row["Section Name"]
            if row.get("Rule Name"):
                kernel["rules"].append({"section": section, "name": row["Rule Name"], "type": row["Rule Type"],
                                        "description": row["Rule Description"],
                                        "speedup_type": row.get("Estimated Speedup Type") or None,
                                        "speedup": float(row["Estimated Speedup"]) if row.get("Estimated Speedup")
                                        else None})
                continue
            if not kernel["sections"] or kernel["sections"][-1]["name"] != section:
                kernel["sections"].append({"name": section, "items": []})
            items = kernel["sections"][-1]["items"]
            label = row.get("Body Item Label", "")
            if not items or items[-1]["label"] != label:
                items.append({"label": label, "metrics": []})
            items[-1]["metrics"].append({"name": row["Metric Name"], "unit": row["Metric Unit"],
                                         "value": row["Metric Value"]})
    return out


def headline(kernel: dict | None) -> dict:
    if not kernel:
        return {}
    out = {}
    for section in kernel["sections"]:
        for item in section["items"]:
            for m in item["metrics"]:
                key = HEADLINE.get((section["name"], m["name"]))
                if key and m["value"] not in ("", "n/a"):
                    out[key] = float(m["value"].replace(",", ""))
    opt = [r for r in kernel["rules"] if r["type"] == "OPT"]
    out["findings"] = len(opt)
    best = max(opt, key=lambda r: r["speedup"] or 0, default=None)
    if best:
        out["top_finding"] = {"name": best["name"], "speedup_pct": best["speedup"],
                              "description": best["description"][:300]}
    return out
