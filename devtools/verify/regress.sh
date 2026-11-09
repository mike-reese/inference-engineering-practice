#!/usr/bin/env bash
# Command center regression check (COMMAND_CENTER.md 7.4, P1): drives the page at CC_URL in ccv on the hidden CCV-1
# output and reads its state from window.__cc. Expected values come from the store (/api/v3/runs), the run's
# latency.json, the rep's moments.toml and rep.toml, registry/components.json and COMMAND_CENTER.md, never literals.
# A page that reads a snapshot instead of the store (D13's session-data.json beside its index.html) narrows the run
# and rep choices to what both hold, and its moments are the snapshot's. Launch uses the runner's dry_run, so nothing
# starts; the checks that need a real recording (the head moves, follow holds the head, the mask) are in live.sh.
# Usage: devtools/verify/regress.sh, or CC_URL=http://127.0.0.1:7710/static/prototypes/D13/index.html for D13.
# RUNNER_URL (default: the page's origin, which proxies /runner) picks the runner. Exits 1 on any failed check.
set -u
cd "$(dirname "$0")/../.."   # repo root
export CCV_SESSION=${CCV_SESSION:-cc-regress-$$}
C=devtools/verify/ccv
URL=${CC_URL:-http://127.0.0.1:7710/static/cc/index.html}
APP=${URL%%/static/*}
RUNNER=${RUNNER_URL:-$APP}
PAGE="$URL?dry_run=1"
fail=0; n=0
ev() { $C eval "$1" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("value"))'; }
check() { n=$((n+1)); if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got '$2' want '$3'"; fail=1; fi; }
# A before / after comparison: the baseline must be a real value, or an unchanged null would pass.
same() { case "$3" in ""|None|null|undefined) n=$((n+1)); echo "FAIL $1: baseline is '$3'"; fail=1;; *) check "$1" "$2" "$3";; esac; }
real() { case "$1" in ""|None|null|undefined) return 1;; esac; }
open_at() { $C open "$PAGE&r=$RANDOM#$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$1")" >/dev/null; sleep 2; }
world() { $C click --css ".ch-nav button[data-w=$1]" >/dev/null; sleep 0.8; }
tf() { ev "(()=>{const e=document.querySelector('$1');return e?getComputedStyle(e).transform:null})()"; }
wheel() { ev "(()=>{const b=document.querySelector('$1');const r=b.getBoundingClientRect();b.dispatchEvent(new WheelEvent('wheel',{deltaY:-400,clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true,cancelable:true}));return 1})()" >/dev/null; sleep 0.2; }
done_() { $C close >/dev/null; echo "$n checks, $([ $fail = 0 ] && echo all passed || echo FAILURES)"; exit $fail; }

$C launch --session "$CCV_SESSION" --size full --url "$PAGE" >/dev/null || exit 1
check "page exposes its state as window.__cc" "$(ev 'typeof window.__cc === "object" && window.__cc !== null')" "True"
[ $fail = 0 ] || { echo "stopped: no window.__cc to read"; done_; }
REP=$(ev '__cc.session.rep'); RUN=$(ev '__cc.session.run')

# Expectations, as shell assignments.
EXPECT=$(python3 - "$APP" "$URL" "$REP" "$RUN" <<'EOF'
import json, re, shlex, sys, tomllib, urllib.request
from pathlib import Path
app, url, rep, run = sys.argv[1:]
get = lambda u: json.load(urllib.request.urlopen(u, timeout=10))
out = {}

def table(heading):
    """The first Markdown table after a COMMAND_CENTER.md heading: rows of cells, header and rule dropped."""
    lines = Path("COMMAND_CENTER.md").read_text().splitlines()
    i = lines.index(heading) + 1
    while not lines[i].startswith("|"):
        i += 1
    rows = []
    while i < len(lines) and lines[i].startswith("|"):
        rows.append([c.strip() for c in lines[i].strip("|").split("|")])
        i += 1
    return rows[2:]

ladder = {d: [r[0] for r in table(h)] for d, h in
          (("execution", "### 3.1 Execution"), ("hardware", "### 3.2 Hardware"), ("architecture", "### 3.3 Architecture"))}
align = [{d: [x.strip() for x in re.split(r",| or ", cell)] for d, cell in zip(ladder, r)}
         for r in table("### 3.4 Position, now, crossing and stepping")]
def aligned(tier, to):  # hardware tiers the alignment table allows for execution tier `tier`
    row = next(r for r in align if ladder["execution"][tier] in r["execution"])
    return " ".join(str(ladder[to].index(x)) for x in row[to])
out["WORLDS"] = len(table("### 2.2 Worlds"))
out["KERNEL"] = ladder["execution"].index("kernel")
out["HW_AT_KERNEL"] = aligned(out["KERNEL"], "hardware")
out["HW_AT_MODULE"] = aligned(ladder["execution"].index("module"), "hardware")
out["COMPONENT"] = ladder["architecture"].index("component")
out["BOXES"] = len(json.loads(Path("devtools/registry/components.json").read_text())["boxes"])

def rep_id(folder):
    toml = folder / "rep.toml"
    return tomllib.loads(toml.read_text())["id"] if toml.exists() else folder.name.split("_")[0]
folders = {rep_id(f.parent): f.parent for f in sorted(Path("reps").glob("*/README.md"))}
folder = folders[rep]
moments = tomllib.loads((folder / "moments.toml").read_text())
out["MOMENTS"] = len(moments["moments"])

def ttft(r):  # the measured request's client TTFT in latency.json, or None when not computed
    lat = folders_of.get(r, Path("-")) / "results" / r / "latency.json"
    if not lat.exists():
        return None
    rec = next((v for k, v in json.loads(lat.read_text()).items() if k.endswith(moments.get("request", "measured"))), {})
    return rec.get("client", {}).get("ttft_ms")

store = [r["run"] for r in get(f"{app}/api/v3/runs")["runs"]]   # newest first
folders_of = {r: f for r in store for f in folders.values() if (f / "results" / r).is_dir()}
snap_url = url.rsplit("/", 1)[0] + "/session-data.json"
try:
    snap = get(snap_url)
except Exception:
    snap = None
shown = (lambda r: True) if snap is None else (lambda r: any(x["id"] == r and x["result"] for x in snap["runs"]))
out["TTFT"] = f"{ttft(run):.3f} ms" if run in store and ttft(run) is not None else "no TTFT for " + run
out["RUN_B"] = next((r for r in store if r != run and folders_of.get(r) == folder and ttft(r) is not None and shown(r)), "")
no_runs = [i for i in sorted(folders) if not any(f == folders[i] for f in folders_of.values())
           and (snap is None or (any(x["id"] == i for x in snap["reps"]) and not any(x["rep"] == i for x in snap["runs"])))]
out["NO_RUNS_REP"] = no_runs[0] if no_runs else ""
out["SNAPSHOT"] = snap_url if snap is not None else "none (store)"
# "Show me" selects the event the page's own moment names: the snapshot's, else the served catalog's (moments.toml)
page_reps = snap["reps"] if snap is not None else get(f"{app}/api/v3/reps")["reps"]
show = next(m for m in next(r for r in page_reps if r["id"] == rep)["moments"]["moments"] if m["id"] == "prefill")
out["SHOW_ID"], out["SHOW_EVENT"] = show["id"], show["event"]

actions = tomllib.loads((folder / "rep.toml").read_text())["actions"]
out["LAUNCH"] = actions[0]["id"]
bad_action, bad_opt = next((a, o) for a in actions for o in a.get("options", []) if "pattern" in o)
out["BAD_ACTION"], out["BAD_OPT"] = bad_action["id"], bad_opt["id"]
out["BAD_VALUE"] = next(v for v in ("x", "-", "?") if not re.fullmatch(bad_opt["pattern"], v))
print("\n".join(f"{k}={shlex.quote(str(v))}" for k, v in out.items()))
EOF
) || { n=$((n+1)); echo "FAIL expectations: could not read the store or the files"; done_; }
eval "$EXPECT"
echo "     session $REP / $RUN; run B $RUN_B; snapshot $SNAPSHOT"

check "default: tiers independent" "$(ev '__cc.paired')" "False"
check "default: opens on the Rep world" "$(ev '__cc.world')" "rep"
open_at '{"world":"stacked","tiers":{"execution":4,"hardware":3,"architecture":4},"paired":true,"t":0,"sel":null}'
check "worlds: one header tab per world of 2.2" "$(ev "document.querySelectorAll('.ch-nav button[data-w]').length")" "$WORLDS"
$C key $((KERNEL+1)) >/dev/null; $C key ArrowRight >/dev/null; $C key ArrowRight >/dev/null; sleep 0.3
sel=$(ev '__cc.sel'); t=$(ev '__cc.t')
check "R2 paired: kernel aligns hardware (3.4)" "$(ev "' $HW_AT_KERNEL '.includes(' ' + __cc.tiers.hardware + ' ')")" "True"
for W in spine architecture stacked; do
  world $W
  check "R1 $W world loaded" "$(ev '__cc.world')" "$W"
  same "R1 $W keeps selection" "$(ev '__cc.sel')" "$sel"
  same "R1 $W keeps cursor" "$(ev '__cc.t')" "$t"
done
world architecture; $C key a >/dev/null; $C key $((COMPONENT+1)) >/dev/null; sleep 0.5
check "architecture world: every box of components.json" "$(ev "document.querySelectorAll('#stage .aw .cbox').length")" "$BOXES"
world spine
check "spine: Split lens by default" "$(ev "document.querySelectorAll('#stage .sp2 .pane').length")" "2"
a0=$(tf '#stage .sp2 .pane .zc'); h0=$(tf '#stage .sp2 .hwsvg')
wheel '#stage .sp2 .pane .zc'
real "$a0" && a=$(tf '#stage .sp2 .pane .zc') && [ "$a" != "$a0" ] && z=yes || z="no (before '$a0')"
check "zoom: architecture pane zooms" "$z" "yes"
same "zoom: hardware pane unchanged" "$(tf '#stage .sp2 .hwsvg')" "$h0"
a1=$(tf '#stage .sp2 .pane .zc'); wheel '#stage .sp2 .hwsvg'
real "$h0" && h=$(tf '#stage .sp2 .hwsvg') && [ "$h" != "$h0" ] && z=yes || z="no (before '$h0')"
check "zoom: hardware pane zooms" "$z" "yes"
same "zoom: architecture pane unchanged" "$(tf '#stage .sp2 .pane .zc')" "$a1"
ev "(()=>{document.querySelectorAll('#stage .sp2 .pbody').forEach(b=>b.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})));return 1})()" >/dev/null
$C key e >/dev/null; $C key $((KERNEL+1)) >/dev/null; $C key p >/dev/null; sleep 0.3
hw=$(ev '__cc.tiers.hardware'); $C key ArrowUp >/dev/null; sleep 0.3
same "R2 independent: only execution moves" "$(ev '__cc.tiers.hardware')" "$hw"
$C key p >/dev/null; sleep 0.3
check "R2 paired again re-aligns (3.4)" "$(ev "' $HW_AT_MODULE '.includes(' ' + __cc.tiers.hardware + ' ')")" "True"
$C click --text "Kernels" --exact >/dev/null; sleep 0.4
k1=$(ev "document.querySelectorAll('.b-body tr[data-sel]')[0]?.dataset.sel ?? null")
$C click --css ".b-body tr[data-sel='$k1']" >/dev/null; sleep 0.3
$C click --text "Selected" --exact >/dev/null; sleep 0.3
$C click --css ".b-body a[data-sel]" >/dev/null; sleep 0.3
picked=$(ev '__cc.sel')
$C click --css ".b-hist[aria-label=Back]" >/dev/null; sleep 0.3
same "history: back restores the selection" "$(ev '__cc.sel')" "$k1"
check "history: back restores the tab" "$(ev '__cc.dock.tab')" "selected"
$C key "[" >/dev/null; sleep 0.3
# Both clicks must have changed the selection, or an unchanged one passes the next two checks.
real "$k1" && [ "$k1" != "$sel" ] && got=$(ev '__cc.sel') || got="no first click (k1 '$k1', start '$sel')"
same "history: [ again reaches the first click's page" "$got" "$sel"
$C click --css ".b-hist[aria-label=Forward]" >/dev/null; sleep 0.2
$C key "]" >/dev/null; sleep 0.3
real "$picked" && [ "$picked" != "$k1" ] && [ "$picked" != "$sel" ] && got=$(ev '__cc.sel') || got="no second click (picked '$picked')"
same "history: forward, then ], returns" "$got" "$picked"
check "history: forward disabled at the end" "$(ev "document.querySelector('.b-hist[aria-label=Forward]').disabled")" "True"
$C key 5 >/dev/null; sleep 0.2
b=$(ev 'JSON.stringify(__cc.bounds)')
$C key " " >/dev/null; sleep 4
check "play: cursor inside bounds" "$(ev '(()=>{const [a,b]=__cc.bounds;return __cc.t>=a&&__cc.t<=b})()')" "True"
same "play: bounds held" "$(ev 'JSON.stringify(__cc.bounds)')" "$b"
check "play: playing" "$(ev '__cc.playing')" "True"
$C key " " >/dev/null; sleep 0.3
$C shot regress-spine >/dev/null
pos=$(ev '__cc.t'); $C open "$PAGE&r=$RANDOM$(ev 'location.hash')" >/dev/null; sleep 2
same "R10 reload keeps cursor" "$(ev '__cc.t')" "$pos"
check "R10 reload keeps world" "$(ev '__cc.world')" "spine"
# Every-row walk (choice 4): from a stop, Alt → walks rows in time order and lands on the next stop, never past it.
$C key a >/dev/null; $C key $((COMPONENT+1)) >/dev/null; $C key ArrowRight >/dev/null; sleep 0.2
t0=$(ev '__cc.t'); $C key ArrowRight >/dev/null; sleep 0.2; t1=$(ev '__cc.t'); $C key ArrowLeft >/dev/null; sleep 0.2
walk="none"
if real "$t0" && real "$t1" && [ "$(ev "__cc.t === $t0 && $t1 > $t0")" = True ]; then
  prev=$t0
  for _ in $(seq 64); do
    $C key ArrowRight --mods alt >/dev/null; sleep 0.15; now=$(ev '__cc.t')
    [ "$(ev "$now > $prev")" = True ] || { walk="stuck at $now"; break; }
    [ "$(ev "$now >= $t1")" = True ] && { walk=$now; break; }
    prev=$now
  done
fi
same "walk: Alt → reaches the next stop row by row" "$walk" "$t1"
$C key e >/dev/null
# ---- shell: Rep world, Load, Compare, Launch
world rep
check "rep world: one key moment per moments.toml entry" "$(ev "document.querySelectorAll('#stage .rw .mom').length")" "$MOMENTS"
check "rep world: client TTFT of latency.json shown ($TTFT)" "$(ev "document.querySelector('#stage .rw table.res')?.textContent.includes('$TTFT') ?? null")" "True"
$C click --css "#stage .rw [data-go=$SHOW_ID]" >/dev/null; sleep 0.8
check "show me: jumps to the spine" "$(ev '__cc.world')" "spine"
check "show me: selects the moment's event ($SHOW_EVENT)" "$(ev "!!__cc.sel && (document.querySelector('.b-body')?.textContent ?? '').includes('$SHOW_EVENT')")" "True"
opn() { $C click --css ".ch-nav [data-sh=open][data-v=$1]" >/dev/null; sleep 0.4; }
opn load
check "load: panel opens" "$(ev "!document.querySelector('.sh-pan').hidden")" "True"
$C click --css ".sh-pan [data-p=load][data-v=$RUN_B]" >/dev/null; sleep 0.6
same "load: run B replayed" "$(ev '__cc.session.run')" "$RUN_B"
check "load: opens on the Rep world" "$(ev '__cc.world')" "rep"
opn load; $C click --css ".sh-pan [data-p=rep][data-v=$NO_RUNS_REP]" >/dev/null; sleep 0.3
real "$NO_RUNS_REP" && r=$(ev "document.querySelector('.sh-pan .main').textContent.includes('No recorded runs')") || r="no rep without runs"
check "load: rep without runs says so ($NO_RUNS_REP)" "$r" "True"
$C key Escape >/dev/null; sleep 0.2
opn compare
$C click --css ".sh-pan [data-p=a][data-v=$RUN]" >/dev/null; sleep 0.2; $C click --css ".sh-pan [data-p=b][data-v=$RUN_B]" >/dev/null; sleep 0.2
$C click --css ".sh-pan [data-p=compare]" >/dev/null; sleep 0.6
check "compare: mode" "$(ev '__cc.session.mode')" "compare"
check "compare: delta columns" "$(ev "document.querySelector('#stage .rw table.res').textContent.includes('B − A')")" "True"
world spine
check "compare: ribbon over the spine" "$(ev "document.querySelector('#stage > div[hidden]') === null && document.querySelector('#stage').textContent.includes('compare · showing A')")" "True"
$C click --css ".ch-nav .ab button[data-v=B]" >/dev/null; sleep 0.4
check "compare: switch to B" "$(ev '__cc.session.side')" "B"
opn launch
OPT="$BAD_ACTION.$BAD_OPT"
ev "(()=>{const i=document.querySelector('.sh-pan [data-opt=\"$OPT\"]');i.value='$BAD_VALUE';return 1})()" >/dev/null
$C click --css ".sh-pan [data-p=launch][data-v=$BAD_ACTION]" >/dev/null; sleep 0.3
check "launch: bad option is refused ($OPT=$BAD_VALUE)" "$(ev "document.querySelector('.sh-pan [data-opt=\"$OPT\"]').classList.contains('bad')")" "True"
post() { curl -s -o /dev/null -w '%{http_code}' -X POST "$RUNNER/runner/jobs" -H 'content-type: application/json' -d "$1"; }
code=$(post "{\"rep\":\"$REP\",\"action\":\"$BAD_ACTION\",\"options\":{\"$BAD_OPT\":\"$BAD_VALUE\"},\"dry_run\":true}")
check "launch: the runner refuses the bad option" "$code" "400"
# An older runner ignores dry_run and would start the job: post only to one that reports dry_run.
if [ "$(curl -s "$RUNNER/runner/health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("dry_run"))' 2>/dev/null)" = True ]; then
  top() { curl -s "$RUNNER/runner/jobs?limit=1" | python3 -c 'import json,sys; print([j["id"] for j in json.load(sys.stdin)])'; }
  last=$(top)
  job=$(curl -s -X POST "$RUNNER/runner/jobs" -H 'content-type: application/json' -d "{\"rep\":\"$REP\",\"action\":\"$LAUNCH\",\"options\":{},\"dry_run\":true}" \
    | python3 -c 'import json,sys; j=json.load(sys.stdin); print(j.get("dry_run"), j.get("action"), j.get("started_ns"))')
  [ "$(top)" = "$last" ] || job="$job; a job was queued"
else job="runner at $RUNNER has no dry_run (restart it: make runner-down && make runner)"; fi
check "launch: runner dry run returns the $LAUNCH job and starts nothing" "$job" "True $LAUNCH None"
$C click --css ".sh-pan [data-p=launch][data-v=$LAUNCH]" >/dev/null; sleep 2
check "launch: live mode" "$(ev '__cc.session.mode')" "live"
$C shot regress-live >/dev/null
$C click --css ".ch-nav [data-sh=follow]" >/dev/null; sleep 0.3
check "launch: follow off" "$(ev '__cc.follow')" "False"
errs=$($C console | python3 -c 'import json,sys; print(json.load(sys.stdin)["errors"])')
check "R11 no console errors" "$errs" "0"
world rep; $C shot regress-rep >/dev/null
done_
