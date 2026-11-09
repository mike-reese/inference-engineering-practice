// The spine's execution bands (D13 worlds/spine.js) on one canvas: a band per execution tier holding that tier's units
// (control.units), the copies strip (hardware / device stops) and the sample strip (SMs active and DRAM, the sidebar's
// roles). A run has up to tens of thousands of units (R1: 39,768 kernels), so a paint visits only the units in the
// window and merges sub-pixel units of one style into one rect. Colours, opacities, strokes and labels follow D13's
// CSS; hit() answers which unit a point is on, as D13's elementFromPoint did.
import { units, stops, FLOW_COLOR, DIM_COLOR } from "../../control/control.js";
import { assignLanes } from "./lanes.js";
import { decorate } from "./states.js";
import { NONE16 } from "../../store/columns.js";
import { roleOf } from "../../sidebar/samples.js";

export const BAND_COL = ["#5b8def", "#3fc1a5", "#9aa7b8", "#c792ea", "#e6c86e", "#ff6fae"];
/** kinds.json kernel_class -> colour; D13 drew gemm, attention and memory, the registry adds other. */
export const CLASS_COL = { gemm: "#ffb547", attention: "#ff6fae", memory: "#4fd1e8", other: "#888888" };
export const NO_FLOW = "#888888";
const COPY = "#58d68d", HWC = DIM_COLOR.hardware;
export const LABEL_MIN_PX = 34, CHAR_PX = 7;
const COPY_MIN_PX = 3;
const MIN_LANE = 14, MAX_LANE = 36, ROW_GAP = 3, LABEL_MIN_H = 9;
const LANE_GAP = 2;
/** Where a lane of a row is drawn: [y, h]. The painter, the hit test and the layout report all place boxes with it. */
export const laneBox = (R, lane) => [R.y + lane * R.lh, R.lh - LANE_GAP];

const shade = (hex, k) => {
  const n = parseInt(hex.slice(1), 16), f = (v) => Math.round(Math.min(255, v * k)).toString(16).padStart(2, "0");
  return `#${f(n >> 16)}${f((n >> 8) & 255)}${f(n & 255)}`;
};
/** Palette: every colour a unit can take, and its shaded twin (D13 shades every other unit of a tier by 0.82). */
const PAL = [...new Set([...Object.values(FLOW_COLOR), NO_FLOW, ...BAND_COL, ...Object.values(CLASS_COL), COPY])];
const PAL_SHADE = PAL.map((c) => shade(c, 0.82));
const pal = (c) => PAL.indexOf(c);

const lowerT = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const k = (lo + hi) >>> 1; if (a[k] < x) lo = k + 1; else hi = k; } return lo; };
const upperT = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const k = (lo + hi) >>> 1; if (a[k] <= x) lo = k + 1; else hi = k; } return lo; };

/**
 * @typedef {{ids: Uint32Array, start: Float64Array, end: Float64Array, reach: number, long: Uint32Array}} Spans
 *   units by start (store/units.js TierUnits); reach: the longest duration outside `long` (indexes of longer ones)
 * @typedef {{i: number, name: string, u: Spans, col: Uint8Array, lane: Uint16Array, lanes: number, alt: Uint8Array,
 *   minW: number, head: number, weight: number, parts: (k: number, y: number, h: number) => number[][], label: ((k: number) => string) | null,
 *   title: (k: number, at: any) => string, draw?: Function, drawHead?: Function, stripLane?: Int32Array}} Row
 *   one row of boxes (an execution band, i its tier; or the copies strip, i -1). col: palette index per unit;
 *   lane: per unit, from assignLanes; alt: 1 on every other unit of a lane (drawn shaded); head: px above the lanes;
 *   weight: the row's lane height in shared lane heights; parts: the boxes unit k is drawn as, [start, end, y, h]
 *   each, inside its lane box [y, y + h]; draw, drawHead, stripLane: set by states.js on the request and iteration rows
 * @typedef {{top: number, y: number, h: number, lh: number}} Box   a row's place: y is lane 0's top, lh the lane height
 * @typedef {{w: number, h: number, gl: number, gr: number, axis: number, sTop: number, sH: number,
 *   clipTop: number, clipBot: number, rows: Box[]}} Layout   rows: one Box per Bands.rows() entry
 * @typedef {{a: number, b: number, t: number, tier: number, sel: number, selLayer: boolean, pe: any, hover: number, lit: Set<number>,
 *   metric: boolean, head: number, live: boolean}} Frame
 */

/** Visit the spans overlapping [a, b] in start order (D13's draw order): long ones that start before the scan first. */
export function eachVisible(L, a, b, fn) {
  const from = a - L.reach;
  for (const k of L.long) if (L.start[k] < from && L.end[k] >= a) fn(k);
  for (let k = lowerT(L.start, from), n = L.start.length; k < n && L.start[k] <= b; k++) if (L.end[k] >= a) fn(k);
}

/** Unit labels by tier name; any other tier shows the row's short name. */
const LABEL = {
  request: (S, id) => { const r = S.field("req", id), q = r === NONE16 ? null : S.requests[r];
    return q ? `request ${q.startsWith(`${S.run}-`) ? q.slice(S.run.length + 1) : q}` : S.nameText(S.field("name", id)); },
  iteration: (S, id) => { const f = S.dims.flowOf(id), n = S.nameText(S.field("name", id)); return f ? `${n}: ${f}` : n; },
  layer: (S, id) => `layer ${S.field("layer", id)}`,
  module: (S, id) => { const n = S.nameText(S.field("name", id)); return n.slice(n.lastIndexOf("/") + 1); },
};
export const unitLabel = (S, tierName, id) => (LABEL[tierName] ?? ((s, x) => s.nameText(s.field("name", x))))(S, id);
const copyLabel = (S, id) => { const b = S.field("bytes", id); return `${S.nameText(S.field("name", id))}${Number.isNaN(b) ? "" : `: ${b} B`}`; };

export class Bands {
  constructor() { /** @type {Row[]} */ this.bands = []; /** @type {Row | null} */ this.copies = null; this.S = null; this.copyKey = null; this.laneMode = "request"; }

  setLaneMode(mode) { this.laneMode = mode; this.bands = []; }

  /** Rebuild each band whose units changed (another store, a live merge, a seal); units() caches per store revision. */
  sync(S, ladder) {
    if (S !== this.S) { this.S = S; this.bands = []; this.copies = null; this.copyKey = null; this.cls = new Map(); }
    if (!S) return;
    ladder.forEach((name, i) => { const u = units(i); if (this.bands[i]?.u !== u) this.bands[i] = decorate(this, S, this.band(S, i, name, u)); });
    this.bands.length = ladder.length;
    const dev = S.dims.ladders.hardware.indexOf("device"), st = dev >= 0 ? stops("hardware", dev) : null;
    if (st !== this.copyKey) {
      this.copyKey = st;
      const ids = st?.ids ?? new Uint32Array(0), start = st?.t ?? new Float64Array(0), end = Float64Array.from(ids, (id) => S.endOf[id]);
      let reach = 0; for (let k = 0; k < ids.length; k++) reach = Math.max(reach, end[k] - start[k]);
      const u = { ids, start, end, reach, long: new Uint32Array(0) };
      this.copies = { i: -1, name: "copies", ...this.row(u, new Uint8Array(ids.length).fill(pal(COPY)), COPY_MIN_PX, null, (k) => copyLabel(S, ids[k])) };
    }
  }

  /** A row of boxes: its units, each on the lane the stacking rule gives it. */
  row(u, col, minW, label, title) {
    const { lane, lanes } = assignLanes(u.start, u.end, col), seen = new Uint32Array(lanes);
    const parts = (k, y, h) => [[u.start[k], u.end[k], y, h]];
    return { u, col, lane, lanes, alt: Uint8Array.from(lane, (l) => seen[l]++ & 1), minW, head: 0, weight: 1, parts, label, title };
  }

  /** @returns {Row} */
  band(S, i, name, u) {
    const n = u.ids.length, col = new Uint8Array(n);
    const flowPal = S.dims.flowNames.map((f) => pal(FLOW_COLOR[f] ?? NO_FLOW)), none = S.dims.FLOW_NONE;
    const byFlow = name === "iteration" || name === "phase", kernel = name === "kernel", fixed = pal(BAND_COL[i] ?? NO_FLOW);
    for (let k = 0; k < n; k++) {
      const id = u.ids[k];
      if (byFlow) { const f = S.field("flow", id); col[k] = f === none ? pal(NO_FLOW) : flowPal[f]; }
      else if (kernel) col[k] = this.kernelPal(S, id);
      else col[k] = fixed;
    }
    const inferred = S.kinds.find((c) => c.name === "inferred module")?.code;
    const title = (k) => `${unitLabel(S, name, u.ids[k])}${S.field("kind", u.ids[k]) === inferred ? " (inferred, M2)" : ""}`;
    return { i, name, ...this.row(u, col, 1, (k) => unitLabel(S, name, u.ids[k]), title) };
  }

  /** The kernel class colour, cached per (kind, name): dims.kernelClass runs regexes. */
  kernelPal(S, id) {
    const key = S.field("kind", id) * 2 ** 32 + S.field("name", id);
    let c = this.cls.get(key);
    if (c === undefined) this.cls.set(key, (c = pal(CLASS_COL[S.dims.kernelClass(id)] ?? NO_FLOW)));
    return c;
  }

  /** Every row of boxes, top to bottom: the copies strip, then the bands. */
  rows() { return this.copies ? [this.copies, ...this.bands] : []; }

  /** Stack the rows from 0 down: a row is its head plus one lane height per lane. A row's lane height is its weight
   *  times the shared one: what fills `avail`, held between MIN_LANE and MAX_LANE, so the total can exceed `avail`
   *  (the caller scrolls).
   *  @returns {Box[]} */
  layout(avail) {
    const rows = this.rows(), count = (b) => Math.max(1, b.lanes);
    const fixed = rows.reduce((s, b) => s + b.head + ROW_GAP, 0), total = rows.reduce((s, b) => s + count(b) * b.weight, 0);
    const shared = Math.max(MIN_LANE, Math.min(MAX_LANE, (avail - fixed) / total));
    let top = 0;
    return rows.map((b) => { const lh = shared * b.weight, h = b.head + count(b) * lh, box = { top, y: top + b.head, h, lh }; top += h + ROW_GAP; return box; });
  }

  /** Paint the sample strip, then every row's track, units and labels for the window [f.a, f.b].
   *  @param {CanvasRenderingContext2D} g @param {Layout} L @param {Frame} f */
  paint(g, L, f) {
    const S = this.S, x0 = L.gl, xw = L.w - L.gl - L.gr, X = (t) => x0 + ((t - f.a) / (f.b - f.a)) * xw;
    const cx = (x) => Math.max(x0 - 20, Math.min(L.w + 20, x)), clip = [x0, x0 + xw];
    g.save();
    g.beginPath(); g.rect(x0, 0, xw, L.h); g.clip();
    if (S) this.samples(g, L, f, X, cx);
    g.beginPath(); g.rect(x0, L.clipTop, xw, L.clipBot - L.clipTop); g.clip();
    this.litDrawn = new Set();
    this.rows().forEach((band, j) => {
      const R = L.rows[j];
      g.globalAlpha = 1; g.fillStyle = band.i === f.tier ? "#ffffff14" : "#ffffff08"; g.fillRect(x0, R.top, xw, R.h);
      if (!band.u.ids.length) { this.note(g, x0 + 8, R.top + R.h / 2, `missing: this run has no ${band.name} rows`); return; }
      if (band.head) band.drawHead(g, f, X, cx, clip, band, R);
      if (band.draw) band.draw(this, g, f, X, cx, clip, band, R); else this.spans(g, f, X, cx, clip, band, R);
    });
    if (S && f.metric) this.instants(g, L, f, X);
    g.restore();
  }

  /** Metric inputs that are no unit of any band (instants such as arrival_time) light as a tick across the rows. */
  instants(g, L, f, X) {
    const S = this.S;
    g.globalAlpha = 1; g.fillStyle = "#fff";
    for (const id of f.lit) {
      const t = S.startOf[id];
      if (!this.litDrawn.has(id) && t >= f.a && t <= f.b) g.fillRect(X(t) - 0.75, L.clipTop, 1.5, L.clipBot - L.clipTop);
    }
  }

  note(g, x, y, s) { g.globalAlpha = 1; g.fillStyle = "#5d6575"; g.font = "11px system-ui, sans-serif"; g.textAlign = "left"; g.textBaseline = "middle"; g.fillText(s, x, y); }

  /**
   * One row's units, each in its lane's box (laneBox). Base pass: every unit not raised, sub-pixel neighbours of one style
   * and lane merged, at the row's opacity (D13: .5, .85 on the tier's own band, .22 while a metric is selected).
   * Raised pass: the units the cursor is in, the hovered, selected, played and metric-lit ones, with D13's opacity
   * and stroke. Then labels.
   */
  spans(g, f, X, cx, [xmin, xmax], band, R) {
    const u = band.u, y = (lane) => laneBox(R, lane)[0], h = laneBox(R, 0)[1];
    const base = f.metric ? 0.22 : band.i === f.tier ? 0.85 : 0.5;
    const runs = new Map(), raised = [], labels = [];
    eachVisible(u, f.a, f.b, (k) => {
      const s = u.start[k], e = u.end[k], id = u.ids[k], xa = cx(X(s)), w = Math.max(band.minW, cx(X(e)) - xa);
      const on = band.i >= 0 && s <= f.t && f.t < e, sel = id === f.sel && (band.name === "layer") === f.selLayer, pe = id === f.pe, hov = id === f.hover, lit = f.lit.has(id);
      const c = band.col[k], shaded = w >= 2 && band.alt[k] === 1;
      if (lit) this.litDrawn.add(id);
      if (on || sel || pe || hov || lit) raised.push([k, xa, w, c, shaded, sel, pe, hov, lit]);
      else {
        const key = (c * 2 + (shaded ? 1 : 0)) * band.lanes + band.lane[k], run = runs.get(key);
        if (run && xa <= run.at(-1)) run[run.length - 1] = Math.max(run.at(-1), xa + w);
        else if (run) run.push(xa, xa + w); else runs.set(key, [xa, xa + w]);
      }
      if (band.label && w >= LABEL_MIN_PX && h >= LABEL_MIN_H) labels.push([k, xa, w, on]);
    });
    g.globalAlpha = base;
    for (const [key, run] of runs) {
      const lane = key % band.lanes, cs = (key - lane) / band.lanes;
      g.fillStyle = cs & 1 ? PAL_SHADE[cs >> 1] : PAL[cs >> 1];
      for (let j = 0; j < run.length; j += 2) g.fillRect(run[j], y(lane), run[j + 1] - run[j], h);
    }
    for (const [k, xa, w, c, shaded, sel, pe, hov, lit] of raised) {
      // D13 CSS: .u .5 / .row .85 / .on, :hover, .sel, .pe 1; svg.mt .u .22 and .lit 1 win over all of those.
      g.globalAlpha = f.metric ? (lit ? 1 : 0.22) : 1;
      g.fillStyle = shaded ? PAL_SHADE[c] : PAL[c]; g.fillRect(xa, y(band.lane[k]), w, h);
      const stroke = f.metric && lit ? ["#fff", 1.5] : pe ? ["#e3b341", 3] : sel ? ["#fff", 2] : hov ? ["#fff", 1] : null;
      if (stroke) { g.globalAlpha = 1; g.strokeStyle = stroke[0]; g.lineWidth = stroke[1]; g.strokeRect(xa, y(band.lane[k]), w, h); }
    }
    g.globalAlpha = 1; g.fillStyle = "#0a0f18"; g.textAlign = "center"; g.textBaseline = "middle";
    for (const [k, xa, w, on] of labels) {
      const va = Math.max(xa, xmin), vb = Math.min(xa + w, xmax), chars = Math.floor((vb - va - 8) / CHAR_PX);
      if (vb - va < LABEL_MIN_PX || chars < 3) continue;
      const name = band.label(k);
      g.font = `${on ? 800 : 600} ${Math.min(11.5, h - 1)}px system-ui, sans-serif`;
      g.fillText(name.length > chars ? `${name.slice(0, chars - 1)}…` : name, (va + vb) / 2, y(band.lane[k]) + h / 2);
    }
  }

  /** The sample strip: fill = SMs active, line = DRAM read + write (or GPM DRAM), each as a min-max per pixel column
   *  held while fresh (RunStore.samplesAt's rule); the window of the sample at the cursor is highlighted. */
  samples(g, L, f, X, cx) {
    const S = this.S, sm = this.sampleRoles(), base = L.sTop + L.sH, Y = (v) => base - Math.max(0, Math.min(1, v / 100)) * (L.sH - 2);
    if (sm.fill < 0 && !sm.line.length) { this.note(g, L.gl + 8, L.sTop + L.sH / 2, "this run has no SMs-active or DRAM samples"); return; }
    const px = Math.max(1, Math.round(L.w - L.gl - L.gr));
    const draw = (metrics, fill) => {
      const s = sumSeries(S, metrics, [f.a, f.b], px), hold = Math.floor((2 * S.samplePeriod(metrics[0])) / ((f.b - f.a) / px));
      g.beginPath();
      let [last, held] = s.lead, open = false;
      for (let x = 0; x < px; x++) {
        let lo = s.lo[x], hi = s.hi[x];
        if (Number.isNaN(hi)) { if (x - last > hold) { open = false; continue; } lo = hi = held; } else { last = x; held = hi; }
        const xx = L.gl + x;
        if (fill) { g.rect(xx, Y(hi), 1, base - Y(hi)); continue; }
        if (!open) { g.moveTo(xx, Y(hi)); open = true; }
        g.lineTo(xx, Y(lo)); g.lineTo(xx, Y(hi)); g.lineTo(xx + 1, Y(hi));
      }
      if (fill) { g.globalAlpha = 0.3; g.fillStyle = HWC; g.fill(); }
      else { g.globalAlpha = 0.8; g.strokeStyle = "#ff7a59"; g.lineWidth = 1.2; g.stroke(); }
    };
    if (sm.fill >= 0) draw([sm.fill], true);
    if (sm.line.length) draw(sm.line, false);
    const at = sm.fill >= 0 ? sampleWindow(S, sm.fill, f.t) : null;
    if (at) { const a = cx(X(at[0])), b = cx(X(at[1])); g.globalAlpha = 0.22; g.fillStyle = HWC; g.fillRect(a, L.sTop, Math.max(1, b - a), L.sH); }
    g.globalAlpha = 1;
  }

  /** Catalog indexes: fill (SMs active, or -1) and the DRAM metrics whose sum is the line. */
  sampleRoles() {
    const S = this.S;
    if (this.roles?.S !== S || this.roles.n !== S.metrics.length)
      this.roles = { S, n: S.metrics.length, fill: roleOf(S, "sm_active"), line: [roleOf(S, "dram_read"), roleOf(S, "dram_write")].filter((i) => i >= 0) };
    return this.roles;
  }

  /** The unit under (x, y), or null: {id, band (tier index, -1 for a copy), title}. The lane under y picks among
   *  units that share x. */
  hit(L, f, x, y) {
    const S = this.S; if (!S || x < L.gl || x > L.w - L.gr || y < L.clipTop || y >= L.clipBot) return null;
    const xw = L.w - L.gl - L.gr, X = (t) => L.gl + ((t - f.a) / (f.b - f.a)) * xw, T = (px) => f.a + ((px - L.gl) / xw) * (f.b - f.a);
    const cx = (v) => Math.max(L.gl - 20, Math.min(L.w + 20, v));
    const j = L.rows.findIndex((R) => y >= R.y && y < R.top + R.h), band = this.rows()[j];
    if (!band) return null;
    const R = L.rows[j], lane = Math.floor((y - R.y) / R.lh), u = band.u;
    let k = -1;
    eachVisible(u, T(x - band.minW - 1), T(x + 1), (c) => {
      if (band.lane[c] !== lane) return;
      const xa = cx(X(u.start[c])), w = Math.max(band.minW, cx(X(u.end[c])) - xa);
      if (x >= xa && x <= xa + w) k = c;
    });
    if (k < 0) return null;
    const [top, h] = laneBox(R, lane), at = { x, X: (t) => cx(X(t)), dy: y - top, h };
    return { id: u.ids[k], band: band.i, title: `${band.title(k, at)} · lane ${lane + 1} of ${band.lanes}` };
  }

  /** Where unit `id` is drawn: {row (index in rows()), lane}, or null. */
  find(id) {
    const S = this.S, rows = this.rows();
    if (!S || !(id >= 0 && id < S.N)) return null;
    for (let row = 0; row < rows.length; row++) {
      const b = rows[row], t = S.startOf[id];
      for (let k = lowerT(b.u.start, t); k < b.u.ids.length && b.u.start[k] === t; k++) if (b.u.ids[k] === id) return { row, lane: b.lane[k] };
    }
    return null;
  }

  /** window.__spineLayout()'s bands: every drawn box of every unit of the run, [id, start, end, x, y, w, h, key], placed
   *  by laneBox and the row's parts as the painter places them; key is the box's colour index, the lane rule's stream. `rows` are the rows' places with no scroll applied. */
  report(L, f, rows) {
    const xw = L.w - L.gl - L.gr, X = (t) => L.gl + ((t - f.a) / (f.b - f.a)) * xw;
    return this.rows().map((b, j) => {
      const boxes = [];
      b.u.ids.forEach((id, k) => {
        for (const [s, e, y, h] of b.parts(k, ...laneBox(rows[j], b.lane[k]))) boxes.push([id, s, e, X(s), y, Math.max(b.minW, X(e) - X(s)), h, b.col[k]]);
      });
      return { band: b.name, boxes };
    });
  }
}

/**
 * Per pixel column over [a, b]: min and max of the sum of metrics of one sample group (NaN where no sample), and
 * lead: [column, value] of the sample before a, whose state still holds at the left edge (column < 0), or [-Infinity, NaN].
 */
function sumSeries(S, metrics, [a, b], px) {
  const g = S.groupOf(metrics[0]), cols = metrics.map((m) => S.groupOf(m) === g ? g.cols[m - g.first] : null).filter(Boolean);
  const lo = new Float32Array(px).fill(NaN), hi = new Float32Array(px).fill(NaN), i0 = lowerT(g.ts, a);
  let lead = [-Infinity, NaN];
  if (i0 > 0) { let v = 0; for (const c of cols) v += c[i0 - 1]; lead = [Math.floor(((g.ts[i0 - 1] - a) / (b - a)) * px), v]; }
  for (let i = i0, e = upperT(g.ts, b); i < e; i++) {
    let v = 0; for (const c of cols) v += c[i];
    const x = Math.min(px - 1, ((g.ts[i] - a) / (b - a) * px) | 0);
    if (!(v >= lo[x])) lo[x] = v; if (!(v <= hi[x])) hi[x] = v;
  }
  return { lo, hi, lead };
}

/** [start, end] of the sample of `metric` holding t while fresh (two periods), else null. */
export function sampleWindow(S, metric, t) {
  const g = S.groupOf(metric), k = upperT(g.ts, t) - 1, p = S.samplePeriod(metric);
  return k >= 0 && t - g.ts[k] <= 2 * p ? [g.ts[k], g.ts[k] + p] : null;
}
