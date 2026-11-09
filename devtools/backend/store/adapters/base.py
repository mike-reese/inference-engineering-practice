"""Shared pieces of the store adapters: the row accumulator (Rows), the parse context (Ctx: things, eid ordinals,
the run's wall clock offset), and the file tails both paths read through.

One adapter per source. An adapter is a class built with a Ctx. feed(records) turns new records into rows, and
flush() returns what it held back until the source ends (a connection whose request is not known yet). The live
writer calls feed() with what a tail read since the last poll; the importer reads the whole file through the same
tail, calls feed() once and then flush(). So a row's eid, ordinal included, is the same live and final: the ordinal
counts the rows of one eid prefix in the order the adapter emits them (source order).
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import NamedTuple

SLUG = re.compile(r"[^A-Za-z0-9_.:+-]+")
FIELDS = ("start", "end", "lane", "kind", "name", "req", "iter", "bytes", "box", "eid", "what", "args", "term",
          "source", "evidence", "raw_file", "raw_ptr", "span_id", "corr", "quirk", "parent", "parent_rule",
          "code_origin", "code_where", "demangled", "contain")
DEFAULTS = {"req": None, "iter": -1, "bytes": math.nan, "box": "", "args": None, "raw_file": None, "raw_ptr": None,
            "span_id": None, "corr": None, "quirk": None, "parent": -1, "parent_rule": None, "code_origin": None,
            "code_where": None, "demangled": None, "contain": True}


def slug(s, n: int = 72) -> str:
    """The eid short name (the ie-run/2 importer's rule): runs of other characters become '-', cut to n."""
    return SLUG.sub("-", str(s)).strip("-")[:n] or "-"


def request_short(rid: str | None) -> str:
    """The request's phase (warmup, measured): the part of the request id after the last '-'."""
    return rid.rsplit("-", 1)[-1] if rid else "-"


def args_text(a) -> str | None:
    return None if a is None else a if isinstance(a, str) else json.dumps(a, separators=(",", ":"), default=str)


class Rows:
    """Rows of one adapter, column by column (a million rows hold one list per field, not a dict per row).
    start/end are absolute CLOCK_MONOTONIC ns; lane is a thing key; parent is an index into the same Rows (-1 none);
    contain=False keeps a row out of time containment (GPU stream rows, rows whose parent is Observed)."""

    def __init__(self):
        self.cols = {f: [] for f in FIELDS}

    def __len__(self) -> int:
        return len(self.cols["start"])

    def add(self, **kw) -> int:
        i = len(self)
        kw["args"] = args_text(kw.get("args"))
        for f, col in self.cols.items():
            col.append(kw[f] if f in kw else DEFAULTS[f])
        return i

    def extend(self, other: "Rows") -> "Rows":
        base = len(self)
        for f, col in self.cols.items():
            col += [p + base if p >= 0 else -1 for p in other.cols[f]] if f == "parent" else other.cols[f]
        return self

    def row(self, i: int) -> dict:
        return {f: col[i] for f, col in self.cols.items()}


class Column(NamedTuple):
    """One column of a sample clock (a samples block): a registry metric (kinds.json metrics) on a thing. metric is
    the column name, unique in its clock; label replaces the registry metric's label (one column per CPU)."""
    metric: str
    rule: str
    thing: str
    label: str | None = None


class Ctx:
    """What the adapters of one run share: things (lanes and their containers), eid ordinals, the wall clock offset.
    wall_offset_ns = UTC ns - CLOCK_MONOTONIC ns on this machine; pcap, nsys and PyTorch times are UTC."""

    def __init__(self, run: str, run_dir: Path | None, registry, wall_offset_ns: int | None, stamped: bool = False):
        self.run, self.dir, self.reg, self.wall_offset_ns, self.stamped = run, run_dir, registry, wall_offset_ns, stamped
        self.things: dict[str, tuple] = {}
        self.ordinal: dict[str, int] = {}
        self.lane_rules = [x for src in registry.sources.values() for x in src.get("lanes", [])]
        self.stats: dict[str, dict] = {}

    def thing(self, key: str, parent: str | None, kind: str, name: str, attrs: dict | None = None,
              evidence: str = "") -> str:
        if key not in self.things:
            self.things[key] = (parent, kind, name, attrs or {}, evidence)
        return key

    def lane(self, process: str, thread: str | None, pid=None, tid=None, kthread=None) -> str:
        """The thread a row sits on, with its process and container (registry `lanes`: process prefix ->
        container), as the ie-run/2 importer named them: container host/<c>, process host/<c>/<process>, lane
        <process>/<thread>."""
        thread = thread or "(process-wide)"
        lane = f"{process}/{thread}"
        if lane in self.things:
            return lane
        attrs = {"tid": tid, "kernel_thread_name": kthread}
        return self.thing(lane, self.process(process, pid), "thread", thread, attrs,
                          "Observed" if tid is not None or thread else "Observed (no thread id recorded)")

    def process(self, process: str, pid=None) -> str:
        """The process thing under its container, e.g. host/server/server pid 87."""
        cont = self.container(process)
        return self.thing(f"{cont}/{process}", cont, "process", process, {"pid": pid},
                          "Observed" if pid is not None else "Observed (no pid recorded)")

    def container(self, process: str) -> str:
        """The container thing of a process (registry `lanes`: process prefix -> container), e.g. host/server."""
        rule = next((x for x in self.lane_rules if process.startswith(x["process_prefix"])), None)
        if rule is None:
            raise KeyError(f"no lane rule (registry 'lanes') for process {process!r}")
        return self.thing(f"host/{rule['container']}", "host", "container" if rule["container"] != "network"
                          else "network", rule["container_name"], {}, "Observed: topology.json (docker inspect)")

    def stream_lane(self, device: int, stream: int, name: str | None = None, attrs: dict | None = None) -> str:
        return self.thing(f"gpu{device}/stream {stream}", f"gpu{device}", "stream", name or f"stream {stream}",
                          attrs or {}, "Observed: CUPTI stream id")

    def eid(self, template: str, **f) -> str:
        """An eid from a registry template; {n} (or a '#n' suffix when the template has none and the prefix repeats)
        is the ordinal of the prefix in the order rows are emitted."""
        prefix = template.replace("#{n}", "").format(**f)
        n = self.ordinal[prefix] = self.ordinal.get(prefix, -1) + 1
        return template.format(**f, n=n) if "{n}" in template else (prefix if n == 0 else f"{prefix}#{n}")

    def count(self, source: str, what: str, k: int = 1) -> None:
        s = self.stats.setdefault(source, {})
        s[what] = s.get(what, 0) + k


class LineTail:
    """A JSON-lines file read from where the last read stopped; each record carries its 0-based line number. A line
    still being written stays for the next read; at the end (final=True) a line cut by a stop is counted, not read."""

    def __init__(self, path: Path):
        self.path, self.offset, self.rest, self.line, self.bad = path, 0, b"", 0, 0

    def read(self, final: bool = False) -> list[dict]:
        try:
            with self.path.open("rb") as f:
                f.seek(self.offset)
                data = f.read()
        except OSError:
            return []
        self.offset += len(data)
        lines = (self.rest + data).split(b"\n")
        self.rest = b"" if final else lines.pop()
        out = []
        for raw in lines:
            n, self.line = self.line, self.line + 1        # numbered as str.splitlines() does: blank lines count
            if not raw.strip():
                continue
            try:
                out.append({**json.loads(raw), "line": n})
            except ValueError:
                self.bad += 1                  # a line cut by the writer's stop
        return out
