"""Detail by row id for one generation: hot and cold columns (DuckDB over the generation's Parquet), the parent
chain, the cause row, links, the calculated metrics that use the row, the Nsight Compute headline counters, and the
open-in-Nsight targets (the host runner opens .nsys-rep and .ncu-rep paths relative to the run folder).

A Generation is built once per (run, generation) and is read-only after that. Lookups run on worker threads; each
thread has its own cursor on one DuckDB connection with the Parquet metadata cache on.
"""
from __future__ import annotations

import json
import threading
from pathlib import Path

import duckdb
import numpy as np

from .schema import NONE16, Manifest, decode

MAX_IDS = 256

_db = duckdb.connect(config={"threads": 2, "parquet_metadata_cache": True})
_local = threading.local()
_lock = threading.Lock()
_open: dict[str, tuple[tuple, "Generation"]] = {}


def _cur() -> duckdb.DuckDBPyConnection:
    cur = getattr(_local, "cur", None)
    if cur is None:
        cur = _local.cur = _db.cursor()
    return cur


def generation(store: Path, run: str) -> "Generation":
    """The current generation of a run, rebuilt when its manifest changes. KeyError when the run is not in the store."""
    path = store / "runs" / run / "manifest.json"
    try:
        st = path.stat()
    except FileNotFoundError:
        raise KeyError(run) from None
    key = (st.st_mtime_ns, st.st_size)
    hit = _open.get(run)
    if hit and hit[0] == key:
        return hit[1]
    with _lock:
        hit = _open.get(run)
        if not (hit and hit[0] == key):
            _open[run] = hit = (key, Generation(path.parent, Manifest.load(path)))
    return hit[1]


class Generation:
    def __init__(self, root: Path, m: Manifest):
        self.m, self.dir = m, root / f"g{m.generation}"
        self.kind_names = [k["name"] for k in m.kinds]
        events = [b for b in m.blocks if b["table"] == "events"]
        n = sum(b["rows"] for b in events)
        self.n = n
        self.parent = np.full(n, -1, np.int32)
        self.cause = np.full(n, -1, np.int32)
        self.block = np.zeros(n, np.uint16)
        self.files = []
        for k, b in enumerate(events):
            _, cols = decode((self.dir / f"{b['name']}.ccvb").read_bytes())
            ids = cols["id"]
            self.parent[ids], self.cause[ids], self.block[ids] = cols["parent"], cols["cause"], k
            self.files.append(str(self.dir / f"events-{b['name']}.parquet"))
        cur = _cur()
        lk = cur.execute(f"""SELECT "from", "to", kind, coalesce(weight, 'NaN'::DOUBLE) AS weight, rule, evidence
            FROM read_parquet('{self.dir}/links.parquet')""").fetchnumpy()
        self.lk_from, self.lk_to = lk["from"].astype(np.int64), lk["to"].astype(np.int64)
        self.lk_weight = lk["weight"].astype(np.float64)
        texts: dict[tuple, int] = {}                        # (kind, rule, evidence) repeats: keep each once
        self.lk_code = np.array([texts.setdefault(t, len(texts)) for t in
                                 zip(lk["kind"].tolist(), lk["rule"].tolist(), lk["evidence"].tolist())], np.int32)
        self.lk_texts = list(texts)
        self.by_from = np.argsort(self.lk_from, kind="stable")
        self.by_to = np.argsort(self.lk_to, kind="stable")
        self.from_sorted, self.to_sorted = self.lk_from[self.by_from], self.lk_to[self.by_to]
        self.counters: dict[int, dict] = {}
        if (self.dir / "profiles.parquet").is_file():
            for eid, prow, kname, metric, measure, unit, value, evd, prun, unit_rule in cur.execute(
                    f"""SELECT event_id, profile_row, kernel_name, metric, measure, unit, value, evidence, profile_run,
                    unit_rule
                    FROM read_parquet('{self.dir}/profiles.parquet') WHERE event_id IS NOT NULL
                    ORDER BY event_id, metric""").fetchall():
                c = self.counters.setdefault(int(eid), {"run": prun, "profile_row": prow, "kernel_name": kname,
                                                        "evidence": evd, "values": []})
                c["values"].append({"metric": metric, "measure": measure, "unit": unit, "value": value,
                                    "unit_rule": unit_rule})
        aux = json.loads((self.dir / "aux.json").read_bytes())
        self.uses: dict[int, list] = {}
        for i, mt in enumerate(aux["metrics"]):
            for r in mt["inputs"]["rows"]:
                self.uses.setdefault(r, []).append({"aux_index": i, **{k: v for k, v in mt.items() if k != "inputs"}})
        self.nsys, ncu = m.tools.get("nsys"), m.tools.get("ncu")
        self.ncu = {"run": ncu["run"], "path": ncu["path"]} if ncu else None

    def _rows(self, ids: list[int]) -> dict[int, dict]:
        files = sorted({self.files[b] for b in self.block[ids].tolist()})
        cur = _cur()
        res = cur.execute(f"SELECT * EXCLUDE (layer), CAST(layer AS INTEGER) AS layer FROM read_parquet({files!r}) "
                          f"WHERE id IN ({','.join(map(str, ids))})")
        cols = [d[0] for d in res.description]
        rows = [dict(zip(cols, r)) for r in res.fetchall()]
        return {r["id"]: r for r in rows}

    def _check(self, ids: list[int]) -> None:
        bad = [i for i in ids if not 0 <= i < self.n]
        if bad:
            raise ValueError(f"row ids {bad[:5]} are outside 0..{self.n - 1}")

    def chain(self, i: int) -> list[int]:
        out = []
        p = int(self.parent[i])
        while p >= 0:
            out.append(p)
            p = int(self.parent[p])
        return out

    def _brief(self, r: dict) -> dict:
        return {"id": r["id"], "kind": self.kind_names[r["kind"]], "tier": r["tier"], "name": self.m.names[r["name"]],
                "start": r["start"], "end": r["end"]}

    def _links(self, i: int) -> list[dict]:
        out = []
        for order, sorted_ in ((self.by_from, self.from_sorted), (self.by_to, self.to_sorted)):
            a, b = np.searchsorted(sorted_, i, "left"), np.searchsorted(sorted_, i, "right")
            for k in order[a:b].tolist():
                kind, rule, evd = self.lk_texts[self.lk_code[k]]
                w = self.lk_weight[k]
                out.append({"from": int(self.lk_from[k]), "to": int(self.lk_to[k]), "kind": kind,
                            "weight": None if np.isnan(w) else float(w), "rule": rule, "evidence": evd})
        return out

    def detail(self, ids: list[int]) -> list[dict]:
        if len(ids) > MAX_IDS:
            raise ValueError(f"{len(ids)} ids; at most {MAX_IDS} per request")
        self._check(ids)
        chains = {i: self.chain(i) for i in ids}
        need = set(ids) | {p for c in chains.values() for p in c} | {int(self.cause[i]) for i in ids if self.cause[i] >= 0}
        rows = self._rows(sorted(need))
        out = []
        for i in ids:
            r = rows[i]
            c = int(self.cause[i])
            t0 = self.m.t0_ns
            open_ = {"nsys": None, "ncu": None}
            if self.nsys and r["source"] == "nsys":
                s0 = self.nsys.get("session_start_ns")
                open_["nsys"] = {"run": self.nsys["run"], "path": self.nsys["path"],
                                 "t": None if s0 is None else [int(t0 - s0 + r["start"]), int(t0 - s0 + r["end"])],
                                 "t_evidence": self.nsys["evidence"]}
            counters = self.counters.get(i)
            if counters and self.ncu:
                open_["ncu"] = {**self.ncu, "profile_row": counters["profile_row"]}
            out.append({
                "id": i, "eid": r["eid"], "kind": self.kind_names[r["kind"]], "tier": r["tier"],
                "name": self.m.names[r["name"]], "start": r["start"], "end": r["end"],
                "lane": self.m.things[r["lane"]]["key"],
                "comp": None if r["comp"] == NONE16 else self.m.things[r["comp"]]["key"],
                "req": None if r["req"] == NONE16 else self.m.requests[r["req"]],
                "iter": None if r["iter"] < 0 else r["iter"], "depth": r["depth"],
                "bytes": None if r["bytes"] is None or np.isnan(r["bytes"]) else r["bytes"],
                "what": r["what"], "args": json.loads(r["args"]) if r["args"] else None, "evidence": r["evidence"],
                "term": r["term"], "source": r["source"], "corr": r["corr"], "quirk": r["quirk"],
                "parent_rule": r["parent_rule"], "layer": r["layer"] if r["layer"] >= 0 else None,
                "code": {"origin": r["code_origin"], "where": r["code_where"]} if r["code_origin"] else None,
                "raw": {"file": r["raw_file"], "pointer": r["raw_ptr"]} if r["raw_file"] else None,
                "parents": [self._brief(rows[p]) for p in chains[i]],
                "cause": self._brief(rows[c]) if c >= 0 else None,
                "links": self._links(i), "metrics": self.uses.get(i, []), "counters": counters, "open": open_,
            })
        return out

    def resolve(self, eids: list[str]) -> list[int]:
        if len(eids) > MAX_IDS:
            raise ValueError(f"{len(eids)} eids; at most {MAX_IDS} per request")
        got = dict(_cur().execute(f"SELECT eid, id FROM read_parquet({self.files!r}) WHERE eid IN "
                                  f"(SELECT unnest(?::VARCHAR[]))", [eids]).fetchall())
        return [got[e] for e in eids if e in got]

    def raw_target(self, i: int) -> tuple[str, str, str] | None:
        """(run folder relative to REPO, file, pointer) of the row's raw record, or None."""
        self._check([i])
        r = self._rows([i])[i]
        return (self.m.source["run_dir"], r["raw_file"], r["raw_ptr"]) if r["raw_file"] else None

