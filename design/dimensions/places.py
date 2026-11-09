"""Each kind's place per dimension and the dimension rules in devtools/registry/kinds.json: shared by stop_counts.py
and map_surfaces.py."""
import json
import re
from pathlib import Path

KINDS = Path(__file__).resolve().parents[2] / "devtools/registry/kinds.json"
RULES = ("top-level", "launch", "module forward", "profiled")


def load() -> dict:
    return json.loads(KINDS.read_text())


def tier_of(value: str) -> str:
    """'kernel (CPU side)' -> 'kernel': the bracket says what the row lands on, not which tier."""
    return value.split(" (")[0]


def text(value) -> str:
    """A place as the doc reads it: the value, or '<then> if <rule>, else <else>'."""
    return value if isinstance(value, str) else f"{value['then']} if {value['if']}, else {value['else']}"


def outputs(value) -> list:
    return [value] if isinstance(value, str) else [value.get("then"), value.get("else")]


def check_places(reg: dict, place: dict | None = None) -> list[str]:
    """Each kind names a valid place in every dimension, and its execution places are allowed for its storage tier
    (dimensions.storage). place (kind -> {dimension: value}) defaults to the registry's own."""
    ladders, dims, bad = reg["ladders"], reg["dimensions"], []
    place = place if place is not None else {k["kind"]: k.get("place") or {} for k in reg["kinds"]}
    for k in reg["kinds"]:
        p = place.get(k["kind"]) or {}
        if set(p) != set(ladders):
            bad.append(f"kind {k['kind']!r}: place names {sorted(p)}, not each of {list(ladders)}")
            continue
        for dim, v in p.items():
            if isinstance(v, dict) and (v.get("if") not in RULES or set(v) - {"if", "then", "else", "match"}):
                bad.append(f"kind {k['kind']!r}: {dim} rule {v} is not one of {RULES} with then and else")
                continue
            for out in outputs(v):
                if not isinstance(out, str) or tier_of(out) not in [*ladders[dim], "detail", "-"]:
                    bad.append(f"kind {k['kind']!r}: {dim} place {out!r} is not a tier of {dim}, detail or -")
        storage = reg["tiers"][k["tier"]]
        allowed = dims["storage"][storage]
        for out in outputs(p["execution"]):
            if isinstance(out, str) and tier_of(out) not in [*allowed, "detail", "-"]:
                bad.append(f"kind {k['kind']!r} (storage tier {storage}): execution place {out!r} is not one of "
                           f"{allowed}, detail or - (dimensions.storage)")
    return bad


def check_dimensions(reg: dict) -> list[str]:
    """The dimension rules name only ladder tiers, kinds and thing kinds that exist."""
    ladders, d, bad = reg["ladders"], reg["dimensions"], []
    kinds = {k["kind"] for k in reg["kinds"]}
    for row in d["align"]:
        bad += [f"align: {dim} {t!r} is not a tier" for dim, t in row.items() if t not in ladders[dim]]
    if [r["execution"] for r in d["align"]] != ladders["execution"]:
        bad.append("align: one row per execution tier, in ladder order")
    if set(d["storage"]) != set(reg["tiers"]):
        bad.append(f"storage: names {sorted(d['storage'])}, not each storage tier")
    bad += [f"storage: {s} allows {t!r}, not an execution tier" for s, ts in d["storage"].items() for t in ts
            if t not in ladders["execution"]]
    for dim, ladder in ladders.items():
        if list(d["stops"][dim]) != ladder:
            bad.append(f"stops: {dim} names {list(d['stops'][dim])}, not its ladder {ladder}")
        for tier, rule in d["stops"][dim].items():
            if "as" in rule:
                to_dim, to_tier = rule["as"].split("/")
                if to_tier not in ladders.get(to_dim, []) or "as" in d["stops"][to_dim][to_tier]:
                    bad.append(f"stops: {dim}/{tier} steps as {rule['as']}, not a tier with its own stops")
            bad += [f"stops: {dim}/{tier} kind {k!r} is not a kind" for k in rule.get("kinds", []) if k not in kinds]
            if rule.get("if", "profiled") not in RULES or rule.get("handoff", "container") not in ladders["architecture"]:
                bad.append(f"stops: {dim}/{tier} rule {rule} names an unknown rule or level")
    for dim, tiers in d["walk"].items():
        bad += [f"walk: {dim}/{t} is not a tier" for t in tiers if t not in ladders[dim]]
    bad += [f"kernel_class: kind {k!r} is not a kind" for c in d["kernel_class"] for k in c.get("kinds", [])
            if k not in kinds]
    bad += [f"ran_on: kind {k!r} is not a kind" for k in d["ran_on"]["kinds"] if k not in kinds]
    for c in d["kernel_class"]:
        if "match" in c:
            re.compile(c["match"])
    return bad
