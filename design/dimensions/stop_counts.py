"""Stop counts per tier of each dimension, for every run in the ie-run/3 store (COMMAND_CENTER.md, section 10).

A stop is a place the cursor lands when stepping at that tier. The tier rules live in proposal.json; this script only
applies them. Run: uv run --no-project --with duckdb python design/dimensions/stop_counts.py [--write]
--write replaces the block between the gen:stops markers in COMMAND_CENTER.md. Exits 1 when the jump check
flags a tier.
"""
import argparse
import json
import re
import sys
from pathlib import Path

import duckdb

HERE = Path(__file__).parent
DOC = HERE.parent.parent / "COMMAND_CENTER.md"
STORE = Path("/mnt/ie-data/cc/store/runs")
NONE16 = 65535


def run_counts(con, run_dir: Path, P: dict) -> dict:
    m = json.loads((run_dir / "manifest.json").read_text())
    g = run_dir / f"g{m['generation']}"
    kinds = [k["name"] for k in m["kinds"]]
    names = m["names"]
    things = m["things"]
    con.sql(f"create or replace table e as select * from read_parquet('{g}/events-*.parquet', union_by_name=true)")
    rows = con.sql("select id, start, kind, tier, name, iter, layer, comp, lane, req from e order by start, id").fetchall()
    by_kind = {}
    for r in rows:
        by_kind.setdefault(kinds[r[2]], []).append(r)

    ex = P["execution_rules"]
    module_re = re.compile(ex["module_name_regex"])
    launch_re = re.compile(ex["launch_name_regex"])
    c = {}
    c["request"] = sum(len(by_kind.get(k, [])) for k in ex["request"])
    c["iteration"] = sum(len(by_kind.get(k, [])) for k in ex["iteration"])
    c["phase"] = sum(len(by_kind.get(k, [])) for k in ex["phase"]) + sum(
        1 for r in by_kind.get("nvtx range", []) if r[3] == ex["phase_nvtx_tier"])
    device = [r for k in ex["kernel"] for r in by_kind.get(k, [])]
    device.sort(key=lambda r: (r[1], r[0]))
    prev, layers = None, 0
    for r in device:
        if r[6] < 0:
            continue
        key = (r[5], r[6])
        if key != prev:
            layers += 1
        prev = key
    c["layer"] = layers
    c["module"] = sum(1 for r in by_kind.get("python call", []) if module_re.search(names[r[4]]))
    c["kernel"] = len(device)
    stops = sum(c.values()) - c["layer"]
    c["detail"] = len(rows) - stops

    iters = c["iteration"] or len({r[5] for r in rows if r[5] is not None and r[5] >= 0})
    launches = sum(1 for k in ("cuda runtime call", "cuda driver call") for r in by_kind.get(k, [])
                   if launch_re.search(names[r[4]]))

    def path(i, depth):
        parts = things[i]["key"].split("/")
        return "/".join(parts[:depth])
    hand = {"container": 0, "process": 0, "component": 0}
    last = {}
    for r in rows:
        if r[7] is None or r[7] == NONE16 or r[9] is None or r[9] < 0:
            continue
        for tier, depth in (("container", 3), ("process", 4), ("component", 99)):
            p = path(r[7], depth)
            if last.get((r[9], tier)) is not None and p != last[(r[9], tier)]:
                hand[tier] += 1
            last[(r[9], tier)] = p

    samples = {}
    for f in sorted(g.glob("samples-*.parquet")):
        n, med = con.sql(f"select count(*), median(d) from (select ts_ns - lag(ts_ns) over (order by ts_ns) d from '{f}')").fetchall()[0]
        samples[f.stem.removeprefix("samples-")] = (n, med)
    profiled = 0
    if (g / "profiles.parquet").exists():
        profiled = con.sql(f"select count(distinct event_id) from '{g / 'profiles.parquet'}'").fetchall()[0][0]
    return {"rows": len(rows), "iters": iters, "exec": c, "launches": launches, "hand": hand,
            "transfers": sum(len(by_kind.get(k, [])) for k in ("memcpy", "memset")), "samples": samples,
            "profiled": profiled}


STOP_TIERS = ["request", "iteration", "phase", "layer", "module", "kernel"]
JUMP = 3


def level_and_time(run: str) -> tuple[str, str]:
    m = re.search(r"-TRACE-(\w+?)_(\d{8}T\d{6}Z)_", run) or re.search(r"()_(\d{8}T\d{6}Z)_", run)
    return (m[1] or "measured", m[2]) if m else ("unknown", run)


def jumps(results: dict) -> list[str]:
    """A tier whose stops per iteration exceed JUMP times the largest earlier run of the same trace level: a row kind
    that should be detail has probably been mapped to a stop tier (the Tier 4 mistake)."""
    seen, flags = {}, []
    for run in sorted(results, key=lambda r: level_and_time(r)[1]):
        R, level = results[run], level_and_time(run)[0]
        if not R["iters"]:
            continue
        for t in STOP_TIERS:
            per = R["exec"][t] / R["iters"]
            prior = seen.get((level, t), 0)
            if prior and per > JUMP * prior:
                flags.append(f"{run}: {t} {per:,.0f} stops per iteration, over {JUMP} x {prior:,.0f} (earlier {level} runs)")
            seen[(level, t)] = max(prior, per)
    return flags


def table(results: dict, flags: list[str]) -> str:
    tiers = STOP_TIERS + ["detail"]
    out = ["Execution stops (own tier). Per iteration in brackets. `detail` rows are never stops.", "",
           "| run | rows | iterations | " + " | ".join(tiers) + " |", "| --- " * (3 + len(tiers)) + "|"]
    for run, R in results.items():
        cells = []
        for t in tiers:
            n = R["exec"][t]
            per = n / R["iters"] if R["iters"] else None
            cells.append(f"{n:,}" + (f" ({per:,.0f})" if per is not None else ""))
        out.append(f"| {run} | {R['rows']:,} | {R['iters']} | " + " | ".join(cells) + " |")
    out += ["", f"Jump check (a stop tier above {JUMP} times its largest earlier run of the same trace level): " +
            ("no jumps." if not flags else f"{len(flags)} flagged."), ""] + [f"- {f}" for f in flags]
    out += ["", "Hardware and architecture stops.", "",
            "| run | transfers | launches | container hand-offs | process hand-offs | component hand-offs | ncu-profiled |",
            "| --- | --- | --- | --- | --- | --- | --- |"]
    for run, R in results.items():
        h = R["hand"]
        out.append(f"| {run} | {R['transfers']:,} | {R['launches']:,} | {h['container']:,} | {h['process']:,} | "
                   f"{h['component']:,} | {R['profiled']:,} |")
    out += ["", "Hardware samples (state, not stops): count and median period.", "",
            "| run | sample group | samples | median period |", "| --- | --- | --- | --- |"]
    for run, R in results.items():
        for grp, (n, med) in R["samples"].items():
            out.append(f"| {run} | {grp} | {n:,} | {med / 1e3:,.0f} µs |" if med else f"| {run} | {grp} | {n:,} | n/a |")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    P = json.loads((HERE / "proposal.json").read_text())
    con = duckdb.connect()
    results = {d.name: run_counts(con, d, P) for d in sorted(STORE.iterdir())
               if (d / "manifest.json").exists() and json.loads((d / "manifest.json").read_text())["generation"] > 0}
    flags = jumps(results)
    md = table(results, flags)
    print(md)
    if a.write:
        text = DOC.read_text()
        new = re.sub(r"(<!-- gen:stops -->\n).*?(<!-- /gen:stops -->)", lambda m: m[1] + md + "\n" + m[2], text, flags=re.S)
        assert new != text or md in text, "gen:stops markers not found in the doc"
        DOC.write_text(new)
    sys.exit(1 if flags else 0)


if __name__ == "__main__":
    main()
