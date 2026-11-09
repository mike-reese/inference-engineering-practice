"""Old-to-new map of every current surface (COMMAND_CENTER.md, section 9).

Finds the storage tiers, kinds and each kind's place (registry/kinds.json), the D13 worlds (prototypes/D13/model.js),
the v1 views (frontend/index.html), the cc panels (cc/sidebar, cc/inspector, cc/control/bar.js) and controls
(cc/control/keys.js) from the source, and looks each one up in surfaces.json. Exits 1 when a surface has no entry, an
entry matches no surface, or a new place names a tier missing from the ladders ("execution / phase") or a world D13
does not draw ("Rep world"). Run: python3 design/dimensions/map_surfaces.py [--write]
"""
import json
import re
import sys
from pathlib import Path

from places import check_dimensions, check_places, load, text

HERE = Path(__file__).parent
REPO = HERE.parent.parent
FE = REPO / "devtools/frontend"
DOC = REPO / "COMMAND_CENTER.md"


def worlds() -> list[str]:
    body = re.search(r"export const WORLDS = (\[.*?\]\]);", (FE / "prototypes/D13/model.js").read_text())[1]
    return [name for _, name in json.loads(body)]


def current(reg: dict) -> list[tuple[str, str]]:
    s = [("tier", t) for t in reg["tiers"]]
    s += [("kind", k["kind"]) for k in reg["kinds"]]
    s += [("D13 world", w) for w in worlds()]
    s += [("v1 view", v) for v in dict.fromkeys(re.findall(r'data-view="([a-z_]+)"', (FE / "index.html").read_text()))]
    s += [("panel", p) for p, f in (("sidebar", "cc/sidebar/sidebar.js"), ("inspector", "cc/inspector/tabs.js"),
                                    ("bar", "cc/control/bar.js")) if (FE / f).exists()]
    keys = (FE / "cc/control/keys.js").read_text()
    s += [("control", d) for d in re.findall(r'does: "([^"]+)"', keys)]
    if "does: `focus ${l.name}" in keys:
        s.append(("control", "focus <level> (keys 1-7)"))
    return s


def unknown_names(place: str, ladders: dict, world_names: list[str]) -> list[str]:
    """Each 'dimension / tier[ and tier]' must start with ladder tiers; each '<Name> world' must be a D13 world."""
    bad = []
    for dim, rest in re.findall(r"\b(execution|hardware|architecture) / ([^;,]+)", place):
        tiers = sorted(ladders[dim], key=len, reverse=True)
        while True:
            hit = next((t for t in tiers if rest == t or rest.startswith(t + " ")), None)
            if hit is None:
                bad.append(f"{dim} / {rest}: no {dim} tier {ladders[dim]}")
                break
            rest = rest[len(hit):]
            if not rest.startswith(" and "):
                break
            rest = rest[len(" and "):]
    for name in re.findall(r"\b([A-Z][a-z]+) world\b", place):
        if name not in world_names and f"{name} world" not in world_names:
            bad.append(f"{name} world: D13 draws {world_names}")
    return bad


def main():
    reg = load()
    surf = {k: v for k, v in json.loads((HERE / "surfaces.json").read_text()).items() if k != "_doc"}
    place = {k["kind"]: k["place"] for k in reg["kinds"] if k.get("place")}
    world_names = worlds()
    found = current(reg)
    rows, missing, wrong = [], [], [f"kinds.json: {b}" for b in check_places(reg) + check_dimensions(reg)]
    for typ, name in found:
        if typ == "kind":
            p = place.get(name)
            new = p and "; ".join(f"{dim}: {text(p[dim])}" for dim in reg["ladders"])
        else:
            new = surf.get(f"{typ}:{name}", {}).get("new")
        if not new:
            missing.append(f"{typ}:{name}")
            continue
        rows.append((typ, name, new))
        wrong += [f"{typ}:{name}: {b}" for b in unknown_names(new, reg["ladders"], world_names)]
    keys = {f"{t}:{n}" for t, n in found}
    stale = [k for k in surf if k not in keys]
    md = "\n".join(["| type | current | new place |", "| --- | --- | --- |"] +
                   [f"| {t} | {n} | {p} |" for t, n, p in rows])
    print(md)
    print(f"\n{len(rows)} surfaces mapped, {len(missing)} missing, {len(stale)} stale, {len(wrong)} naming a tier or "
          f"world that does not exist", file=sys.stderr)
    for kind, items in (("missing", missing), ("stale", stale), ("unknown", wrong)):
        for x in items:
            print(f"{kind}: {x}", file=sys.stderr)
    failed = missing or stale or wrong
    if "--write" in sys.argv and not failed:
        doc = DOC.read_text()
        new = re.sub(r"(<!-- gen:surfaces -->\n).*?(<!-- /gen:surfaces -->)", lambda m: m[1] + md + "\n" + m[2], doc,
                     flags=re.S)
        assert new != doc or md in doc, "gen:surfaces markers not found in the doc"
        DOC.write_text(new)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
