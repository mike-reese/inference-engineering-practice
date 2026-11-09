"""devtools/registry/*.json, loaded and validated once. Everything downstream trusts these types."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from .schema import TIERS

REGISTRY_DIR = Path(__file__).resolve().parents[2] / "registry"


@dataclass(frozen=True)
class KindRule:
    code: int
    kind: str
    tier: int
    nest_bump: bool
    derived: bool
    color: str
    label: str
    home: str
    place: dict                   # {execution, hardware, architecture}: the kind's place per dimension

    def manifest(self) -> dict:
        return {"code": self.code, "name": self.kind, "tier": self.tier, "nest_bump": self.nest_bump,
                "derived": self.derived, "color": self.color, "label": self.label, "home": self.home,
                "place": self.place}


@dataclass(frozen=True)
class LinkKind:
    code: int
    kind: str
    cause: bool
    label: str


@dataclass(frozen=True)
class Registry:
    kinds: tuple[KindRule, ...]
    link_kinds: tuple[LinkKind, ...]
    levels: tuple[str, ...]
    metric_rules: dict            # metric name -> its kinds.json metrics entry (sidebar, label, place, ...)
    components: dict              # components.json
    sample_tracks: dict           # sample evidence -> source track (registry "samples" rules)
    measures: dict                # measure name -> definition, from the source registries
    ncu_headline: tuple           # the Nsight Compute counters kept per kernel (ncu.json headline)
    ncu_units: dict               # headline counter -> (unit, {report display unit: factor to that unit})
    digest: str                   # hash of every registry file: part of a run's inputs signature
    sources: dict                 # source name (run_json, nsys, torch_profiler, ncu, inventory) -> its registry file
    ladders: dict                 # dimension -> its tiers, coarse to fine (kinds.json ladders)
    dimensions: dict              # kinds.json dimensions: align, storage, stops, walk, handoff, ran_on, kernel_class, flow

    def metric_places(self) -> dict:
        """Every metric's place ({"hardware": a hardware tier or "-"}), served with each manifest (store/serve.py)."""
        return {name: m["place"] for name, m in self.metric_rules.items()}

    def execution_kinds(self, tier: str) -> list[str]:
        """The kinds placed at an execution tier without a rule (e.g. "request": client request)."""
        return [k.kind for k in self.kinds if isinstance(k.place.get("execution"), str)
                and k.place["execution"].split(" (")[0] == tier]

    @classmethod
    def load(cls, root: Path = REGISTRY_DIR) -> "Registry":
        files = sorted(root.glob("*.json"))
        raw = {p.name: json.loads(p.read_bytes()) for p in files}
        k, c = raw["kinds.json"], raw["components.json"]
        if tuple(k["tiers"]) != TIERS:
            raise ValueError(f"kinds.json tiers {k['tiers']} differ from schema.TIERS {TIERS}")
        levels = tuple(k["levels"])
        kinds = []
        for i, e in enumerate(k["kinds"]):
            if not 0 <= e["tier"] < len(TIERS) or e["home"] not in levels:
                raise ValueError(f"kinds.json: {e['kind']!r} has tier {e['tier']} or home {e['home']!r} out of range")
            kinds.append(KindRule(i, e["kind"], e["tier"], e.get("nest_bump", False), e.get("derived", False),
                                  e["color"], e["label"], e["home"], e["place"]))
        links = tuple(LinkKind(i, e["kind"], e["cause"], e["label"]) for i, e in enumerate(k["link_kinds"]))
        for names, what in (([x.kind for x in kinds], "kind"), ([x.kind for x in links], "link kind"),
                            ([b["key"] for b in c["boxes"]], "box"), ([b["key"] for b in c["bounds"]], "bound")):
            if len(set(names)) != len(names):
                raise ValueError(f"registry: duplicate {what} in {sorted(n for n in names if names.count(n) > 1)}")
        boxes, bounds = {b["key"] for b in c["boxes"]}, {b["key"] for b in c["bounds"]}
        for b in c["boxes"]:
            if b["bound"] not in bounds:
                raise ValueError(f"components.json: box {b['key']!r} sits in unknown bound {b['bound']!r}")
        for a, b in c["edges"]:
            if a not in boxes or b not in boxes:
                raise ValueError(f"components.json: edge {a}->{b} names an unknown box")
        kind_names = {x.kind for x in kinds}
        for r in c["comp_rules"]:
            one_box = ("box" in r) != ("box_from_arg" in r)
            if not one_box or r.get("box") not in boxes | {None} or r.get("kind") not in kind_names | {None}:
                raise ValueError(f"components.json: comp rule {r} needs one known box or box_from_arg, and a known kind")
        sources = [v for n, v in raw.items() if n not in ("kinds.json", "components.json")]
        tracks = {s["evidence"]: s["match"]["track"] for src in sources for s in src.get("samples", [])}
        measures = {m["measure"]: m | {"source": src["source"]} for src in sources for m in src.get("measures", [])}
        digest = hashlib.sha256(b"".join(p.name.encode() + p.read_bytes() for p in files)).hexdigest()[:20]
        headline = tuple(raw["ncu.json"]["headline"])
        keep, scale = raw["ncu.json"]["keep_metrics"], raw["ncu.json"]["scale"]
        unknown = [x for x in headline if x not in keep or keep[x]["unit"] not in scale]
        if unknown:
            raise ValueError(f"ncu.json: headline counters {unknown} need a keep_metrics unit that has a scale table")
        units = {x: (keep[x]["unit"], scale[keep[x]["unit"]]) for x in headline}
        return cls(tuple(kinds), links, levels, {m["metric"]: m for m in k["metrics"]}, c, tracks, measures, headline,
                   units, digest, {src["source"]: src for src in sources}, k["ladders"], k["dimensions"])

    def event_rule(self, source: str, kind: str, **match) -> dict:
        """The event_kinds entry of a source registry for a kind (and match fields, e.g. thread="sdk")."""
        for e in self.sources[source]["event_kinds"]:
            if e["kind"] == kind and all(e["match"].get(k) == v for k, v in match.items()):
                return e
        raise KeyError(f"registry {source}: no event_kinds entry for kind {kind!r} {match or ''}")

    def kind(self, name: str) -> KindRule:
        for x in self.kinds:
            if x.kind == name:
                return x
        raise KeyError(f"kind {name!r} is not in registry/kinds.json")

    def link_kind(self, name: str) -> LinkKind:
        for x in self.link_kinds:
            if x.kind == name:
                return x
        raise KeyError(f"link kind {name!r} is not in registry/kinds.json link_kinds")
