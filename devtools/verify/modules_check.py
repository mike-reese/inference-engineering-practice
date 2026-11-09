"""The M2 check (COMMAND_CENTER.md 7.4 M2): the module rows a graphs-on run's import inferred, against the code run's
module frames and the run's own Nsight Systems export.

  names      each inferred module's device rows, in start order, have the names of the device rows its code-run
             frame launched (kernels by short name, copies by direction: devtools/backend/store/modules.py
             match_key). The frame's rows are found here from the code run's store (launch call, then parents).
             Full names are compared too, for information: the two profilers' demanglers write them differently.
  spans      each module's span holds its device rows and its inner modules.
  unmatched  per iteration of the run's store, the kernel stops (kernel, memcpy and memset rows) that no inferred
             module holds. Counted and shown, not judged.
  totals     per kernel name, the instances and total ns of the run's kernel rows equal `nsys stats -r
             cuda_gpu_kern_sum` on a copy of the run's trace/*.sqlite, by full name and summed by short name.

Usage: CC_STORE=/mnt/ie-data/cc/store-m2 .venv/bin/python devtools/verify/modules_check.py RUN [RUN ...]
Exits 1 when a names, spans or totals check fails, or a run has no inferred modules.
"""
import csv
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict
from pathlib import Path

import duckdb
import numpy as np

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "devtools" / "backend"))
from store.derive import kernel_short_name  # noqa: E402
from store.modules import match_key  # noqa: E402

STORE = Path(os.environ.get("CC_STORE", "/mnt/ie-data/cc/store")) / "runs"
DEVICE = ("kernel", "memcpy", "memset")
MODULE = "inferred module"


class Run:
    """One run's store generation: hot columns in id order (ids are dense, so a row's id is its index)."""

    def __init__(self, run: str):
        self.run = run
        self.m = json.loads((STORE / run / "manifest.json").read_bytes())
        self.events = f"{STORE / run}/g{self.m['generation']}/events-*.parquet"
        self.t = duckdb.sql(f'SELECT start, "end", lane, kind, iter, parent, cause, name FROM '
                            f"read_parquet('{self.events}') ORDER BY id").fetchnumpy()
        self.code = {k["name"]: k["code"] for k in self.m["kinds"]}
        self.kind_of = {k["code"]: k["name"] for k in self.m["kinds"]}
        self.names = self.m["names"]
        self.device = np.isin(self.t["kind"], [self.code[k] for k in DEVICE])

    def name(self, i: int) -> str:
        return self.names[self.t["name"][i]]

    def key(self, i: int) -> str:
        return match_key(self.kind_of[int(self.t["kind"][i])], self.name(i))

    def cold(self, column: str, ids) -> dict:
        ids = sorted({int(i) for i in ids})
        return dict(duckdb.execute(f"SELECT id, {column} FROM read_parquet('{self.events}') WHERE id IN "
                                   "(SELECT unnest(?))", [ids]).fetchall()) if ids else {}

    def by_eid(self, eids) -> dict:
        return {e: i for i, e in duckdb.execute(f"SELECT id, eid FROM read_parquet('{self.events}') WHERE eid IN "
                                                "(SELECT unnest(?))", [sorted(set(eids))]).fetchall()}


def frame_rows(ref: Run, frames: set) -> dict[int, list[int]]:
    """Per code-run frame, the device rows launched under it (the launch call's parent chain), in start order."""
    out, parent, cause = defaultdict(list), ref.t["parent"], ref.t["cause"]
    for x in np.flatnonzero(ref.device & (cause >= 0)).tolist():
        p = parent[cause[x]]
        while p >= 0:
            if p in frames:
                out[int(p)].append(x)
            p = parent[p]
    return out


def module_rows(r: Run) -> dict[int, list[int]]:
    """Per inferred module row, the device rows it holds, itself or through inner modules, in start order."""
    mod, parent, out = r.code[MODULE], r.t["parent"], defaultdict(list)
    for x in np.flatnonzero(r.device & (parent >= 0)).tolist():
        p = parent[x]
        while p >= 0 and r.t["kind"][p] == mod:
            out[int(p)].append(x)
            p = parent[p]
    return out


def nsys_kernels(sqlite: Path) -> list[tuple[str, int, int]]:
    """(name, instances, total ns) per kernel name of `nsys stats -r cuda_gpu_kern_sum`, run on a copy of the export
    so the run folder's file is never opened for writing."""
    with tempfile.TemporaryDirectory() as tmp:
        copy = Path(tmp) / sqlite.name
        shutil.copyfile(sqlite, copy)
        out = subprocess.run(["nsys", "stats", "-q", "-r", "cuda_gpu_kern_sum", "-f", "csv", "-o", "-", str(copy)],
                             check=True, capture_output=True, text=True).stdout
    rows = csv.DictReader(io.StringIO(out[out.index("Time (%),"):]))
    return [(x["Name"], int(x["Instances"]), int(x["Total Time (ns)"])) for x in rows]


def names(r: Run, ref: Run, held: dict, launched: dict) -> tuple[list[str], dict]:
    def keys(run: Run, rows: list[int]) -> list[str]:
        return [run.key(x) for x in rows]

    differ = [i for i in launched if keys(r, held[i]) != keys(ref, launched[i])]
    pairs = [(x, y) for i in launched for x, y in zip(held[i], launched[i])
             if r.kind_of[int(r.t["kind"][x])] == "kernel"]
    full, full_ref = r.cold("full_name", [x for x, _ in pairs]), ref.cold("full_name", [y for _, y in pairs])
    out = {"modules": len(launched), "modules whose names equal the code run's frame": len(launched) - len(differ),
           "device rows compared (once per module that holds them)": sum(len(held[i]) for i in launched),
           "kernel pairs with equal full names (information)":
               f"{sum(full[x] == full_ref[y] for x, y in pairs)} of {len(pairs)}",
           "first full-name difference (this run, code run)":
               next(((full[x], full_ref[y]) for x, y in pairs if full[x] != full_ref[y]), None)}
    if not differ:
        return [], out
    i = differ[0]
    return [f"{len(differ)} modules' device rows differ from their code-run frame's, first {r.name(i)} (row {i}): "
            f"{keys(r, held[i])} vs {keys(ref, launched[i])}"], out


def spans(r: Run, mods: list[int], held: dict) -> tuple[list[str], dict]:
    start, end, parent = r.t["start"], r.t["end"], r.t["parent"]

    def holds(a: int, rows: list[int]) -> bool:
        return start[a] <= start[rows].min() and end[a] >= end[rows].max()

    loose = [i for i in mods if not holds(i, held[i]) or (parent[i] >= 0 and not holds(parent[i], [i]))]
    lane = r.t["lane"]
    on_lane = {ln: np.flatnonzero(r.device & (lane == ln)) for ln in np.unique(lane[mods]).tolist()}
    inside = sum(int(((start[x] >= start[i]) & (end[x] <= end[i])).sum()) - len(held[i])
                 for i in mods for x in [on_lane[lane[i]]])
    out = {"modules whose span holds its device rows and inner modules": len(mods) - len(loose),
           "device rows of no or another module inside a span, same stream (information)": inside}
    return [f"{len(loose)} module spans do not hold their rows, first row {loose[0]} ({r.name(loose[0])})"
            ] if loose else [], out


def unmatched(r: Run) -> dict:
    it, parent = r.t["iter"], r.t["parent"]
    in_module = r.device & (parent >= 0) & (r.t["kind"][np.maximum(parent, 0)] == r.code[MODULE])
    per = Counter()
    for v in np.unique(it[r.device & (it >= 0)]).tolist():
        sel = r.device & (it == v)
        per[int(sel.sum()), int((sel & ~in_module).sum())] += 1
    iterations = it[r.t["kind"] == r.code["iteration"]]
    return {"iteration rows": len(iterations),
            "iteration rows with no kernel stops": int((~np.isin(iterations, it[r.device])).sum()),
            "iterations with kernel stops, by (kernel stops, unmatched)": {
                f"{k} stops, {u} unmatched": n for (k, u), n in sorted(per.items())},
            "kernel stops with no iteration": int((r.device & (it < 0)).sum()),
            "kernel stops in a module": int(in_module.sum()), "kernel stops": int(r.device.sum())}


def totals(r: Run) -> tuple[list[str], dict]:
    sqlite = sorted((REPO / r.m["source"]["run_dir"] / "trace").glob("*.sqlite"))[0]
    kernels = np.flatnonzero(r.t["kind"] == r.code["kernel"])
    full = r.cold("full_name", kernels)
    ns = (r.t["end"][kernels] - r.t["start"][kernels]).round().astype(np.int64)
    store = {"full": defaultdict(lambda: [0, 0]), "short": defaultdict(lambda: [0, 0])}
    for i, d in zip(kernels.tolist(), ns.tolist()):
        for what, name in (("full", full[i]), ("short", r.name(i))):
            store[what][name][0] += 1
            store[what][name][1] += d
    nsys = {"full": defaultdict(lambda: [0, 0]), "short": defaultdict(lambda: [0, 0])}
    for name, n, d in nsys_kernels(sqlite):
        for what, key in (("full", name), ("short", kernel_short_name(name))):
            nsys[what][key][0] += n
            nsys[what][key][1] += d
    bad, out = [], {"source": f"nsys stats -r cuda_gpu_kern_sum {sqlite.relative_to(REPO)}"}
    for what in ("full", "short"):
        a, b = store[what], nsys[what]
        miss = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
        out[f"by {what} name"] = {"names": len(b), "instances": sum(v[0] for v in b.values()),
                                  "total ns": sum(v[1] for v in b.values()), "names that differ": len(miss)}
        if miss:
            bad.append(f"{len(miss)} {what} names differ from nsys stats, first {miss[0]!r}: store "
                       f"{a.get(miss[0])}, nsys {b.get(miss[0])}")
    return bad, out


def check(run: str) -> tuple[list[str], dict]:
    r = Run(run)
    stats = r.m["import"].get("modules") or {}
    if not stats.get("rows"):
        return [f"no inferred modules ({stats.get('not inferred', 'no modules stats')})"], {"run": run}
    ref = Run(stats["reference"]["run"])
    mods = np.flatnonzero(r.t["kind"] == r.code[MODULE]).tolist()
    eid = {i: json.loads(a)["reference"]["eid"] for i, a in r.cold("args", mods).items()}
    frame = ref.by_eid(eid.values())
    launched_by = frame_rows(ref, set(frame.values()))
    launched = {i: launched_by[frame[eid[i]]] for i in mods}
    held = module_rows(r)
    bad_names, out_names = names(r, ref, held, launched)
    bad_spans, out_spans = spans(r, mods, held)
    bad_totals, out_totals = totals(r)
    return bad_names + bad_spans + bad_totals, {
        "run": run, "generation": r.m["generation"], "reference": f"{ref.run} g{ref.m['generation']}",
        "names": out_names, "spans": out_spans, "unmatched": unmatched(r), "totals": out_totals}


def main() -> None:
    runs = sys.argv[1:]
    if not runs:
        sys.exit(__doc__)
    failed = []
    for run in runs:
        bad, out = check(run)
        print(json.dumps(out, indent=1, default=str))
        print(("FAIL " if bad else "ok   ") + run, file=sys.stderr)
        for b in bad:
            print(f"     {run}: {b}", file=sys.stderr)
        failed += bad
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
