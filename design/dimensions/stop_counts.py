"""Stop counts per tier of each dimension, and the stop check, for every run in the ie-run/3 store (COMMAND_CENTER.md,
sections 3.4 and 10).

Placement comes from devtools/registry/kinds.json: each kind's place per dimension, a ladder tier, "detail", "-", or a
rule that picks per row. A kernel stop (a kernel, memcpy or memset row) also claims its cause, the call that launched
it, as its CPU side: the same stop, not a second one.

The stop check, per run; exits 1 on any failure:
  - kernel stops equal the kernel, memcpy and memset rows of the run's own device trace, the files the importer reads:
    trace/*.sqlite (Nsight Systems CUPTI tables) and trace/torch_trace.json (PyTorch profiler); 0 with neither;
  - every row has one tier per dimension: its kind has a valid place in each, and no row is claimed by two execution
    tiers (its kind's place and the CPU side of a kernel stop);
  - detail, the rows no stop tier claims, is never negative.
--self-test maps "cuda runtime call" to phase. The launch calls are then claimed twice, so it must exit 1.

Run: uv run --no-project --with duckdb python design/dimensions/stop_counts.py [--write | --self-test]
--write replaces the block between the gen:stops markers in COMMAND_CENTER.md.
"""
import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

import duckdb
import numpy as np

HERE = Path(__file__).parent
REPO = HERE.parent.parent
DOC = REPO / "COMMAND_CENTER.md"
KINDS = REPO / "devtools/registry/kinds.json"
STORE = Path("/mnt/ie-data/cc/store/runs")
NONE16 = 65535
RULES = ("top-level", "launch", "module forward", "profiled")
NSYS_DEVICE = ("CUPTI_ACTIVITY_KIND_KERNEL", "CUPTI_ACTIVITY_KIND_MEMCPY", "CUPTI_ACTIVITY_KIND_MEMSET")
TORCH_DEVICE = {"kernel", "gpu_memcpy", "gpu_memset"}
DETAIL, UNPLACED = -1, -2


def tier_of(value: str) -> str:
    """'kernel (CPU side)' -> 'kernel': the bracket says what the row lands on, not which tier."""
    return value.split(" (")[0]


def check_places(reg: dict) -> list[str]:
    ladders, bad = reg["ladders"], []
    for k in reg["kinds"]:
        place = k.get("place") or {}
        if set(place) != set(ladders):
            bad.append(f"kind {k['kind']!r}: place names {sorted(place)}, not each of {list(ladders)}")
            continue
        for dim, v in place.items():
            if isinstance(v, dict) and (v.get("if") not in RULES or set(v) - {"if", "then", "else", "match"}):
                bad.append(f"kind {k['kind']!r}: {dim} rule {v} is not one of {RULES} with then and else")
                continue
            for out in ([v] if isinstance(v, str) else [v.get("then"), v.get("else")]):
                if not isinstance(out, str) or tier_of(out) not in [*ladders[dim], "detail", "-"]:
                    bad.append(f"kind {k['kind']!r}: {dim} place {out!r} is not a tier of {dim}, detail or -")
    return bad


def device_trace(run_dir: Path | None) -> tuple[str, int | None]:
    if run_dir is None:
        return "none (no run folder)", 0
    if not run_dir.is_dir():
        return f"{run_dir} is missing", None
    found, n = [], 0
    for db in sorted(run_dir.glob("trace/*.sqlite")):
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        have = {r[0] for r in con.execute("select name from sqlite_master where type = 'table'")}
        n += sum(con.execute(f"select count(*) from {t}").fetchone()[0] for t in NSYS_DEVICE if t in have)
        found.append(db.name)
    torch = run_dir / "trace" / "torch_trace.json"
    if torch.is_file():
        n += sum(e.get("ph") == "X" and e.get("cat") in TORCH_DEVICE for e in json.loads(torch.read_bytes())["traceEvents"])
        found.append(torch.name)
    return ", ".join(found) or "none", n


def run_counts(con, run_dir: Path, reg: dict, place: dict) -> dict:
    m = json.loads((run_dir / "manifest.json").read_text())
    g = run_dir / f"g{m['generation']}"
    kinds, names, things = [k["name"] for k in m["kinds"]], m["names"], m["things"]
    h = con.sql(f"select id, start, kind, tier, name, iter, layer, comp, req, cause from read_parquet("
                f"'{g}/events-*.parquet', union_by_name=true) order by start, id").fetchnumpy()
    h = {k: np.ma.filled(v, -1) if np.ma.isMaskedArray(v) else np.asarray(v) for k, v in h.items()}
    n, K = len(h["id"]), h["kind"]
    ladders, base = reg["ladders"], {k["kind"]: k["tier"] for k in reg["kinds"]}
    bad = [f"kind {kinds[c]!r} ({int((K == c).sum()):,} rows) has no place in kinds.json"
           for c in np.unique(K) if kinds[c] not in place]

    def plain(dim, tier):
        return [c for c, k in enumerate(kinds) if isinstance(place.get(k, {}).get(dim), str)
                and tier_of(place[k][dim]) == tier]
    device = np.isin(K, plain("execution", "kernel"))
    causes = h["cause"][device]
    launch_ids = np.unique(causes[causes >= 0])
    profiled_ids = np.array([], np.int64)
    if (g / "profiles.parquet").exists():
        profiled_ids = con.sql(f"select distinct event_id from '{g / 'profiles.parquet'}' where event_id >= 0"
                               ).fetchnumpy()["event_id"]

    def when(rule, kind, sel):
        if rule["if"] == "top-level":
            return h["tier"][sel] == base[kind]
        if rule["if"] == "launch":
            return np.isin(h["id"][sel], launch_ids)
        if rule["if"] == "profiled":
            return np.isin(h["id"][sel], profiled_ids)
        rx, codes = re.compile(rule["match"]), h["name"][sel]
        hit = {int(c): bool(rx.search(names[c])) for c in np.unique(codes)}
        return np.array([hit[int(c)] for c in codes], bool)

    def tiers(dim):
        """Each row's tier index in the dimension's ladder, DETAIL for detail or -, UNPLACED for an unknown kind."""
        out, code = np.full(n, UNPLACED, np.int8), lambda v: ladders[dim].index(tier_of(v)) \
            if tier_of(v) in ladders[dim] else DETAIL
        for c in np.unique(K):
            kind, sel = kinds[c], np.flatnonzero(K == c)
            v = place.get(kind, {}).get(dim)
            if v is None:
                continue
            out[sel] = code(v) if isinstance(v, str) else np.where(when(v, kind, sel), code(v["then"]), code(v["else"]))
        return out

    ex, hw = tiers("execution"), tiers("hardware")
    for dim, t in (("execution", ex), ("hardware", hw), ("architecture", tiers("architecture"))):
        if (t == UNPLACED).any():
            bad.append(f"{dim}: {int((t == UNPLACED).sum()):,} rows have no tier")
    KERNEL = ladders["execution"].index("kernel")
    side = np.isin(h["id"], launch_ids)
    twice = side & (ex != KERNEL)
    if twice.any():
        first = int(np.flatnonzero(twice)[0])
        bad.append(f"{int(twice.sum()):,} rows on two execution tiers, the CPU side of a kernel stop and their kind's "
                   f"{ladders['execution'][ex[first]] if ex[first] >= 0 else 'detail'} (first row {int(h['id'][first])}, "
                   f"{kinds[K[first]]} {names[h['name'][first]]})")
    c = {t: int(((ex == i) & ~side).sum()) for i, t in enumerate(ladders["execution"])}
    claimed = int((ex >= 0).sum() + twice.sum())
    c["detail"] = n - claimed
    if c["detail"] < 0:
        bad.append(f"detail is {c['detail']:,}: stop tiers claim more rows than the run has")
    source, want = device_trace(REPO / m["source"]["run_dir"] if m["source"].get("run_dir") else None)
    if want is None:
        bad.append(f"device trace: {source}")
    elif c["kernel"] != want:
        bad.append(f"kernel stops {c['kernel']:,} differ from the {want:,} kernel, memcpy and memset rows of {source}")

    order = np.flatnonzero(device & (h["layer"] >= 0))
    keys = list(zip(h["iter"][order].tolist(), h["layer"][order].tolist()))
    c["layer"] = sum(1 for i, k in enumerate(keys) if i == 0 or k != keys[i - 1])
    iters = c["iteration"] or len(np.unique(h["iter"][h["iter"] >= 0]))

    def path(i, depth):
        return "/".join(things[i]["key"].split("/")[:depth])
    hand, last = {"container": 0, "process": 0, "component": 0}, {}
    for comp, req in zip(h["comp"].tolist(), h["req"].tolist()):
        if comp < 0 or comp == NONE16 or req < 0:
            continue
        for tier, depth in (("container", 3), ("process", 4), ("component", 99)):
            p = path(comp, depth)
            if last.get((req, tier)) is not None and p != last[(req, tier)]:
                hand[tier] += 1
            last[(req, tier)] = p

    samples = {}
    for f in sorted(g.glob("samples-*.parquet")):
        k, med = con.sql(f"select count(*), median(d) from (select ts_ns - lag(ts_ns) over (order by ts_ns) d "
                         f"from '{f}')").fetchall()[0]
        samples[f.stem.removeprefix("samples-")] = (k, med)
    return {"rows": n, "iters": iters, "exec": c, "launches": len(launch_ids), "hand": hand, "samples": samples,
            "hw": {t: int((device & (hw == i)).sum()) for i, t in enumerate(ladders["hardware"])},
            "source": source, "want": want, "twice": int(twice.sum()), "bad": bad}


def table(reg: dict, results: dict, skipped: list[str]) -> str:
    tiers = reg["ladders"]["execution"] + ["detail"]
    out = ["Execution stops (own tier), per iteration in brackets. `layer` groups kernel rows by decoder layer. A kernel "
           "stop's launch call is its CPU side (launches, below): the same stop, not detail. `detail` is the rows no "
           "stop tier claims; they are never stops.", "",
           "| run | rows | iterations | " + " | ".join(tiers) + " |", "| --- " * (3 + len(tiers)) + "|"]
    for run, R in results.items():
        cells = []
        for t in tiers:
            k = R["exec"][t]
            cells.append(f"{k:,}" + (f" ({k / R['iters']:,.0f})" if R["iters"] else ""))
        out.append(f"| {run} | {R['rows']:,} | {R['iters']} | " + " | ".join(cells) + " |")
    out += ["", "Stop check: kernel stops equal the kernel, memcpy and memset rows of the run's device trace; no row is "
            "on two execution tiers; detail is not negative.", "",
            "| run | device trace | trace rows | kernel stops | rows on two tiers | result |",
            "| --- | --- | --- | --- | --- | --- |"]
    for run, R in results.items():
        want = "n/a" if R["want"] is None else f"{R['want']:,}"
        out.append(f"| {run} | {R['source']} | {want} | {R['exec']['kernel']:,} | {R['twice']:,} | "
                   f"{'FAIL: ' + '; '.join(R['bad']) if R['bad'] else 'ok'} |")
    if skipped:
        out += ["", "Not counted: " + "; ".join(skipped) + "."]
    hw = [t for t in reg["ladders"]["hardware"] if any(R["hw"][t] for R in results.values())]
    out += ["", "Hardware and architecture stops. Hardware: kernel stops at their hardware tier (kinds.json). "
            "Architecture: hand-offs of a request to another container, process or component.", "",
            "| run | " + " | ".join(f"hardware {t}" for t in hw) + " | launches | container hand-offs | "
            "process hand-offs | component hand-offs |", "| --- " * (5 + len(hw)) + "|"]
    for run, R in results.items():
        h = R["hand"]
        out.append(f"| {run} | " + " | ".join(f"{R['hw'][t]:,}" for t in hw) + f" | {R['launches']:,} | "
                   f"{h['container']:,} | {h['process']:,} | {h['component']:,} |")
    out += ["", "Hardware samples (state, not stops): count and median period.", "",
            "| run | sample group | samples | median period |", "| --- | --- | --- | --- |"]
    for run, R in results.items():
        for grp, (k, med) in R["samples"].items():
            out.append(f"| {run} | {grp} | {k:,} | {med / 1e3:,.0f} µs |" if med else f"| {run} | {grp} | {k:,} | n/a |")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    reg = json.loads(KINDS.read_text())
    place = {k["kind"]: dict(k["place"]) for k in reg["kinds"] if k.get("place")}
    if a.self_test:
        place["cuda runtime call"]["execution"] = "phase"
        print("self-test: cuda runtime call placed at execution / phase; the stop check must fail\n", file=sys.stderr)
    problems = check_places(reg)
    con = duckdb.connect()
    results, skipped = {}, []
    for d in sorted(STORE.iterdir()):
        if not (d / "manifest.json").exists():
            continue
        m = json.loads((d / "manifest.json").read_text())
        if not list((d / f"g{m['generation']}").glob("events-*.parquet")):
            skipped.append(f"{d.name} ({m['source'].get('live') or m['status']}, no events)")
            continue
        if m["status"] == "live":
            skipped.append(f"{d.name} (live; counted after its final import)")
            continue
        results[d.name] = run_counts(con, d, reg, place)
    md = table(reg, results, skipped)
    print(md)
    failed = problems + [f"{run}: {b}" for run, R in results.items() for b in R["bad"]]
    print(f"\nstop check: {len(results)} runs, {len(failed)} failures", file=sys.stderr)
    for f in failed:
        print("FAIL " + f, file=sys.stderr)
    if a.write and not failed:
        text = DOC.read_text()
        new = re.sub(r"(<!-- gen:stops -->\n).*?(<!-- /gen:stops -->)", lambda x: x[1] + md + "\n" + x[2], text, flags=re.S)
        assert new != text or md in text, "gen:stops markers not found in the doc"
        DOC.write_text(new)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
