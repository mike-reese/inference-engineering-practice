#!/usr/bin/env bash
# Data movement check: plays R1 in ccv on the hidden CCV-1 output and checks that the moving parts still move the
# way D13 moved them. Three views:
#   component  Architecture world, component map: packets glide box to box (movers.js), the map region repaints
#   container  Architecture world, container cards: the beam follows the cursor along the strip, the region repaints
#   stacked    Stacked world, GPU board: particles stream VRAM -> L2 -> SMs (pixels only; it is a WebGL canvas)
# Each view must also paint at the CCV-1 rate (60 Hz). On 2026-11-09 the views still moved but painted at 24 fps
# (Architecture) and 40 fps (Stacked): the bar's detail strip (1000-2000 elements) was overlap-tested against the
# sidebar's cursor layers every frame. The cadence checks catch that class of regression; the path and pixel checks
# catch a frozen or teleporting mover.
# Usage: devtools/verify/motion.sh, or CC_URL=http://127.0.0.1:7700/static/cc/index.html for another server.
# Exits 1 on any failed check. Evidence (sheets, webp, motion.json) lands in the ccv session folder.
set -u
cd "$(dirname "$0")/../.."   # repo root
export CCV_SESSION=${CCV_SESSION:-cc-motion-$$}
C=devtools/verify/ccv
URL=${CC_URL:-http://127.0.0.1:7710/static/cc/index.html}
export CCV_APP=${URL%%/static/*}
R1=${R1:-I02A-TRACE-timeline_20261109T060522Z_ee2252}
SAMPLE_MS=4000; RECORD_MS=3000
fail=0; n=0
val() { python3 -c 'import json,sys; v=json.load(sys.stdin).get("value"); print(v if isinstance(v,str) else json.dumps(v))'; }
ev() { $C eval "$1" | val; }
get() { python3 -c 'import json,sys; v=json.loads(sys.argv[1])
for k in sys.argv[2:]: v = v[k]
print(v)' "$@"; }
# at most / at least: CHECK NAME VALUE LIMIT
most() { n=$((n+1)); if python3 -c 'import sys; sys.exit(0 if float(sys.argv[1]) <= float(sys.argv[2]) else 1)' "$2" "$3"; then echo "ok   $1 ($2 <= $3)"; else echo "FAIL $1: $2 > $3"; fail=1; fi; }
least() { n=$((n+1)); if python3 -c 'import sys; sys.exit(0 if float(sys.argv[1]) >= float(sys.argv[2]) else 1)' "$2" "$3"; then echo "ok   $1 ($2 >= $3)"; else echo "FAIL $1: $2 < $3"; fail=1; fi; }
url() { python3 -c 'import sys,urllib.parse; print(sys.argv[1]+"?r="+sys.argv[2]+"#"+urllib.parse.quote(sys.argv[3]))' "$URL" "$RANDOM" "$1"; }
VIEW() { python3 -c 'import json,sys; print(json.dumps({"session":{"mode":"replay","rep":"I02A-L1","run":sys.argv[1]},"world":sys.argv[2],"focus":"architecture","tiers":json.loads(sys.argv[3]),"t":int(sys.argv[4])}))' "$R1" "$@"; }
open_view() { $C open "$(url "$1")" >/dev/null; $C wait --expr 'window.READY === true' --timeout 60000 >/dev/null || { n=$((n+1)); echo "FAIL the page never opened $R1"; fail=1; done_; }; sleep 1; }
play() { $C click --css '[data-act=play]' >/dev/null; [ "$(ev '__cc.playing')" = "true" ] || { n=$((n+1)); echo "FAIL play did not start"; fail=1; }; }
stop() { $C click --css '[data-act=play]' >/dev/null; }
movers() { $C eval "$(sed "s/})(MS)\$/})($SAMPLE_MS)/" devtools/verify/movers.js)" | val; }
# cadence: frame intervals the page's animation loop saw while playing (CCV-1 runs at 60 Hz, 16.7 ms)
cadence() { most "$1 frame interval p50 ms" "$(get "$2" frames p50)" 20; most "$1 frame interval p95 ms" "$(get "$2" frames p95)" 34; }
# pixels: NAME SHARE STILL REGION; REGION is --css SEL or --box WxH+X+Y; at least SHARE of frame pairs change and the
# region never holds still longer than STILL ms
pixels() { local name=$1 share=$2 still=$3; shift 3; local m; m=$($C record "motion-$name" --ms $RECORD_MS "$@") || { n=$((n+1)); echo "FAIL $name record: $m"; fail=1; return; }
  least "$name painted frames in ${RECORD_MS} ms" "$(get "$m" frames)" 105
  most "$name painted interval p50 ms" "$(get "$m" interval_ms p50)" 22
  least "$name moving frame pairs, share" "$(python3 -c 'import json,sys; m=json.loads(sys.argv[1]); print(round(m["moving_pairs"]/max(1,m["pairs"]),2))' "$m")" "$share"
  most "$name longest still stretch ms" "$(get "$m" longest_still_ms)" "$still"
  echo "     evidence: $(get "$m" sheet)"; }
done_() { local errs; errs=$($C console | python3 -c 'import json,sys; print(json.load(sys.stdin)["errors"])')
  n=$((n+1)); if [ "$errs" = 0 ]; then echo "ok   no console errors"; else echo "FAIL $errs console errors"; fail=1; fi
  $C close >/dev/null; trap - EXIT; echo "$n checks, $([ $fail = 0 ] && echo all passed || echo FAILURES)"; exit $fail; }
trap '$C close >/dev/null 2>&1' EXIT

$C launch --session "$CCV_SESSION" --size full --url "$(url "$(VIEW architecture '{"execution":0,"hardware":2,"architecture":4}' 73381153020)")" >/dev/null || exit 1
$C wait --expr 'window.READY === true' --timeout 60000 >/dev/null || { echo "FAIL the page never opened $R1"; exit 1; }

echo "== component: Architecture world, component map, event pace from the ASGI headers stamp"
# event pace steps phase to phase, so most packets finish their trip. The map is still between packets (up to 1.7 s
# on 2026-11-09), so the packet checks below prove the motion here, and the pixels only the paint rate.
$C select --css '.b-pace' --option events >/dev/null
play; s=$(movers); pixels component 0.05 2500 --css '#stage .compmap'; stop
cadence component "$s"
least "component packets that travelled" "$(get "$s" packets trips)" 3
# D13's packet eases over 300 ms: about 18 frames at 60 Hz, 7 at 24 fps, 1 when it jumps
least "component median frames per packet trip" "$(get "$s" packets medianFrames)" 14

echo "== container: Architecture world, container cards, whole-run bounds"
open_view "$(VIEW architecture '{"execution":0,"hardware":2,"architecture":2}' 73381153020)"
play; s=$(movers); pixels container 0.5 400 --css '#stage .aw'; stop
cadence container "$s"
least "container beam dot moves along the strip" "$(get "$s" beam moves)" 20

echo "== stacked: Stacked world, GPU board at hardware device tier, iteration bounds"
open_view "$(VIEW stacked '{"execution":1,"hardware":2,"architecture":2}' 73402310386)"
B=$(ev '(() => { const L = [...document.querySelectorAll("#stage .sw-lbl")]; const g = L.find(e => /5060/.test(e.textContent))?.getBoundingClientRect(), v = L.find(e => /VRAM/.test(e.textContent))?.getBoundingClientRect(); if (!g || !v) return ""; const x0 = Math.round(g.left - 60), x1 = Math.round(v.right + 10), y1 = Math.round(g.top), y0 = Math.round(y1 - (x1 - x0) * 0.42); return `${x1-x0}x${y1-y0}+${x0}+${y0}`; })()')
if [ -z "$B" ]; then n=$((n+1)); echo "FAIL stacked: the GPU and VRAM labels are missing, no board box"; fail=1
else play; s=$(movers); pixels stacked 0.5 400 --box "$B"; stop; cadence stacked "$s"; fi

done_
