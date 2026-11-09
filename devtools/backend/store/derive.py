"""Pure derivation rules for ie-run/3 rows: numpy arrays in, numpy arrays out. No I/O, no clock, no registry loading.

Arrays are indexed by row id unless a name says otherwise; rows are in (start, id) order.
"""
from __future__ import annotations

import heapq
import re
import sys
from pathlib import Path

import numpy as np

from .schema import NONE16

SRC = Path(__file__).resolve().parents[3] / "src"

ITERATION_RULE = ("Calculated: from the scheduler stamp of iteration N to where its last own row ends (choice 5): "
                  "its component stamps with a loop counter of their own, the device work it launched, and the NVTX "
                  "ranges the profiler tied to it (the forward step). The idle gap before the next request belongs to "
                  "no iteration. kv_cache stamps carry no loop counter (the newest one seen is filled in) and place no "
                  "end")
WINDOW_RULE = ("Calculated: a row on the executor loop thread (the lane of the forward-step NVTX ranges) belongs to "
               "the derived iteration whose window holds its start")


class RowError(ValueError):
    """A row breaks an ie-run/3 invariant. The import stops; `row` (and `other`) are row ids to name in the message."""

    def __init__(self, what: str, row: int, other: int = -1):
        super().__init__(what)
        self.what, self.row, self.other = what, row, other


def remap(keys: np.ndarray, values: np.ndarray, x: np.ndarray) -> np.ndarray:
    """Source ids -> row ids through a sparse map (keys sorted, values aligned; source ids can be far apart).
    -1, and an id that is not a key, map to -1."""
    k = np.minimum(np.searchsorted(keys, x), len(keys) - 1)
    return np.where((x >= 0) & (keys[k] == x), values[k], -1)


CONTAIN_RULE = "Calculated: time containment on one thread"


def contain(lane: np.ndarray, start: np.ndarray, end: np.ndarray, mask: np.ndarray,
            parent: np.ndarray) -> tuple[np.ndarray, int]:
    """Parent = the innermost row on the same lane whose interval holds this row (ties: the longer one is outer, then
    input order). Only rows in `mask` take part; a row that already has a parent keeps it; an instant or a zero-length
    row never holds another. Returns (parent, rows that cross a sibling instead of nesting). The ie-run/2 rule
    (D2 ingest.py contain)."""
    parent = parent.astype(np.int64).copy()
    rows = np.flatnonzero(mask)
    order = rows[np.lexsort((-end[rows], start[rows], lane[rows]))].tolist()
    ln, st, en = lane.tolist(), start.tolist(), end.tolist()
    par = parent.tolist()
    crossing, stack, cur = 0, [], None
    for i in order:
        if ln[i] != cur:
            stack, cur = [], ln[i]
        s, e = st[i], en[i]
        while stack and en[stack[-1]] < s:
            stack.pop()
        while stack and en[stack[-1]] < e:
            crossing += 1
            stack.pop()
        if stack and par[i] < 0:
            par[i] = stack[-1]
        if e > s:
            stack.append(i)
    return np.array(par, np.int64), crossing


MESSAGE_RULE = "Calculated: same request id and message, k-th send -> k-th receive"


def message_links(req: list, comp: list, name: list) -> list[tuple[int, int, str]]:
    """Cross-process hops (the ie-run/2 rule, D1 canonical.py stamp_links): ZMQ send -> receive (stamps of lane
    group ipc), and response headers server (http) -> wire (eth0) -> client (sdk). Rows are in (start, id) order;
    comp is the run.json component of a row (a stamp's lane group, the client or engine lane, eth0), None for rows
    of other sources. Returns (from, to, link kind)."""
    by: dict[tuple, list[int]] = {}
    for i, (r, c, nm) in enumerate(zip(req, comp, name)):
        if r is not None and c is not None:
            by.setdefault((r, c, nm), []).append(i)
    out = []
    for (r, c, nm), sends in by.items():
        if c == "ipc" and nm.startswith("ZMQ send"):
            pairs = [(sends, by.get((r, "ipc", nm.replace("send", "receive")), []), "zmq")]
        elif c == "http" and nm == "response headers":
            wire = by.get((r, "eth0", "response headers"), [])
            pairs = [(sends, wire, "network"), (wire, by.get((r, "sdk", "response headers"), []), "network")]
        else:
            continue
        for a, b, kind in pairs:
            out += [(x, y, kind) for x, y in zip(a, b)]
    return out


def tiers(kind: np.ndarray, parent: np.ndarray, base_tier: np.ndarray, nest_bump: np.ndarray) -> np.ndarray:
    """The kind's tier; one tier finer, once, when the parent has the same kind and the kind has nest_bump.
    Raises RowError on the first row coarser than its parent."""
    tier = base_tier[kind].astype(np.uint8)
    has = parent >= 0
    p = np.where(has, parent, 0)
    tier[has & nest_bump[kind] & (kind[p] == kind)] += 1
    bad = np.flatnonzero(has & (tier < tier[p]))
    if len(bad):
        i = int(bad[0])
        raise RowError(f"{len(bad)} rows are coarser than their parent (tier {tier[i]} under tier {tier[p[i]]})",
                       i, int(p[i]))
    return tier


def depths(lane: np.ndarray, start: np.ndarray, end: np.ndarray, parent: np.ndarray) -> np.ndarray:
    """Sub-row inside the lane. A child sits one below its parent on the same lane; rows that overlap without nesting
    take the lowest free sub-row (greedy interval packing). Raises RowError past sub-row 65,535."""
    order = np.lexsort((np.arange(len(lane)), -end, start, lane))
    depth = np.zeros(len(lane), np.int64)
    done = np.zeros(len(lane), bool)
    open_rows: dict[int, list] = {}
    used: dict[int, set] = {}
    for i in order.tolist():
        ln = int(lane[i])
        heap, busy = open_rows.setdefault(ln, []), used.setdefault(ln, set())
        s = start[i]
        while heap and heap[0][0] <= s:
            busy.discard(heapq.heappop(heap)[1])
        p = parent[i]
        d = int(depth[p]) + 1 if p >= 0 and lane[p] == ln and done[p] else 0
        while d in busy:
            d += 1
        if d > 0xFFFF:
            raise RowError("a lane needs more than 65,536 sub-rows (depth is <u2)", i)
        depth[i], done[i] = d, True
        if end[i] > s:
            heapq.heappush(heap, (end[i], d))
            busy.add(d)
    return depth.astype(np.uint16)


def derived_iterations(stamp_iter: np.ndarray, stamp_start: np.ndarray, row_iter: np.ndarray,
                       row_end: np.ndarray) -> np.ndarray:
    """One iteration per scheduler stamp (stamps in start order), per ITERATION_RULE. Returns the end of each.
    row_iter/row_end: the iteration and end of the rows that are an iteration's own work; other rows, such as a
    blocking OS call on the loop thread, never extend an iteration."""
    its, counts = np.unique(stamp_iter, return_counts=True)
    if (counts > 1).any():
        raise ValueError(f"iteration {int(its[counts > 1][0])} has {int(counts.max())} scheduler stamps; "
                         "the derived iteration needs one per iteration")
    last = np.full(len(its), -np.inf)
    has = np.isin(row_iter, its)
    np.maximum.at(last, np.searchsorted(its, row_iter[has]), row_end[has])
    return np.maximum(stamp_start, last[np.searchsorted(its, stamp_iter)])


def iteration_windows(stamp_start: np.ndarray, end: np.ndarray) -> np.ndarray:
    """The window WINDOW_RULE fills from: each derived iteration cut at the next scheduler stamp, so windows never
    overlap (an iteration's device work can end after the next stamp)."""
    return np.maximum(stamp_start, np.minimum(end, np.append(stamp_start[1:], np.inf)))


def iterations(source_iter: np.ndarray, start: np.ndarray, on_loop_thread: np.ndarray, it_start: np.ndarray,
               it_end: np.ndarray, it_num: np.ndarray, cause: np.ndarray, is_device: np.ndarray):
    """iter column: the source iteration; a row on the executor loop thread with none takes the derived iteration
    whose window holds its start (WINDOW_RULE); a device op takes its launching call's iteration.
    Returns (iter, stats). Derived windows are sorted and do not overlap."""
    it = source_iter.astype(np.int32)
    stats = {"rule": WINDOW_RULE}
    if len(it_start):
        k = np.searchsorted(it_start, start, side="right") - 1
        inside = on_loop_thread & (k >= 0) & (start < it_end[np.maximum(k, 0)])
        win = np.where(inside, it_num[np.maximum(k, 0)], -1)
        fill = (it < 0) & (win >= 0)
        stats["loop thread rows filled from the window"] = int(fill.sum())
        stats["loop thread rows whose source iteration differs from the window"] = int(((it >= 0) & (win >= 0) &
                                                                                          (win != it)).sum())
        it[fill] = win[fill]
    dev = is_device & (cause >= 0)
    via = it[cause[dev]]
    stats["device ops with a launching call"] = int(dev.sum())
    stats["device ops whose iteration changed (source -> launching call)"] = int((via != it[dev]).sum())
    it[dev] = via
    return it, stats


def causes(n: int, frm: np.ndarray, to: np.ndarray) -> np.ndarray:
    """cause[to] = from for links whose kind fills the cause column. Raises RowError when a row has two origins."""
    vals, counts = np.unique(to, return_counts=True)
    if (counts > 1).any():
        raise RowError("a row has two cause links (launch, ZMQ send or network send)", int(vals[counts > 1][0]))
    out = np.full(n, -1, np.int32)
    out[to] = frm
    return out


def request_of_iteration(stamp_iter: np.ndarray, stamp_req: np.ndarray) -> dict[int, int]:
    """Iteration -> request index, from the scheduler stamps, when exactly one request ran in the iteration."""
    seen: dict[int, set] = {}
    for it, r in zip(stamp_iter.tolist(), stamp_req.tolist()):
        if r != NONE16:
            seen.setdefault(it, set()).add(r)
    return {it: rs.pop() for it, rs in seen.items() if len(rs) == 1}


def requests(req: np.ndarray, it: np.ndarray, by_iteration: dict[int, int]) -> np.ndarray:
    """req column: the row's own request, else the request of its iteration."""
    out = req.astype(np.uint16)
    need = np.flatnonzero((out == NONE16) & (it >= 0))
    for i, v in zip(need.tolist(), it[need].tolist()):
        out[i] = by_iteration.get(v, NONE16)
    return out


def euler(keys: list[str], parent_keys: list[str | None]) -> tuple[list[int], list[int], list[int]]:
    """DFS over the thing tree, children by key. Returns (order, parent position, post): order[i] is the input index
    of the thing at position i (its pre number), and every descendant of i has a position in [i, post[i]]."""
    kids: dict[str | None, list[int]] = {}
    index = {k: i for i, k in enumerate(keys)}
    for i, p in enumerate(parent_keys):
        kids.setdefault(p if p in index else None, []).append(i)
    for v in kids.values():
        v.sort(key=lambda i: keys[i])
    order, parent_pos, post = [], [], []
    stack = [(i, -1) for i in reversed(kids.get(None, []))]
    while stack:
        i, ppos = stack.pop()
        pos = len(order)
        order.append(i)
        parent_pos.append(ppos)
        post.append(pos)
        stack += [(c, pos) for c in reversed(kids.get(keys[i], []))]
    for pos in reversed(range(len(order))):
        if parent_pos[pos] >= 0:
            post[parent_pos[pos]] = max(post[parent_pos[pos]], post[pos])
    return order, parent_pos, post


def boxes(rules: list[dict], kind_names: list[str], kind: np.ndarray, lane_keys: list[str], lane: np.ndarray,
          names: list[str], name: np.ndarray, box_arg: np.ndarray, known: set[str]) -> np.ndarray:
    """Component box per row (object array, None = none): the first rule whose fields all match (registry
    components.json comp_rules, v1 boxOf as data). Raises RowError for an args box that is not a known box."""
    arg_vals, arg = np.unique(box_arg.astype(str), return_inverse=True)
    combos, inv = np.unique(np.stack([kind, lane, name, arg]).T, axis=0, return_inverse=True)
    out = []
    for k, ln, nm, a in combos.tolist():
        hit = None
        for r in rules:
            if ("kind" in r and r["kind"] != kind_names[k]) or ("lane" in r and r["lane"] != lane_keys[ln]) \
                    or ("name_in" in r and names[nm] not in r["name_in"]):
                continue
            if "box_from_arg" in r:
                if not arg_vals[a]:
                    continue
                if arg_vals[a] not in known:
                    row = int(np.flatnonzero(inv.ravel() == len(out))[0])
                    raise RowError(f"args.{r['box_from_arg']} = {arg_vals[a]!r} is not a box in components.json", row)
                hit = str(arg_vals[a])
            else:
                hit = r["box"]
            break
        out.append(hit)
    return np.array(out, dtype=object)[inv.ravel()]


def layers(is_kernel: np.ndarray, it: np.ndarray, name_of_row: np.ndarray) -> np.ndarray:
    """Decoder layer per kernel (-1 = none) by the RMSNorm heuristic of trace/adapters/nsys.py layer_of, over the
    kernels of each iteration in start order. Kernels with no iteration get none.
    Imported here: the adapters package pulls in scipy, which only the converter needs."""
    if str(SRC) not in sys.path:
        sys.path.insert(0, str(SRC))
    from inference_analysis.trace.adapters.nsys import layer_of
    out = np.full(len(it), -1, np.int16)
    rows = np.flatnonzero(is_kernel & (it >= 0))
    its = it[rows]
    for v in np.unique(its).tolist():
        r = rows[its == v]
        out[r] = [-1 if x is None else x for x in layer_of(name_of_row[r].tolist())]
    return out


FLOW_NONE = 255
FLOW_RULE = "Calculated: registry kinds.json dimensions.flow"


def iteration_flows(sched_iter: list[int], sched_stamp: list[dict], engine_names: list[str], prefill_rx: str,
                    decode_rx: str, names: list[str]) -> dict[int, int]:
    """Iteration -> flow code (names: the flow names). The scheduler's 'batch scheduled' stamp first: prefill when it
    lists context requests or context tokens, else decode. An engine timestamp names the rest: 'prefill (iteration N)',
    'decode (iterations a-b)'."""
    prefill, decode = names.index("prefill"), names.index("decode")
    out = {}
    for it, st in zip(sched_iter, sched_stamp):
        out[int(it)] = prefill if st.get("context") or (st.get("num_ctx_tokens") or 0) > 0 else decode
    pre, dec = re.compile(prefill_rx), re.compile(decode_rx)
    for x in engine_names:
        if m := pre.match(x):
            out.setdefault(int(m[1]), prefill)
        elif m := dec.match(x):
            for v in range(int(m[1]), int(m[2]) + 1):
                out.setdefault(v, decode)
    return out


def flows(names: list[str], it: np.ndarray, it_flow: dict[int, int], named: np.ndarray, stream_box: np.ndarray,
          request_tier: np.ndarray, req: np.ndarray, start: np.ndarray) -> np.ndarray:
    """flow column (kinds.json dimensions.flow). named: a flow code from the row's own name (engine timestamps),
    FLOW_NONE if none; stream_box: the row sits in a stream-out box; request_tier: the row is placed at execution
    request (it spans every flow)."""
    request_in, prefill, stream_out = names.index("request in"), names.index("prefill"), names.index("stream out")
    out = np.full(len(it), FLOW_NONE, np.uint8)
    for v in np.unique(it[it >= 0]).tolist():
        if v in it_flow:
            out[it == v] = it_flow[v]
    out[named != FLOW_NONE] = named[named != FLOW_NONE]
    out[stream_box] = stream_out
    rest = (out == FLOW_NONE) & (req != NONE16)
    pre = np.flatnonzero((out == prefill) & (req != NONE16))
    turn = {}
    for r, t in zip(req[pre].tolist(), start[pre].tolist()):
        turn[r] = min(turn.get(r, t), t)
    for i in np.flatnonzero(rest).tolist():
        t = turn.get(int(req[i]))
        if t is not None:
            out[i] = request_in if start[i] < t else stream_out
    out[request_tier] = FLOW_NONE
    return out


GENERIC_KERNELS = ("kernel", "Kernel", "Kernel2", "device_kernel")
BUILTIN_TYPES = {"void", "bool", "char", "short", "int", "long", "unsigned", "signed", "float", "double", "half",
                 "__half", "__nv_bfloat16", "size_t", "int8_t", "int16_t", "int32_t", "int64_t", "uint8_t", "uint16_t",
                 "uint32_t", "uint64_t", "true", "false"}
SHORT_NAME_RULE = ("Calculated (choice 7): the demangled function's base name; a generic base (kernel, Kernel, Kernel2, "
                   "device_kernel) takes the leaf identifier of its first template argument as base<leaf>, or, when "
                   "that argument is a builtin type, its namespace's leaf as ns::base. The full name is in full_name")


def _top_level(s: str, sep: str) -> list[str]:
    out, depth, cur = [], 0, []
    for ch in s:
        depth += {"<": 1, ">": -1, "(": 1, ")": -1}.get(ch, 0)
        if ch == sep and depth == 0:
            out.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    return out + ["".join(cur)]


def kernel_short_name(full: str) -> str:
    """SHORT_NAME_RULE. cutlass::Kernel2<cutlass_80_wmma_..._align8>(..) -> Kernel2<cutlass_80_wmma_..._align8>;
    std::enable_if<..>::type internal::gemvx::kernel<int, ..>(..) -> gemvx::kernel; void ns::FooKernel<8u>(..) ->
    FooKernel; a plain name stays as it is."""
    parts = kernel_base_name(full).split("::")
    base = parts[-1]
    if base not in GENERIC_KERNELS:
        return base
    s, depth, cut = full.strip(), 0, None
    for i, ch in enumerate(s):
        depth += {"<": 1, ">": -1, "(": 1, ")": -1}.get(ch, 0)
        if ch == "(" and depth == 1:
            cut = i
    head = (s[:cut] if cut is not None else s).rstrip()
    leaf = None
    if head.endswith(">"):
        depth = 0
        for i in range(len(head) - 1, -1, -1):
            depth += {">": 1, "<": -1}.get(head[i], 0)
            if depth == 0:
                first = _top_level(head[i + 1:-1], ",")[0]
                flat = "".join(ch for d, ch in _depths(first) if d == 0)
                ids = re.findall(r"[A-Za-z_]\w*", flat)
                leaf = ids[-1] if ids else None
                break
    if leaf and leaf not in BUILTIN_TYPES:
        return f"{base}<{leaf}>"
    return f"{parts[-2]}::{base}" if len(parts) > 1 else base


def _depths(s: str):
    depth = 0
    for ch in s:
        if ch == "<":
            depth += 1
        yield depth, ch
        if ch == ">":
            depth -= 1


def kernel_base_name(demangled: str) -> str:
    """The qualified function name of a demangled C++ kernel signature: the return type, the template arguments and
    the parameter list dropped (std::enable_if<..>::type internal::gemvx::kernel<int, ..>(..) -> internal::gemvx::kernel)."""
    s, depth, cut = demangled.strip(), 0, None
    for i, ch in enumerate(s):
        depth += {"<": 1, ">": -1, "(": 1, ")": -1}.get(ch, 0)
        if ch == "(" and depth == 1:
            cut = i
    s = s[:cut] if cut is not None else s
    out, depth = [], 0
    for ch in s:
        depth += ch == "<"
        if depth == 0:
            out.append(ch)
        depth -= ch == ">"
    tokens = "".join(out).split()
    return tokens[-1] if tokens else demangled
