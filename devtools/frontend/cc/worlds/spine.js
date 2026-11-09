// Execution spine world (D13 worlds/spine.js) on the shown run: a lens window on top (Architecture | Hardware | Split,
// 55% of the height, draggable) and the six execution bands below. The bands, the sample strip and the copies strip
// paint on one canvas (spine/bands.js; a run has tens of thousands of units); the play bounds, metric bracket, cursor,
// live mask and axis sit on an SVG above it, which takes the input. Wheel zooms time around the mouse, drag pans,
// double-click fits the play bounds. Each pane (architecture, hardware, the bands) zooms on its own.
import { state, subscribe, setTier, select, seek, now, store, storeError, metrics, metricInputs, ladders, DIM_COLOR, FLOW_COLOR } from "../control/control.js";
import { mountArch } from "../arch.js";
import { panZoom } from "../zoom.js";
import { perf } from "../perf.js";
import { roleOf, fmtValue, fmtSpan } from "../sidebar/samples.js";
import { Bands, BAND_COL } from "./spine/bands.js";
import { HardwareLens } from "./spine/hardware.js";

const NS = "http://www.w3.org/2000/svg";
const ms = (ns) => `${(ns / 1e6).toFixed(3)} ms`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const HWC = DIM_COLOR.hardware, ARC = DIM_COLOR.architecture;
const GL = 118, GR = 10, HEAD = 20, AXIS = 20, XFER = 12;
const MIN_VIEW_NS = 3000;   // D13's narrowest window (3 µs)
const MODES = [["arch", "Architecture"], ["hw", "Hardware"], ["split", "Split"]];

const CSS = `
.sp2 { position:absolute; inset:0; display:flex; flex-direction:column; background:#0b0e14; font:12px system-ui, sans-serif; }
.sp2 .lens { flex:none; display:flex; flex-direction:column; min-height:0; border-bottom:1px solid var(--line); background:var(--panel); }
.sp2 .lhead { display:flex; align-items:center; gap:8px; padding:3px 8px; border-bottom:1px solid var(--line); font:12px ui-monospace, monospace; }
.sp2 .lhead button { background:none; border:1px solid var(--line); color:var(--dim); font:inherit; padding:2px 10px; border-radius:4px; cursor:pointer; }
.sp2 .lhead button:hover { color:var(--text); }
.sp2 .lhead button.on { color:var(--text); background:#ffffff14; border-color:var(--dim); }
.sp2 .lhead .ctx { color:var(--dim); margin-left:6px; } .sp2 .lhead .note { margin-left:auto; color:#e3b341; }
.sp2 .lbody { flex:1; min-height:0; display:flex; }
.sp2 .pane { min-width:0; min-height:0; display:flex; flex-direction:column; }
.sp2 .pane .ptitle { flex:none; padding:2px 8px; font:11px ui-monospace, monospace; text-transform:uppercase; letter-spacing:.5px; }
.sp2 .pane .pbody { flex:1; min-height:0; overflow:auto; position:relative; }
.sp2 .pane .zc { position:absolute; inset:0; overflow:visible; }
.sp2 .pane .ztag { float:right; color:var(--dim); text-transform:none; letter-spacing:0; }
.sp2 .vdiv { flex:none; width:6px; cursor:col-resize; background:var(--line); }
.sp2 .hdiv { flex:none; height:6px; cursor:row-resize; background:var(--line); }
.sp2 .vdiv:hover, .sp2 .hdiv:hover { background:var(--dim); }
.sp2 .hwsvg { position:absolute; inset:0; width:100%; height:100%; display:block; }
.sp2 .hwsvg text { fill:#e8eef7; font-family:system-ui, sans-serif; font-size:.85px; dominant-baseline:central; pointer-events:none; }
.sp2 .hwsvg text.big { font-size:1.05px; font-weight:700; } .sp2 .hwsvg text.sub { font-size:.72px; fill:#a9b8cc; }
.sp2 .hwsvg text.tiny { font-size:.6px; fill:#a9b8cc; }
.sp2 .hwsvg text.dark { fill:#0a0f18; font-weight:700; }
.sp2 .hwsvg .pk { cursor:pointer; } .sp2 .hwsvg .pk:hover rect { filter:brightness(1.5); }
.sp2 .hwsvg .pk.sel rect { stroke:${ARC}; stroke-width:.22; }
.sp2 .flow { stroke-linecap:round; stroke-dasharray:.01 1.6; animation:spflow .9s linear infinite; }
@keyframes spflow { to { stroke-dashoffset:-1.61; } }
.sp2 .spine { flex:1; min-height:0; position:relative; }
.sp2 .spine canvas { position:absolute; inset:0; width:100%; height:100%; display:block; }
.sp2 .spine svg { position:absolute; inset:0; width:100%; height:100%; display:block; user-select:none; touch-action:none; }
.sp2 .spine svg.drag { cursor:grabbing; }
.sp2 .rl { position:absolute; left:4px; width:${GL - 10}px; display:flex; align-items:center; padding:0 6px; cursor:pointer; border-radius:4px;
  font:11.5px ui-monospace, monospace; text-transform:uppercase; letter-spacing:.3px; border-left:3px solid currentColor; background:#070a10; white-space:nowrap; overflow:hidden; }
.sp2 .rl:hover { background:#1a2333; } .sp2 .rl.on { font-weight:700; color:#fff !important; background:#ffffff1a; }
.sp2 .hl { position:absolute; top:0; left:${GL}px; right:${GR}px; height:${HEAD}px; display:flex; gap:12px; align-items:center; overflow:hidden;
  white-space:nowrap; font-size:11.5px; color:#a9b8cc; pointer-events:none; }
.sp2 .hl b { color:#fff; background:#ffffff14; padding:0 6px; border-radius:3px; }
.sp2 .axl { fill:#8a90a0; font:10.5px ui-monospace, monospace; dominant-baseline:central; }
.sp2 .legend { position:absolute; right:${GR}px; bottom:2px; font-size:11px; color:#a9b8cc; pointer-events:none; background:#0b0e14; padding:0 4px; }
.sp2 .legend span { margin-left:8px; font-weight:700; }
.sp2 .hl .hint { margin-left:auto; color:#5d6575; }
`;

const ls = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* none */ } } };
const svgEl = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  parent?.append(e); return e;
};
const set = (e, attrs) => { for (const k in attrs) e.setAttribute(k, attrs[k]); };
/** The smallest 1-2-5 step (ns) whose ticks sit more than `gap` px apart over a window of w ns drawn in px pixels. */
const tickStep = (w, px, gap = 90) => { const min = (gap * w) / px, p = 10 ** Math.floor(Math.log10(min)); return [1, 2, 5, 10].map((m) => m * p).find((s) => s > min); };
/** A tick label: seconds for steps of 100 ms and up, else ms as the headline shows t, with the decimals the step needs. */
function tickLabel(t, step) {
  const [k, u] = step >= 1e8 ? [1e9, "s"] : [1e6, "ms"];
  return `${(t / k).toFixed(Math.max(0, Math.ceil(-Math.log10(step / k) - 1e-9)))} ${u}`;
}
const isLive = (S) => !!S?.live && !S.live.ended;
const nowText = (v) => (Number.isNaN(v) ? "no sample now" : `${fmtValue(v, "%")} now`);

export function mount(el) {
  const key = (k) => `cc.spine.lens.${k}`;
  const root = document.createElement("div"); root.className = "sp2";
  root.innerHTML = `<style>${CSS}</style>
    <div class="lens"><div class="lhead">${MODES.map(([id, n]) => `<button data-mode="${id}">${n}</button>`).join("")}<span class="ctx"></span><span class="note"></span></div>
      <div class="lbody"></div></div>
    <div class="hdiv" title="drag to resize the lens"></div>
    <div class="spine"><canvas></canvas><svg><title></title></svg><div class="hl"></div><div class="legend">colour = flow:${Object.entries(FLOW_COLOR)
      .map(([f, c]) => `<span style="color:${c}">${esc(f)}</span>`).join("")}</div></div>`;
  el.append(root);
  const lensEl = root.querySelector(".lens"), lbody = root.querySelector(".lbody"), ctxEl = root.querySelector(".ctx");
  const spineEl = root.querySelector(".spine"), canvas = spineEl.querySelector("canvas"), g = canvas.getContext("2d");
  const svg = spineEl.querySelector("svg"), tip = svg.querySelector("title"), hl = spineEl.querySelector(".hl");

  // ---------------- lens window (D13): Architecture | Hardware | Split, each pane with its own zoom
  let lensMode = ls.get(key("tab"), "split"); if (!MODES.some(([m]) => m === lensMode)) lensMode = "split";
  let lensFrac = +ls.get(key("frac"), 0.55), splitFrac = +ls.get(key("split"), 0.5);
  if (!(lensFrac >= 0.12 && lensFrac <= 0.8)) lensFrac = 0.55;
  if (!(splitFrac >= 0.15 && splitFrac <= 0.85)) splitFrac = 0.5;
  const applyFrac = () => { lensEl.style.height = `${(lensFrac * 100).toFixed(1)}%`; };
  applyFrac();
  let archDispose = null, hw = null, zooms = [];
  const views = Object.fromEntries(["arch", "hw"].map((p) => {
    try { const v = JSON.parse(ls.get(key(`zoom.${p}`), "")); if (v && v.k > 0) return [p, v]; } catch { /* none saved */ }
    return [p, { k: 1, x: 0, y: 0 }];
  }));
  /** Give a pane its own zoom: the content moves inside the pane body; the title shows the zoom and how to reset. */
  function zoomable(pane, id, content) {
    const body = pane.querySelector(".pbody"), tag = document.createElement("span"); tag.className = "ztag";
    pane.querySelector(".ptitle").append(tag); body.style.overflow = "hidden"; body.append(content);
    zooms.push(panZoom(body, content, views[id], (v) => {
      tag.textContent = v.k === 1 && !v.x && !v.y ? "wheel zoom · drag pan" : `×${v.k.toFixed(1)} · double-click resets`;
      ls.set(key(`zoom.${id}`), JSON.stringify(v));
    }));
  }
  function buildLens() {
    archDispose?.(); archDispose = null; hw = null; lbody.replaceChildren();
    zooms.forEach((z) => z.dispose()); zooms = [];
    root.querySelectorAll(".lhead button").forEach((b) => b.classList.toggle("on", b.dataset.mode === lensMode));
    const pane = (title, color) => {
      const p = document.createElement("div"); p.className = "pane";
      p.innerHTML = `<div class="ptitle" style="color:${color}">${title}</div><div class="pbody"></div>`;
      lbody.append(p); return p;
    };
    let a = null;
    if (lensMode !== "hw") { a = pane("architecture", ARC); a.style.flex = "1"; }
    if (lensMode === "split") {
      const d = document.createElement("div"); d.className = "vdiv"; d.title = "drag to resize"; lbody.append(d);
      dragDivider(d, (e) => { const r = lbody.getBoundingClientRect(); splitFrac = Math.max(0.15, Math.min(0.85, (e.clientX - r.left) / r.width)); a.style.flex = `0 0 ${splitFrac * 100}%`; },
        () => ls.set(key("split"), splitFrac));
      a.style.flex = `0 0 ${splitFrac * 100}%`;
    }
    if (lensMode !== "arch") {
      const h = pane("hardware", HWC); h.style.flex = "1";
      const hwSvg = svgEl("svg", { class: "hwsvg", viewBox: "-22 -11.5 44 23", preserveAspectRatio: "xMidYMid meet" });
      zoomable(h, "hw", hwSvg);
      hw = new HardwareLens(hwSvg, h.querySelector(".ptitle").firstChild, () => drawHw(false));
    }
    if (a) {
      const c = document.createElement("div"); c.className = "zc"; zoomable(a, "arch", c);
      const r = mountArch(c, { size: "full" }); archDispose = typeof r === "function" ? r : null;
    }
  }
  root.querySelector(".lhead").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]"); if (!b || b.dataset.mode === lensMode) return;
    lensMode = b.dataset.mode; ls.set(key("tab"), lensMode); buildLens(); drawHw(true);
  });
  const drawHw = (force) => hw?.draw(store(), now(), force);
  function dragDivider(d, move, done) {
    d.addEventListener("pointerdown", (e) => {
      e.preventDefault(); d.setPointerCapture(e.pointerId);
      const mv = (ev) => move(ev), up = () => { d.removeEventListener("pointermove", mv); d.removeEventListener("pointerup", up); done(); };
      d.addEventListener("pointermove", mv); d.addEventListener("pointerup", up);
    });
  }
  dragDivider(root.querySelector(".hdiv"), (e) => {
    const r = root.getBoundingClientRect(); lensFrac = Math.max(0.12, Math.min(0.8, (e.clientY - r.top) / r.height)); applyFrac();
  }, () => ls.set(key("frac"), lensFrac));
  buildLens();

  // ---------------- spine: the canvas holds the bands, the SVG the marks over them; both follow one view [a, b] (ns)
  const bands = new Bands(), size = { w: 1, h: 1 }, view = { a: 0, b: 1 };
  const clip = svgEl("clipPath", { id: `spclip${Math.random().toString(36).slice(2, 8)}` }, svgEl("defs", {}, svg));
  const clipRect = svgEl("rect", {}, clip);
  const gClip = svgEl("g", { "clip-path": `url(#${clip.id})` }, svg);
  const shadeL = svgEl("rect", { fill: "#000", "fill-opacity": 0.38, "pointer-events": "none" }, gClip);
  const shadeR = svgEl("rect", { fill: "#000", "fill-opacity": 0.38, "pointer-events": "none" }, gClip);
  const bEdges = [0, 1].map(() => svgEl("line", { stroke: "#e3b341", "stroke-opacity": 0.7, "stroke-dasharray": "4 3", "pointer-events": "none" }, gClip));
  const brFill = svgEl("rect", { fill: "#fff", "fill-opacity": 0.06, "pointer-events": "none" }, gClip);
  const brPath = svgEl("path", { fill: "none", stroke: "#fff", "stroke-width": 2, "pointer-events": "none" }, gClip);
  const cursor = svgEl("line", { stroke: "#fff", "stroke-width": 1.5, "pointer-events": "none" }, gClip);
  const cursorGlow = svgEl("rect", { fill: "#fff", "fill-opacity": 0.08, "pointer-events": "none" }, gClip);
  // Live: everything past the head has not been recorded yet.
  const future = svgEl("rect", { fill: "#0b0f16", "fill-opacity": 0.82, "pointer-events": "none" }, gClip);
  const futureLbl = svgEl("text", { fill: "#ff7b72", "font-size": 12, "pointer-events": "none" }, gClip);
  const axisG = svgEl("g", {}, svg);
  const rowLabels = BAND_COL.map((c, i) => {
    const d = document.createElement("div"); d.className = "rl"; d.style.color = c; d.dataset.band = i;
    d.onclick = () => setTier("execution", i); spineEl.append(d); return d;
  });
  const sampleLbl = document.createElement("div"); sampleLbl.className = "rl"; sampleLbl.style.cssText = `color:${HWC};cursor:default;font-size:10.5px;text-transform:none`;
  sampleLbl.textContent = "samples"; spineEl.append(sampleLbl);
  const xferLbl = document.createElement("div"); xferLbl.className = "rl"; xferLbl.style.cssText = "color:#58d68d;cursor:default;font-size:10px;text-transform:none";
  xferLbl.textContent = "copies"; xferLbl.title = "copies: the run's memcpy and memset rows (hardware device stops)"; spineEl.append(xferLbl);

  /** @type {import("./spine/bands.js").Layout} */
  let L = { w: 1, h: 1, gl: GL, gr: GR, axis: AXIS, rows: [], sTop: HEAD, sH: 22, xTop: HEAD + 24, xferH: XFER };
  const X = (t) => GL + ((t - view.a) / (view.b - view.a)) * (size.w - GL - GR);
  const T = (x) => view.a + ((x - GL) / (size.w - GL - GR)) * (view.b - view.a);
  const cx = (x) => Math.max(GL - 20, Math.min(size.w + 20, x));

  function measure() {
    size.w = Math.max(200, spineEl.clientWidth); size.h = Math.max(120, spineEl.clientHeight);
    const sH = Math.max(22, Math.round(size.h * 0.14)), sTop = HEAD, xTop = sTop + sH + 2;
    const bandTop = xTop + XFER + 3, bandH = (size.h - bandTop - AXIS) / 6;
    L = { w: size.w, h: size.h, gl: GL, gr: GR, axis: AXIS, sTop, sH, xTop, xferH: XFER,
      rows: BAND_COL.map((_, i) => ({ y: bandTop + i * bandH + 1.5, h: Math.max(6, bandH - 3) })) };
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.w * dpr); canvas.height = Math.round(size.h * dpr);
    set(clipRect, { x: GL, y: 0, width: size.w - GL - GR, height: size.h });
    L.rows.forEach((r, i) => Object.assign(rowLabels[i].style, { top: `${r.y}px`, height: `${r.h}px` }));
    Object.assign(sampleLbl.style, { top: `${sTop}px`, height: `${sH}px` }); Object.assign(xferLbl.style, { top: `${xTop}px`, height: `${XFER}px` });
  }

  // ---------------- painting: the canvas and the marks, at most once per frame unless a state frame asks now
  let hover = -1, lit = new Set(), raf = 0, inputs = [];
  const frame = () => ({ a: view.a, b: view.b, t: state.t, tier: state.tiers.execution, sel: typeof state.sel === "number" ? state.sel : -1,
    pe: state.playEvent ?? -1, hover, lit, metric: lit.size > 0, head: state.head, live: isLive(store()) });
  function paint() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    const t0 = performance.now(), S = store(), dpr = canvas.width / size.w;
    bands.sync(S, S ? S.dims.ladders.execution : []);
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, size.w, size.h);
    bands.paint(g, L, frame());
    marks();
    const t1 = performance.now();
    perf.sample("spine_paint", t1 - t0);
    for (const [intent, ts] of inputs) perf.sample(`input:${intent}`, t1 - ts);
    inputs = [];
  }
  const requestPaint = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); }); };

  /** Play-bound shades and edges, the metric bracket, the axis, then the cursor and the live mask. */
  function marks() {
    const [b0, b1] = state.bounds, xb0 = cx(X(b0)), xb1 = cx(X(b1)), open = !!store();
    set(shadeL, { x: GL - 20, width: open ? Math.max(0, xb0 - GL + 20) : 0 });
    set(shadeR, { x: xb1, width: open ? Math.max(0, size.w - xb1) : 0 });
    for (const s of [shadeL, shadeR]) set(s, { y: L.sTop, height: size.h - L.sTop - AXIS });
    bEdges.forEach((e, i) => { const x = i ? xb1 : xb0; set(e, { x1: x, x2: x, y1: L.sTop, y2: size.h - AXIS, visibility: open ? "visible" : "hidden" }); });
    const span = metricSpan();
    brFill.style.display = brPath.style.display = span ? "" : "none";
    if (span) {
      const x0 = cx(X(span[0])), x1 = cx(X(span[1])), y = L.rows[0].y - 2;
      set(brFill, { x: x0, width: Math.max(1, x1 - x0), y, height: size.h - AXIS - y });
      brPath.setAttribute("d", `M${x0},${y + 8}V${y}H${x1}V${y + 8}`);
    }
    axisG.replaceChildren();
    if (open) {
      const step = tickStep(view.b - view.a, size.w - GL - GR);
      for (let k = Math.ceil(view.a / step); k * step <= view.b; k++) {
        const t = k * step, x = X(t); if (x < GL || x > size.w - GR - 470) continue;
        svgEl("line", { x1: x, x2: x, y1: size.h - AXIS, y2: size.h - AXIS + 4, stroke: "#5d6575" }, axisG);
        svgEl("text", { x: x + 3, y: size.h - AXIS / 2 + 1, class: "axl" }, axisG).textContent = tickLabel(t, step);
      }
    }
    placeCursor();
  }
  function placeCursor() {
    const S = store(), x = S ? X(state.t) : -100, y0 = L.sTop, y1 = size.h - AXIS;
    set(cursor, { x1: x, x2: x, y1: y0, y2: y1 });
    set(cursorGlow, { x: x - 4, width: 8, y: y0, height: y1 - y0 });
    const live = isLive(S), hx = Math.max(GL, X(state.head));
    set(future, { x: hx, y: 0, width: live ? Math.max(0, size.w - hx) : 0, height: size.h });
    set(futureLbl, { x: hx + 8, y: L.sTop + 14 }); futureLbl.textContent = live && size.w - hx > 140 ? "not recorded yet ▸" : "";
  }

  /** [start, end, metric] of the selected metric's input rows, or null. */
  function metricSpan() {
    const S = store(), mt = S && state.metric ? metrics().find((x) => x.id === state.metric) : null;
    if (!mt) return null;
    let a = Infinity, b = -Infinity;
    for (const id of mt.rows) if (id < S.N) { a = Math.min(a, S.startOf[id]); b = Math.max(b, S.endOf[id]); }
    return a <= b ? [a, b, mt] : null;
  }

  function headline() {
    const S = store(), span = metricSpan();
    if (!S) { hl.innerHTML = `<span>${esc(noRun())}</span>`; return; }
    if (span) {
      const m = span[2], req = m.request?.startsWith(`${S.run}-`) ? m.request.slice(S.run.length + 1) : m.request;
      hl.innerHTML = `<b>${esc(m.name)}: ${esc(fmtValue(m.value, m.unit))}${req ? ` · request ${esc(req)}` : ""} · ${m.rows.length} input row${m.rows.length === 1 ? "" : "s"} lit (aux.json)</b>`;
      return;
    }
    const n = now(), sm = roleOf(S, "sm_active"), dr = [roleOf(S, "dram_read"), roleOf(S, "dram_write")].filter((i) => i >= 0);
    const dram = dr.length ? dr.reduce((s, i) => s + n.sample[i], 0) : NaN;
    const samples = sm < 0 && !dr.length ? "samples: this run has no SMs-active or DRAM samples"
      : `samples, ${fmtSpan(S.samplePeriod(sm >= 0 ? sm : dr[0]))} state, never stops${sm >= 0 ? ` · fill: SMs active avg (${nowText(n.sample[sm])})` : ""}${dr.length ? ` · line: DRAM read + write (${nowText(dram)})` : ""}`;
    hl.innerHTML = `<span>t = ${ms(state.t)}</span><span style="color:${HWC}">${esc(samples)}</span>
      <span style="color:#e3b341">play bounds ${ms(state.bounds[0])} to ${ms(state.bounds[1])}</span><span class="hint">wheel zoom · drag pan · double-click fit</span>`;
  }
  /** Why no run is drawn: the open failed, a launch has no run yet, or the store is still opening. */
  function noRun() {
    const ss = state.session, err = storeError();
    if (ss.mode === "live" && ss.live?.dry_run) return "dry run: the runner started nothing, so there is no run to draw";
    if (!ss.run) return ss.mode === "live" ? "waiting for the launched job's run to start recording" : "no run is open";
    return err ? `the run did not open: ${err}` : `opening ${ss.run}`;
  }

  function onStructure() {
    const S = store(), L_ = ladders(), et = state.tiers.execution;
    lit = metricInputs();
    rowLabels.forEach((d, i) => {
      const n = L_?.execution?.[i] ?? "";
      d.textContent = `${i + 1} ${n}`; d.title = `zoom the bands to execution tier ${i + 1}${n ? ` (${n})` : ""}`; d.classList.toggle("on", i === et);
    });
    const sm = S ? roleOf(S, "sm_active") : -1;
    sampleLbl.title = S ? `samples, state not stops: fill ${sm >= 0 ? `${S.metrics[sm].label} avg (${fmtSpan(S.samplePeriod(sm))})` : "none (no SMs-active samples)"}, line DRAM read + write %` : "samples";
    ctxEl.textContent = L_ ? `bands at execution › ${L_.execution[et]} · hardware › ${L_.hardware[state.tiers.hardware]} · architecture › ${L_.architecture[state.tiers.architecture]}${state.paired ? "" : " (independent)"}` : "";
    headline();
  }

  // ---------------- view: follows the play bounds (or the metric span); wheel, drag and double-click
  let tween = 0;
  function fitTo([a, b], animate = true) {
    const pad = (b - a) * 0.06; a -= pad; b += pad;
    if (!(b > a)) { a -= 1; b += 1; }
    cancelAnimationFrame(tween);
    if (!animate) { view.a = a; view.b = b; return; }
    const fa = view.a, fb = view.b, t0 = performance.now();
    const go = (now_) => {
      const p = Math.min(1, (now_ - t0) / 220), e = p * p * (3 - 2 * p);
      view.a = fa + (a - fa) * e; view.b = fb + (b - fb) * e; paint();
      if (p < 1) tween = requestAnimationFrame(go);
    };
    tween = requestAnimationFrame(go);
  }
  const target = () => { const s = metricSpan(); return s ? [s[0], s[1]] : state.bounds; };
  const extentW = () => { const S = store(); return S ? Math.max(MIN_VIEW_NS, S.extent[1] - S.extent[0]) : 1; };
  svg.addEventListener("wheel", (e) => {
    e.preventDefault(); if (!store()) return;
    cancelAnimationFrame(tween);
    perf.sample("delivery:zoom", performance.now() - e.timeStamp); inputs.push(["zoom", e.timeStamp]);
    const r = svg.getBoundingClientRect(), tm = T(e.clientX - r.left), cur = view.b - view.a;
    // A fit can be narrower than the narrowest window (a sub-µs kernel) or wider than the widest; the wheel then only
    // moves toward the limit, so zooming in never widens the view.
    const w = Math.max(Math.min(MIN_VIEW_NS, cur), Math.min(Math.max(extentW() * 1.3, cur), cur * Math.exp(e.deltaY * 0.0015)));
    const k = w / cur;
    view.a = tm - (tm - view.a) * k; view.b = view.a + w; requestPaint();
  }, { passive: false });
  let drag = null;
  const at = (e) => { const r = svg.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  svg.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, a: view.a, b: view.b, moved: false }; svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (drag) {
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 4) return;
      drag.moved = true; svg.classList.add("drag"); cancelAnimationFrame(tween);
      perf.sample("delivery:pan", performance.now() - e.timeStamp); inputs.push(["pan", e.timeStamp]);
      const dt = (dx / (size.w - GL - GR)) * (drag.b - drag.a);
      view.a = drag.a - dt; view.b = drag.b - dt; requestPaint();
      return;
    }
    const [x, y] = at(e), h = store() ? bands.hit(L, frame(), x, y) : null, id = h ? h.id : -1;
    if (id === hover) return;
    hover = id; tip.textContent = h ? h.title : ""; svg.style.cursor = h ? "pointer" : ""; requestPaint();
  });
  svg.addEventListener("pointerleave", () => { if (hover < 0) return; hover = -1; tip.textContent = ""; svg.style.cursor = ""; requestPaint(); });
  svg.addEventListener("pointerup", (e) => {
    const d = drag; drag = null; svg.classList.remove("drag");
    if (!d || d.moved || !store()) return;
    const [x, y] = at(e);
    if (x < GL) return;
    const h = bands.hit(L, frame(), x, y);
    if (h) select(h.id); else seek(T(x));
  });
  svg.addEventListener("dblclick", () => { if (store()) fitTo(target()); });

  let lastTier = state.tiers.execution, lastStore, lastSpan = "";
  const ro = new ResizeObserver(() => { measure(); paint(); }); ro.observe(spineEl);
  measure();
  const unsub = subscribe((s, ch) => {
    const S = store(), opened = S !== lastStore; lastStore = S;
    const tierMoved = s.tiers.execution !== lastTier; lastTier = s.tiers.execution;
    // A metric from the URL is known before aux.json arrives; the view fits its span once the span exists.
    const span = metricSpan(), spanKey = span ? `${span[0]}:${span[1]}` : "", spanNew = !!span && spanKey !== lastSpan; lastSpan = spanKey;
    let dirty = false;
    if (opened || ch.rev || ch.sel || ch.metric || ch.tiers || ch.paired || ch.playEvent || ch.bounds || ch.world || ch.session) { onStructure(); dirty = true; }
    if (opened || ch.rev || ch.tiers || ch.sel) drawHw(true);
    if (S && (opened || tierMoved || ch.bounds || (ch.metric && s.metric) || spanNew)) { fitTo(target(), !ch.world && !opened); dirty = true; }
    else if (ch.metric) dirty = true;
    if (ch.t) { headline(); drawHw(false); dirty = true; } else if (ch.head) placeCursor();
    if (dirty) paint();
  });

  return () => {
    cancelAnimationFrame(tween); cancelAnimationFrame(raf); unsub(); ro.disconnect(); archDispose?.(); zooms.forEach((z) => z.dispose()); root.remove();
  };
}
