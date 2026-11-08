"""Old-to-new map of every current surface (COMMAND_CENTER.md, section 9).

Finds the current tiers and kinds (registry/kinds.json), v3 levels (cc/levels/index.js), v2 levels (D5v2 model.js),
v1 views (frontend/index.html), panels (cc/sidebar, cc/inspector, cc/control/bar.js) and controls (cc/control/keys.js)
from the source, and looks each one up in proposal.json. Exits 1 when a surface has no entry or an entry matches no
surface. Run: python3 design/dimensions/map_surfaces.py [--write]
"""
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
REPO = HERE.parent.parent
FE = REPO / "devtools/frontend"
DOC = REPO / "COMMAND_CENTER.md"


def current() -> list[tuple[str, str]]:
    reg = json.loads((REPO / "devtools/registry/kinds.json").read_text())
    s = [("tier", t) for t in reg["tiers"]]
    s += [("kind", k["kind"]) for k in reg["kinds"]]
    s += [("v3 level", n) for n in re.findall(r'name: "([^"]+)"', (FE / "cc/levels/index.js").read_text())]
    names = re.search(r"NAMES = \[([^\]]+)\]", (FE / "prototypes/D5v2/base/model.js").read_text())[1]
    s += [("v2 level", n) for n in re.findall(r'"([^"]+)"', names)]
    s += [("v1 view", v) for v in dict.fromkeys(re.findall(r'data-view="([a-z_]+)"', (FE / "index.html").read_text()))]
    s += [("panel", p) for p, f in (("sidebar", "cc/sidebar/sidebar.js"), ("inspector", "cc/inspector/inspector.js"),
                                    ("bar", "cc/control/bar.js")) if (FE / f).exists()]
    keys = (FE / "cc/control/keys.js").read_text()
    s += [("control", d) for d in re.findall(r'does: "([^"]+)"', keys)]
    if "does: `focus ${l.name}" in keys:
        s.append(("control", "focus <level> (keys 1-7)"))
    return s


def main():
    P = json.loads((HERE / "proposal.json").read_text())
    surf, kinds = P["surfaces"], P["kinds"]
    found = current()
    rows, missing = [], []
    for typ, name in found:
        if typ == "kind":
            k = kinds.get(name)
            if not k:
                missing.append(f"kind:{name}")
                continue
            rows.append((typ, name, f"execution: {k['execution']}; hardware: {k['hardware']}; "
                                     f"architecture: {k['architecture']}"))
        else:
            e = surf.get(f"{typ}:{name}")
            if not e:
                missing.append(f"{typ}:{name}")
                continue
            rows.append((typ, name, e["new"]))
    keys = {f"{t}:{n}" for t, n in found}
    stale = [k for k in surf if k not in keys] + [f"kind:{k}" for k in kinds if f"kind:{k}" not in keys]
    md = "\n".join(["| type | current | new place |", "| --- | --- | --- |"] +
                   [f"| {t} | {n} | {p} |" for t, n, p in rows])
    print(md)
    print(f"\n{len(rows)} surfaces mapped, {len(missing)} missing, {len(stale)} stale", file=sys.stderr)
    for m in missing:
        print(f"missing: {m}", file=sys.stderr)
    for s in stale:
        print(f"stale: {s}", file=sys.stderr)
    if "--write" in sys.argv:
        text = DOC.read_text()
        new = re.sub(r"(<!-- gen:surfaces -->\n).*?(<!-- /gen:surfaces -->)", lambda m: m[1] + md + "\n" + m[2], text, flags=re.S)
        assert new != text or md in text, "gen:surfaces markers not found in the doc"
        DOC.write_text(new)
    sys.exit(1 if missing or stale else 0)


if __name__ == "__main__":
    main()
