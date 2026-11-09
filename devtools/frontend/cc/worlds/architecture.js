// Architecture world (owner, D12 variant 2): the v1 architecture drawing fills the stage. A thin execution strip under
// it keeps playback readable, and a beam ties the strip's current phase to its box in the drawing.
// The strip draws the run's execution units: at most one rect per pixel column per lane, the unit that started last
// in that column on top, as D13's later rects cover earlier ones.
import { state, subscribe, select, seek, now, store, units, DIM_COLOR, FLOW_COLOR } from "../control/control.js";
import { mountArch } from "../arch.js";

const NS = "http://www.w3.org/2000/svg";
const GUTTER = 70, ROWS = ["request", "phase", "kernel"], ROW_H = 18, ROW_GAP = 4, TOP = 14;
const KIND_COL = { gemm: "#ffb547", attention: "#ff6fae", memory: "#4fd1e8" };   // keys: kinds.json kernel_class
const NONE_COL = "#8a90a0";
const ms = (t) => `${(t / 1e6).toFixed(2)} ms`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const attr = (s) => String(s).replace(/["\\]/g, "\\$&");

const CSS = `
.aw { position:absolute; inset:0; display:flex; flex-direction:column; }
.aw .main { flex:1; min-height:0; position:relative; }
.aw .arch { position:absolute; inset:0; overflow:hidden; }
.aw .strip { flex:none; height:90px; border-top:1px solid var(--line); background:#0b0e13; position:relative; }
.aw .strip svg { position:absolute; inset:0; width:100%; height:100%; cursor:crosshair; }
.aw .strip .lbl { fill:var(--dim); font-size:10px; text-transform:uppercase; }
.aw .strip .tick { fill:var(--dim); font-size:9.5px; }
.aw .strip .u { stroke:#0b0e13; stroke-width:.5; cursor:pointer; }
.aw .strip .u:hover { stroke:var(--text); stroke-width:1; }
.aw .strip .u.cur { stroke:#e3b341; stroke-width:1.5; }
.aw .strip .u.pe { stroke:#fff; stroke-width:2; }
.aw .strip .u.sel { stroke:${DIM_COLOR.architecture}; stroke-width:2; }
.aw .strip .bounds { fill:#e3b34114; stroke:#e3b34188; stroke-dasharray:3 3; pointer-events:none; }
.aw .strip .peband { fill:#fff; pointer-events:none; }
.aw .strip .cursor { stroke:#e3b341; stroke-width:1.5; pointer-events:none; }
.aw .strip .loop { fill:#e3b341; font-size:10px; pointer-events:none; }
.aw .strip .fit { fill:var(--dim); font-size:10px; cursor:pointer; } .aw .strip .fit:hover { fill:var(--text); }
.aw .beam { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; overflow:visible; }
.aw .beam path { fill:none; stroke:#e3b341; stroke-width:2; opacity:.75; }
.aw .beam rect { fill:none; stroke:#e3b341; stroke-width:2.5; rx:6; }
.aw .beam circle { fill:#e3b341; }
`;

/** The strip's lanes: D13's rows, each split where D13 drew two kinds of rect in one row. */
function lanesOf(S) {
  const flow = (id) => FLOW_COLOR[S.dims.flowOf(id)] ?? NONE_COL;
  const dev = new Set(S.dims.d.stops.hardware.device?.kinds ?? []), transfer = (id) => dev.has(S.kinds[S.field("kind", id)].name);
  const out = (id) => S.dims.flowOf(id) === "stream out";
  return [
    { row: 0, tier: "request", y: 4, h: ROW_H - 8, color: () => "#3a4150" },
    { row: 0, tier: "iteration", y: 0, h: ROW_H, color: flow },
    { row: 1, tier: "phase", y: 0, h: ROW_H / 2 - 0.5, color: flow, keep: (id) => !out(id) },
    { row: 1, tier: "phase", y: ROW_H / 2, h: ROW_H / 2 - 0.5, color: flow, keep: out },
    { row: 2, tier: "kernel", y: 0, h: ROW_H, color: (id) => KIND_COL[S.dims.kernelClass(id)] ?? NONE_COL, keep: (id) => !transfer(id) },
    { row: 2, tier: "kernel", y: ROW_H - 5, h: 5, min: 2, color: () => DIM_COLOR.hardware, keep: transfer },
  ].map((L) => ({ ...L, e: S.dims.ladders.execution.indexOf(L.tier), cols: null }));
}

export function mount(stage) {
  if (!document.getElementById("aw-css")) {
    const s = document.createElement("style"); s.id = "aw-css"; s.textContent = CSS; document.head.append(s);
  }
  stage.innerHTML = `<div class="aw">
    <div class="main"></div><div class="strip"></div><svg class="beam"><path/><rect/><circle r="3"/></svg></div>`;
  const root = stage.querySelector(".aw"), main = root.querySelector(".main"), stripEl = root.querySelector(".strip");
  const beam = root.querySelector(".beam");
  let axisMode = "run";

  const archHost = document.createElement("div"); archHost.className = "arch"; main.append(archHost);
  const disposeMain = mountArch(archHost, { size: "full" });

  // ---------------- execution strip: request, phase and kernel rows on one time axis
  const svg = document.createElementNS(NS, "svg"); stripEl.append(svg);
  let S = null, lanes = [], axis = [0, 1], width = 1, cursorLine = null, boundsRect = null, loopText = null, peBand = null, lastLit = [];
  const X = (t) => GUTTER + ((t - axis[0]) / (axis[1] - axis[0])) * (width - GUTTER - 8);
  const T = (x) => axis[0] + ((x - GUTTER) / (width - GUTTER - 8)) * (axis[1] - axis[0]);
  const rowY = (i) => TOP + i * (ROW_H + ROW_GAP);

  /** One lane's rects: per pixel column the unit that started last there; runs of one unit share a rect. */
  function laneRects(L, cols, parts) {
    if (L.e < 0) return;
    const u = units(L.e), owner = new Int32Array(cols).fill(-1);
    for (let k = 0; k < u.ids.length; k++) {
      if (u.start[k] > axis[1]) break;
      if (u.end[k] < axis[0]) continue;
      const id = u.ids[k]; if (L.keep && !L.keep(id)) continue;
      const c0 = Math.max(0, Math.min(cols - 1, Math.floor(X(Math.max(u.start[k], axis[0])) - GUTTER)));
      const c1 = Math.max(c0 + (L.min ?? 1), Math.min(cols, Math.ceil(X(Math.min(u.end[k], axis[1])) - GUTTER)));
      owner.fill(id, c0, Math.min(cols, c1));
    }
    const y = rowY(L.row) + L.y;
    for (let c = 0; c < cols;) {
      const id = owner[c]; let e = c + 1; while (e < cols && owner[e] === id) e++;
      if (id >= 0) parts.push(`<rect class="u" data-id="${id}" data-l="${lanes.indexOf(L)}" data-c="${c}" data-e="${e}" x="${GUTTER + c}" y="${y}" width="${e - c}" height="${L.h}" fill="${L.color(id)}"><title>${esc(S.nameText(S.field("name", id)))}</title></rect>`);
      c = e;
    }
  }

  function buildStrip() {
    S = store(); width = Math.max(200, stripEl.clientWidth);
    if (!S) { svg.innerHTML = ""; cursorLine = null; return; }
    lanes = lanesOf(S);
    axis = axisMode === "bounds" ? state.bounds : [S.extent[0], Math.max(S.extent[1], S.extent[0] + 1)];
    const cols = Math.max(1, Math.floor(width - GUTTER - 8)), parts = [];
    ROWS.forEach((name, i) => parts.push(`<text class="lbl" x="6" y="${rowY(i) + 12}">${name}</text>`));
    for (const L of lanes) laneRects(L, cols, parts);
    parts.push(`<text class="tick" x="${GUTTER}" y="10">${ms(axis[0])}</text>`,
      `<text class="tick" x="${width - 8}" y="10" text-anchor="end">${ms(axis[1])}</text>`,
      `<text class="fit" x="6" y="10" data-fit="1">${axisMode === "run" ? "[fit]" : "[run]"}</text>`,
      `<rect class="bounds" y="${TOP - 3}" height="${3 * (ROW_H + ROW_GAP) + 2}"/>`,
      `<text class="loop" y="10"></text>`,
      `<rect class="peband" y="${TOP - 3}" height="2" width="0"/>`,
      `<line class="cursor" y1="${TOP - 4}" y2="${rowY(3)}"/>`);
    svg.innerHTML = parts.join("");
    for (const L of lanes) L.cols = new Array(cols).fill(null);
    for (const r of svg.querySelectorAll("rect.u")) lanes[+r.dataset.l].cols.fill(r, +r.dataset.c, +r.dataset.e);
    cursorLine = svg.querySelector(".cursor"); boundsRect = svg.querySelector(".bounds"); loopText = svg.querySelector(".loop"); peBand = svg.querySelector(".peband");
    lastLit = []; paintBounds(); paintCursor();
  }
  /** The rect that shows row `id` in the strip (the one in its start column), or null when the strip has no lane for it. */
  function rectOf(id) {
    if (id == null || typeof id !== "number" || !S || id >= S.N) return null;
    const c = Math.floor(X(S.startOf[id]) - GUTTER);
    for (const L of lanes) if (L.cols && S.dims.ex[id] === L.e && (!L.keep || L.keep(id))) return L.cols[c] ?? null;
    return null;
  }
  const paintBounds = () => {
    if (!boundsRect) return;
    const [b0, b1] = state.bounds, x0 = Math.max(GUTTER, X(b0)), x1 = Math.min(width - 8, X(b1));
    boundsRect.setAttribute("x", x0); boundsRect.setAttribute("width", Math.max(1, x1 - x0));
    loopText.setAttribute("x", Math.min(x0 + 4, width - 200));
    loopText.textContent = state.playing ? `⟲ looping ${ms(b0)} – ${ms(b1)}` : "";
  };
  let phaseRect = null;
  const paintCursor = () => {
    if (!cursorLine) return;
    const x = X(state.t); cursorLine.setAttribute("x1", x); cursorLine.setAttribute("x2", x);
    lastLit.forEach(([r, c]) => r.classList.remove(c));
    const n = now(), phase = n.exec[S.dims.ladders.execution.indexOf("phase")];
    const lit = [[rectOf(phase?.id), "cur"], [rectOf(n.kernel?.id), "cur"], [rectOf(state.playEvent), "pe"], [rectOf(state.sel), "sel"]].filter(([r]) => r);
    lit.forEach(([r, c]) => r.classList.add(c)); lastLit = lit;
    const pe = state.playEvent;
    peBand.setAttribute("x", pe != null ? X(S.startOf[pe]) : 0); peBand.setAttribute("width", pe != null ? Math.max(2, X(S.endOf[pe]) - X(S.startOf[pe])) : 0);
    phaseRect = (state.tiers.architecture >= 5 && rectOf(n.kernel?.id)) || rectOf(phase?.id) || null;
  };
  svg.addEventListener("click", (e) => {
    if (e.target.dataset?.fit) { axisMode = axisMode === "run" ? "bounds" : "run"; return buildStrip(); }
    const id = e.target.dataset?.id;
    if (id) return select(id);
    const r = svg.getBoundingClientRect(), x = e.clientX - r.left;
    if (x >= GUTTER && S) seek(T(x));
  });
  const ro = new ResizeObserver(() => { buildStrip(); requestAnimationFrame(paintBeam); });
  ro.observe(stripEl); ro.observe(main);

  // ---------------- beam: current phase in the strip -> its box in the architecture view, at the architecture tier
  const [bPath, bRect, bDot] = beam.children;
  function targetEl() {
    const arch = main.querySelector(".v1arch");
    if (!arch || !S) return null;
    const n = now(), tier = state.tiers.architecture, P = S.dims.ladders.execution.indexOf("phase");
    const box = n.comp >= 0 ? S.things[n.comp]?.attrs?.key : null, lane = n.exec[P] ? S.field("lane", n.exec[P].id) : -1;
    const proc = n.process >= 0 ? S.things[n.process].key : null, cont = lane >= 0 ? S.things[S.dims.laneLevel.container[lane]]?.key : null;
    const boxSel = box && `[data-box="${attr(box)}"]`, contSel = cont && `.card[data-id="${attr(cont)}"], .network[data-id="${attr(cont)}"]`;
    const sels = tier >= 5 && n.kernel ? [`[data-layer="device code"]`, boxSel] : tier >= 4 ? [boxSel]
      : tier === 3 ? [proc && `[data-proc="${attr(proc)}"]`, contSel] : [contSel];
    for (const s of sels) { const el = s && arch.querySelector(s); if (el && el.getClientRects().length) return el; }
    return null;
  }
  function paintBeam() {
    const tg = targetEl();
    if (!tg || !phaseRect || !phaseRect.isConnected) { beam.style.visibility = "hidden"; return; }
    const av = main.getBoundingClientRect();
    let b = tg.getBoundingClientRect();
    if (b.top < av.top || b.bottom > av.bottom) { tg.scrollIntoView({ block: "nearest", inline: "nearest" }); b = tg.getBoundingClientRect(); }
    beam.style.visibility = "";
    const o = root.getBoundingClientRect(), p = phaseRect.getBoundingClientRect();
    const px = p.left + p.width / 2 - o.left, py = p.top - o.top;
    const bx = b.left + b.width / 2 - o.left, by = Math.min(b.bottom, av.bottom) - o.top;
    bRect.setAttribute("x", b.left - o.left - 2); bRect.setAttribute("y", b.top - o.top - 2);
    bRect.setAttribute("width", b.width + 4); bRect.setAttribute("height", b.height + 4);
    bPath.setAttribute("d", `M${px},${py} C${px},${py - 60} ${bx},${by + 60} ${bx},${by}`);
    bDot.setAttribute("cx", px); bDot.setAttribute("cy", py);
  }

  buildStrip();
  const unsub = subscribe((s, ch) => {
    if (ch.rev || store() !== S) buildStrip();
    else if (ch.bounds || ch.tiers) { if (axisMode === "bounds") buildStrip(); else paintBounds(); }
    if (ch.playing) paintBounds();
    if (ch.t || ch.playEvent || ch.sel || ch.tiers) paintCursor();
    queueMicrotask(paintBeam);
  });
  main.addEventListener("scroll", paintBeam, true);
  return () => { unsub(); ro.disconnect(); disposeMain?.(); };
}
