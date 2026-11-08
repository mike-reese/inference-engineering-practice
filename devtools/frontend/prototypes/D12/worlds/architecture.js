// Architecture world (owner, D12 variant 2): the v1 architecture drawing fills the stage. A thin execution strip under
// it keeps playback readable, and a beam ties the strip's current phase to its box in the drawing.
import { state, subscribe, select, seek, now, data, DIM_COLOR } from "../model.js";
import { mountArch } from "../arch.js";

const { EXEC, TRANSFERS, END, byId, FLOW_COLOR } = data;
const NS = "http://www.w3.org/2000/svg";
const GUTTER = 70, ROWS = [["request", 0], ["phase", 2], ["kernel", 5]], ROW_H = 18, ROW_GAP = 4, TOP = 14;
const KIND_COL = { gemm: "#ffb547", attn: "#ff6fae", mem: "#4fd1e8" };
const ms = (t) => `${(t / 1000).toFixed(2)} ms`;
const colorOf = (u) => u.tier === 5 ? KIND_COL[u.gpu.kind] : FLOW_COLOR[u.flow] ?? "#8a90a0";
const ancestor = (id, tier) => { let x = byId.get(id); while (x && x.tier > tier) x = byId.get(x.parent); return x?.tier === tier ? x.id : null; };

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

export function mount(stage) {
  if (!document.getElementById("aw-css")) {
    const s = document.createElement("style"); s.id = "aw-css"; s.textContent = CSS; document.head.append(s);
  }
  stage.innerHTML = `<div class="aw">
    <div class="main"></div><div class="strip"></div><svg class="beam"><path/><rect/><circle r="3"/></svg></div>`;
  const root = stage.querySelector(".aw"), main = root.querySelector(".main"), stripEl = root.querySelector(".strip");
  const beam = root.querySelector(".beam");
  let disposeMain = null, axisMode = "run";

  const archHost = document.createElement("div"); archHost.className = "arch"; main.append(archHost);
  disposeMain = mountArch(archHost, { size: "full" });

  // ---------------- execution strip: request, phase and kernel rows on one time axis
  const svg = document.createElementNS(NS, "svg"); stripEl.append(svg);
  let axis = [0, END], width = 1, rects = new Map(), cursorLine = null, boundsRect = null, loopText = null, peBand = null, lastLit = [];
  const X = (t) => GUTTER + ((t - axis[0]) / (axis[1] - axis[0])) * (width - GUTTER - 8);
  const T = (x) => axis[0] + ((x - GUTTER) / (width - GUTTER - 8)) * (axis[1] - axis[0]);
  const rowY = (i) => TOP + i * (ROW_H + ROW_GAP);

  function buildStrip() {
    width = Math.max(200, stripEl.clientWidth);
    axis = axisMode === "bounds" ? state.bounds : [0, END];
    const parts = [];
    ROWS.forEach(([name, tier], i) => {
      parts.push(`<text class="lbl" x="6" y="${rowY(i) + 12}">${name}</text>`);
      if (tier === 0) for (const u of EXEC.filter((x) => x.tier === 0)) parts.push(`<rect class="u" data-id="${u.id}" x="${X(Math.max(u.t0, axis[0]))}" y="${rowY(i) + 4}" width="${Math.max(1, X(Math.min(u.t1, axis[1])) - X(Math.max(u.t0, axis[0])))}" height="${ROW_H - 8}" fill="#3a4150"><title>${u.name}</title></rect>`);
      const units = tier === 0 ? EXEC.filter((u) => u.tier === 1) : EXEC.filter((u) => u.tier === tier);
      for (const u of units) {
        if (u.t1 < axis[0] || u.t0 > axis[1]) continue;
        const x0 = Math.max(GUTTER, X(u.t0)), x1 = Math.min(width - 8, X(u.t1));
        const half = tier === 2, y = rowY(i) + (half && u.flow === "f.out" ? ROW_H / 2 : 0);
        parts.push(`<rect class="u" data-id="${u.id}" x="${x0}" y="${y}" width="${Math.max(1, x1 - x0)}" height="${half ? ROW_H / 2 - 0.5 : ROW_H}" fill="${colorOf(u)}"><title>${u.name}</title></rect>`);
      }
      if (tier === 5) for (const x of TRANSFERS) {
        if (x.t1 < axis[0] || x.t0 > axis[1]) continue;
        parts.push(`<rect class="u" data-id="${x.id}" x="${X(x.t0)}" y="${rowY(i) + ROW_H - 5}" width="${Math.max(2, X(x.t1) - X(x.t0))}" height="5" fill="${DIM_COLOR.hardware}"><title>${x.what}</title></rect>`);
      }
    });
    parts.push(`<text class="tick" x="${GUTTER}" y="10">${ms(axis[0])}</text>`,
      `<text class="tick" x="${width - 8}" y="10" text-anchor="end">${ms(axis[1])}</text>`,
      `<text class="fit" x="6" y="10" data-fit="1">${axisMode === "run" ? "[fit]" : "[run]"}</text>`,
      `<rect class="bounds" y="${TOP - 3}" height="${3 * (ROW_H + ROW_GAP) + 2}"/>`,
      `<text class="loop" y="10"></text>`,
      `<rect class="peband" y="${TOP - 3}" height="2" width="0"/>`,
      `<line class="cursor" y1="${TOP - 4}" y2="${rowY(3)}"/>`);
    svg.innerHTML = parts.join("");
    rects = new Map([...svg.querySelectorAll("rect.u")].map((r) => [r.dataset.id, r]));
    cursorLine = svg.querySelector(".cursor"); boundsRect = svg.querySelector(".bounds"); loopText = svg.querySelector(".loop"); peBand = svg.querySelector(".peband");
    lastLit = []; paintBounds(); paintCursor();
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
    const n = now(), phase = n.exec[2];
    const lit = [[rects.get(phase?.id), "cur"], [rects.get(n.kernel?.id), "cur"], [rects.get(state.playEvent), "pe"], [rects.get(state.sel), "sel"]].filter(([r]) => r);
    lit.forEach(([r, c]) => r.classList.add(c)); lastLit = lit;
    const pe = byId.get(state.playEvent), band = peBand;
    band.setAttribute("x", pe ? X(pe.t0) : 0); band.setAttribute("width", pe ? Math.max(2, X(pe.t1) - X(pe.t0)) : 0);
    phaseRect = (state.tiers.architecture >= 5 && rects.get(n.kernel?.id)) || rects.get(phase?.id) || null;
  };
  svg.addEventListener("click", (e) => {
    if (e.target.dataset?.fit) { axisMode = axisMode === "run" ? "bounds" : "run"; return buildStrip(); }
    const id = e.target.dataset?.id;
    if (id) return select(id);
    const r = svg.getBoundingClientRect(), x = e.clientX - r.left;
    if (x >= GUTTER) seek(T(x));
  });
  const ro = new ResizeObserver(() => { buildStrip(); requestAnimationFrame(paintBeam); });
  ro.observe(stripEl); ro.observe(main);

  // ---------------- beam: current phase in the strip -> its box in the architecture view, at the architecture tier
  const [bPath, bRect, bDot] = beam.children;
  function targetEl() {
    const n = now(), tier = state.tiers.architecture, arch = main.querySelector(".arch");
    if (!arch) return null;
    const comp = n.comp, ids = tier >= 5 && n.kernel ? ["sw.device", comp] : tier >= 4 ? [comp]
      : tier === 3 ? [n.process, ancestor(comp, 2)] : [ancestor(comp, 2)];
    for (const id of ids) {
      const el = id && arch.querySelector(`[data-box="${id}"], [data-id="${id}"], [data-sel="${id}"]`);
      if (el) return { el, id };
    }
    return null;
  }
  function paintBeam() {
    const tg = targetEl();
    if (!tg || !phaseRect) { beam.style.visibility = "hidden"; return; }
    const av = main.getBoundingClientRect();
    let b = tg.el.getBoundingClientRect();
    if (b.top < av.top || b.bottom > av.bottom) { tg.el.scrollIntoView({ block: "nearest", inline: "nearest" }); b = tg.el.getBoundingClientRect(); }
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
    if (ch.bounds || ch.tiers) { if (axisMode === "bounds") buildStrip(); else paintBounds(); }
    if (ch.playing) paintBounds();
    if (ch.t || ch.playEvent || ch.sel || ch.tiers) paintCursor();
    queueMicrotask(paintBeam);
  });
  main.addEventListener("scroll", paintBeam, true);
  return () => { unsub(); ro.disconnect(); disposeMain?.(); };
}
