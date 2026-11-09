"""Nsight Compute headline counters (import only; owner ruling 2026-11-08: ncu is link-only plus the L6 headline
counters, no ncu CLI in the image).

Which report: a kernels-level run (labels.json trace "kernels", a profile_range) replays kernels of one iteration of
the same request a timeline-level run traced. Its counters belong to the timeline run of the same rep that is the
latest one started before it, when both runs sent the same prompt (prompt.json equal); registry ncu.json tie.run.
Values: trace/kernels.csv (ncu --page raw, row 2 holds each column's display unit) for the counters it has; the
counters it lacks from trace/sections.csv (ncu --page details) by section and metric label (registry ncu.json
sections). The details page rounds to two decimals.
Tie: the k-th profiled kernel (ncu ID order = launch order) <-> the k-th kernel of that iteration on the timeline run
by start, accepted only when the short names match (registry ncu.json tie.rule).
"""
from __future__ import annotations

import csv
import json
from pathlib import Path

from .base import Ctx


def labels(run_dir: Path) -> dict:
    try:
        return json.loads((run_dir / "labels.json").read_bytes())
    except (OSError, ValueError):
        return {}


def _stamp(p: Path) -> str:
    return p.name.rsplit("_", 2)[-2] if p.name.count("_") >= 2 else ""


def _timelines_before(runs: list[Path], k: Path) -> list[Path]:
    return [t for t in runs if labels(t).get("trace") == "timeline" and _stamp(t) < _stamp(k)]


def profile_run_for(run_dir: Path) -> Path | None:
    """The kernels-level run whose counters belong to this timeline-level run, or None."""
    if labels(run_dir).get("trace") != "timeline":
        return None
    runs = sorted((p for p in run_dir.parent.iterdir() if (p / "labels.json").is_file()), key=_stamp)
    mine = _stamp(run_dir)
    for k in runs:
        lab = labels(k)
        if lab.get("trace") != "kernels" or not lab.get("profile_range") or _stamp(k) <= mine:
            continue
        before = _timelines_before(runs, k)
        if before and before[-1].name == run_dir.name and _same_prompt(run_dir, k):
            return k
    return None


def timeline_run_for(run_dir: Path) -> Path | None:
    """The timeline-level run whose profile_run_for is this kernels-level run, or None."""
    if labels(run_dir).get("trace") != "kernels":
        return None
    runs = sorted((p for p in run_dir.parent.iterdir() if (p / "labels.json").is_file()), key=_stamp)
    before = _timelines_before(runs, run_dir)
    tied = before and profile_run_for(before[-1])
    return before[-1] if tied and tied.name == run_dir.name else None


def _same_prompt(a: Path, b: Path) -> bool:
    try:
        return (a / "prompt.json").read_bytes() == (b / "prompt.json").read_bytes()
    except OSError:
        return False


def _num(text: str) -> float | None:
    try:
        return float(text.replace(",", ""))
    except ValueError:
        return None


class NcuHeadline:
    source = "ncu"

    def __init__(self, ctx: Ctx):
        self.ctx, self.reg = ctx, ctx.reg
        self.rules = ctx.reg.sources["ncu"]

    def read(self, kernels_run: Path) -> tuple[list[dict], int]:
        """Per profiled kernel: {row, kernel_name, values {counter: (value in the registry unit, unit rule)}}.
        Returns (kernels, profile iteration)."""
        it = int(str(labels(kernels_run)["profile_range"]).split("-")[0])
        with (kernels_run / "trace" / "kernels.csv").open(newline="") as f:
            rd = list(csv.reader(f))
        head, units, body = rd[0], rd[1], rd[2:]
        name_col = head.index("Kernel Name")
        sections = self.rules.get("sections", {})
        detail = {}
        missing = [x for x in self.reg.ncu_headline if x not in head]
        if missing:
            need = {tuple(sections[x]): x for x in missing if x in sections}
            if len(need) != len(missing):
                raise KeyError(f"{kernels_run.name}: headline counters {missing} are not in kernels.csv and registry "
                               "ncu.json sections names no details row for them")
            with (kernels_run / "trace" / "sections.csv").open(newline="") as f:
                for r in csv.DictReader(f):
                    x = need.get((r["Section Name"], r["Metric Name"]))
                    if x is not None:
                        detail[(int(r["ID"]), x)] = (_num(r["Metric Value"]), r["Metric Unit"])
        out = []
        for k, row in enumerate(body):
            kid = int(row[head.index("ID")])
            values = {}
            for x in self.reg.ncu_headline:
                if x in head:
                    v, shown = _num(row[head.index(x)]), units[head.index(x)]
                    how = None
                else:
                    v, shown = detail.get((kid, x), (None, None))
                    how = "Observed: trace/sections.csv (ncu --page details, rounded to two decimals)"
                if v is None:
                    continue
                unit, table = self.reg.ncu_units[x]
                if shown not in table:
                    raise KeyError(f"{kernels_run.name}: {x} is in {shown!r}; registry ncu.json scale has no factor "
                                   f"from {shown!r} to {unit!r}")
                factor = float(table[shown])
                parts = [f"Calculated: report value in {shown} times {factor:g} = {unit}"] if shown != unit else []
                values[x] = (v * factor, unit, "; ".join(parts + ([how] if how else [])) or None)
            out.append({"row": k, "kernel_name": row[name_col], "values": values})
        return out, it

    def tie(self, kernels: list[dict], timeline: list[tuple[int, str]]) -> tuple[list[int | None], dict]:
        """timeline: (row id, short name) of the iteration's kernels in start order -> row id per profiled kernel."""
        ids, tied = [], 0
        for k, kr in enumerate(kernels):
            ev = timeline[k] if k < len(timeline) else None
            kname = kr["kernel_name"]
            ok = ev is not None and (ev[1] in kname or kname.startswith(ev[1]) or ev[1].split("<")[0] in kname)
            ids.append(ev[0] if ok else None)
            tied += ok
        return ids, {"ncu_kernels": len(kernels), "timeline_kernels_in_iteration": len(timeline), "tied": tied,
                     "not_tied": len(kernels) - tied, "rule": self.rules["tie"]["rule"],
                     "evidence": self.rules["tie"]["evidence"]}
