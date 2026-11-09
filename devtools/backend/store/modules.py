"""Module inference (COMMAND_CENTER.md 7.4, M2). A run whose device trace has no module frames (CUDA graphs on: one
graph launch per forward step) gets module rows from the module forward() frames of a reference run of its rep, the
code run (registry modules.json). Pure: the importer reads the reference from the store and writes the rows."""
import re
from dataclasses import dataclass
from typing import Hashable, Iterable, Mapping, Sequence

RULE = ("the device rows of each forward step, in start order, as match keys (a kernel's short name, a copy's "
        "direction, memset), are aligned with each distinct forward step of the code run by a longest common "
        "subsequence (earliest match on ties); the step with the most pairs is the reference. A module forward() "
        "frame of the reference becomes a row when every device row it launched pairs and the paired rows are "
        "consecutive on one stream. The row spans those device rows; each device row takes the innermost such module "
        "as its parent")
EVIDENCE = f"Inferred: {RULE}"
PARENT_RULE = "Inferred: the module of the code run that launched the paired device row (modules.RULE)"
COPY_DIRECTION = {"host to device": "HtoD", "device to host": "DtoH", "device to device": "DtoD", "peer to peer": "PtoP"}
TORCH_COPY = re.compile(r"^Memcpy (HtoD|DtoH|DtoD|PtoP)\b")


def match_key(kind: str, name: str) -> str:
    """What two device rows must share to pair. Kernels: the short name (full names differ between the PyTorch
    profiler's and Nsight Systems' demanglers). Copies: the direction, named differently by the two tools."""
    if kind == "memcpy":
        m = TORCH_COPY.match(name)
        return "memcpy " + (m[1] if m else COPY_DIRECTION.get(name, name))
    return "memset" if kind == "memset" else name


@dataclass(frozen=True)
class Frame:
    """A module forward() frame of a reference step. rows: the positions in Reference.keys of the device rows it
    launched, itself or through inner modules. parent: the index of the enclosing frame, -1 at the top."""
    name: str
    eid: str
    parent: int
    rows: tuple[int, ...]


@dataclass(frozen=True)
class Reference:
    """One distinct forward step of the reference run. frames: every frame that launched a device row, each after
    the frame that encloses it."""
    iteration: int
    keys: tuple[str, ...]
    frames: tuple[Frame, ...]


@dataclass(frozen=True)
class Match:
    """A forward step aligned with its reference. pairs: the length of the common subsequence. frames: each inferred
    frame (an index into reference.frames) with the step positions of its device rows."""
    reference: Reference
    pairs: int
    frames: tuple[tuple[int, tuple[int, ...]], ...]


def references(steps: Iterable[tuple[int, Sequence[tuple[str, Sequence[Hashable]]]]],
               frame_of: Mapping[Hashable, tuple[str, str]]) -> list[Reference]:
    """The distinct forward steps of the reference run; a step whose keys repeat an earlier step's is dropped.
    steps: (iteration, rows) in iteration order; rows: (match key, frames) per device row in start order, the frames
    that enclose its launch, outermost first. frame_of: frame -> (name, eid)."""
    out, seen = [], set()
    for it, rows in steps:
        keys = tuple(k for k, _ in rows)
        if keys in seen:
            continue
        seen.add(keys)
        index, parent, held = {}, [], []
        for pos, (_, chain) in enumerate(rows):
            up = -1
            for f in chain:
                if f not in index:
                    index[f] = len(parent)
                    parent.append(up)
                    held.append([])
                held[index[f]].append(pos)
                up = index[f]
        out.append(Reference(it, keys, tuple(Frame(*frame_of[f], parent[k], tuple(held[k]))
                                             for f, k in index.items())))
    return out


def lcs_pairs(a: Sequence[str], b: Sequence[str]) -> list[tuple[int, int]]:
    """(i, j) pairs of one longest common subsequence of a and b; each a[i] pairs with the earliest b[j] that keeps
    the subsequence longest."""
    n, m = len(a), len(b)
    L = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        Li, Li1, ai = L[i], L[i + 1], a[i]
        for j in range(m - 1, -1, -1):
            Li[j] = Li1[j + 1] + 1 if ai == b[j] else max(Li1[j], Li[j + 1])
    out, i, j = [], 0, 0
    while i < n and j < m:
        if a[i] == b[j] and L[i][j] == L[i + 1][j + 1] + 1:
            out.append((i, j))
            i, j = i + 1, j + 1
        elif L[i + 1][j] >= L[i][j + 1]:
            i += 1
        else:
            j += 1
    return out


def infer(refs: Sequence[Reference], keys: Sequence[str], lanes: Sequence[Hashable]) -> Match:
    """RULE for one forward step: keys and lanes of its device rows in start order. refs must not be empty."""
    ref, pairs = None, []
    for r in refs:
        p = lcs_pairs(r.keys, keys)
        if ref is None or len(p) > len(pairs):
            ref, pairs = r, p
    to_step = dict(pairs)
    rank, seen = [], {}
    for ln in lanes:
        rank.append(seen.get(ln, 0))
        seen[ln] = rank[-1] + 1
    got = []
    for f, frame in enumerate(ref.frames):
        if all(p in to_step for p in frame.rows):
            pos = tuple(to_step[p] for p in frame.rows)
            if len({lanes[p] for p in pos}) == 1 and rank[pos[-1]] - rank[pos[0]] == len(pos) - 1:
                got.append((f, pos))
    return Match(ref, len(pairs), tuple(got))
