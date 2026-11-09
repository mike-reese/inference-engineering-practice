"""make store-check: every run of the ie-run/3 store, and schema.py against the browser's column list.

Per run: tier(child) >= tier(parent), dense ids in (start, id) order, unique eids, only kernels carry a layer, row
counts per kind equal the manifest's import stats, and a CCVB round trip (decode, compare to the Parquet twin and the
header, re-encode to the same bytes; block bytes and etags equal the manifest).
Live and final are one path: when a run's live generation (g0) sits beside its final one, every live eid must be in
the final generation, and a run whose live writer recorded capture/clock.json keeps that t0 in the final manifest.

Runs: every run folder of $CC_STORE/runs with a manifest, live ones (including the rolling host run) too. A live
run's ids follow arrival order, so the start-order check is skipped for it, and the output says so.

Registry: the nvml metrics' period_ms and clock equal the probe table (/mnt/ie-data/cc/probe/nvml_refresh.json).
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

import duckdb
import numpy as np

from .schema import COLUMNS, METRIC_DTYPE, TIERS, Manifest, decode, encode, etag

CC_STORE = Path(os.environ.get("CC_STORE", "/mnt/ie-data/cc/store"))
PROBE = Path(os.environ.get("NVML_PROBE", "/mnt/ie-data/cc/probe/nvml_refresh.json"))
COLUMNS_JS = Path(__file__).resolve().parents[2] / "frontend" / "cc" / "store" / "columns.js"


def columns_js() -> list[str]:
    """columns.js COLUMNS, parsed as [name, type] pairs per table."""
    text = COLUMNS_JS.read_text()
    body = text[text.index("COLUMNS"):]
    problems = []
    for table, cols in COLUMNS.items():
        m = re.search(rf"\b{table}\s*:\s*\[", body)
        got = None
        if m:
            depth, end = 0, m.end() - 1
            for end in range(m.end() - 1, len(body)):
                depth += {"[": 1, "]": -1}.get(body[end], 0)
                if depth == 0:
                    break
            got = re.findall(r'\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\]', body[m.end():end])
        want = [(c.name, c.dtype) for c in cols]
        if got != want:
            problems.append(f"columns.js {table}: {got} != schema.py {want}")
    return problems


def same(a: np.ndarray, b: np.ndarray) -> bool:
    """Equal arrays; NaN equals NaN (Parquet keeps a float NaN as NULL, read back as NaN)."""
    return a.shape == b.shape and bool(np.all((a == b) | (np.isnan(a) & np.isnan(b)) if a.dtype.kind == "f" else a == b))


def nvml_periods() -> list[str]:
    """Registry nvml metrics against the probe table: same period and same sampler clock (group)."""
    from .registry import Registry
    if not PROBE.is_file():
        return [f"{PROBE} is missing (run store/probe_nvml.py)"]
    probe = json.loads(PROBE.read_bytes())
    period = {r["metric"]: r["period_ms"] for r in probe["table"]}
    clock = {m: g["group"] for g in probe["groups"] for m in g["metrics"]}
    bad = []
    for m, rule in Registry.load().metric_rules.items():
        if rule.get("group") != "nvml":
            continue
        if (rule.get("period_ms"), rule.get("clock")) != (period.get(m), clock.get(m)):
            bad.append(f"{m}: registry period {rule.get('period_ms')} ms, clock {rule.get('clock')}; probe "
                       f"{period.get(m)} ms, {clock.get(m)}")
    return bad


def check_run(con, run: str) -> tuple[list[str], dict]:
    root = CC_STORE / "runs" / run
    if not (root / "manifest.json").is_file():
        return [f"not converted (no {root}/manifest.json)"], {}
    m = Manifest.load(root / "manifest.json")
    g = root / f"g{m.generation}"
    bad = []
    kind_names = [k["name"] for k in m.kinds]
    derived = {k["name"] for k in m.kinds if k["derived"]}

    # CCVB round trip, against the Parquet twin and the manifest
    hot = {c.name: [] for c in COLUMNS["events"]}
    for b in m.blocks:
        data = (g / f"{b['name']}.ccvb").read_bytes()
        if len(data) != b["bytes"] or etag(data) != b["etag"]:
            bad.append(f"{b['name']}: bytes or etag differ from the manifest")
        try:
            header, cols = decode(data)
        except ValueError as e:
            bad.append(f"{b['name']}: {e}")
            continue
        again = encode({k: v for k, v in header.items() if k not in ("schema", "columns")},
                       [(c["name"], c["type"], cols[c["name"]]) for c in header["columns"]])
        if again != data:
            bad.append(f"{b['name']}: re-encoding the decoded block gives different bytes")
        if header["rows"] != b["rows"] or header["table"] != b["table"]:
            bad.append(f"{b['name']}: header rows/table differ from the manifest")
        if b["table"] == "events":
            pq = con.execute(f"SELECT * FROM '{g}/events-{b['name']}.parquet' ORDER BY start, id").fetchnumpy()
            for c in COLUMNS["events"]:
                v = pq[c.name]
                v = np.ma.filled(v.astype(np.float64), np.nan) if np.ma.isMaskedArray(v) else np.asarray(v)
                if not same(cols[c.name], v.astype(c.dtype)):
                    bad.append(f"{b['name']}: column {c.name} differs between CCVB and Parquet")
                hot[c.name].append(cols[c.name])
            t = [cols["start"].min(), cols["start"].max(), cols["end"].max()]
            if header["t"] != [float(x) for x in t] or \
                    header["tier_counts"] != np.bincount(cols["tier"], minlength=len(TIERS)).tolist():
                bad.append(f"{b['name']}: header t or tier_counts differ from the columns")
        elif b["table"] == "samples":
            pq = con.execute(f"SELECT * FROM '{g}/{b['name']}.parquet' ORDER BY ts_ns").fetchnumpy()
            names = [m.metrics[k]["metric"] for k in header["metrics"]]
            if not same(cols["ts"], (pq["ts_ns"] - m.t0_ns).astype(np.float64)):
                bad.append(f"{b['name']}: ts differs between CCVB and Parquet")
            for j, name in enumerate(names):
                v = pq[name]
                v = np.ma.filled(v.astype(np.float64), np.nan) if np.ma.isMaskedArray(v) else np.asarray(v, np.float64)
                if not same(cols[f"m{j}"], v.astype(METRIC_DTYPE)):
                    bad.append(f"{b['name']}: m{j} ({name}) differs between CCVB and Parquet")
    live = m.status == "live"
    skipped = ["ids in start order (live ids follow arrival; each block is in (start, id) order)"] if live else []
    if not hot["id"]:
        if live:
            return bad, {"rows": 0, "status": "live", "skipped": skipped,
                         "sample blocks": sum(b["table"] == "samples" for b in m.blocks)}
        return bad + ["no events blocks"], {}
    order = np.argsort(np.concatenate(hot["id"]), kind="stable")
    h = {k: np.concatenate(v)[order] for k, v in hot.items()}
    n = len(h["id"])

    # Dense ids in (start, id) order
    if not np.array_equal(h["id"], np.arange(n)):
        bad.append("ids are not dense 0..N-1 across the blocks")
    elif not live and (np.diff(h["start"]) < 0).any():
        bad.append(f"row {int(np.flatnonzero(np.diff(h['start']) < 0)[0]) + 1} starts before the row before it")

    # Only kernels carry a decoder layer
    kernel = kind_names.index("kernel") if "kernel" in kind_names else -1
    stray = np.flatnonzero((h["layer"] >= 0) & (h["kind"] != kernel))
    if len(stray):
        bad.append(f"layer: {len(stray)} rows that are not kernels carry a layer, first row {int(stray[0])}")

    # Tier invariant
    p = h["parent"]
    has = p >= 0
    worse = np.flatnonzero(has & (h["tier"] < h["tier"][np.where(has, p, 0)]))
    if len(worse):
        bad.append(f"tier invariant: {len(worse)} rows are coarser than their parent, first row {int(worse[0])}")

    # Unique eids
    dup = con.execute(f"SELECT count(*) - count(DISTINCT eid), count(*) FILTER (eid IS NULL) "
                      f"FROM '{g}/events-*.parquet'").fetchone()
    if dup != (0, 0):
        bad.append(f"eids: {dup[0]} duplicates, {dup[1]} missing")

    if live:
        got = {kind_names[k]: int(c) for k, c in enumerate(np.bincount(h["kind"], minlength=len(kind_names))) if c}
        return bad, {"rows": n, "status": "live", "kinds": got, "skipped": skipped,
                     "sample blocks": sum(b["table"] == "samples" for b in m.blocks)}

    # Row counts per kind equal the manifest's import stats
    got = {kind_names[k]: int(c) for k, c in enumerate(np.bincount(h["kind"], minlength=len(kind_names))) if c}
    if got != m.import_stats.get("kinds"):
        bad.append(f"kinds {got} differ from the manifest's import stats {m.import_stats.get('kinds')}")
    info = {"rows": n, "derived": {k: got[k] for k in derived if k in got},
            "tiers": np.bincount(h["tier"], minlength=len(TIERS)).tolist(), "generation": m.generation,
            "layers": int((h["layer"] >= 0).sum())}

    # One path: the live generation's eids are in the final one; one t0 across them
    live_g = root / "g0"
    if m.generation > 0 and live_g.is_dir() and list(live_g.glob("events-*.parquet")):
        miss, total = con.execute(f"""SELECT count(*) FILTER (f.id IS NULL), count(*)
            FROM '{live_g}/events-*.parquet' l LEFT JOIN '{g}/events-*.parquet' f ON l.eid = f.eid""").fetchone()
        info["live eids in final"] = f"{total - miss} of {total}"
        if miss:
            first = con.execute(f"""SELECT l.eid FROM '{live_g}/events-*.parquet' l
                ANTI JOIN '{g}/events-*.parquet' f ON l.eid = f.eid LIMIT 3""").fetchall()
            bad.append(f"live/final parity: {miss} of {total} live eids are not in g{m.generation}, "
                       f"first {[x[0] for x in first]}")
    clock = root / "capture" / "clock.json"
    if clock.is_file() and json.loads(clock.read_bytes())["t0_ns"] != m.t0_ns:
        bad.append(f"t0: manifest {m.t0_ns}, capture/clock.json {json.loads(clock.read_bytes())['t0_ns']}")
    return bad, info


def main() -> None:
    con = duckdb.connect()
    problems = columns_js() if COLUMNS_JS.is_file() else [f"{COLUMNS_JS} is missing"]
    print(("FAIL " if problems else "ok   ") + "schema.py == frontend/cc/store/columns.js")
    for x in problems:
        print("     ", x)
    periods = nvml_periods()
    print(("FAIL " if periods else "ok   ") + f"registry nvml periods == {PROBE}")
    for x in periods:
        print("     ", x)
    problems += periods
    runs = sorted(p.parent.name for p in (CC_STORE / "runs").glob("*/manifest.json"))
    failed = len(problems) > 0
    for run in runs:
        bad, info = check_run(con, run)
        failed |= bool(bad)
        print(("FAIL " if bad else "ok   ") + run + ("  " + json.dumps(info) if info else ""))
        for x in bad:
            print("     ", x)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
