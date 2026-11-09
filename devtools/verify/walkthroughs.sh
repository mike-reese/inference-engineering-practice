#!/usr/bin/env bash
# Walkthroughs (COMMAND_CENTER.md section 5, and the sidebar check of 7.4 M1): drive the page at CC_URL in ccv on the
# hidden CCV-1 output, as a user does (keys, clicks, links), and check what it shows against sources outside the
# interface. I02A on R1: the run's latency.json, its client records, server stamps and nsys report (.sqlite). I02C:
# the run's readout.json. Row identities and the run clock (t0, wall offset) come from the store at CC_STORE.
# Usage: CC_URL=http://127.0.0.1:7711/static/cc/index.html CC_STORE=/mnt/ie-data/cc/store-cc devtools/verify/walkthroughs.sh
# R1 and I02C name the runs (defaults: 7.3's R1 and an imported I02C run). Exits 1 on any failed check.
#
# Clocks. The store puts every UTC source (pcap, nsys) on the run clock with the run's one wall offset (capture/
# clock.json); latency.json converts each request's wire times with that request's own client anchor pair. The two
# offsets differ by a few ns, so a wire time is expected at its latency.json value minus (wall offset - anchor
# offset). Engine times are float seconds: a hop matches within 1 ns.
set -u
cd "$(dirname "$0")/../.."   # repo root
export CCV_SESSION=${CCV_SESSION:-cc-walk-$$}
C=devtools/verify/ccv
URL=${CC_URL:-http://127.0.0.1:7710/static/cc/index.html}
export CCV_APP=${URL%%/static/*}
STORE=${CC_STORE:-/mnt/ie-data/cc/store}
R1=${R1:-I02A-TRACE-timeline_20261109T060522Z_ee2252}
I02C=${I02C:-I02C_20261107T181031Z_5626f7}
PY="uv run --no-sync python"
fail=0; n=0
ev() { $C eval "$1" | python3 -c 'import json,sys; v=json.load(sys.stdin).get("value"); print(v if isinstance(v,str) else json.dumps(v))'; }
check() { n=$((n+1)); if [ "$2" = "$3" ]; then echo "ok   $1 ($2)"; else echo "FAIL $1: got '$2' want '$3'"; fail=1; fi; }
# within TOL ns (times are ns on the run clock); an empty or null value never matches
near() { n=$((n+1)); if python3 -c 'import sys; a,b,t=sys.argv[1:4]; sys.exit(0 if a not in ("","null","None") and b not in ("","null","None") and abs(float(a)-float(b))<=float(t) else 1)' "$2" "$3" "$4"; then
  echo "ok   $1 ($2 ns, expected $3)"; else echo "FAIL $1: got '$2' want '$3' (within $4 ns)"; fail=1; fi; }
note() { echo "     $*"; }
get() { python3 -c 'import json,sys; v=json.loads(sys.argv[1])
for k in sys.argv[2:]: v = v[k] if isinstance(v, dict) else v[int(k)]
print("null" if v is None else json.dumps(v) if isinstance(v, (list, dict)) else v)' "$@"; }
url() { python3 -c 'import sys,urllib.parse; print(sys.argv[1]+"?r="+sys.argv[2]+"#"+urllib.parse.quote(sys.argv[3]))' "$URL" "$RANDOM" "$1"; }
ready() { $C wait --expr 'window.READY === true' --timeout 60000 >/dev/null || { echo "FAIL the page never opened its run"; fail=1; done_; }; }
open_view() { $C open "$(url "$1")" >/dev/null; ready; }
click() { $C click "$@" >/dev/null || { n=$((n+1)); echo "FAIL click $*"; fail=1; }; }
world() { click --css ".ch-nav button[data-w=$1]"; sleep 0.8; }
key() { $C key "$@" >/dev/null; sleep 0.25; }
# a view of a run: VIEW REP RUN WORLD [JSON merged on top]
VIEW() { python3 -c 'import json,sys; v={"session":{"mode":"replay","rep":sys.argv[1],"run":sys.argv[2]},"world":sys.argv[3],"focus":"execution","tiers":{"execution":2,"hardware":2,"architecture":4},"t":0,"sel":None,"dock":{"pos":"bottom","tab":"selected","open":True}}; v.update(json.loads(sys.argv[4])); print(json.dumps(v))' "$@"; }
# the selected row as the page holds it: [id, t, kind, name, request]
SELROW='import("./control/control.js").then((m) => { const S = m.store(), id = __cc.sel; return JSON.stringify(typeof id === "number" ? [id, __cc.t, S.kinds[S.field("kind", id)].name, S.nameText(S.field("name", id)), S.requests[S.field("req", id)] ?? null] : [id, __cc.t]); })'
done_() { local errs; errs=$($C console | python3 -c 'import json,sys; print(json.load(sys.stdin)["errors"])')
  check "no console errors" "$errs" "0"
  $C close >/dev/null; trap - EXIT; echo "$n checks, $([ $fail = 0 ] && echo all passed || echo FAILURES)"; exit $fail; }

# ---------------------------------------------------------------- expectations, from the store and the results files
EXPECT=$($PY - "$STORE" "$R1" "$I02C" <<'EOF'
import json, shlex, sqlite3, sys, tomllib
from pathlib import Path
import duckdb
store, r1, i02c = Path(sys.argv[1]) / "runs", sys.argv[2], sys.argv[3]
out = {}

def results(run):
    return next(Path("reps").glob(f"*/results/{run}"))

def manifest(run):
    return json.loads((store / run / "manifest.json").read_text())

def rows(run, where, params=()):
    """(id, start, eid) of the run's rows matching `where`, by (start, id)."""
    m = manifest(run)
    return duckdb.sql(f"select id, start, eid from read_parquet('{store / run / ('g%d' % m['generation'])}/events-*.parquet') "
                      f"where {where} order by start, id", params=list(params)).fetchall()

def rep_of(res):
    return json.loads((res / "labels.json").read_text()).get("rep") or res.parent.parent.name.split("_")[0]

# ---- I02A on R1: the rep's measured request (moments.toml `request`)
m, res = manifest(r1), results(r1)
moments = tomllib.loads((res.parent.parent / "moments.toml").read_text())
who = moments.get("request", "measured")
rid = next(r for r in m["requests"] if r.endswith(f"-{who}"))
req = m["requests"].index(rid)
lat = json.loads((res / "latency.json").read_text())[rid]
record = json.loads((res / "client" / f"{rid}.json").read_text())
t0 = m["t0_ns"]
clock_file = store / r1 / "capture" / "clock.json"
if not clock_file.is_file():
    sys.exit(f"{r1} has no capture/clock.json: its wall offset is unknown")
wall = json.loads(clock_file.read_text())["wall_offset_ns"]
anchor = record["anchor_pair"]["utc_ns"] - record["anchor_pair"]["monotonic_ns"]
corr = wall - anchor   # ns: the page's wire time = latency.json wire time - corr
send_ns = record["send_ns"] - t0
out |= {"R1_REP": rep_of(res), "MEAS": rid, "SEND_T": send_ns, "CORR": corr, "TTFT_NS": round(lat["client"]["ttft_ms"] * 1e6)}
out["SEND_EID"] = rows(r1, "req = ? and eid like 'client/sdk/%/send#0'", [req])[0][2]

# the TTFT split on the page: cumulative latency.json segments (ns from send), each boundary on its own clock
segs = lat["segments"][:7]
clocks = ["client", "wire", "engine", "engine", "engine", "engine", "wire", "client"]
cum = [0.0]
for s in segs: cum.append(cum[-1] + s["ms"] * 1e6)
bound = [c - (corr if k == "wire" else 0) for c, k in zip(cum, clocks)]
out["SEGS"] = json.dumps([[s["name"], s["ms"], bound[i], bound[i + 1]] for i, s in enumerate(segs)])

# the hops a phase walk passes from the send to the first token event: [label, kind, name pattern, ns from send, source]
stamp = next(s for s in map(json.loads, (res / "trace" / "server_stamps.jsonl").read_text().splitlines())
             if s.get("xrid") == rid and s.get("box") == "asgi" and s.get("name") == "response headers")
role = next(e for e in record["events"] if any((c.get("delta") or {}).get("role") for c in e["event"].get("choices", [])))
hops = [["request's last byte on the wire", "network frame", "^request body$", bound[1], "latency.json segments[0]"],
        ["headers sent by ASGI", "component stamp", "^response headers$", stamp["t0"] - t0 - send_ns, "trace/server_stamps.jsonl"],
        ["headers on the wire", "network frame", "^response headers$", lat["wire"]["headers_ms"] * 1e6 - corr, "latency.json wire.headers_ms"],
        ["headers at the client", "client event", "^response headers$", lat["client"]["headers_ms"] * 1e6, "latency.json client.headers_ms"],
        ["first token on the wire", "network frame", "^\\d+ token event", lat["wire"]["ttft_ms"] * 1e6 - corr, "latency.json wire.ttft_ms"],
        ["first body read", "client transport", "^body read$", lat["client"]["first_body_read_ms"] * 1e6, "latency.json client.first_body_read_ms"],
        ["role event", "client event", "^event: role$", role["ns"] - record["send_ns"], "client record events (the role delta)"],
        ["first token event", "client event", "^event: token$", lat["client"]["ttft_ms"] * 1e6, "latency.json client.ttft_ms"]]
out["HOPS"] = json.dumps(hops)

# the ASGI headers stamp: its row, and whether the worker's forward box (component things .../forward) is busy then
asgi = rows(r1, "req = ? and eid like 'stamp/asgi/%/response-headers#0'", [req])[0]
fwd = next(t for t in m["things"] if t["kind"] == "component" and t["key"].endswith("/forward"))
busy = rows(r1, "comp = ? and start <= ? and \"end\" > ?", [fwd["i"], asgi[1], asgi[1]])
nxt = rows(r1, "comp = ? and req = ? and start > ?", [fwd["i"], req, asgi[1]])
out |= {"ASGI_EID": asgi[2], "ASGI_T": int(asgi[1]), "ASGI_BOX": stamp["box"], "FWD_BOX": fwd["key"].rsplit("/", 1)[-1],
        "FWD_BUSY": "yes" if busy else "no", "FWD_NEXT_MS": f"{(nxt[0][1] - asgi[1]) / 1e6:.3f}" if nxt else "none"}
out["WIRE_HDR_EID"] = rows(r1, "req = ? and eid like 'wire/%/response-headers#0'", [req])[0][2]

# moments 1 to 4: the first row of the measured request whose name starts with the moment's event
names = [n[0] if isinstance(n, list) else n for n in m["names"]]   # a name is its text, or [text, ...]
mom = []
for x in moments["moments"][:4]:
    codes = [i for i, nm in enumerate(names) if nm.startswith(x["event"])]
    hit = rows(r1, f"req = ? and name in ({','.join(map(str, codes)) or '-1'})", [req])
    mom.append([x["id"], hit[0][0] if hit else None, int(hit[0][1]) if hit else None])
out["MOMENTS"] = json.dumps(mom)

# the nsys report: export time = run time + NSYS_SHIFT (the importer's rule, adapters/nsys.py)
db = sqlite3.connect(f"file:{res / 'trace' / 'timeline.sqlite'}?mode=ro", uri=True)
utc0 = db.execute("select utcEpochNs from TARGET_INFO_SESSION_START_TIME").fetchone()[0]
shift = out["NSYS_SHIFT"] = t0 + wall - utc0
out["NSYS_DB"] = str(res / "trace" / "timeline.sqlite")

# a cursor where the GPU is busy: the GPU metrics sample with the most DRAM read while the kernels the ncu tie names
# (tools.ncu.event_ids, iteration 67) run
ids = ",".join(map(str, m["tools"]["ncu"]["event_ids"]))
lo, hi = duckdb.sql(f"select min(start), max(\"end\") from read_parquet('{store / r1 / ('g%d' % m['generation'])}/events-*.parquet') where id in ({ids})").fetchall()[0]
dram = db.execute("select metricId from TARGET_INFO_GPU_METRICS where metricName = 'DRAM Read Bandwidth [Throughput %]'").fetchone()[0]
ts, v = db.execute("select timestamp, value from GPU_METRICS where metricId = ? and timestamp between ? and ? order by value desc, timestamp limit 1",
                   (dram, lo + shift, hi + shift)).fetchone()
out |= {"BUSY_T": ts - shift, "BUSY_READ": v}

# ---- I02C: readout.json clients on the run clock
mc, rc = manifest(i02c), results(i02c)
ro = json.loads((rc / "readout.json").read_text())
out |= {"C_REP": rep_of(rc), "C_GEN": mc["generation"],
        "CLIENTS": json.dumps({k: [v["request_id"], v["send_ns"] - mc["t0_ns"], None if v["first_content_ns"] is None else v["first_content_ns"] - mc["t0_ns"]]
                               for k, v in ro["clients"].items()})}
print("\n".join(f"{k}={shlex.quote(str(v))}" for k, v in out.items()))
EOF
) || { echo "FAIL expectations: could not read the store or the results files"; exit 1; }
eval "$EXPECT"
note "R1 $R1, request $MEAS; I02C $I02C; wire clock correction $CORR ns"

# The nsys report at run time T: the GPU state (the latest-starting kernel running, the copies and memsets in flight;
# starts on the run clock) and the GPU metrics sample the page reads at T (the last one at or before T).
nsys_at() { $PY - "$NSYS_DB" "$NSYS_SHIFT" "$1" <<'EOF'
import json, sqlite3, sys
db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
shift, t = int(sys.argv[2]), float(sys.argv[3])
x = t + shift
tables = {r[0] for r in db.execute("select name from sqlite_master where type = 'table'")}
held = lambda table: [s for (s,) in db.execute(f"select start from {table} where start <= ? and end > ? order by start", (x, x))] if table in tables else []
kernels = held("CUPTI_ACTIVITY_KIND_KERNEL")
copies = sorted(held("CUPTI_ACTIVITY_KIND_MEMCPY") + held("CUPTI_ACTIVITY_KIND_MEMSET"))
ids = dict(db.execute("select metricName, metricId from TARGET_INFO_GPU_METRICS"))
ts = db.execute("select max(timestamp) from GPU_METRICS where timestamp <= ?", (x,)).fetchone()[0]
val = lambda name: db.execute("select value from GPU_METRICS where timestamp = ? and metricId = ?", (ts, ids[name])).fetchone()[0]
print(json.dumps({"gpu": [kernels[-1] - shift if kernels else None, [c - shift for c in copies]], "sample": ts - shift,
                  "read": val("DRAM Read Bandwidth [Throughput %]"), "write": val("DRAM Write Bandwidth [Throughput %]")}))
EOF
}
# The page at its cursor: the GPU state the hardware world draws (now(): the kernel-tier unit running if it is a
# kernel, the transfers in flight), the sidebar's DRAM rows (raw sample value and text) and the chrome's hardware line.
PAGE_GPU='import("./control/control.js").then((m) => { const S = m.store(), n = m.now(), v = S.samplesAt(__cc.t);
  const kind = (id) => S.kinds[S.field("kind", id)].name;
  const raw = (name) => { const i = S.metrics.findIndex((x) => x.metric === name); return i < 0 ? null : v[i]; };
  const txt = (label) => [...document.querySelectorAll("#hw .hwrow")].find((r) => r.querySelector(".nm")?.textContent === label)?.querySelector(".val")?.textContent ?? null;
  return JSON.stringify({ t: __cc.t, gpu: [n.kernel && kind(n.kernel.id) === "kernel" ? n.kernel.t0 : null, n.transfers.map((x) => x.t0).sort((a, b) => a - b)],
    read: raw("DRAM Read Bandwidth [Throughput %]"), write: raw("DRAM Write Bandwidth [Throughput %]"), read_text: txt("DRAM read"), write_text: txt("DRAM write"),
    line: [...document.querySelectorAll(".ch-now .v")][1]?.textContent ?? null }); })'
pct() { python3 -c 'import sys; v=float(sys.argv[1]); print(f"{v:.1f} %" if v < 10 else f"{v:.0f} %")' "$1"; }
gpu_check() {   # LABEL: the page's GPU state and sidebar DRAM rows at its cursor against the nsys report
  local page nsys
  page=$(ev "$PAGE_GPU"); nsys=$(nsys_at "$(get "$page" t)")
  note "$1 at t = $(get "$page" t): hardware line \"$(get "$page" line)\"; nsys sample at $(get "$nsys" sample)"
  check "$1: GPU state [kernel running, copies in flight] = nsys report" "$(get "$page" gpu | tr -d ' ')" "$(get "$nsys" gpu | tr -d ' ')"
  check "$1: sidebar DRAM read = nsys GPU metrics of that 100 µs window" "$(get "$page" read)" "$(get "$nsys" read)"
  check "$1: sidebar DRAM write = nsys GPU metrics of that 100 µs window" "$(get "$page" write)" "$(get "$nsys" write)"
  check "$1: sidebar DRAM read text" "$(get "$page" read_text)" "$(pct "$(get "$nsys" read)")"
  check "$1: sidebar DRAM write text" "$(get "$page" write_text)" "$(pct "$(get "$nsys" write)")"
}

# ---------------------------------------------------------------- I02A on R1: which client time is the first token?
[ "$(python3 -c 'import json,sys; print(len(json.load(sys.stdin)["sessions"]))' < <($C sessions))" = 0 ] || { echo "stopped: another ccv session is open"; exit 1; }
$C launch --session "$CCV_SESSION" --size full --url "$(url "$(VIEW "$R1_REP" "$R1" rep '{}')")" >/dev/null || exit 1
trap '$C close >/dev/null 2>&1' EXIT
ready
check "R1 open" "$(ev '__cc.session.run')" "$R1"

# The Rep world's moments 1 to 4 jump to these points: each selects its event's first row and moves the cursor there.
k=0
for row in $(python3 -c 'import json,sys; [print(f"{x[0]}:{x[1]}:{x[2]}") for x in json.loads(sys.argv[1])]' "$MOMENTS"); do
  k=$((k+1)); IFS=: read -r id want_id want_t <<<"$row"
  world rep
  $C wait --css "#stage .rw [data-go=\"$id\"]" --timeout 30000 >/dev/null
  click --css "#stage .rw [data-go=\"$id\"]"; sleep 0.8
  check "moment $k ($id): show me selects the event's first row (store)" "$(ev '__cc.sel')" "$want_id"
  check "moment $k ($id): the cursor is at that row" "$(ev 'String(__cc.t)')" "$want_t"
  check "moment $k ($id): execution / phase in the spine" "$(ev '[__cc.world, __cc.focus, __cc.tiers.execution].join()')" "spine,execution,2"
done

# Execution / phase: from the request's send, step the hops to the client's first token event.
open_view "$(VIEW "$R1_REP" "$R1" spine "{\"sel\":{\"eid\":\"$SEND_EID\"}}")"
$C wait --expr 'typeof __cc.sel === "number"' --timeout 30000 >/dev/null
check "phase walk starts at the request's send (client record send_ns)" "$(ev 'String(__cc.t)')" "$SEND_T"
key e; key 3
walk=$(mktemp)
for _ in $(seq 400); do
  key ArrowRight
  r=$(ev "$SELROW"); echo "$r" >> "$walk"
  python3 -c 'import json,sys; sys.exit(0 if json.loads(sys.argv[1])[1] - int(sys.argv[2]) >= int(sys.argv[3]) else 1)' "$r" "$SEND_T" "$TTFT_NS" && break
done
note "phase walk: $(wc -l < "$walk") steps from the send to the first token event"
while IFS=$'\t' read -r label got want src; do
  near "phase hop: $label = $src" "$got" "$want" 1
done < <(python3 - "$walk" "$HOPS" "$SEND_T" "$MEAS" <<'EOF'
import json, re, sys
steps = [json.loads(l) for l in open(sys.argv[1])]
hops, send, rid = json.loads(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
for label, kind, name, want, src in hops:
    hit = next((s for s in steps if len(s) == 5 and s[2] == kind and re.search(name, s[3]) and s[4] == rid), None)
    print(f"{label}\t{'' if hit is None else hit[1] - send}\t{want}\t{src}")
EOF
)
rm -f "$walk"

# The Metrics tab's TTFT split: each segment equals latency.json; a click puts the cursor on the segment's start hop
# and selects its end hop, each on its own clock (the engine ones included).
click --css '.b-tabs [data-tab=metrics]'
$C wait --css '.segbar .seg[data-m]' --timeout 30000 >/dev/null
k=0
while IFS=$'\t' read -r name ms b0 b1; do
  k=$((k+1)); js=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "segment $k: $name")
  seg=$(ev "(() => { const s = [...document.querySelectorAll('.segbar .seg[data-m]')].find((x) => x.dataset.m.endsWith('/' + $js)); return s ? s.dataset.m : null; })()")
  check "TTFT split segment $k shown ($name)" "$([ "$seg" != null ] && echo yes || echo no)" "yes"
  [ "$seg" = null ] && continue
  jseg=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1], ensure_ascii=False))' "$seg")   # a JS string and a CSS one
  check "segment $k value = latency.json" "$(ev "import('./control/control.js').then((m) => String(m.metrics().find((x) => x.id === $jseg)?.value))")" "$ms"
  click --css ".segbar .seg[data-m=$jseg]"; sleep 0.4
  near "segment $k: cursor at its start hop" "$(ev "String(__cc.t - $SEND_T)")" "$b0" 1
  near "segment $k: its end hop selected" "$(ev "import('./control/control.js').then((m) => String(m.store().startOf[__cc.sel] - $SEND_T))")" "$b1" 1
done < <(python3 -c 'import json,sys; [print(f"{n}\t{ms}\t{b0}\t{b1}") for n, ms, b0, b1 in json.loads(sys.argv[1])]' "$SEGS")
$C shot walk-i02a-metrics >/dev/null

# One cursor, three answers, at the headers sent by ASGI: execution / phase, architecture / component (the ASGI box
# lights; the forward box is as busy as the store says), hardware / device (the GPU state equals the nsys report).
open_view "$(VIEW "$R1_REP" "$R1" architecture "{\"sel\":{\"eid\":\"$ASGI_EID\"}}")"
$C wait --expr 'typeof __cc.sel === "number"' --timeout 30000 >/dev/null
check "headers sent by ASGI: the cursor is at the stamp's row" "$(ev 'String(__cc.t)')" "$ASGI_T"
key a; key 5; sleep 0.5
check "architecture / component: the cursor stays" "$(ev 'String(__cc.t)')" "$ASGI_T"
on=$(ev '[...document.querySelectorAll("#stage .cbox.on")].map((g) => g.dataset.box).join(",")')
check "architecture / component: the $ASGI_BOX box lights (server_stamps.jsonl box)" "$(case ",$on," in *",$ASGI_BOX,"*) echo yes;; *) echo "no ($on)";; esac)" "yes"
check "architecture / component: the $FWD_BOX box is busy as the store says (a $FWD_BOX row spans the cursor)" "$(case ",$on," in *",$FWD_BOX,"*) echo yes;; *) echo no;; esac)" "$FWD_BUSY"
note "boxes lit: $on; the request's next $FWD_BOX row starts $FWD_NEXT_MS ms after the ASGI headers (store)"
$C shot walk-i02a-architecture >/dev/null
world stacked; key h; key 3; sleep 0.5
check "hardware / device: the cursor stays" "$(ev 'String(__cc.t)')" "$ASGI_T"
gpu_check "headers sent by ASGI"
$C shot walk-i02a-hardware >/dev/null

# The same crossing at the headers on the wire, and at a cursor where the GPU is busy (the sample with the most DRAM
# read while the ncu-tied kernels run): the GPU state and the sidebar's DRAM % equal the nsys report.
open_view "$(VIEW "$R1_REP" "$R1" stacked "{\"sel\":{\"eid\":\"$WIRE_HDR_EID\"}}")"
$C wait --expr 'typeof __cc.sel === "number"' --timeout 30000 >/dev/null
key h; key 3; sleep 0.5
gpu_check "headers on the wire"
open_view "$(VIEW "$R1_REP" "$R1" stacked "{\"t\":$BUSY_T}")"
key h; key 3; sleep 0.5
check "ncu-tied kernels, most DRAM read ($BUSY_READ %): the cursor is at the sample's time" "$(ev 'String(__cc.t)')" "$BUSY_T"
gpu_check "ncu-tied kernels, most DRAM read"
$C shot walk-i02a-busy >/dev/null

# ---------------------------------------------------------------- I02C: two requests in flight on one slot
open_view "$(VIEW "$C_REP" "$I02C" spine '{"tiers":{"execution":0,"hardware":2,"architecture":4}}')"
check "I02C open" "$(ev '__cc.session.run')" "$I02C"
key e; key 1
stops=$(mktemp); prev=""
for _ in $(seq 20); do
  key ArrowRight; r=$(ev "$SELROW")
  [ "$r" = "$prev" ] && break
  echo "$r" >> "$stops"; prev=$r
done
note "execution / request stops: $(python3 -c 'import json,sys; print(", ".join(str(json.loads(l)[4]) for l in open(sys.argv[1])))' "$stops")"
for who in $(python3 -c 'import json,sys; print(" ".join(json.loads(sys.argv[1])))' "$CLIENTS"); do
  IFS=$'\t' read -r rid send first <<<"$(python3 -c 'import json,sys; r,s,f=json.loads(sys.argv[1])[sys.argv[2]]; print(f"{r}\t{s}\t{f}")' "$CLIENTS" "$who")"
  stop=$(python3 -c 'import json,sys; print(next((l.strip() for l in open(sys.argv[1]) if json.loads(l)[4] == sys.argv[2]), ""))' "$stops" "$rid")
  check "I02C $who: a request stop" "$([ -n "$stop" ] && echo yes || echo no)" "yes"
  [ -z "$stop" ] && continue
  near "I02C $who: stop time = readout.json send_ns on the run clock" "$(get "$stop" 1)" "$send" 0
  open_view "$(VIEW "$C_REP" "$I02C" spine "{\"tiers\":{\"execution\":0,\"hardware\":2,\"architecture\":4},\"sel\":{\"id\":$(get "$stop" 0),\"generation\":$C_GEN},\"dock\":{\"pos\":\"bottom\",\"tab\":\"tokens\",\"open\":true}}")"
  $C wait --expr 'typeof __cc.sel === "number" && !!document.querySelector(".b-body p")' --timeout 30000 >/dev/null; sleep 0.5
  got=$(ev "import('./control/control.js').then((m) => { const r = document.querySelector('.b-body table.tokens tr[data-row]'); return r && r.dataset.row ? String(m.store().startOf[Number(r.dataset.row)]) : (document.querySelector('.b-body')?.textContent.includes('no client token events') ? 'null' : 'unread'); })")
  if [ "$first" = None ]; then check "I02C $who: no first content (readout.json first_content_ns is null)" "$got" "null"
  else near "I02C $who: first content = readout.json first_content_ns on the run clock" "$got" "$first" 0; fi
  $C shot "walk-i02c-$who" >/dev/null
done
rm -f "$stops"
done_
