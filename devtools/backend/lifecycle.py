"""Lifecycle: an engine's startup phases, found in its log.

Each marker is a log line that starts a phase. Markers are matched in order: once one is seen, only later markers can
match, so a line that also appears earlier (a dry run, a repeat) cannot move the timeline backwards.
"""
import re

# TensorRT-LLM 1.2.1 (trtllm-serve, PyTorch backend). Another engine adds its own table.
TRTLLM_MARKERS = [
    ("API process: Python imports", None),  # starts at container start, not at a log line
    ("API process: server setup", r"\[TensorRT-LLM\] TensorRT LLM version: (\S+)"),
    ("worker: spawn and Python imports", r"using MpiPoolSession to spawn MPI processes"),
    ("worker: model setup", r"Refreshed the MPI local session"),
    ("weights: load", r"Use ([\d.]+) GB for model weights"),
    ("executor: setup", r"Model init total -- ([\d.]+)s"),
    ("autotuner", r"\[Autotuner\] Autotuning process starts"),
    ("CUDA graph capture", r"\[Autotuner\] Autotuning process ends"),
    ("memory profiling (dummy requests)", r"Memory used after loading model weights \(inside torch\).*: ([\d.]+) GiB"),
    ("KV pool allocation, executor rebuild", r"Estimated max memory in KV cache : ([\d.]+) GiB"),
    ("API server start", r"Setting PyTorch memory fraction"),
    ("HTTP ready, waiting for the healthcheck", r"Application startup complete"),
]


class Lifecycle:
    def __init__(self, started_ns: int, markers=TRTLLM_MARKERS):
        self.markers = [(name, re.compile(pattern) if pattern else None) for name, pattern in markers]
        self.marks = [{"phase": markers[0][0], "ns": started_ns, "values": [], "line": "container started"}]
        self.next = 1  # index of the first marker not yet seen

    def add(self, phase: str, ns: int, line: str) -> None:
        """A mark from outside the log, e.g. Docker's healthcheck turning healthy."""
        self.marks.append({"phase": phase, "ns": ns, "values": [], "line": line})
        self.next = len(self.markers)  # nothing in the log can come after it

    def lines(self, index: int) -> tuple[int, int | None]:
        """Phase `index` as [start, end) in ns; the last phase is open-ended."""
        end = self.marks[index + 1]["ns"] if index + 1 < len(self.marks) else None
        return self.marks[index]["ns"], end

    def feed(self, ns: int, line: str) -> bool:
        """Check one log line; True when it starts a phase."""
        for index in range(self.next, len(self.markers)):
            name, pattern = self.markers[index]
            match = pattern.search(line)
            if match:
                self.marks.append({"phase": name, "ns": ns, "values": list(match.groups()), "line": line})
                self.next = index + 1
                return True
        return False
