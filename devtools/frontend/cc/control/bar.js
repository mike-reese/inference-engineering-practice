// The bottom bar (COMMAND_CENTER.md 2.1, 7.1): D13's bar.js on the RunStore. Tabs over a body (inspector/tabs.js),
// history buttons, dock position, size and open state, the transport (step, play, pace, rate) and two strips: the run
// overview (the GPU utilization samples, the bounds, the cursor) and the timeline around the playback bounds (units
// of every execution tier, copies on the last row, the focused tier's stops, the selected metric's input rows, the
// play event, the cursor). Strips draw on a fixed width of VW units: ns from the run's t0 reach about 1e11, and
// Chromium drew nothing but x = 0 in a viewBox that wide, so times map onto 0..VW in float64 first.
import { state, subscribe, store, setDock, select, seek, step, selectMetric, goBack, goForward, now, tierName, stops, units, eventsIn,
  togglePlay, setPace, setRate, metricInputs, setWorld, loadRun, DIM_COLOR } from "./control.js";
import { TABS, unitText } from "../inspector/tabs.js";
import { openInNsight } from "../inspector/nsight.js";
import { roleOf, fmtSpan } from "../sidebar/samples.js";
import { runOf, esc } from "../session.js";

const ms = (ns, d = 3) => (ns / 1e6).toFixed(d);
const TIER_COLOR = ["#e0b84a", "#58b368", "#4a8fe0", "#9b6fd6", "#d6896f", "#e05a7a", "#7f8a96"];   // execution tiers, then copies
const rowY = (r) => 3 + 5 * r;
const RATES = [0.25, 0.5, 1, 2, 4];
const OLD_TAB = { selection: "selected", control: "run" };
const COPY_KINDS = new Set(["memcpy", "memset"]);
const TITLED = 1500;   // up to this many units in the window draw one rect each, with its name on hover; more merge per pixel
const OVER_PX = 600;   // overview sample columns
const PAD_MIN = 1000;  // ns: the least the detail strip shows on each side of the bounds
const VW = 10000;      // strip width in viewBox units

const CSS = `
#bar { display:flex; flex-direction:column; position:relative; font:12px/1.35 system-ui, sans-serif; background:var(--bg); }
#bar button, #bar select { font:inherit; cursor:pointer; }
.b-tabs { display:flex; flex-wrap:wrap; gap:4px; padding:4px 8px; border-bottom:1px solid var(--line); align-items:center; }
.b-tabs button, .b-transport button, .b-transport select { background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:5px; padding:1px 9px; }
.b-tabs button.on { border-color:#5e81ac; background:#5e81ac; color:#fff; }
.b-tabs .b-hist { padding:1px 7px; } .b-tabs .b-hist:disabled { opacity:.35; cursor:default; }
.b-tabs .b-hist + .b-hist { margin-right:8px; }
.b-tabs .sp { flex:1; min-width:0; color:var(--dim); font-size:11px; text-align:right; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.b-tabs .sp.bad { color:var(--down); }
.b-body { flex:1; min-height:0; overflow:auto; padding:6px 12px 10px; }
.b-transport { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:4px 8px 2px; border-top:1px solid var(--line); }
.b-transport button.on { border-color:#ffd36b; color:#ffd36b; }
.b-transport label { color:var(--dim); }
.b-grain { color:#9fc3ff; margin-left:6px; }
.b-tlabel { font-family:ui-monospace, monospace; font-size:12px; flex:1 1 0; min-width:120px; text-align:right; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.b-strips { padding:0 8px 6px; display:grid; gap:3px; }
.b-strips svg { width:100%; display:block; border-radius:3px; background:#101216; }
.b-over { height:14px; cursor:pointer; } .b-detail { height:40px; cursor:crosshair; touch-action:none; }
.b-strips line, .b-strips rect.mk { vector-effect:non-scaling-stroke; }
.b-grip { position:absolute; z-index:5; }
body.dock-bottom .b-grip { left:0; right:0; top:-3px; height:6px; cursor:ns-resize; }
body.dock-right .b-grip { top:0; bottom:0; left:-3px; width:6px; cursor:ew-resize; }
.b-grip:hover { background:#5e81ac; }
body.dock-closed .b-tabs, body.dock-closed .b-body, body.dock-closed .b-grip, body.dock-closed .b-over { display:none; }
body.dock-closed .b-detail { height:24px; }
body.dock-closed.dock-right #bar .b-strips, body.dock-closed.dock-right .b-transport > :not(.b-collapse) { display:none; }
body.dock-closed.dock-right .b-transport { border:0; padding:4px 2px; }
body.dock-bottom #bar { flex-direction:column; }
.b-body h3 { font-size:13px; margin:2px 0 6px; } .b-body p { margin:4px 0; }
.b-body .cols { display:grid; grid-template-columns:repeat(auto-fit, minmax(340px, 1fr)); gap:4px 20px; }
.b-body table { border-collapse:collapse; }
.b-body table.kv td { padding:1px 10px 1px 0; border-bottom:1px solid #22262e; white-space:nowrap; } .b-body table.kv td:first-child { color:var(--dim); }
.b-body table.kv td.wrap { white-space:normal; overflow-wrap:anywhere; }
.b-body table.rows { width:100%; }
.b-body table.rows th { text-align:left; color:var(--dim); font-weight:500; border-bottom:1px solid var(--line); padding:2px 8px 2px 0; position:sticky; top:-6px; background:var(--bg); white-space:nowrap; }
.b-body table.rows td { border-bottom:1px solid #22262e; padding:1px 8px 1px 0; vertical-align:top; }
.b-body tr.on td { background:#3a3220; } .b-body tr.sel td { box-shadow:inset 0 0 0 1px #fff; } .b-body tr.past td { color:#c5ccd6; }
.b-body tr[data-sel] { cursor:pointer; } .b-body tr[data-sel]:hover td { background:#ffffff0a; }
.b-body th.num { text-align:right; } .b-body td.num { text-align:right; font-family:ui-monospace, monospace; white-space:nowrap; }
.b-body code, .b-body pre { font-family:ui-monospace, monospace; font-size:11px; }
.b-body .tag { font-size:10px; padding:0 5px; border-radius:8px; border:1px solid var(--line); color:var(--dim); white-space:nowrap; }
.b-body button.b-open { background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:5px; padding:0 7px; font-size:11px; }
.b-body pre.fatal { color:var(--down); white-space:pre-wrap; }
.label { color:var(--dim); font-size:11px; text-transform:uppercase; margin:8px 0 4px; } .label:first-child { margin-top:0; }
.dim, .muted { color:var(--dim); }
a.go { color:#9fc3ff; cursor:pointer; text-decoration:none; } a.go:hover { text-decoration:underline; } a.go.on { color:#ffd36b; }
a.seek { color:#ffd36b; cursor:pointer; margin-left:3px; }
ol.path { margin:2px 0; padding-left:18px; } ol.path li::marker { color:var(--dim); }
.chips { display:flex; flex-wrap:wrap; gap:3px; margin-bottom:6px; } .chips span { background:#1d2633; border:1px solid #2d5a8a; border-radius:3px; padding:0 4px; font-size:11px; font-family:ui-monospace, monospace; }
pre.json, pre.payload { background:var(--panel); border:1px solid var(--line); border-radius:4px; padding:6px; max-height:30vh; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; margin:0 0 6px; }
table.sched td, table.sched th { padding:1px 6px; border-bottom:1px solid var(--line); text-align:left; }
table.metrics { width:100%; margin-top:6px; } table.metrics td, table.metrics th { text-align:left; padding:2px 8px 2px 0; border-bottom:1px solid var(--line); white-space:nowrap; }
table.metrics th { color:var(--dim); font-weight:normal; } table.metrics tr[data-m] { cursor:pointer; } table.metrics tr.on td { color:#9fc3ff; }
table.metrics tr.on td.inp a { color:#f778ba; }
.meter { display:inline-block; width:80px; height:6px; background:var(--line); border-radius:3px; overflow:hidden; vertical-align:middle; } .meter span { display:block; height:100%; background:#58a6ff; }
.card { background:var(--panel); border:1px solid var(--line); border-left:4px solid var(--up); border-radius:4px; padding:6px 8px; margin-top:6px; }
.card .title { font-weight:600; display:flex; gap:6px; align-items:center; } .card .state { margin-left:auto; font-weight:normal; color:var(--dim); }
.card .image { color:var(--dim); font-size:11px; }
.pdot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:4px; }
.segbar { display:flex; height:22px; margin:4px 0; } .seg { color:#0f1115; font-size:10px; overflow:hidden; cursor:pointer; padding-left:2px; white-space:nowrap; }
.seg.on { outline:2px solid #fff; outline-offset:-2px; }
.segleg { display:flex; flex-wrap:wrap; gap:4px 12px; font-size:11px; color:var(--dim); } .segleg i { display:inline-block; width:10px; height:10px; margin-right:4px; vertical-align:middle; }
.b-body details { border:1px solid var(--line); border-radius:6px; padding:6px; margin-bottom:8px; } .b-body summary { cursor:pointer; }
.b-cp { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:8px; }
.b-cp .ph { border:1px dashed var(--line); border-radius:6px; padding:8px; } .b-cp .ph b { display:block; }
.b-cp .ph .tg { color:var(--starting); font-size:11px; }
`;

const tabOf = (s) => TABS.find((t) => t.key === (OLD_TAB[s.dock.tab] ?? s.dock.tab)) ?? TABS[0];
const nameOf = (S, sel) => (typeof sel === "number" ? (sel < S.N ? S.nameText(S.field("name", sel)) : null) : S.things.find((x) => x.key === sel)?.name ?? null);

export function mountBar(el) {
  const css = document.createElement("style"); css.textContent = CSS; document.head.append(css);
  el.innerHTML = `<div class="b-grip" title="drag to resize"></div>
    <div class="b-tabs" role="tablist"><button data-act="hist-back" class="b-hist" aria-label="Back" title="back to the previous selection and tab ([)">←</button><button data-act="hist-fwd" class="b-hist" aria-label="Forward" title="forward again (])">→</button>${TABS.map((t) => `<button role="tab" data-act="tab" data-tab="${t.key}">${t.label}</button>`).join("")}
      <span class="sp"></span><button data-act="pos" class="b-pos"></button><button data-act="big" title="enlarge or shrink the bar" aria-label="enlarge or shrink the bar">⤢</button></div>
    <div class="b-body" role="tabpanel"></div>
    <div class="b-transport">
      <button class="b-collapse" data-act="open"></button>
      <button data-act="back" aria-label="Step back" title="previous stop of the focused tier (←)">◀</button>
      <button data-act="play" class="b-play" aria-label="Play"></button>
      <button data-act="next" aria-label="Step forward" title="next stop of the focused tier (→)">▶|</button>
      <label>pace <select class="b-pace" aria-label="Pace" title="events: visit every event in the bounds · time: real time across the bounds (T)">
        <option value="events">events</option><option value="time">time</option></select></label>
      <label>rate <select class="b-rate" aria-label="Rate">${RATES.map((r) => `<option value="${r}">×${r}</option>`).join("")}</select></label>
      <span class="b-grain"></span><span class="b-tlabel"></span></div>
    <div class="b-strips"><svg class="b-over" aria-label="Run overview" preserveAspectRatio="none"></svg>
      <svg class="b-detail" aria-label="Timeline" preserveAspectRatio="none"></svg></div>`;
  const $ = (q) => el.querySelector(q);
  const tabs = $(".b-tabs"), body = $(".b-body"), sp = $(".sp"), grip = $(".b-grip");
  const play = $(".b-play"), pace = $(".b-pace"), rate = $(".b-rate"), grain = $(".b-grain"), tlabel = $(".b-tlabel");
  const over = $(".b-over"), detail = $(".b-detail");
  let deps = null, win = [0, 1], ext = [0, 1], marks = null, size = { h: null, w: null }, drawnStore = null, againAt = 0;
  const say = (text, bad = false) => { sp.textContent = text; sp.classList.toggle("bad", bad); };

  el.addEventListener("mousedown", (e) => { if (e.target.closest("button")) e.preventDefault(); });
  el.addEventListener("click", (e) => {
    const wd = e.target.closest("[data-world]");
    if (wd) { e.stopPropagation(); setWorld(wd.dataset.world); return; }
    const sk = e.target.closest("[data-seek]");
    if (sk) { e.stopPropagation(); seek(Number(sk.dataset.seek)); return; }
    const op = e.target.closest("[data-open]");
    if (op) { e.stopPropagation(); const target = JSON.parse(op.dataset.open); say(`asking the runner to open ${target.path}…`); openInNsight(target).then((r) => say(r.message, !r.ok)); return; }
    const rw = e.target.closest("[data-raw]");
    if (rw) { e.stopPropagation(); loadRaw(Number(rw.dataset.raw)); return; }
    const rn = e.target.closest("[data-run]");
    if (rn) { e.stopPropagation(); loadRun(runOf(rn.dataset.run)?.rep ?? state.session.rep, rn.dataset.run); return; }
    const a = e.target.closest("[data-sel]");
    if (a) { e.stopPropagation(); select(a.dataset.sel); return; }
    const m = e.target.closest("[data-m]");
    if (m) { selectMetric(m.dataset.m); return; }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "tab") setDock({ tab: b.dataset.tab, open: true });
    else if (act === "pos") setDock({ pos: state.dock.pos === "bottom" ? "right" : "bottom" });
    else if (act === "big") setDock({ big: !state.dock.big });
    else if (act === "open") setDock({ open: !state.dock.open });
    else if (act === "hist-back") goBack();
    else if (act === "hist-fwd") goForward();
    else if (act === "play") togglePlay();
    else if (act === "back") step(-1);
    else if (act === "next") step(+1);
  });
  pace.onchange = () => { setPace(pace.value); pace.blur(); };
  rate.onchange = () => { setRate(Number(rate.value)); rate.blur(); };

  /** A row's raw record from the run folder (GET /raw), shown under its button. */
  async function loadRaw(id) {
    const S = store(), out = body.querySelector(`[data-raw-out="${id}"]`); if (!S || !out) return;
    out.hidden = false; out.textContent = "loading…";
    try {
      const r = await fetch(`${S.base}/raw?id=${id}`), j = await r.json();
      out.textContent = r.ok ? JSON.stringify(j.value ?? j, null, 1) : `HTTP ${r.status}: ${JSON.stringify(j)}`;
    } catch (err) { out.textContent = String(err); }
  }

  grip.addEventListener("pointerdown", (e) => {
    grip.setPointerCapture(e.pointerId);
    const right = state.dock.pos === "right";
    const move = (ev) => {
      if (right) size.w = `${Math.max(300, innerWidth - ev.clientX - 270)}px`; else size.h = `${Math.max(140, Math.min(innerHeight - 200, innerHeight - ev.clientY))}px`;
      applySize(state);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", () => grip.removeEventListener("pointermove", move), { once: true });
  });
  function applySize(s) {
    const root = document.documentElement.style;
    root.setProperty("--bar-h", s.dock.big ? "60vh" : size.h ?? "380px");
    root.setProperty("--bar-w", s.dock.big ? "62vw" : size.w ?? "440px");
  }

  // ---------------------------------------------------------------- strips
  const tAt = (svg, e, [a, b]) => { const r = svg.getBoundingClientRect(); return a + ((e.clientX - r.left) / r.width) * (b - a); };
  const lowerT = (t, x) => { let lo = 0, hi = t.length; while (lo < hi) { const k = (lo + hi) >>> 1; if (t[k] < x) lo = k + 1; else hi = k; } return lo; };
  const upperT = (t, x) => { let lo = 0, hi = t.length; while (lo < hi) { const k = (lo + hi) >>> 1; if (t[k] <= x) lo = k + 1; else hi = k; } return lo; };
  let drag = null;
  detail.addEventListener("pointerdown", (e) => { detail.setPointerCapture(e.pointerId); drag = { x: e.clientX, moved: false }; });
  detail.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x) > 2) drag.moved = true;
    if (drag.moved) seek(tAt(detail, e, win));
  });
  detail.addEventListener("pointerup", (e) => {
    if (!drag) return; const moved = drag.moved; drag = null;
    if (moved || !store()) return;
    const t = tAt(detail, e, win), r = detail.getBoundingClientRect(), pxPerNs = r.width / (win[1] - win[0]), st = stops();
    let best = -1;
    for (let k = Math.max(0, lowerT(st.t, t) - 1); k < st.t.length && k <= lowerT(st.t, t); k++) if (best < 0 || Math.abs(st.t[k] - t) < Math.abs(st.t[best] - t)) best = k;
    if (best >= 0 && st.t[best] >= win[0] && st.t[best] <= win[1] && Math.abs(st.t[best] - t) * pxPerNs <= 6) { select(st.ids[best]); seek(st.t[best]); } else seek(t);
  });
  over.addEventListener("click", (e) => { if (store()) seek(tAt(over, e, ext)); });

  /** The detail strip's window: the bounds and 10% of them on each side, at least PAD_MIN. (D13's floor, 1/2000 of
   *  its 3.4 ms timeline, is 46 ms on R1's 93 s and hid every layer and kernel.) */
  function windowOf(s) {
    const [b0, b1] = s.bounds, pad = Math.max((b1 - b0) * 0.1, PAD_MIN);
    return [b0 - pad, b1 + pad];
  }
  /** x on a strip: [a, b] in ns maps onto 0..VW. */
  const xOf = ([a, b]) => (t) => ((t - a) / (b - a)) * VW;
  /** The strip row of a row: its execution tier; copies and rows below the ladder on the last row. */
  const stripRow = (S, id) => {
    if (COPY_KINDS.has(S.kinds[S.field("kind", id)]?.name)) return 6;
    const e = S.dims.ex[id]; return e >= 0 ? e : S.dims.side[id] ? 5 : 6;
  };

  function drawStatic(s) {
    const S = store(); drawnStore = S;
    if (!S) { over.innerHTML = ""; detail.innerHTML = ""; marks = null; grain.textContent = ""; tlabel.textContent = "no run open"; return; }
    ext = [S.extent[0], Math.max(S.extent[1], S.extent[0] + 1)];
    const O = xOf(ext), [b0, b1] = s.bounds, col = DIM_COLOR[s.focus];
    // overview: GPU utilization samples (nvidia-smi, else the SMs-active metric), the bounds, the cursor
    const gi = roleOf(S, "gpu_util") >= 0 ? roleOf(S, "gpu_util") : roleOf(S, "sm_active");
    let smp = "";
    if (gi >= 0) {
      const { hi } = S.series(gi, ext, OVER_PX), cw = VW / OVER_PX;
      for (let k = 0; k < OVER_PX; k++) if (hi[k] > 0) { const f = Math.min(1, hi[k] / 100); smp += `<rect x="${k * cw}" width="${cw}" y="${14 - 13 * f}" height="${13 * f}" fill="#3fb950" opacity=".35"/>`; }
    }
    const bw = Math.max(VW / 600, O(b1) - O(b0));
    over.setAttribute("viewBox", `0 0 ${VW} 14`);
    over.innerHTML = `${smp}<rect x="${O(b0)}" width="${bw}" y="0" height="14" fill="#ffd36b" opacity=".22"/>
      <rect class="mk" x="${O(b0)}" width="${bw}" y="0.5" height="13" fill="none" stroke="#ffd36b" stroke-width="1"/>
      <line class="cur" x1="${O(s.t)}" x2="${O(s.t)}" y1="0" y2="14" stroke="#fff" stroke-width="1"/>
      <rect class="fut" x="${O(s.head)}" width="${Math.max(0, VW - O(s.head))}" y="0" height="14" fill="#0b0f16" opacity=".85"/>`;

    win = windowOf(s);
    const [a, b] = win, X = xOf(win), W = Math.max(200, Math.round(detail.getBoundingClientRect().width) || 1000);
    // units of every execution tier inside the window (copies on the last row): one rect each with its name, or
    // merged per pixel when there are more than TITLED
    const hits = [], L = S.dims.ladders.execution, K = L.indexOf("kernel");
    for (let e = 0; e < L.length; e++) {
      const u = units(e), hit = (k) => hits.push(u.ids[k], u.start[k], u.end[k], e === K && COPY_KINDS.has(S.kinds[S.field("kind", u.ids[k])]?.name) ? 6 : e);
      for (let k = lowerT(u.start, a - u.reach); k < u.start.length && u.start[k] <= b; k++) if (u.end[k] >= a) hit(k);
      for (const k of u.long) if (u.start[k] < a - u.reach && u.end[k] >= a) hit(k);
    }
    let rows = "";
    if (hits.length / 4 <= TITLED) {
      for (let h = 0; h < hits.length; h += 4) {
        const id = hits[h], x0 = X(Math.max(a, hits[h + 1])), r = hits[h + 3];
        const title = unitText(S, L[Math.min(r, K)], id);
        rows += `<rect x="${x0}" width="${Math.max(VW / 800, X(Math.min(b, hits[h + 2])) - x0)}" y="${rowY(r)}" height="3.5" fill="${TIER_COLOR[r]}" opacity=".85"><title>${esc(title)}</title></rect>`;
      }
    } else {
      const cover = Array.from(TIER_COLOR, () => new Uint8Array(W)), px = (t) => (X(t) / VW) * W;
      for (let h = 0; h < hits.length; h += 4) {
        const p0 = Math.max(0, Math.floor(px(hits[h + 1]))), p1 = Math.min(W, Math.max(p0 + 1, Math.ceil(px(hits[h + 2]))));
        cover[hits[h + 3]].fill(1, p0, p1);
      }
      cover.forEach((c, r) => { for (let p = 0; p < W; p++) if (c[p]) { const q = p; while (p < W && c[p]) p++; rows += `<rect x="${(q / W) * VW}" width="${((p - q) / W) * VW}" y="${rowY(r)}" height="3.5" fill="${TIER_COLOR[r]}" opacity=".85"/>`; } });
    }
    let lit = "";
    for (const id of metricInputs()) if (id < S.N && S.startOf[id] >= a && S.startOf[id] <= b) lit += `<rect x="${X(S.startOf[id])}" width="${Math.max(VW / 300, X(Math.min(b, S.endOf[id])) - X(S.startOf[id]))}" y="0" height="40" fill="#ff3df0" opacity=".22"/>`;
    // the focused tier's stops in the window; past a few per pixel, one line per pixel
    const st = stops(), k0 = lowerT(st.t, a), k1 = upperT(st.t, b), n = k1 - k0;
    let lines = "";
    if (n <= 4 * W) for (let k = k0; k < k1; k++) lines += `<line x1="${X(st.t[k])}" x2="${X(st.t[k])}" y1="0" y2="40" stroke="${col}" stroke-width="${n > 200 ? 1 : 2}" opacity=".9"/>`;
    else { let last = -1; for (let k = k0; k < k1; k++) { const p = Math.floor((X(st.t[k]) / VW) * W); if (p !== last) { last = p; lines += `<line x1="${(p / W) * VW}" x2="${(p / W) * VW}" y1="0" y2="40" stroke="${col}" stroke-width="1" opacity=".9"/>`; } } }
    const sel = typeof s.sel === "number" && s.sel < S.N ? S.startOf[s.sel] : null;
    detail.setAttribute("viewBox", `0 0 ${VW} 40`);
    detail.innerHTML = `<rect x="${X(b0)}" width="${X(b1) - X(b0)}" y="0" height="40" fill="#ffd36b" opacity=".08"/>
      <line x1="${X(b0)}" x2="${X(b0)}" y1="0" y2="40" stroke="#ffd36b" stroke-width="1.5"/><line x1="${X(b1)}" x2="${X(b1)}" y1="0" y2="40" stroke="#ffd36b" stroke-width="1.5"/>
      ${rows}${lit}${lines}
      ${sel != null && sel >= a && sel <= b ? `<line x1="${X(sel)}" x2="${X(sel)}" y1="0" y2="40" stroke="#fff" stroke-width="5" opacity=".35"/>` : ""}
      <g class="pe"></g>
      <line class="cur" x1="${X(s.t)}" x2="${X(s.t)}" y1="0" y2="40" stroke="#ffd36b" stroke-width="2"/>`;
    marks = { oc: over.querySelector(".cur"), fut: over.querySelector(".fut"), dc: detail.querySelector(".cur"), pe: detail.querySelector(".pe") };
    grain.textContent = `grain: ${s.focus} › ${tierName()} · ${n} in view · ${eventsIn().length} events in bounds`;
    grain.style.color = col;
  }

  function drawPlayEvent(s) {
    const S = store(), id = s.playEvent;
    if (!marks || !S) return;
    if (id == null || !(id < S.N) || S.endOf[id] < win[0] || S.startOf[id] > win[1]) { marks.pe.innerHTML = ""; return; }
    const X = xOf(win), x0 = X(Math.max(win[0], S.startOf[id])), r = stripRow(S, id);
    marks.pe.innerHTML = `<rect class="mk" x="${x0}" width="${Math.max(VW / 400, X(Math.min(win[1], S.endOf[id])) - x0)}" y="${rowY(r) - 1}" height="5.5" fill="none" stroke="#fff" stroke-width="1.5"/><line x1="${X(S.startOf[id])}" x2="${X(S.startOf[id])}" y1="0" y2="40" stroke="#3fb950" stroke-width="2"/>`;
  }

  function drawCursor(s) {
    const S = store();
    if (!marks || !S) return;
    const O = xOf(ext), X = xOf(win);
    marks.oc.setAttribute("x1", O(s.t)); marks.oc.setAttribute("x2", O(s.t));
    marks.fut.setAttribute("x", O(s.head)); marks.fut.setAttribute("width", Math.max(0, VW - O(s.head)));
    marks.dc.setAttribute("x1", X(s.t)); marks.dc.setAttribute("x2", X(s.t));
    const [b0, b1] = s.bounds, ev = s.playEvent != null && s.playEvent < S.N ? S.nameText(S.field("name", s.playEvent)) : null;
    tlabel.textContent = `${ms(s.t)} / ${ms(ext[1])} ms · bounds ${ms(b0)}–${ms(b1)} (${fmtSpan(b1 - b0)})${s.playing && ev ? ` · at ${ev}` : ""}`;
  }

  // ---------------------------------------------------------------- the open tab
  /** Render the open tab when its deps changed (or when forced: cold data it asked for arrived). True if rendered. */
  function render(force) {
    const s = state, tab = tabOf(s), d = [tab.key, ...tab.deps(s)];
    if (!force && deps && d.length === deps.length && d.every((v, i) => v === deps[i])) return false;
    const top = deps && deps[0] === d[0] ? body.scrollTop : 0; deps = d;
    try { tab.render(body, s, again); tab.tick?.(body, s); }
    catch (err) { console.error(`bar: ${tab.key}`, err); body.innerHTML = `<pre class="fatal">${esc(err.stack ?? err)}</pre>`; }
    body.scrollTop = top;
    return true;
  }
  function again() {
    if (againAt) return;
    againAt = requestAnimationFrame(() => { againAt = 0; if (state.dock.open) render(true); });
  }

  subscribe((s, ch) => {
    const tab = tabOf(s), S = store(), fresh = S !== drawnStore;
    if (ch.dock) {
      for (const b of tabs.querySelectorAll("[data-tab]")) { const on = b.dataset.tab === tab.key; b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on)); }
      $(".b-pos").textContent = s.dock.pos === "bottom" ? "dock → right" : "dock ↓ bottom";
      $(".b-collapse").textContent = s.dock.open ? "▾" : "▴"; $(".b-collapse").title = s.dock.open ? "collapse the bar" : "expand the bar";
      applySize(s);
    }
    if (ch.playing) { play.textContent = s.playing ? "⏸ pause" : "▶ play"; play.classList.toggle("on", s.playing); play.setAttribute("aria-label", s.playing ? "Pause" : "Play"); }
    if (ch.nav) { const [hb, hf] = tabs.querySelectorAll(".b-hist"); hb.disabled = !s.nav.back; hf.disabled = !s.nav.fwd; }
    if (ch.pace) pace.value = s.pace;
    if (ch.rate) rate.value = String(s.rate);
    const stat = fresh || ch.focus || ch.tiers || ch.bounds || ch.sel || ch.metric || ch.rev;
    if (stat) drawStatic(s);
    if (stat || ch.playEvent) drawPlayEvent(s);
    if (stat || ch.t || ch.playEvent || ch.playing || ch.head) drawCursor(s);
    if (ch.sel || fresh) { const name = S && s.sel != null ? nameOf(S, s.sel) : null; say(name != null ? `selected: ${name}` : ""); }
    if (!s.dock.open) { deps = null; return; }
    if (!render(false) && (ch.t || ch.sel)) tab.tick?.(body, s);
  });
}
