"""The rep catalog for the command center shell, and the moments lint (COMMAND_CENTER.md 2.5, 2.6, 7.2).

GET /api/v3/reps answers {reps, runs}, the shape of D13's session-data.json (prototypes/D13/tools/build_session.py):
  reps: every reps/*/README.md folder: {id, title, folder, registered, actions, sections, moments}; actions are the
        rep.toml launch actions, sections the README's Mechanism, Task, Results, Why It Matters and Pass Check,
        moments the rep's moments.toml (null without one).
  runs: every run of the ie-run/3 store that comes from a rep folder: {id, rep, labels, started, status, result};
        result is read from the run folder's result file, moments.toml `result` (default latency.json). latency.json
        is read per request: the summary of the moments' request (scalars of client, engine, wire, remainder, and the
        segments). Any other result file is read whole. null: results not computed (no result file, no
        latency.json entry for that request, or moments.toml `complete` names a value in the result that is false).

The moments lint, per rep with a moments.toml and per store run of that rep with a result: every moment's `at` and
evidence `path` resolves to a number in the result, and its `event` names a row of the moment's request (a row
whose name starts with it). A run without a result is listed as "results not computed" and has nothing to resolve;
a rep whose moments resolve on no run fails.
Run: python -m store.reps --lint [REP ...]   (CC_STORE picks the store, REPO the checkout); exits 1 on any miss.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tomllib
from pathlib import Path

CC_STORE = Path(os.environ.get("CC_STORE", "/mnt/ie-data/cc/store"))
REPO = Path(os.environ.get("REPO", Path(__file__).resolve().parents[3]))
SECTIONS = ["Mechanism", "Task", "Results", "Why It Matters", "Pass Check"]
STAMP = re.compile(r"(\d{8}T\d{6}Z)")
ACTION_KEYS = ("id", "group", "label", "description", "measured", "minutes")
LATENCY = "latency.json"


def readme_sections(text: str) -> dict:
    """Top-level '## ' sections by name; also the bold-lead form '**Mechanism.** ...' some READMEs use."""
    out, cur = {}, None
    for line in text.splitlines():
        if m := re.match(r"^##\s+(.+?)\s*$", line):
            cur = m.group(1).strip()
            out[cur] = []
            continue
        if b := re.match(r"^\*\*(%s)\.\*\*\s*(.*)$" % "|".join(SECTIONS), line):
            cur = b.group(1)
            out[cur] = [b.group(2)]
            continue
        if cur:
            out[cur].append(line)
    return {k: "\n".join(v).strip() for k, v in out.items() if k in SECTIONS}


def measured(lat: dict, suffix: str) -> dict | None:
    """The latency.json summary of the request whose id ends with suffix: scalars only, and the segments."""
    for key, rec in lat.items():
        if key.endswith(suffix):
            def pick(d):
                return {k: v for k, v in (d or {}).items() if isinstance(v, (int, float, str))}
            return {"request_id": key, "client": pick(rec.get("client")), "engine": pick(rec.get("engine")),
                    "wire": pick(rec.get("wire")), "remainder": pick(rec.get("remainder")),
                    "segments": rec.get("segments", [])}
    return None


def value_at(result: dict | None, path: str):
    """D13 session.js valueAt: 'wire.headers_ms'; 'segments[first_scheduled_time].ms' picks the segment whose name
    starts with the bracketed text (never by index)."""
    o = result
    for k in [x for x in re.split(r"\.|\[([^\]]+)\]", path) if x]:
        if isinstance(o, list) and not k.isdigit():
            o = next((x for x in o if str(x.get("name", "")).startswith(k)), None)
        elif isinstance(o, list):
            o = o[int(k)] if int(k) < len(o) else None
        else:
            o = o.get(k) if isinstance(o, dict) else None
    return o


def rep_folders(repo: Path) -> list[Path]:
    return sorted(p.parent for p in repo.glob("reps/*/README.md"))


def rep_of(folder: Path, repo: Path) -> dict:
    toml = folder / "rep.toml"
    man = tomllib.loads(toml.read_text()) if toml.exists() else {"id": folder.name.split("_")[0]}
    readme = (folder / "README.md").read_text()
    h1 = re.search(r"^#\s+\S+\s+-+\s+(.+)$", readme, re.M)
    spec = folder / man.get("spec", "README.md")
    moments = tomllib.loads((folder / "moments.toml").read_text()) if (folder / "moments.toml").exists() else None
    return {"id": man["id"], "title": man.get("title") or (h1.group(1).strip() if h1 else folder.name),
            "folder": str(folder.relative_to(repo)), "registered": toml.exists(),
            "actions": [{k: a.get(k) for k in ACTION_KEYS} | {"options": a.get("options", [])}
                        for a in man.get("actions", [])],
            "sections": readme_sections(spec.read_text()) if spec.exists() else {}, "moments": moments}


def catalog(repo: Path = REPO, store: Path = CC_STORE) -> dict:
    reps, by_folder = [], {}
    for folder in rep_folders(repo):
        r = rep_of(folder, repo)
        reps.append(r)
        by_folder[r["folder"]] = r
    runs = []
    for d in sorted((store / "runs").iterdir()) if (store / "runs").is_dir() else []:
        if not (d / "manifest.json").is_file():
            continue
        m = json.loads((d / "manifest.json").read_bytes())
        rd = (m.get("source") or {}).get("run_dir")
        if not rd:
            continue
        rep = by_folder.get(str(Path(rd).parent.parent))
        if rep is None:
            continue
        folder = repo / rd
        s = STAMP.search(d.name)
        runs.append({"id": d.name, "rep": rep["id"], "status": m["status"],
                     "labels": json.loads((folder / "labels.json").read_bytes()) if (folder / "labels.json").is_file()
                     else {},
                     "started": s.group(1) if s else None,
                     "result": read_result(folder / result_file(rep), rep["moments"] or {})})
    runs.sort(key=lambda r: (r["started"] or "", r["id"]), reverse=True)
    return {"reps": reps, "runs": runs}


def result_file(rep: dict) -> str:
    """The run's result file named by moments.toml `result`, relative to the run folder."""
    return (rep["moments"] or {}).get("result", LATENCY)


def read_result(path: Path, moments: dict) -> dict | None:
    """The run's result, or None (results not computed) when the file is missing, latency.json has no entry for the
    moments' request, or moments.toml `complete` names a value in the result that is false (a failed request)."""
    if not path.is_file():
        return None
    data = json.loads(path.read_bytes())
    result = measured(data, moments.get("request", "measured")) if path.name == LATENCY else data
    return None if "complete" in moments and value_at(result, moments["complete"]) is False else result


def request_names(store: Path, run: str, suffix: str) -> tuple[str | None, set[str]]:
    """(request id, the names of its rows) in a store run, read from the generation's Parquet."""
    import duckdb
    d = store / "runs" / run
    m = json.loads((d / "manifest.json").read_bytes())
    req = next((i for i, r in enumerate(m["requests"]) if r.endswith(suffix)), None)
    if req is None:
        return None, set()
    codes = duckdb.connect().sql(f"select distinct name from read_parquet('{d}/g{m['generation']}/events-*.parquet', "
                                 f"union_by_name=true) where req = {req}").fetchnumpy()["name"]
    return m["requests"][req], {m["names"][int(c)] for c in codes}


def lint(reps: list[str] | None = None, repo: Path = REPO, store: Path = CC_STORE) -> tuple[list[str], list[str]]:
    """(misses, notes). A miss is a moment path or event that does not resolve in a run with a result."""
    cat = catalog(repo, store)
    misses, notes = [], []
    for rep in cat["reps"]:
        if reps and rep["id"] not in reps:
            continue
        if not rep["moments"]:
            notes.append(f"{rep['id']}: no moments.toml")
            continue
        moments, suffix = rep["moments"].get("moments", []), rep["moments"].get("request", "measured")
        runs, file = [r for r in cat["runs"] if r["rep"] == rep["id"]], result_file(rep)
        checked = 0
        for run in runs:
            if run["result"] is None:
                why = f", or {rep['moments']['complete']} is false" if "complete" in rep["moments"] else ""
                notes.append(f"{rep['id']} {run['id']}: results not computed (no {file} result for *{suffix}{why})")
                continue
            checked += 1
            req, names = request_names(store, run["id"], suffix)
            for mo in moments:
                for path in [mo["at"]] + [e["path"] for e in mo.get("evidence", [])]:
                    v = value_at(run["result"], path)
                    if not isinstance(v, (int, float)) or isinstance(v, bool):
                        misses.append(f"{rep['id']} {run['id']} moment {mo['id']}: path {path!r} is {v!r}, "
                                      "not a number")
                if req is None:
                    misses.append(f"{rep['id']} {run['id']} moment {mo['id']}: the store has no request *{suffix}")
                elif not any(n.startswith(mo["event"]) for n in names):
                    misses.append(f"{rep['id']} {run['id']} moment {mo['id']}: event {mo['event']!r} names no row of "
                                  f"request {req}")
        if not checked:
            misses.append(f"{rep['id']}: its moments resolve on no run (none of its {len(runs)} store runs has a "
                          f"{file} result)")
        notes.append(f"{rep['id']}: {len(moments)} moments, {len(runs)} store runs, {checked} with results checked")
    return misses, notes


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--lint", action="store_true", help="resolve every moment in every run of the rep")
    ap.add_argument("reps", nargs="*", help="rep ids (default: every rep with a moments.toml)")
    a = ap.parse_args()
    if not a.lint:
        print(json.dumps(catalog(), indent=1))
        return
    misses, notes = lint(a.reps or None)
    for n in notes:
        print(n)
    for x in misses:
        print("MISS " + x)
    print(f"moments lint: {len(misses)} misses")
    sys.exit(1 if misses else 0)


if __name__ == "__main__":
    main()
