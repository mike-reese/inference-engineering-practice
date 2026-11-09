"""Stop counts per (dimension, tier), and the stop check, for every run in the ie-run/3 store (COMMAND_CENTER.md,
sections 3.4 and 10).

Placement and stops come from devtools/registry/kinds.json: each kind's place per dimension (a ladder tier, "detail",
"-", or a rule that picks per row) and dimensions.stops (what a step visits per tier). A kernel stop (a kernel, memcpy
or memset row) also claims its cause, the call that launched it, as its CPU side: the same stop, not a second one.
The browser's RunStore applies the same rules; `--json` writes the counts it is compared with.

The stop check, per run; exits 1 on any failure:
  - every kind's execution place is allowed for its storage tier (dimensions.storage);
  - kernel stops equal the kernel, memcpy and memset rows of the run's own device trace, the files the importer reads:
    trace/*.sqlite (Nsight Systems CUPTI tables) and trace/torch_trace.json (PyTorch profiler); 0 with neither;
  - module stops equal the module forward() frames of trace/torch_trace.json (the kind rule's match on its
    python_function events); 0 without one (graphs-on runs: module is missing until M2);
  - every row has one tier per dimension: its kind has a valid place in each, and no row is claimed by two execution
    tiers (its kind's place and the CPU side of a kernel stop);
  - detail, the rows no stop tier claims, is never negative.
--self-test runs the check once per mutation, each placing a detail kind (or a launch call) at a stop tier, and exits 1
only when every mutation fails the check; a mutation the check misses is named and the exit is 0.

Run: uv run --no-project --with duckdb python design/dimensions/stop_counts.py [--write | --self-test] [--json PATH]
CC_STORE (default /mnt/ie-data/cc/store) picks the store, as for store.check.
--write replaces the block between the gen:stops markers in COMMAND_CENTER.md.
"""
import argparse
import copy
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

import duckdb
import numpy as np

from places import check_dimensions, check_places, load, tier_of

HERE = Path(__file__).parent
REPO = HERE.parent.parent
DOC = REPO / "COMMAND_CENTER.md"
STORE = Path(os.environ.get("CC_STORE", "/mnt/ie-data/cc/store")) / "runs"
NONE16 = 65535
NSYS_DEVICE = ("CUPTI_ACTIVITY_KIND_KERNEL", "CUPTI_ACTIVITY_KIND_MEMCPY", "CUPTI_ACTIVITY_KIND_MEMSET")
TORCH_DEVICE = {"kernel", "gpu_memcpy", "gpu_memset"}
DETAIL, UNPLACED = -1, -2
MUTATIONS = (("cuda runtime call", "phase"), ("os runtime call", "phase"), ("cpu operator", "module"),
             ("cuda graph node", "module"))


def traces(run_dir: Path | None, module_rx: re.Pattern) -> tuple[str, int | None, int]:
    """(files read, device rows, module forward() frames) of the run's own traces."""
    if run_dir is None:
        return "none (no run folder)", 0, 0
    if not run_dir.is_dir():
        return f"{run_dir} is missing", None, 0
    found, n, modules = [], 0, 0
    for db in sorted(run_dir.glob("trace/*.sqlite")):
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        have = {r[0] for r in con.execute("select name from sqlite_master where type = 'table'")}
        n += sum(con.execute(f"select count(*) from {t}").fetchone()[0] for t in NSYS_DEVICE if t in have)
        found.append(db.name)
    torch = run_dir / "trace" / "torch_trace.json"
    if torch.is_file():
        ev = [e for e in json.loads(torch.read_bytes())["traceEvents"] if e.get("ph") == "X"]
        n += sum(e.get("cat") in TORCH_DEVICE for e in ev)
        modules = sum(e.get("cat") == "python_function" and bool(module_rx.search(e.get("name", ""))) for e in ev)
        found.append(torch.name)
    return ", ".join(found) or "none", n, modules


def load_run(con, run_dir: Path, reg: dict) -> dict:
    m = json.loads((run_dir / "manifest.json").read_text())
    g = run_dir / f"g{m['generation']}"
    h = con.sql(f"select id, start, kind, tier, name, iter, layer, lane, comp, req, cause from read_parquet("
                f"'{g}/events-*.parquet', union_by_name=true) order by start, id").fetchnumpy()
    h = {k: np.ma.filled(v, -1) if np.ma.isMaskedArray(v) else np.asarray(v) for k, v in h.items()}
    profiled = np.array([], np.int64)
    if (g / "profiles.parquet").exists():
        profiled = con.sql(f"select distinct event_id from '{g / 'profiles.parquet'}' where event_id >= 0"
                           ).fetchnumpy()["event_id"]
    module_rx = re.compile(next(k["place"]["execution"]["match"] for k in reg["kinds"]
                                if isinstance(k["place"]["execution"], dict)
                                and k["place"]["execution"]["if"] == "module forward"))
    source, want, modules = traces(REPO / m["source"]["run_dir"] if m["source"].get("run_dir") else None, module_rx)
    samples = {}
    for f in sorted(g.glob("samples-*.parquet")):
        k, med = con.sql(f"select count(*), median(d) from (select ts_ns - lag(ts_ns) over (order by ts_ns) d "
                         f"from '{f}')").fetchall()[0]
        samples[f.stem.removeprefix("samples-")] = (k, med)
    return {"m": m, "h": h, "profiled": profiled, "source": source, "want": want, "modules": modules,
            "samples": samples}


def level_of(things: list, kinds: list[str]) -> np.ndarray:
    """Per thing, the index of its nearest ancestor (or itself) whose kind is one of kinds, -1 if none."""
    out = np.full(len(things), -1, np.int64)
    for t in things:
        x = t
        while x is not None and x["kind"] not in kinds:
            x = things[x["parent"]] if x["parent"] is not None and x["parent"] >= 0 else None
        out[t["i"]] = x["i"] if x is not None else -1
    return out


def handoffs(h: dict, rows: np.ndarray, key: np.ndarray) -> np.ndarray:
    """The rows (positions, in (start, id) order) where a request's key differs from its previous row's key.
    rows: positions taking part, in order; key: their key at this level (-1: no thing at this level)."""
    req = h["req"][rows]
    ok = (req != NONE16) & (key >= 0)
    rows, req, key = rows[ok], req[ok], key[ok]
    out, last = [], {}
    for p, r, k in zip(rows.tolist(), req.tolist(), key.tolist()):
        if r in last and last[r] != k:
            out.append(p)
        last[r] = k
    return np.array(out, np.int64)


def stops(R: dict, reg: dict, place: dict) -> tuple[dict, dict]:
    """(stops, facts): stops[dim][tier] = row positions in (start, id) order (for the layer and hand-off tiers, the
    row that opens the stop); facts: detail, launches, rows on two tiers, check failures."""
    m, h = R["m"], R["h"]
    kinds, names, things = [k["name"] for k in m["kinds"]], m["names"], m["things"]
    n, K = len(h["id"]), h["kind"]
    ladders, dims = reg["ladders"], reg["dimensions"]
    base = {k["kind"]: k["tier"] for k in reg["kinds"]}
    bad = [f"kind {kinds[c]!r} ({int((K == c).sum()):,} rows) has no place in kinds.json"
           for c in np.unique(K) if kinds[c] not in place]

    def plain(dim, tier):
        return [c for c, k in enumerate(kinds) if isinstance(place.get(k, {}).get(dim), str)
                and tier_of(place[k][dim]) == tier]
    device = np.isin(K, plain("execution", "kernel"))
    causes = h["cause"][device]
    launch_ids = np.unique(causes[causes >= 0])
    profiled = np.isin(h["id"], R["profiled"])

    def when(rule, kind, sel):
        if rule["if"] == "top-level":
            return h["tier"][sel] == base[kind]
        if rule["if"] == "launch":
            return np.isin(h["id"][sel], launch_ids)
        if rule["if"] == "profiled":
            return profiled[sel]
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

    ex = tiers("execution")
    for dim, t in (("execution", ex), ("hardware", tiers("hardware")), ("architecture", tiers("architecture"))):
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

    lane_level = {lv: level_of(things, dims["handoff"][lv]) for lv in ("container", "process")}
    S: dict = {d: {} for d in ladders}

    def resolve(dim, tier):
        if tier in S[dim]:
            return S[dim][tier]
        rule = dims["stops"][dim][tier]
        if "place" in rule:
            out = np.flatnonzero((ex == ladders["execution"].index(rule["place"])) & ~side)
        elif "group" in rule:
            rows = resolve("execution", rule["of"])
            g = np.stack([h[c][rows] for c in rule["group"]], 1)
            keep = (g >= 0).all(1)
            rows, g = rows[keep], g[keep]
            new = np.ones(len(rows), bool)
            new[1:] = (g[1:] != g[:-1]).any(1)
            out = rows[new]
        elif "kinds" in rule:
            sel = np.isin(K, [kinds.index(k) for k in rule["kinds"] if k in kinds])
            if rule.get("if") == "profiled":
                sel &= profiled
            out = np.flatnonzero(sel)
        elif "as" in rule:
            out = resolve(*rule["as"].split("/"))
        else:
            rows = np.flatnonzero(ex == ladders["execution"].index(dims["handoff"]["rows"]))
            lv = rule["handoff"]
            key = (h["comp"][rows].astype(np.int64) if dims["handoff"][lv] == "comp"
                   else lane_level[lv][h["lane"][rows]])
            if dims["handoff"][lv] == "comp":
                key[key == NONE16] = -1
            out = handoffs(h, rows, key)
        S[dim][tier] = out
        return out

    for dim, ladder in ladders.items():
        for tier in ladder:
            resolve(dim, tier)
    claimed = int((ex >= 0).sum() + twice.sum())
    detail = n - claimed
    if detail < 0:
        bad.append(f"detail is {detail:,}: stop tiers claim more rows than the run has")
    k_stops = len(S["execution"]["kernel"])
    if R["want"] is None:
        bad.append(f"device trace: {R['source']}")
    elif k_stops != R["want"]:
        bad.append(f"kernel stops {k_stops:,} differ from the {R['want']:,} kernel, memcpy and memset rows of "
                   f"{R['source']}")
    if len(S["execution"]["module"]) != R["modules"]:
        bad.append(f"module stops {len(S['execution']['module']):,} differ from the {R['modules']:,} module forward() "
                   f"frames of the run's torch_trace.json")
    return S, {"detail": detail, "launches": len(launch_ids), "twice": int(twice.sum()), "bad": bad}


def counts(S: dict) -> dict:
    return {dim: {tier: len(v) for tier, v in tiers.items()} for dim, tiers in S.items()}


def table(reg: dict, results: dict, skipped: list[str]) -> str:
    L = reg["ladders"]
    tiers = L["execution"] + ["detail"]
    out = ["Execution stops (own tier), per iteration in brackets. `layer` groups kernel rows by decoder layer. A kernel "
           "stop's launch call is its CPU side (launches, below): the same stop, not detail. `detail` is the rows no "
           "stop tier claims; they are never stops.", "",
           "| run | rows | iterations | " + " | ".join(tiers) + " |", "| --- " * (3 + len(tiers)) + "|"]
    for run, R in results.items():
        cells = []
        for t in tiers:
            k = R["facts"]["detail"] if t == "detail" else R["counts"]["execution"][t]
            cells.append(f"{k:,}" + (f" ({k / R['iters']:,.0f})" if R["iters"] else ""))
        out.append(f"| {run} | {R['rows']:,} | {R['iters']} | " + " | ".join(cells) + " |")
    out += ["", "Stop check: every execution place is allowed for its kind's storage tier; kernel stops equal the kernel, "
            "memcpy and memset rows of the run's device trace; module stops equal the module forward() frames of its "
            "torch_trace.json; no row is on two execution tiers; detail is not negative.", "",
            "| run | device trace | trace rows | kernel stops | module frames | module stops | rows on two tiers | result |",
            "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    for run, R in results.items():
        want = "n/a" if R["want"] is None else f"{R['want']:,}"
        c, f = R["counts"]["execution"], R["facts"]
        out.append(f"| {run} | {R['source']} | {want} | {c['kernel']:,} | {R['modules']:,} | {c['module']:,} | "
                   f"{f['twice']:,} | {'FAIL: ' + '; '.join(f['bad']) if f['bad'] else 'ok'} |")
    if skipped:
        out += ["", "Not counted: " + "; ".join(skipped) + "."]
    out += ["", "Hardware and architecture stops (`dimensions.stops` in kinds.json). Hardware: device steps on transfers "
            "(memcpy, memset), unit on kernels, kernel traffic and SM internals on profiled kernels; system and node "
            "step on execution request and iteration. Architecture: container, process and component step on a "
            "request's hand-offs (its phase rows moving to another container, process or component); fleet and node "
            "on requests; software layer on kernel stops at their launch call.", "",
            "| run | " + " | ".join(f"hardware {t}" for t in L["hardware"]) + " | launches | "
            + " | ".join(f"architecture {t}" for t in L["architecture"]) + " |",
            "| --- " * (2 + len(L["hardware"]) + len(L["architecture"])) + "|"]
    for run, R in results.items():
        c = R["counts"]
        out.append(f"| {run} | " + " | ".join(f"{c['hardware'][t]:,}" for t in L["hardware"])
                   + f" | {R['facts']['launches']:,} | " + " | ".join(f"{c['architecture'][t]:,}" for t in L["architecture"])
                   + " |")
    out += ["", "Hardware samples (state, not stops): count and median period.", "",
            "| run | sample group | samples | median period |", "| --- | --- | --- | --- |"]
    for run, R in results.items():
        for grp, (k, med) in R["samples"].items():
            out.append(f"| {run} | {grp} | {k:,} | {med / 1e3:,.0f} µs |" if med else f"| {run} | {grp} | {k:,} | n/a |")
    return "\n".join(out)


def check(reg: dict, place: dict, runs: dict) -> tuple[dict, list[str]]:
    problems = check_places(reg, place) + check_dimensions(reg)
    results = {}
    for name, R in runs.items():
        S, facts = stops(R, reg, place)
        c = counts(S)
        h = R["h"]
        results[name] = {"rows": len(h["id"]), "counts": c, "facts": facts, "source": R["source"], "want": R["want"],
                         "modules": R["modules"], "samples": R["samples"],
                         "iters": c["execution"]["iteration"] or len(np.unique(h["iter"][h["iter"] >= 0]))}
    return results, problems + [f"{run}: {b}" for run, R in results.items() for b in R["facts"]["bad"]]


def main():
    ap = argparse.ArgumentParser()
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--self-test", action="store_true")
    ap.add_argument("--json", type=Path, help="write {run: {dimension: {tier: stops}}} here")
    a = ap.parse_args()
    reg = load()
    place = {k["kind"]: dict(k["place"]) for k in reg["kinds"] if k.get("place")}
    con = duckdb.connect()
    runs, skipped = {}, []
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
        runs[d.name] = load_run(con, d, reg)
    if a.self_test:
        missed = []
        for kind, tier in MUTATIONS:
            mutated = copy.deepcopy(place)
            mutated[kind]["execution"] = tier
            _, failed = check(reg, mutated, runs)
            print(f"self-test: {kind} placed at execution / {tier}: {len(failed)} failures"
                  + (f", first: {failed[0]}" if failed else ", NOT CAUGHT"), file=sys.stderr)
            if not failed:
                missed.append(f"{kind} -> {tier}")
        print(f"\nself-test: {len(MUTATIONS) - len(missed)} of {len(MUTATIONS)} mutations fail the stop check",
              file=sys.stderr)
        sys.exit(0 if missed else 1)
    results, failed = check(reg, place, runs)
    md = table(reg, results, skipped)
    print(md)
    print(f"\nstop check: {len(results)} runs, {len(failed)} failures", file=sys.stderr)
    for f in failed:
        print("FAIL " + f, file=sys.stderr)
    if a.json:
        a.json.write_text(json.dumps({run: R["counts"] for run, R in results.items()}, indent=1))
    if a.write and not failed:
        text = DOC.read_text()
        new = re.sub(r"(<!-- gen:stops -->\n).*?(<!-- /gen:stops -->)", lambda x: x[1] + md + "\n" + x[2], text, flags=re.S)
        assert new != text or md in text, "gen:stops markers not found in the doc"
        DOC.write_text(new)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
