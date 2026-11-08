#!/usr/bin/env bash
# D12 regression check: drives the real page in ccv on the hidden CCV-1 output and reads window.__d12.
# Usage: D12/regress.sh. Exits 1 on any failed check.
set -u
cd "$(dirname "$0")/../../../.."   # repo root
export CCV_SESSION=d12-regress
C=devtools/verify/ccv
URL=http://127.0.0.1:7710/static/prototypes/D12/index.html
fail=0; n=0
ev() { $C eval "$1" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("value"))'; }
check() { n=$((n+1)); if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got '$2' want '$3'"; fail=1; fi; }
open_at() { $C open "$URL?r=$RANDOM#$(python3 -c 'import json,sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$1")" >/dev/null; sleep 2; }
world() { $C click --css ".ch-nav button[data-w=$1]" >/dev/null; sleep 0.8; }
tf() { ev "document.querySelector('$1')?.style.transform ?? 'none'"; }
wheel() { ev "(()=>{const b=document.querySelector('$1');const r=b.getBoundingClientRect();b.dispatchEvent(new WheelEvent('wheel',{deltaY:-400,clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true,cancelable:true}));return 1})()" >/dev/null; sleep 0.2; }

$C launch --session d12-regress --size full --url "$URL" >/dev/null || exit 1
open_at '{"world":"stacked","tiers":{"execution":4,"hardware":3,"architecture":4},"paired":true,"t":0,"sel":null}'
check "worlds: three header tabs" "$(ev "document.querySelectorAll('.ch-nav button[data-w]').length")" "3"
$C key 6 >/dev/null; $C key ArrowRight >/dev/null; $C key ArrowRight >/dev/null; sleep 0.3
sel=$(ev '__d12.sel'); t=$(ev '__d12.t')
check "R2 paired: kernel aligns hardware" "$(ev '__d12.tiers.hardware')" "4"
for W in spine architecture stacked; do
  world $W
  check "R1 $W world loaded" "$(ev '__d12.world')" "$W"
  check "R1 $W keeps selection" "$(ev '__d12.sel')" "$sel"
  check "R1 $W keeps cursor" "$(ev '__d12.t')" "$t"
done
world architecture; $C key a >/dev/null; $C key 5 >/dev/null; sleep 0.5
check "architecture world: all 26 v1 boxes" "$(ev "document.querySelectorAll('#stage .aw .cbox').length")" "26"
world spine
check "spine: Split lens by default" "$(ev "document.querySelectorAll('#stage .sp2 .pane').length")" "2"
a0=$(tf '#stage .sp2 .pane .zc'); h0=$(tf '#stage .sp2 .hwsvg')
wheel '#stage .sp2 .pane .zc'
check "zoom: architecture pane zooms" "$([ "$(tf '#stage .sp2 .pane .zc')" != "$a0" ] && echo yes)" "yes"
check "zoom: hardware pane unchanged" "$(tf '#stage .sp2 .hwsvg')" "$h0"
a1=$(tf '#stage .sp2 .pane .zc'); wheel '#stage .sp2 .hwsvg'
check "zoom: hardware pane zooms" "$([ "$(tf '#stage .sp2 .hwsvg')" != "$h0" ] && echo yes)" "yes"
check "zoom: architecture pane unchanged" "$(tf '#stage .sp2 .pane .zc')" "$a1"
ev "(()=>{document.querySelectorAll('#stage .sp2 .pbody').forEach(b=>b.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})));return 1})()" >/dev/null
$C key e >/dev/null; $C key 6 >/dev/null; $C key p >/dev/null; $C key ArrowUp >/dev/null; sleep 0.3
check "R2 independent: only execution moves" "$(ev '__d12.tiers.hardware')" "4"
$C key p >/dev/null; sleep 0.3
check "R2 paired again re-aligns" "$(ev '__d12.tiers.hardware')" "3"
$C click --text "Kernels" --exact >/dev/null; sleep 0.4
k1=$(ev "document.querySelectorAll('.b-body tr[data-sel]')[0].dataset.sel"); k2=$(ev "document.querySelectorAll('.b-body tr[data-sel]')[3].dataset.sel")
$C click --css ".b-body tr[data-sel='$k1']" >/dev/null; sleep 0.3
$C click --text "Selected" --exact >/dev/null; sleep 0.3
$C click --css ".b-body a[data-sel]" >/dev/null; sleep 0.3
picked=$(ev '__d12.sel')
$C click --css ".b-hist[aria-label=Back]" >/dev/null; sleep 0.3
check "history: back restores the selection" "$(ev '__d12.sel')" "$k1"
check "history: back restores the tab" "$(ev '__d12.dock.tab')" "selected"
$C click --css ".b-hist[aria-label=Back]" >/dev/null; sleep 0.3
check "history: back again reaches the first click's page" "$(ev '__d12.sel')" "$sel"
$C click --css ".b-hist[aria-label=Forward]" >/dev/null; sleep 0.2
ev "(()=>{dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',altKey:true,bubbles:true}));return 1})()" >/dev/null; sleep 0.3
check "history: forward twice returns" "$(ev '__d12.sel')" "$picked"
check "history: forward disabled at the end" "$(ev "document.querySelector('.b-hist[aria-label=Forward]').disabled")" "True"
$C key 5 >/dev/null; sleep 0.2
b=$(ev 'JSON.stringify(__d12.bounds)')
$C key " " >/dev/null; sleep 4
check "play: cursor inside bounds" "$(ev '(()=>{const [a,b]=__d12.bounds;return __d12.t>=a&&__d12.t<=b})()')" "True"
check "play: bounds held" "$(ev 'JSON.stringify(__d12.bounds)')" "$b"
check "play: playing" "$(ev '__d12.playing')" "True"
$C key " " >/dev/null; sleep 0.3
$C shot regress-spine >/dev/null
pos=$(ev '__d12.t'); $C open "$URL?r=$RANDOM$(ev 'location.hash')" >/dev/null; sleep 2
check "R10 reload keeps cursor" "$(ev '__d12.t')" "$pos"
check "R10 reload keeps world" "$(ev '__d12.world')" "spine"
errs=$($C console | python3 -c 'import json,sys; print(json.load(sys.stdin)["errors"])')
check "R11 no console errors" "$errs" "0"
$C close >/dev/null
echo "$n checks, $([ $fail = 0 ] && echo all passed || echo FAILURES)"; exit $fail
