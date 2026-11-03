"""Recorded runs: run.json built by the same adapters rep.py uses (src/inference_analysis/trace), and raw records.

A run folder is read-only here. run.json is read from the folder when it is newer than every input, otherwise built
in memory and cached by the inputs' modification times.
"""
import csv
import io
import json
import os
import sys
from pathlib import Path

REPO = Path(os.environ.get("REPO", "/repo"))
sys.path.insert(0, str(REPO / "src"))
from inference_analysis.trace.adapters.ncu import sections  # noqa: E402
from inference_analysis.trace.build import build_run  # noqa: E402

CACHE = {}  # run id -> (signature, run.json dict)
SECTIONS = {}  # run id -> (mtime of trace/sections.csv, kernel id -> sections and rule findings)


def find_run(run_id: str) -> Path:
    for config in REPO.glob(f"*/*/results/{run_id}/config.yaml"):
        return config.parent
    raise KeyError(run_id)


def signature(run: Path) -> tuple:
    return tuple(sorted((str(p), p.stat().st_mtime) for p in run.rglob("*")
                        if p.is_file() and p.name != "run.json" and p.suffix not in (".pcap", ".nsys-rep", ".ncu-rep")))


def run_json(run_id: str) -> dict:
    run = find_run(run_id)
    sig = signature(run)
    if run_id in CACHE and CACHE[run_id][0] == sig:
        return CACHE[run_id][1]
    saved = run / "run.json"
    newest = max((m for _, m in sig), default=0)
    if saved.exists() and saved.stat().st_mtime >= newest:
        data = json.loads(saved.read_text())
    else:
        data = build_run(run).to_json()
    CACHE[run_id] = (sig, data)
    return data


def safe_path(run: Path, relative: str) -> Path:
    path = (run / relative).resolve()
    if run.resolve() not in path.parents and path != run.resolve():
        raise PermissionError(relative)
    return path


def raw(run_id: str, file: str, pointer: str) -> dict:
    """The source of one span: a JSON pointer into a JSON file, one TSV row by frame number, one CSV line."""
    run = find_run(run_id)
    path = safe_path(run, file)
    if path.suffix == ".json":
        value = json.loads(path.read_text())
        for part in [p for p in pointer.split("/") if p]:
            value = value[int(part)] if isinstance(value, list) else value[part]
        return {"file": file, "pointer": pointer, "value": value}
    if path.suffix == ".tsv" and pointer.startswith("frame.number="):
        number = pointer.split("=", 1)[1]
        for row in csv.DictReader(io.StringIO(path.read_text()), delimiter="\t"):
            if row.get("frame.number") == number:
                payload = bytes.fromhex(row.pop("tcp.payload") or "")
                return {"file": file, "pointer": pointer, "value": {**row, "payload_text":
                                                                     payload.decode(errors="replace")}}
    if path.suffix in (".csv", ".log", ".txt") and pointer.startswith("line "):
        n = int(pointer.split()[1])
        lines = path.read_text().splitlines()
        return {"file": file, "pointer": pointer, "value": lines[n - 1] if n <= len(lines) else None}
    return {"file": file, "pointer": pointer, "value": None, "note": "open the file in Tools"}


def spans(run_id: str, request: str | None = None, level: str | None = None, component: str | None = None,
          name: str | None = None, limit: int = 500) -> list:
    out = []
    for s in run_json(run_id)["spans"]:
        if (request and s["request_id"] != request) or (level and s["level"] != level) \
                or (component and s["component"] != component) or (name and name not in s["name"]):
            continue
        out.append(s)
        if len(out) >= limit:
            break
    return out


def source(run_id: str, file: str, line: int, context: int = 12) -> dict:
    """Engine source around a line, from the files the code-level run copied out of the image."""
    run = find_run(run_id)
    path = safe_path(run, f"trace/source/{file.lstrip('/')}")
    lines = path.read_text().splitlines()
    start = max(1, line - context)
    return {"file": file, "line": line, "start": start, "lines": lines[start - 1: line + context]}


def kernel_sections(run_id: str, kernel_id: int) -> dict:
    """One kernel's Nsight Compute sections and rule findings (trace/sections.csv, TRACE=kernels runs)."""
    path = find_run(run_id) / "trace" / "sections.csv"
    mtime = path.stat().st_mtime  # OSError when this run has no sections export
    if run_id not in SECTIONS or SECTIONS[run_id][0] != mtime:
        SECTIONS[run_id] = (mtime, sections(path))
    return {"id": kernel_id, **SECTIONS[run_id][1].get(kernel_id, {"sections": [], "rules": []})}
