"""Docker container events: capture/docker.jsonl, one row per event (start, die, health_status: healthy, ...).

The devtools Docker collector reads the Engine's event stream; the backend writes each event to the capture file of
the host run and of every live rep run, and turns it into a row through this parser. The import reads the run's
capture file through the same parser. Times: the daemon's timeNano (UTC) minus the wall offset at receipt, stored in
the capture record as mono_ns.

Startup: a container's `start` and its first `health_status` after it make one `container startup` row, the cold
start of that container (runtime start, engine imports, compiles, weight load, warmup, until the healthcheck passes).
The row is emitted when the health status arrives, so the live writer and the import emit it at the same point of
the event stream. A container with no healthcheck never reports a health status and gets no startup row; a start
that ends (die) before any health status is counted, not drawn.
"""
from __future__ import annotations

from .base import Ctx, Rows

CAPTURE = "docker"
EVIDENCE = "Observed: Docker Engine events API (timeNano, wall clock, converted to CLOCK_MONOTONIC at receipt)"
STARTUP_EVIDENCE = "Derived: the container's Docker 'start' event to its first 'health_status' event"


class DockerEvents:
    source = "docker"

    def __init__(self, ctx: Ctx):
        self.ctx = ctx
        self.starting: dict[str, tuple[int, int | None]] = {}   # container thing -> (start mono_ns, capture line)
        self.health: dict[str, list[int]] = {}                  # container thing -> health status times (mono_ns)

    def feed(self, events: list[dict]) -> Rows:
        out, ctx = Rows(), self.ctx
        for d in events:
            name = d.get("container")
            if not name or not d.get("action"):
                ctx.count(self.source, "events with no container or action")
                continue
            lane = ctx.docker_container(name, d.get("project"))
            if lane is None:
                continue
            action, verb = d["action"], d["action"].split(":")[0]
            out.add(start=d["mono_ns"], end=d["mono_ns"], lane=lane, kind="container event", name=action,
                    eid=ctx.eid("docker/{name}/{action}#{n}", name=name, action=verb),
                    what=f"Docker reports '{action}' for the container {name}.",
                    args={k: v for k, v in d.items() if k != "line"}, term="container event (Docker Engine API)",
                    source=self.source, evidence=EVIDENCE, raw_file=f"capture/{CAPTURE}.jsonl",
                    raw_ptr=f"line {d['line'] + 1}" if "line" in d else None)
            if verb == "start":
                self.starting[lane] = (d["mono_ns"], d.get("line"))
            elif verb == "health_status":
                self.health.setdefault(lane, []).append(d["mono_ns"])
                if lane in self.starting:
                    self._startup(out, lane, name, d, *self.starting.pop(lane))
            elif verb == "die" and self.starting.pop(lane, None) is not None:
                ctx.count(self.source, "starts that died with no health status (no healthcheck, or died starting)")
        return out

    def _startup(self, out: Rows, lane: str, name: str, d: dict, t0: int, line0: int | None) -> None:
        status, s = d["action"].split(":", 1)[-1].strip(), (d["mono_ns"] - t0) / 1e9
        lines = [x + 1 for x in (line0, d.get("line")) if x is not None]
        out.add(start=t0, end=d["mono_ns"], lane=lane, kind="container startup", name="startup",
                eid=self.ctx.eid("docker/{name}/startup#{n}", name=name),
                what=f"The container {name} starts up: Docker 'start' to the first health status ({status}), "
                     f"{s:.2f} s.",
                args={"container": name, "status": status, "seconds": round(s, 6)},
                term="container startup (Docker start to first health status)", source=self.source,
                evidence=STARTUP_EVIDENCE, raw_file=f"capture/{CAPTURE}.jsonl",
                raw_ptr=f"lines {lines[0]} and {lines[-1]}" if len(lines) == 2 else None)

    def flush(self) -> Rows:
        if self.starting:
            self.ctx.count(self.source, "starts with no health status by the end (no startup row)", len(self.starting))
        return Rows()
