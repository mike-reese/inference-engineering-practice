"""ie-run/3: the one column list, the manifest shape, and the CCVB block codec.

frontend/cc/store/columns.js mirrors COLUMNS. `make store-check` fails when the two differ.

CCVB (little-endian, zero copy in the browser):
    0      b"CCVB"
    4      u32 H, the header length; the header JSON is padded with spaces so that 8 + H is a multiple of 8
    8      header JSON: schema, table, block, band, gen, rows, base_rows, t, tier_counts, dict_delta, metrics, columns
    8 + H  column buffers; column offsets count from 8 + H, and every buffer starts 8-byte aligned
"""
from __future__ import annotations

import hashlib
import json
import os
import struct
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Literal

import numpy as np

SCHEMA = "ie-run/3"
CCVB = "ccvb/1"
TIERS = ("request", "iteration", "stage", "op", "call", "device", "os")
DEVICE_TIER = 5
SPINE_MAX_TIER = 2            # tiers 0..2 form the spine band, always resident in the browser
BLOCK_ROWS = 32_768
NONE16 = 0xFFFF
MAGIC = b"CCVB"

Table = Literal["events", "links", "samples"]


@dataclass(frozen=True)
class Column:
    name: str
    dtype: str                # numpy dtype string; also the CCVB column type
    doc: str


COLUMNS: dict[str, tuple[Column, ...]] = {
    "events": (
        Column("id", "<u4", "dense row id; the total order is (start, id)"),
        Column("start", "<f8", "ns from manifest t0_ns"),
        Column("end", "<f8", "ns from t0_ns; equals start for an instant"),
        Column("lane", "<u2", "thing index of the thread, GPU stream, client or wire lane"),
        Column("comp", "<u2", "thing index of the component box, NONE16 if none"),
        Column("kind", "|u1", "kind code (manifest.kinds)"),
        Column("tier", "|u1", "rank 0..6 (manifest.tiers)"),
        Column("depth", "<u2", "sub-row inside the lane: nesting, then greedy packing"),
        Column("req", "<u2", "request index (manifest.requests), NONE16 if none"),
        Column("iter", "<i4", "engine iteration, -1 if none; a device op takes its launching call's iteration"),
        Column("parent", "<i4", "parent row id, -1 if none"),
        Column("cause", "<i4", "cross-lane origin row (launch call of a device op, send of a receive), -1 if none"),
        Column("name", "<u4", "string index (manifest.names)"),
        Column("bytes", "<f8", "bytes moved, NaN if none"),
        Column("layer", "<i2", "decoder layer of a kernel (RMSNorm heuristic of nsys.py layer_of), -1 if none"),
    ),
    "links": (
        Column("from", "<u4", "row id"),
        Column("to", "<u4", "row id"),
        Column("kind", "|u1", "link kind code (manifest.link_kinds)"),
        Column("weight", "<f4", "share, 0 if none"),
    ),
    "samples": (
        Column("ts", "<f8", "ns from t0_ns; then one <f4 column per metric, m0..mk in the order of header.metrics"),
    ),
}
METRIC_DTYPE = "<f4"

# Events columns kept in Parquet only; the detail route answers them by id.
COLD: tuple[tuple[str, str], ...] = (
    ("eid", "VARCHAR"), ("what", "VARCHAR"), ("args", "VARCHAR"), ("evidence", "VARCHAR"), ("term", "VARCHAR"),
    ("source", "VARCHAR"), ("corr", "BIGINT"), ("quirk", "VARCHAR"), ("parent_rule", "VARCHAR"),
    ("raw_file", "VARCHAR"), ("raw_ptr", "VARCHAR"), ("code_origin", "VARCHAR"), ("code_where", "VARCHAR"),
)


@dataclass(frozen=True)
class Manifest:
    """manifest.json of one run. Written last, by temp file and rename, so a reader never sees a partial store."""
    run: str
    generation: int
    status: Literal["live", "final"]
    t0_ns: int
    head_ns: float
    tiers: list
    kinds: list               # [{code, name, tier, nest_bump, derived, color, label, home}]
    link_kinds: list          # [{code, name, cause, label}]
    things: list              # [{i, key, parent, kind, name, pre, post, attrs, evidence}]
    names: list
    requests: list
    metrics: list             # sample metric catalog: [{code, metric, label, unit, thing, group, sidebar, source,
                              #   period_ms, period_ns_measured, evidence}]; samples headers name metrics by code
    blocks: list              # [{name, table, band, rows, t, tier_counts, bytes, etag, group?, metrics?}]
    aux: dict                 # {name, bytes, etag}: aux.json of this generation
    source: dict              # {run_dir (relative to REPO), importer, live?}
    tools: dict               # {nsys?: {run, path, session_start_ns, evidence}, ncu?: {run, path, ...}}: open in Nsight
    inputs_sig: str
    import_stats: dict = field(default_factory=dict)
    schema: str = SCHEMA

    def to_json(self) -> bytes:
        d = asdict(self)
        d["import"] = d.pop("import_stats")
        return json.dumps(d, separators=(",", ":"), ensure_ascii=False).encode()

    @classmethod
    def load(cls, path: Path) -> "Manifest":
        d = json.loads(path.read_bytes())
        if d.get("schema") != SCHEMA:
            raise ValueError(f"{path}: schema {d.get('schema')!r}, expected {SCHEMA}")
        d["import_stats"] = d.pop("import")
        return cls(**d)


def encode(header: dict, columns: list[tuple[str, str, np.ndarray]]) -> bytes:
    """One CCVB block. header holds everything but schema and columns; every array has header["rows"] elements."""
    off, specs, bufs = 0, [], []
    for name, dtype, a in columns:
        a = np.ascontiguousarray(a, dtype=np.dtype(dtype))
        if len(a) != header["rows"]:
            raise ValueError(f"column {name}: {len(a)} rows, header says {header['rows']}")
        b = a.tobytes()
        pad = (-len(b)) % 8
        specs.append({"name": name, "type": dtype, "offset": off, "length": len(a)})
        bufs.append(b + b"\0" * pad)
        off += len(b) + pad
    h = json.dumps({"schema": CCVB, **header, "columns": specs}, separators=(",", ":"), ensure_ascii=False).encode()
    h += b" " * ((-(len(h) + 8)) % 8)
    return MAGIC + struct.pack("<I", len(h)) + h + b"".join(bufs)


def decode(buf: bytes) -> tuple[dict, dict[str, np.ndarray]]:
    if buf[:4] != MAGIC:
        raise ValueError("not a CCVB block")
    (hl,) = struct.unpack_from("<I", buf, 4)
    base = 8 + hl
    if base % 8:
        raise ValueError(f"header length {hl} is not padded to 8")
    header = json.loads(buf[8:base])
    cols = {c["name"]: np.frombuffer(buf, dtype=np.dtype(c["type"]), count=c["length"], offset=base + c["offset"])
            for c in header["columns"]}
    return header, cols


def etag(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:20]


def write_atomic(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)
