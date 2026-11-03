"""The ie-run/1 schema: one run, every layer, one clock (CLOCK_MONOTONIC nanoseconds).

A span is something that happened in one component: an instant (end_ns None) or an interval.
A metric is a number calculated from spans; its inputs are the IDs of the spans it was calculated from.
"""

from dataclasses import asdict, dataclass, field

SCHEMA = "ie-run/1"
CLOCK = "CLOCK_MONOTONIC ns"
LEVELS = ("network", "client", "server", "hardware")  # level 0, the architecture, is the topology itself

@dataclass(frozen=True)
class Span:
    id: str
    level: str
    component: str
    name: str
    start_ns: int
    end_ns: int | None = None
    request_id: str | None = None
    attrs: dict = field(default_factory=dict)
    raw: dict | None = None # {"file": <path in the run folder>, "pointer": <where in it>}

@dataclass(frozen=True)
class Metric:
    name: str
    formula: str
    inputs: tuple[str, ...]
    value: float | None
    unit: str
    request_id: str | None = None

@dataclass
class Run:
    run_id: str
    topology: dict = field(default_factory=dict)
    spans: list[Span] = field(default_factory=list)
    metrics: list[Metric] = field(default_factory=list)
    unavailable: list[dict] = field(default_factory=list)
    sources: list[dict] = field(default_factory=list)
    profiles: dict = field(default_factory=dict)  # tables with no time on the run's clock (Nsight Compute, source)
    labels: dict = field(default_factory=dict)  # what kind of run: trace level, measured or not

    def requests(self) -> list[str]:
        """Request IDs in the order their first span happened."""
        first = {}
        for span in sorted(self.spans, key=lambda s: s.start_ns):
            if span.request_id is not None:
                first.setdefault(span.request_id, span.start_ns)
        return list(first)

    def to_json(self) -> dict:
        return {
            "schema": SCHEMA,
            "clock": CLOCK,
            "run_id": self.run_id,
            "topology": self.topology,
            "requests": self.requests(),
            "spans": [asdict(s) for s in sorted(self.spans, key=lambda s: (s.start_ns, s.id))],
            "metrics": [asdict(m) for m in self.metrics],
            "unavailable": self.unavailable,
            "sources": self.sources,
            "profiles": self.profiles,
            "labels": self.labels,
        }

def validate(run: Run) -> list[str]:
    """Every problem that would make the run unsafe to replay; empty when it is sound."""
    problems = []
    ids = [s.id for s in run.spans]
    duplicates = sorted({i for i in ids if ids.count(i) > 1})
    if duplicates:
        problems.append(f"duplicate span ids: {duplicates}")
    for s in run.spans:
        if s.level not in LEVELS:
            problems.append(f"{s.id}: level {s.level!r} is not one of {LEVELS}")
        if s.end_ns is not None and s.end_ns < s.start_ns:
            problems.append(f"{s.id}: ends {(s.start_ns - s.end_ns) / 1e6} ms before it starts (wrong clock or join?)")
        if s.raw is not None and "file" not in s.raw:
            problems.append(f"{s.id}: raw has no file")
    known = set(ids)
    for m in run.metrics:
        missing = [i for i in m.inputs if i not in known]
        if missing:
            problems.append(f"metric {m.name}: inputs {missing} are not spans in this run")
    return problems
