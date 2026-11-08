"""Each kind's place per dimension in devtools/registry/kinds.json: shared by stop_counts.py and map_surfaces.py."""
import json
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


def check_places(reg: dict) -> list[str]:
    ladders, bad = reg["ladders"], []
    for k in reg["kinds"]:
        place = k.get("place") or {}
        if set(place) != set(ladders):
            bad.append(f"kind {k['kind']!r}: place names {sorted(place)}, not each of {list(ladders)}")
            continue
        for dim, v in place.items():
            if isinstance(v, dict) and (v.get("if") not in RULES or set(v) - {"if", "then", "else", "match"}):
                bad.append(f"kind {k['kind']!r}: {dim} rule {v} is not one of {RULES} with then and else")
                continue
            for out in ([v] if isinstance(v, str) else [v.get("then"), v.get("else")]):
                if not isinstance(out, str) or tier_of(out) not in [*ladders[dim], "detail", "-"]:
                    bad.append(f"kind {k['kind']!r}: {dim} place {out!r} is not a tier of {dim}, detail or -")
    return bad
