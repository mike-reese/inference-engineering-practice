// The spine's execution bands (D13 worlds/spine.js) on one canvas: a band per execution tier holding that tier's units
// (control.units), the copies strip (hardware / device stops) and the sample strip (SMs active and DRAM, the sidebar's
// roles). A run has up to tens of thousands of units (R1: 39,768 kernels), so a paint visits only the units in the
// window and merges sub-pixel units of one style into one rect. Colours, opacities, strokes and labels follow D13's
// CSS; hit() answers which unit a point is on, as D13's elementFromPoint did.
import { units, stops, FLOW_COLOR, DIM_COLOR } from "../../control/control.js";
import { NONE16 } from "../../store/columns.js";
import { roleOf } from "../../sidebar/samples.js";

export const BAND_COL = ["#5b8def", "#3fc1a5", "#9aa7b8", "#c792ea", "#e6c86e", "#ff6fae"];
/** kinds.json kernel_class -> colour; D13 drew gemm, attention and memory, the registry adds other. */
export const CLASS_COL = { gemm: "#ffb547", attention: "#ff6fae", memory: "#4fd1e8", other: "#888888" };
const NO_FLOW = "#888888", COPY = "#58d68d", HWC = DIM_COLOR.hardware;
const LABEL_MIN_PX = 34, CHAR_PX = 7, COPY_MIN_PX = 3;

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
 * @typedef {{i: number, name: string, u: Spans, col: Uint8Array, low: Uint8Array | null}} Band
 *   col: palette index per unit; low: 1 where a phase unit is stream out (D13 draws those in the lower half)
 * @typedef {{w: number, h: number, gl: number, gr: number, axis: number, rows: {y: number, h: number}[],
 *   sTop: number, sH: number, xTop: number, xferH: number}} Layout
 * @typedef {{a: number, b: number, t: number, tier: number, sel: any, pe: any, hover: number, lit: Set<number>,
 *   metric: boolean, head: number, live: boolean}} Frame
 */

/** Visit the spans overlapping [a, b] in start order (D13's draw order): long ones that start before the scan first. */
function eachVisible(L, a, b, fn) {
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
  constructor() { /** @type {Band[]} */ this.bands = []; this.copies = null; this.S = null; this.copyKey = null; }

  /** Rebuild each band whose units changed (another store, a live merge, a seal); units() caches per store revision. */
  sync(S, ladder) {
    if (S !== this.S) { this.S = S; this.bands = []; this.copies = null; this.copyKey = null; this.cls = new Map(); }
    if (!S) return;
    ladder.forEach((name, i) => { const u = units(i); if (this.bands[i]?.u !== u) this.bands[i] = this.band(S, i, name, u); });
    this.bands.length = ladder.length;
    const dev = S.dims.ladders.hardware.indexOf("device"), st = dev >= 0 ? stops("hardware", dev) : null;
    if (st !== this.copyKey) {
      this.copyKey = st;
      const ids = st?.ids ?? new Uint32Array(0), start = st?.t ?? new Float64Array(0), end = Float64Array.from(ids, (id) => S.endOf[id]);
      let reach = 0; for (let k = 0; k < ids.length; k++) reach = Math.max(reach, end[k] - start[k]);
      this.copies = { ids, start, end, reach, long: new Uint32Array(0) };
    }
  }

  /** @returns {Band} */
  band(S, i, name, u) {
    const n = u.ids.length, col = new Uint8Array(n), low = name === "phase" ? new Uint8Array(n) : null;
    const flowPal = S.dims.flowNames.map((f) => pal(FLOW_COLOR[f] ?? NO_FLOW)), none = S.dims.FLOW_NONE;
    const byFlow = name === "iteration" || name === "phase", kernel = name === "kernel", fixed = pal(BAND_COL[i] ?? NO_FLOW);
    const out = flowPal[S.dims.flowNames.indexOf("stream out")];
    for (let k = 0; k < n; k++) {
      const id = u.ids[k];
      if (byFlow) { const f = S.field("flow", id); col[k] = f === none ? pal(NO_FLOW) : flowPal[f]; if (low) low[k] = col[k] === out ? 1 : 0; }
      else if (kernel) col[k] = this.kernelPal(S, id);
      else col[k] = fixed;
    }
    return { i, name, u, col, low };
  }

  /** The kernel class colour, cached per (kind, name): dims.kernelClass runs regexes. */
  kernelPal(S, id) {
    const key = S.field("kind", id) * 2 ** 32 + S.field("name", id);
    let c = this.cls.get(key);
    if (c === undefined) this.cls.set(key, (c = pal(CLASS_COL[S.dims.kernelClass(id)] ?? NO_FLOW)));
    return c;
  }

  /** Paint tracks, the sample strip, copies, units and labels for the window [f.a, f.b].
   *  @param {CanvasRenderingContext2D} g @param {Layout} L @param {Frame} f */
  paint(g, L, f) {
    const S = this.S, x0 = L.gl, xw = L.w - L.gl - L.gr, X = (t) => x0 + ((t - f.a) / (f.b - f.a)) * xw;
    const cx = (x) => Math.max(x0 - 20, Math.min(L.w + 20, x));
    g.save();
    g.beginPath(); g.rect(x0, 0, xw, L.h); g.clip();
    L.rows.forEach((r, i) => { g.fillStyle = i === f.tier ? "#ffffff14" : "#ffffff08"; g.fillRect(x0, r.y, xw, r.h); });
    if (S) this.samples(g, L, f, X, cx);
    this.litDrawn = new Set();
    if (S) {
      const clip = [x0, x0 + xw];
      this.spans(g, f, X, cx, clip, this.copies, null, { y: L.xTop, h: L.xferH }, COPY_MIN_PX, null);
      this.bands.forEach((band, i) => {
        const r = L.rows[i];
        if (!band.u.ids.length) { this.note(g, x0 + 8, r.y + r.h / 2, `missing: this run has no ${band.name} rows`); return; }
        this.spans(g, f, X, cx, clip, band.u, band, r, 1, (id) => unitLabel(S, band.name, id));
      });
      if (f.metric) this.instants(g, L, f, X);
    }
    g.restore();
  }

  /** Metric inputs that are no unit of any band (instants such as arrival_time) light as a tick across the bands. */
  instants(g, L, f, X) {
    const S = this.S, y0 = L.rows[0].y, last = L.rows.at(-1), y1 = last.y + last.h;
    g.globalAlpha = 1; g.fillStyle = "#fff";
    for (const id of f.lit) {
      const t = S.startOf[id];
      if (!this.litDrawn.has(id) && t >= f.a && t <= f.b) g.fillRect(X(t) - 0.75, y0, 1.5, y1 - y0);
    }
  }

  note(g, x, y, s) { g.globalAlpha = 1; g.fillStyle = "#5d6575"; g.font = "11px system-ui, sans-serif"; g.textAlign = "left"; g.textBaseline = "middle"; g.fillText(s, x, y); }

  /**
   * One band's spans (or the copies strip, band null). Base pass: every unit not raised, merged per style, at the
   * band's opacity (D13: .5, .85 on the tier's own band, .22 while a metric is selected). Raised pass: the units the
   * cursor is in, the hovered, selected, played and metric-lit ones, with D13's opacity and stroke. Then labels.
   */
  spans(g, f, X, cx, [xmin, xmax], L, band, R, minW, label) {
    const base = f.metric ? 0.22 : band && band.i === f.tier ? 0.85 : 0.5;
    const runs = new Map(), raised = [], labels = [];
    eachVisible(L, f.a, f.b, (k) => {
      const s = L.start[k], e = L.end[k], id = L.ids[k], xa = cx(X(s)), w = Math.max(minW, cx(X(e)) - xa);
      const half = band?.low ? (band.low[k] ? 2 : 1) : 0;
      const on = band != null && s <= f.t && f.t < e, sel = id === f.sel, pe = id === f.pe, hov = id === f.hover, lit = f.lit.has(id);
      const c = band ? band.col[k] : pal(COPY), shaded = band != null && w >= 2 && (k & 1) === 1;
      if (lit) this.litDrawn.add(id);
      if (on || sel || pe || hov || lit) raised.push([k, xa, w, half, c, shaded, on, sel, pe, hov, lit]);
      else {
        const key = (c * 2 + (shaded ? 1 : 0)) * 3 + half, run = runs.get(key);
        if (run && xa <= run.at(-1)) run[run.length - 1] = Math.max(run.at(-1), xa + w);
        else if (run) run.push(xa, xa + w); else runs.set(key, [xa, xa + w]);
      }
      if (label && w >= LABEL_MIN_PX && R.h >= 11) labels.push([k, xa, w, half, on]);
    });
    const yh = (half) => (half === 0 ? [R.y, R.h] : [half === 2 ? R.y + R.h / 2 : R.y, R.h / 2 - 0.5]);
    g.globalAlpha = base;
    for (const [key, run] of runs) {
      const half = key % 3, cs = (key - half) / 3, [y, h] = yh(half);
      g.fillStyle = cs & 1 ? PAL_SHADE[cs >> 1] : PAL[cs >> 1];
      for (let j = 0; j < run.length; j += 2) g.fillRect(run[j], y, run[j + 1] - run[j], h);
    }
    for (const [, xa, w, half, c, shaded, on, sel, pe, hov, lit] of raised) {
      const [y, h] = yh(half);
      // D13 CSS: .u .5 / .row .85 / .on, :hover, .sel, .pe 1; svg.mt .u .22 and .lit 1 win over all of those.
      g.globalAlpha = f.metric ? (lit ? 1 : 0.22) : 1;
      g.fillStyle = shaded ? PAL_SHADE[c] : PAL[c]; g.fillRect(xa, y, w, h);
      const stroke = f.metric && lit ? ["#fff", 1.5] : pe ? ["#e3b341", 3] : sel ? ["#fff", 2] : hov ? ["#fff", 1] : null;
      if (stroke) { g.globalAlpha = 1; g.strokeStyle = stroke[0]; g.lineWidth = stroke[1]; g.strokeRect(xa, y, w, h); }
    }
    if (labels.length) {
      // Units of one band can overlap in time (phases of two processes), so a label that would cross one already
      // drawn in its half is left out; the cursor's units label first.
      g.globalAlpha = 1; g.fillStyle = "#0a0f18"; g.textAlign = "center"; g.textBaseline = "middle";
      const taken = [[], [], []];
      labels.sort((p, q) => q[4] - p[4]);
      for (const [k, xa, w, half, on] of labels) {
        const [y, h] = yh(half), va = Math.max(xa, xmin), vb = Math.min(xa + w, xmax), vw = vb - va, chars = Math.floor((vw - 8) / CHAR_PX);
        if (vw < LABEL_MIN_PX || chars < 3 || h < 11) continue;
        const name = label(L.ids[k]), s = name.length > chars ? `${name.slice(0, chars - 1)}…` : name;
        g.font = `${on ? 800 : 600} 11.5px system-ui, sans-serif`;
        const c = (va + vb) / 2, r = g.measureText(s).width / 2 + 3;
        if (taken[half].some(([a, b]) => c - r < b && c + r > a)) continue;
        taken[half].push([c - r, c + r]);
        g.fillText(s, c, y + h / 2);
      }
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

  /** The unit (or copy) under (x, y), topmost first as drawn, or null: {id, title}. */
  hit(L, f, x, y) {
    const S = this.S; if (!S || x < L.gl || x > L.w - L.gr) return null;
    const xw = L.w - L.gl - L.gr, X = (t) => L.gl + ((t - f.a) / (f.b - f.a)) * xw, T = (px) => f.a + ((px - L.gl) / xw) * (f.b - f.a);
    const cx = (v) => Math.max(L.gl - 20, Math.min(L.w + 20, v));
    const find = (sp, minW, inHalf) => {
      let best = -1;
      eachVisible(sp, T(x - minW - 1), T(x + 1), (k) => {
        const xa = cx(X(sp.start[k])), w = Math.max(minW, cx(X(sp.end[k])) - xa);
        if (x >= xa && x <= xa + w && inHalf(k)) best = k;
      });
      return best;
    };
    if (y >= L.xTop && y < L.xTop + L.xferH) { const k = find(this.copies, COPY_MIN_PX, () => true); return k < 0 ? null : { id: this.copies.ids[k], title: copyLabel(S, this.copies.ids[k]) }; }
    const i = L.rows.findIndex((r) => y >= r.y && y < r.y + r.h), band = this.bands[i];
    if (!band) return null;
    const r = L.rows[i], lower = y >= r.y + r.h / 2;
    const k = find(band.u, 1, (j) => !band.low || (band.low[j] === 1) === lower);
    return k < 0 ? null : { id: band.u.ids[k], title: unitLabel(S, band.name, band.u.ids[k]) };
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
