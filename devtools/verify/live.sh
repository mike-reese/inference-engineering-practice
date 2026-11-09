#!/usr/bin/env bash
# Command center live check (COMMAND_CENTER.md 7.3, 7.4 M1): one real Launch of I02A `off` through the runner, followed
# live in ccv on the hidden CCV-1 output. The checks regress.sh cannot make on a dry run: the head moves, follow holds
# the cursor at the head, and the spine masks the future. It records a run on the GPU (7.3, owner approved): run it
# only when the GPU is free.
# Usage: devtools/verify/live.sh, or CC_URL=http://127.0.0.1:7710/static/cc/index.html for another page. RUNNER_URL
# (default: the page's origin, which proxies /runner) picks the runner. LIVE_WAIT_S (default 900) bounds the wait for
# the run's first rows (the stack starts first). Exits 1 on any failed check.
set -u
cd "$(dirname "$0")/../.."   # repo root
export CCV_SESSION=${CCV_SESSION:-cc-live-$$}
C=devtools/verify/ccv
URL=${CC_URL:-http://127.0.0.1:7710/static/cc/index.html}
APP=${URL%%/static/*}
RUNNER=${RUNNER_URL:-$APP}
WAIT=${LIVE_WAIT_S:-900}
REP=I02A-L1; ACTION=off   # 7.3: M1's Launch check records one I02A off run
fail=0; n=0
ev() { $C eval "$1" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("value"))'; }
check() { n=$((n+1)); if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got '$2' want '$3'"; fail=1; fi; }
real() { case "$1" in ""|None|null|undefined) return 1;; esac; }
done_() { $C close >/dev/null; echo "$n checks, $([ $fail = 0 ] && echo all passed || echo FAILURES)"; exit $fail; }

curl -sf "$RUNNER/runner/health" >/dev/null || { echo "stopped: no runner at $RUNNER (make runner)"; exit 1; }
$C launch --session "$CCV_SESSION" --size full --url "$URL" >/dev/null || exit 1
check "page opens on a $REP run" "$(ev '__cc.session.rep')" "$REP"
[ $fail = 0 ] || { echo "stopped: the Launch panel launches the shown rep's actions"; done_; }

$C click --css ".ch-nav [data-sh=open][data-v=launch]" >/dev/null; sleep 0.4
$C click --css ".sh-pan [data-p=launch][data-v=$ACTION]" >/dev/null; sleep 1
check "launch: live mode, not a dry run" "$(ev '__cc.session.mode + " " + __cc.session.live?.dry_run')" "live false"
echo "     job $(ev '__cc.session.live?.job'): waiting up to $WAIT s for the run's first rows"
waited=0; state=""
while [ $waited -lt "$WAIT" ]; do
  [ "$(ev '__cc.session.mode === "live" && __cc.head > 0')" = True ] && break
  now=$(ev '__cc.session.live?.state + " " + (__cc.session.live?.note ?? "")')
  [ "$now" != "$state" ] && { state=$now; echo "     ${waited} s: $state"; }
  case "$now" in ok*|failed*|cancelled*) break;; esac   # the job ended before its run streamed
  sleep 2; waited=$((waited+2))
done
check "launch: the run streams rows (head > 0 within $WAIT s)" "$(ev '__cc.session.mode === "live" && __cc.head > 0')" "True"
[ $fail = 0 ] || { $C shot live-no-rows >/dev/null; done_; }

h1=$(ev '__cc.head'); sleep 0.5
check "launch: head moves" "$(real "$h1" && ev "__cc.head > $h1 && $h1 > 0")" "True"
check "launch: follow keeps cursor at head" "$(ev 'Math.abs(__cc.t-__cc.head) <= __cc.head*0.2')" "True"
# The mask is 0 while the view glides (220 ms) to new bounds and the head is still right of it: poll for up to 1 s.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  mask=$(ev "+document.querySelector('#stage .sp2 svg rect[fill=\"#0b0f16\"]')?.getAttribute('width') > 0")
  [ "$mask" = True ] && break; sleep 0.1
done
check "launch: spine masks the future" "$mask" "True"
$C shot live-following >/dev/null
$C click --css ".ch-nav [data-sh=follow]" >/dev/null; sleep 0.3
check "launch: follow off" "$(ev '__cc.follow')" "False"
errs=$($C console | python3 -c 'import json,sys; print(json.load(sys.stdin)["errors"])')
check "no console errors" "$errs" "0"
done_
