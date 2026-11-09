"""Engine startup phases: the run folder's server_s<N>.log -> `startup phase` rows on the server container.

scripts/compose_stack.py saves the server service's log (`docker compose logs --timestamps`) before compose down, so
this source exists only for the import, never live. The phase markers per engine are data (registry
server_log.json). Times: each line's UTC timestamp minus the run's wall offset (Ctx.wall_offset_ns), the clock the
Docker events use. The last phase, the wait for the healthcheck, ends at the container's first health status after
the engine's own 'end' line (adapters/docker.py DockerEvents.health). The rows stay out of time containment: their
times come from the log's clock, so a Docker event that ties a phase boundary is not work inside that phase.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

from .base import Ctx, Rows, slug

SOURCE = "server_log"
LINE = re.compile(r"^(?P<service>[\w.-]+)\s+\|\s(?P<date>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(?P<frac>\d+))?Z ?(?P<text>.*)$")
EVIDENCE = "Observed: the engine's own log lines (docker compose logs --timestamps, UTC, converted to CLOCK_MONOTONIC)"
HEALTH_EVIDENCE = "Observed: the engine's last startup line to Docker's first health status (Docker Engine events API)"


def utc_ns(date: str, frac: str | None) -> int:
    s = int(datetime.fromisoformat(date).replace(tzinfo=timezone.utc).timestamp())
    return s * 1_000_000_000 + int((frac or "0")[:9].ljust(9, "0"))


class ServerLog:
    source = SOURCE

    def __init__(self, ctx: Ctx, health: dict[str, list[int]]):
        self.ctx, self.health = ctx, health
        self.engines = ctx.reg.sources[SOURCE]["engines"]

    def read(self, path: Path) -> Rows:
        out, ctx = Rows(), self.ctx
        if ctx.wall_offset_ns is None:
            ctx.count(SOURCE, f"{path.name}: no wall offset for UTC times")
            return out
        lines = []
        for n, raw in enumerate(path.read_text(errors="replace").splitlines()):
            m = LINE.match(raw)
            if m:
                lines.append((n, m["service"], utc_ns(m["date"], m["frac"]) - ctx.wall_offset_ns, m["text"]))
        engine = next((e for e in self.engines if any(re.search(e["detect"], t) for *_, t in lines)), None)
        if not lines or engine is None:
            ctx.count(SOURCE, f"{path.name}: no timestamped lines or no known engine")
            return out
        service = lines[0][1]
        lane = ctx.docker_container(f"{ctx.own_project}-{service}", ctx.own_project) if ctx.own_project else None
        if lane is None:
            ctx.count(SOURCE, f"{path.name}: service {service} is no container of this run")
            return out
        marks, k = [], 0
        for p in engine["phases"]:
            rx = re.compile(p["from"]) if p["from"] else None
            hit = next((j for j in range(k, len(lines)) if rx is None or rx.search(lines[j][3])), None)
            if hit is None:
                ctx.count(SOURCE, f"{path.name}: marker of '{p['phase']}' not found; phases stop there")
                break
            marks.append((p["phase"], hit))
            k = hit + 1
        end = None if len(marks) < len(engine["phases"]) else next(
            (j for j in range(k, len(lines)) if re.search(engine["end"], lines[j][3])), None)
        if end is None and len(marks) == len(engine["phases"]):
            ctx.count(SOURCE, f"{path.name}: end marker not found; the last phase is dropped")
        bounds = [j for _, j in marks] + ([end] if end is not None else [])
        for (phase, a), b in zip(marks, bounds[1:]):
            self._phase(out, path, lane, engine["engine"], phase, lines[a], lines[b], EVIDENCE)
        if end is not None:
            t_end = lines[end][2]
            ready = next((t for t in sorted(self.health.get(lane, [])) if t >= t_end), None)
            if ready is None:
                ctx.count(SOURCE, f"{path.name}: no health status after the end marker")
            else:
                self._phase(out, path, lane, engine["engine"], engine["health"], lines[end],
                            (None, service, ready, "Docker: first health status"), HEALTH_EVIDENCE)
        return out

    def _phase(self, out: Rows, path: Path, lane: str, engine: str, phase: str, a: tuple, b: tuple,
               evidence: str) -> None:
        s = (b[2] - a[2]) / 1e9
        out.add(start=a[2], end=b[2], lane=lane, kind="startup phase", name=phase,
                eid=self.ctx.eid("serverlog/{log}/{phase}#{n}", log=path.stem, phase=slug(phase)),
                what=f"{engine} startup: {phase}, {s:.2f} s (from log line {a[0] + 1}).",
                args={"engine": engine, "from": a[3][:200], "to": b[3][:200], "seconds": round(s, 6)},
                term="engine startup phase (server log)", source=SOURCE, evidence=evidence, raw_file=path.name,
                raw_ptr=f"line {a[0] + 1}" + (f" to line {b[0] + 1}" if b[0] is not None else ""), contain=False)
