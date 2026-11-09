#!/usr/bin/env python3
"""Spine lane guard: in the Execution spine's bands pane, units that are open at the same time must not be painted on
top of each other, and one logical stream (the boxes of one colour, the key the page reports per box) must stay on its
own lanes. On 2026-11-09 the pane painted overlapping units as one bar; the first fix stacked them but let a stream
bounce between lanes.

Fast by design: one ccv launch, one read-only eval per run, all checking in Python. The eval returns the page's own
report, window.__spineLayout() (one box [id, start, end, x, y, w, h, key] per drawn box), and, read from the store without
the layout code, each band's units with their start and end. Per band:

  coverage      every unit of the store has a box, and every box is a unit of that band
  no overlap    no two boxes of different units are open at the same time and share y (an instant counts as 1 ns);
                a unit with one box is timed by the store, not by the page
  lanes         a stream uses as many y positions as it overlaps itself (1 if never); skipped where units have
                several boxes
and per run: band rows share no y, some band has units that overlap in time (else the guard proved nothing), at most
3 real clicks select the box the report places there, and the console has no errors.

Limits: it trusts the report for every box it does not click; it checks time and y, not x, so boxes that only touch
in pixels (minimum widths) pass; boxes of one unit may overlap each other; it reads the fitted view only, so a fault
that appears after a zoom, a scroll or a selection passes; labels and colours are not checked.

Usage: devtools/verify/overlap_check.py [--run RUN[,RUN]] [--rep REP[,REP]] [--no-clicks] | --self-test
       CC_URL=http://127.0.0.1:7711/static/cc/index.html for another server. Exits 1 on any failed check.
"""
import argparse, json, os, random, subprocess, sys, urllib.parse
from collections import Counter, defaultdict, namedtuple
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CCV = str(ROOT / "devtools/verify/ccv")
URL = os.environ.get("CC_URL", "http://127.0.0.1:7710/static/cc/index.html")
ENV = {**os.environ, "CCV_APP": URL.split("/static/")[0], "CCV_SESSION": os.environ.get("CCV_SESSION", f"overlap-guard-{os.getpid()}")}
SVG = "#stage .spine svg"
NO_CONTRACT = "the page has no window.__spineLayout(): the spine layout contract is missing"
COVERAGE, OVERLAP, LANES, ROWS, NOT_VACUOUS = "coverage", "no overlap", "a stream keeps its lanes", "band rows share no y", "the run has units that overlap in time"
EPS_PX = 0.01
MAX_CLICKS, MIN_CLICK_PX = 3, 12

Box = namedtuple("Box", "id start end x y w h key", defaults=[None])
HANDOFF = 0.02  # worlds/spine/lanes.js: a unit may start inside the last 2% of the unit before it without overlapping it


def settled(start, end):
    """Where a span stops blocking its lane: its end less the hand-off, at least 1 ns after its start."""
    return start + max(1, (1 - HANDOFF) * (end - start))

# The store half mirrors Bands.sync() (worlds/spine/bands.js): a band per execution tier from units(), the copies
# strip from the hardware device stops. `view.clip` is the part of the svg the user can see, in svg coordinates.
PROBE_JS = r"""
import("./control/control.js").then((m) => {
  if (typeof window.__spineLayout !== "function") return JSON.stringify({ contract: false });
  const S = m.store();
  const band = (name, ids, start, end) => ({ band: name, ids: Array.from(ids), start: Array.from(start), end: Array.from(end) });
  const store = m.ladders().execution.map((name, tier) => { const u = m.units(tier); return band(name, u.ids, u.start, u.end); });
  const device = S.dims.ladders.hardware.indexOf("device"), st = device >= 0 ? m.stops("hardware", device) : { ids: [], t: [] };
  store.push(band("copies", st.ids, st.t, Array.from(st.ids, (id) => S.endOf[id])));
  const svg = document.querySelector("#stage .spine svg"), r = svg.getBoundingClientRect();
  const clip = [Math.max(0, r.left), Math.max(0, r.top), Math.min(innerWidth, r.right), Math.min(innerHeight, r.bottom)];
  for (let e = svg.parentElement; e; e = e.parentElement) {
    if (getComputedStyle(e).overflow === "visible") continue;
    const q = e.getBoundingClientRect();
    clip[0] = Math.max(clip[0], q.left); clip[1] = Math.max(clip[1], q.top); clip[2] = Math.min(clip[2], q.right); clip[3] = Math.min(clip[3], q.bottom);
  }
  const view = { w: r.width, h: r.height, clip: [clip[0] - r.left, clip[1] - r.top, clip[2] - r.left, clip[3] - r.top] };
  return JSON.stringify({ contract: true, layout: window.__spineLayout(), store, view });
})
"""
SEL_JS = "JSON.stringify(window.__cc.sel ?? null)"


def concurrent_pairs(boxes):
    """Pairs of boxes of different units that are open at the same time, found by one sweep in start order."""
    open_boxes = []
    for b in sorted(boxes, key=lambda b: b.start):
        open_boxes = [o for o in open_boxes if settled(o.start, o.end) > b.start]
        yield from ((o, b) for o in open_boxes if o.id != b.id)
        open_boxes.append(b)


def shares_y(a, b):
    return a.y < b.y + b.h - EPS_PX and b.y < a.y + a.h - EPS_PX


def most_open(spans):
    """The largest number of [start, end] spans open at one time, by the lane rule's own test (settled)."""
    edges = sorted([(s, 1) for s, _ in spans] + [(settled(s, e), -1) for s, e in spans])
    most = now = 0
    for _, step in edges:
        now += step
        most = max(most, now)
    return most


def first(items, n=3):
    return ", ".join(str(i) for i in items[:n]) + (" ..." if len(items) > n else "")


def check_band(units, boxes):
    """Coverage, overlap and lane results for one band, as (ok, check, detail); ok None is an info line."""
    name, span = units["band"], dict(zip(units["ids"], zip(units["start"], units["end"])))
    drawn = Counter(b.id for b in boxes)
    missing, strangers = [i for i in span if i not in drawn], sorted(set(drawn) - set(span))
    yield (not missing and not strangers, f"{name}: {COVERAGE}", f"{len(span)} units, {len(boxes)} boxes" if not missing and not strangers
           else f"{len(missing)} of {len(span)} units have no box (ids {first(missing)}); {len(strangers)} box ids are no unit of this band (ids {first(strangers)})")

    timed = [b._replace(start=span[b.id][0], end=span[b.id][1]) if drawn[b.id] == 1 and b.id in span else b for b in boxes]
    stacked = [(a.id, b.id) for a, b in concurrent_pairs(timed) if shares_y(a, b)]
    yield (not stacked, f"{name}: {OVERLAP}", f"{len(boxes)} boxes" if not stacked
           else f"{len(stacked)} pairs of boxes are open at the same time and share y (ids {first(['%s/%s' % p for p in stacked])})")

    if missing or strangers or any(n != 1 for n in drawn.values()):
        yield (None, f"{name}: {LANES}", "skipped, not every unit has exactly one box")
        return
    y_of, members = {b.id: round(b.y, 2) for b in boxes}, defaultdict(list)
    for b in boxes:
        members[b.key].append(b.id)
    moved = [f"colour {s}: {len({y_of[i] for i in ids})} lanes, overlaps itself {most_open([span[i] for i in ids])} deep (first id {ids[0]})"
             for s, ids in members.items() if len({y_of[i] for i in ids}) != most_open([span[i] for i in ids])]
    yield (not moved, f"{name}: {LANES}", f"{len(members)} streams" if not moved else f"{len(moved)} of {len(members)} streams do not ({first(moved, 2)})")


def check_run(store, layout):
    """Every data check of one run: `store` is the store's bands, `layout` the page's __spineLayout().bands."""
    boxes = defaultdict(list)
    for entry in layout:
        boxes[entry["band"]] += [Box(*b) for b in entry["boxes"]]
    known = {u["band"] for u in store}
    for u in store:
        yield from check_band(u, boxes[u["band"]])
    unknown = sorted(b for b in boxes if b not in known and boxes[b])
    if unknown:
        yield (False, f"{COVERAGE} of bands", f"the page reports bands the store does not have: {first(unknown)}")

    counted = {e["band"] for e in layout if e.get("form") == "count"}
    rows = sorted((min(b.y for b in bs), max(b.y + b.h for b in bs), band) for band, bs in boxes.items() if bs and band not in counted)
    crossed = [f"{a[2]}/{b[2]}" for a, b in zip(rows, rows[1:]) if b[0] < a[1] - EPS_PX]
    yield (not crossed, ROWS, f"{len(rows)} bands" if not crossed else f"rows cross: {first(crossed)}")
    if counted:
        yield (None, ROWS, f"left out, drawn in count form: {first(sorted(counted))}")

    deep = {u["band"]: most_open(list(zip(u["start"], u["end"]))) for u in store}
    busy = [f"{band} {n} at once" for band, n in deep.items() if n > 1]
    yield (bool(busy), NOT_VACUOUS, ", ".join(busy) if busy else "no band has two units open at once: the guard proved nothing")


def click_targets(layout, view):
    """Up to MAX_CLICKS (band, box) to click: drawn, fully in view, wide enough, with a neighbour open at the same time.
    The first lane of each band comes before any band's second lane."""
    left, top, right, bottom = view["clip"]
    scroll = view.get("scrollTop", 0)
    lanes = defaultdict(list)
    for entry in layout:
        if entry.get("form") == "count":
            continue
        boxes = [Box(*b) for b in entry["boxes"]]
        crowded = {x.id for pair in concurrent_pairs(boxes) for x in pair}
        for b in boxes:
            if b.id in crowded and b.w >= MIN_CLICK_PX and b.x >= left and b.x + b.w <= right and b.y - scroll >= top and b.y + b.h - scroll <= bottom:
                lanes[entry["band"], round(b.y, 2)].append(b)
    ranked, lanes_seen = [], Counter()
    for (band, _), in_lane in sorted(lanes.items()):
        ranked.append((lanes_seen[band], band, max(in_lane, key=lambda b: b.w)))
        lanes_seen[band] += 1
    return [(band, b) for _, band, b in sorted(ranked, key=lambda r: r[0])][:MAX_CLICKS]


def self_test():
    """Hand-made layouts, each judged by check_run: the checks that must fail, and no others."""
    units = {"band": "phase", "ids": [1, 2, 3], "start": [0, 0, 20], "end": [10, 30, 30]}
    box = lambda uid, y: [uid, units["start"][units["ids"].index(uid)], units["end"][units["ids"].index(uid)], 0, y, 10, 8, uid % 2]
    cases = [
        ("a clean layout passes", [box(1, 0), box(2, 8), box(3, 0)], set()),
        ("two boxes open at once that share y fail", [box(1, 0), box(2, 0), box(3, 0)], {OVERLAP}),
        ("a stream on two lanes without self-overlap fails", [box(1, 0), box(2, 8), box(3, 16)], {LANES}),
        ("a missing unit fails", [box(1, 0), box(2, 8)], {COVERAGE}),
    ]
    for name, layout, want in cases:
        got = {check.split(": ")[-1] for ok, check, _ in check_run([units], [{"band": "phase", "boxes": layout}]) if ok is False}
        report(got == want, name, "" if got == want else f"failed checks {sorted(got)}, want {sorted(want)}")


checks = failed = 0


def report(ok, name, detail=""):
    global checks, failed
    text = name + (f"{', ' if ok else ': '}{detail}" if detail else "")
    if ok is None:
        print(f"     {text}", flush=True)
        return
    checks += 1
    failed += not ok
    print(f"{'ok  ' if ok else 'FAIL'} {text}", flush=True)


def ccv(*args, check=True):
    p = subprocess.run([CCV, *args], env=ENV, capture_output=True, text=True, timeout=120)
    try:
        out = json.loads(p.stdout)
    except json.JSONDecodeError:
        out = {"error": (p.stdout + p.stderr)[-400:]}
    if check and p.returncode != 0:
        raise RuntimeError(f"ccv {' '.join(args)[:80]}: {out.get('error')}")
    return out


def view_url(run, rep):
    view = {"session": {"mode": "replay", "rep": rep, "run": run}, "world": "spine", "focus": "execution",
            "tiers": {"execution": 0, "hardware": 2, "architecture": 4}}  # execution tier 0: a selection does not move the axis
    return f"{URL}?r={random.randrange(10**9)}#{urllib.parse.quote(json.dumps(view))}"


def guard(clicks):
    """All checks of the run the page shows; False when the page has no layout contract."""
    data = json.loads(ccv("eval", PROBE_JS)["value"])
    if not data["contract"]:
        report(False, NO_CONTRACT)
        return False
    layout, view = data["layout"]["bands"], {**data["view"], **data["layout"].get("view", {})}
    for result in check_run(data["store"], layout):
        report(*result)
    targets = click_targets(layout, view) if clicks else []
    if clicks and not targets:
        report(None, "clicks", f"skipped, the fitted view has no box at least {MIN_CLICK_PX} px wide with a neighbour open at the same time")
    for band, b in targets:
        fx, fy = (b.x + b.w / 2) / view["w"], (b.y - view.get("scrollTop", 0) + b.h / 2) / view["h"]
        ccv("click", "--css", SVG, "--frac", f"{fx:.5f},{fy:.5f}")
        want, got = {"layer": b.id} if band == "layer" else b.id, json.loads(ccv("eval", SEL_JS)["value"])
        report(got == want, f"{band}: a click on box {b.id} selects it", "" if got == want else f"window.__cc.sel is {json.dumps(got)}")
    return True


def main():
    a = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    a.add_argument("--run", action="append", help="run id; repeat or separate with commas (default: the I02C code run, which overlaps in several bands)")
    a.add_argument("--rep", action="append", help="the rep of each run, in the same order; the last one covers the remaining runs")
    a.add_argument("--no-clicks", action="store_true", help="data checks only")
    a.add_argument("--self-test", action="store_true", help="judge hand-made layouts with the check functions; no browser")
    o = a.parse_args()
    if o.self_test:
        self_test()
    else:
        runs = [r for arg in o.run or ["I02C-TRACE-code_20261109T213328Z_39a18c"] for r in arg.split(",")]
        reps = [r for arg in o.rep or ["I02C-L1"] for r in arg.split(",")]
        try:
            for i, run in enumerate(runs):
                url = view_url(run, reps[min(i, len(reps) - 1)])
                ccv("launch", "--size", "half", "--url", url) if i == 0 else ccv("open", url)
                print(f"== {run}", flush=True)
                if not guard(not o.no_clicks):
                    break
            else:
                errors = ccv("console", check=False).get("errors")
                report(errors == 0, "console errors", "0" if errors == 0 else str(errors))
        finally:
            ccv("close", check=False)
    print(f"{checks} checks, {'all passed' if not failed else 'FAILURES'}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
