"""Helpers shared by the adapters. Standard library only: the devtools container builds runs with these too."""
from pathlib import Path

from ..schema import Run


def run_dir(path: Path) -> Path:
    """The run folder a file belongs to (adapters get files at most two levels down)."""
    for parent in (path.parent, *path.parents):
        if (parent / "config.yaml").exists():
            return parent
    return path.parent


def clock_offset(run: Run, request_id: str | None = None) -> int | None:
    """UTC ns - monotonic ns, from a client record's anchor pair (the client adapter stores them)."""
    joins = run.topology.get("clock_joins", {})
    if request_id in joins:
        return joins[request_id]
    return next(iter(joins.values()), None)


def find(run: Run, request_id: str, component: str, name: str):
    return next((s for s in run.spans if s.request_id == request_id and s.component == component
                 and s.name == name), None)


def engine_window(run: Run) -> list[tuple[str, int, int, int, int]]:
    """(request_id, first_iter, last_iter, first_scheduled_ns, last_token_ns) per engine record in the run."""
    out = []
    for s in run.spans:
        if s.component == "executor" and s.name == "request in executor":
            out.append((s.request_id, s.attrs["first_iter"], s.attrs["last_iter"], s.start_ns, s.end_ns))
    return out
