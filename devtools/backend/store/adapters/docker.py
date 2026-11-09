"""Docker container events: capture/docker.jsonl, one row per event (start, die, health_status: healthy, ...).

The devtools Docker collector reads the Engine's event stream; the backend writes each event to the capture file of
the host run and of every live rep run, and turns it into a row through this parser. The import reads the run's
capture file through the same parser. Times: the daemon's timeNano (UTC) minus the wall offset at receipt, stored in
the capture record as mono_ns.
"""
from __future__ import annotations

from .base import Ctx, Rows

CAPTURE = "docker"
EVIDENCE = "Observed: Docker Engine events API (timeNano, wall clock, converted to CLOCK_MONOTONIC at receipt)"


class DockerEvents:
    source = "docker"

    def __init__(self, ctx: Ctx):
        self.ctx = ctx

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
            action = d["action"]
            out.add(start=d["mono_ns"], end=d["mono_ns"], lane=lane, kind="container event", name=action,
                    eid=ctx.eid("docker/{name}/{action}#{n}", name=name, action=action.split(":")[0]),
                    what=f"Docker reports '{action}' for the container {name}.",
                    args={k: v for k, v in d.items() if k != "line"}, term="container event (Docker Engine API)",
                    source=self.source, evidence=EVIDENCE, raw_file=f"capture/{CAPTURE}.jsonl",
                    raw_ptr=f"line {d['line'] + 1}" if "line" in d else None)
        return out

    def flush(self) -> Rows:
        return Rows()
