"""The rep's own Prometheus scrapes (I02C: one before and one after the measured requests), as run.json spans
prometheus/<scrape>/line <n>: one span per series line the rep's metrics read. Import only (run.json exists after
the rep). They become the sample group samples-prometheus: one sample per scrape, stamped at the scrape's end
(CLOCK_MONOTONIC at receipt, as the engine collector's scrape), one column per Prometheus base name summed over its
label sets (the run.json metrics' own formula). Every span maps to the sample of its scrape, so run.json metric
inputs resolve to sample indexes.
"""
from __future__ import annotations

import numpy as np

from .base import Ctx

PREFIX = "prometheus/"
TRACK = "prometheus"
PROCESS = "server"      # the engine's container (registry lanes: process prefix "server")


def series(ctx: Ctx, spans: list[dict]) -> list[dict]:
    """run.json spans -> sample series (importer.sample_groups input); [] when the run has no Prometheus spans."""
    rule = next(r for r in ctx.reg.sources["run_json"]["samples"] if r["match"]["track"] == TRACK)
    mine = [s for s in spans if s["id"].startswith(PREFIX)]
    if not mine:
        return []
    thing = ctx.container(PROCESS)
    scrape_end: dict[str, int] = {}
    for s in mine:
        scrape_end[s["attrs"]["scrape"]] = max(scrape_end.get(s["attrs"]["scrape"], 0), int(s["end_ns"]))
    sums: dict[str, dict[str, float]] = {}
    spans_of: dict[str, dict[str, list[str]]] = {}
    for s in mine:
        base, scrape = s["attrs"]["series"].split("{")[0], s["attrs"]["scrape"]
        sums.setdefault(base, {})[scrape] = sums.get(base, {}).get(scrape, 0.0) + float(s["attrs"]["value"])
        spans_of.setdefault(base, {}).setdefault(scrape, []).append(s["id"])
    out = []
    for base in sorted(sums):
        scrapes = sorted(sums[base], key=lambda k: scrape_end[k])
        out.append({"track": rule["match"]["track"], "metric": base, "thing": thing, "unit": rule["units"].get(base),
                    "evidence": rule["evidence"], "ts": np.array([scrape_end[k] for k in scrapes], np.int64),
                    "values": np.array([sums[base][k] for k in scrapes], np.float64),
                    "spans": {sid: k for k, sc in enumerate(scrapes) for sid in spans_of[base][sc]}})
    return out
