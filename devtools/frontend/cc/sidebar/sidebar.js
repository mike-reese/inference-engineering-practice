// The hardware sidebar: the manifest's sidebar metrics (sidebar: true), grouped by source. Each row shows the value at
// the cursor with its unit, a sparkline over the Control window with the cursor marked, and the source and sampling
// period as evidence. A metric with no samples in the run is left out; one with no fresh sample at the cursor is greyed
// with the reason (the store decides freshness for the levels and this sidebar alike). A live run grows the catalog and
// fills groups that had no sample: the rows are rebuilt when the set of sampled sidebar metrics changes.
import { evidence, fmtValue, implausible, why } from "../scene/samples.js";

const SPARK_W = 240, SPARK_H = 20;   // the sidebar row width in CSS px (#hw is 270 px wide)
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const isPct = (u) => u === "%" || u === "Throughput %";

export class HardwareSidebar {
  /** @param {HTMLElement} root @param {import("../store/run.js").RunStore} store @param {import("../control/control.js").Control} control */
  constructor(root, store, control) {
    this.root = root; this.store = store;
    this.build();
    control.subscribe((f) => this.frame(f));
  }

  /** The sidebar metrics that have a sample, as "i,i,..": what the rows show. */
  shown() {
    const s = this.store, out = [];
    for (let i = 0; i < s.metrics.length; i++) if (s.metrics[i].sidebar && s.sampleSpan(i)) out.push(i);
    return out.join();
  }

  build() {
    const store = this.store, root = this.root;
    const all = store.metrics.map((m, i) => ({ m, i })).filter(({ m }) => m.sidebar);
    // a metric with no sample anywhere in the run says nothing about this run: leave it out, and say how many
    this.rows = all.filter(({ i }) => store.sampleSpan(i));
    this.key = this.shown();
    const left = all.length - this.rows.length;
    // sparkline scale: 0-100 for percents, else the metric's range over the run, widened by every spark drawn later
    for (const r of this.rows) {
      if (isPct(r.m.unit)) { r.lo = 0; r.hi = 100; continue; }
      r.lo = Infinity; r.hi = -Infinity; this.widen(r, store.series(r.i, store.extent, 256));
    }
    const groups = new Map(); for (const r of this.rows) (groups.get(r.m.group) ?? groups.set(r.m.group, []).get(r.m.group)).push(r);
    root.innerHTML = `<h2>Hardware</h2><p class="hint">At the cursor · sparkline over the window</p>
      ${[...groups.values()].map((list) => `<section class="hwg"><h3>${esc(evidence(store, list[0].i))}</h3>${list.map((r) =>
        `<div class="hwrow" data-i="${r.i}" title="${esc(r.m.metric)} · ${esc(evidence(store, r.i))}"><span class="nm">${esc(r.m.label)}</span><span class="val"></span>
          <canvas width="${SPARK_W * devicePixelRatio}" height="${SPARK_H * devicePixelRatio}" style="height:${SPARK_H}px" aria-hidden="true"></canvas>
          <span class="ev">${esc(evidence(store, r.i))}</span><span class="why"></span></div>`).join("")}</section>`).join("")}
      ${!this.rows.length ? `<p class="muted">This run has no sampled hardware metrics.</p>` : ""}
      ${left ? `<p class="muted">${left} sidebar metric${left > 1 ? "s have" : " has"} no samples in this run and ${left > 1 ? "are" : "is"} not shown.</p>` : ""}`;
    for (const r of this.rows) {
      const el = root.querySelector(`.hwrow[data-i="${r.i}"]`);
      Object.assign(r, { el, val: el.querySelector(".val"), why: el.querySelector(".why"), cv: el.querySelector("canvas") });
      r.g = r.cv.getContext("2d");
    }
    this.win = null; this.t = NaN;
  }

  /** Widen a non-percent row's scale to cover a spark. */
  widen(r, { lo, hi }) {
    if (isPct(r.m.unit)) return;
    for (let x = 0; x < lo.length; x++) { if (lo[x] < r.lo) r.lo = lo[x]; if (hi[x] > r.hi) r.hi = hi[x]; }
    if (!(r.hi > r.lo)) r.hi = r.lo + 1;
  }

  frame(f) {
    if (f.changed.data && this.shown() !== this.key) this.build();
    const winChanged = f.win !== this.win, t = f.cursor.t;
    if (!winChanged && !f.changed.data && t === this.t) return;
    this.win = f.win; this.t = t;
    const v = this.store.samplesAt(t);
    for (const r of this.rows) {
      const x = v[r.i], stale = Number.isNaN(x), bad = stale ? "" : implausible(x, r.m.unit);
      r.val.textContent = stale ? "–" : bad ? "invalid" : fmtValue(x, r.m.unit);
      r.el.classList.toggle("stale", stale || !!bad);
      r.why.textContent = stale ? why(this.store, r.i) : bad;
      if (winChanged || f.changed.data) { r.spark = this.store.series(r.i, f.win, SPARK_W); this.widen(r, r.spark); }
      this.draw(r, f.win, t);
    }
  }

  /** Min-max bars per pixel column; between sparse samples (nvidia-smi at 100 ms) the last value holds while fresh. The cursor is a line. */
  draw(r, [a, b], t) {
    const g = r.g, k = devicePixelRatio, { lo, hi } = r.spark, s = (y) => SPARK_H - ((y - r.lo) / (r.hi - r.lo)) * (SPARK_H - 2) - 1;
    const hold = Math.floor((2 * this.store.samplePeriod(r.i)) / ((b - a) / SPARK_W));   // columns a sample stays fresh
    g.setTransform(k, 0, 0, k, 0, 0); g.clearRect(0, 0, SPARK_W, SPARK_H);
    g.fillStyle = "#262a32"; g.fillRect(0, 0, SPARK_W, SPARK_H);
    g.fillStyle = "#7fb0ff";
    for (let x = 0, last = -1; x < SPARK_W; x++) {
      if (Number.isNaN(hi[x])) { if (last >= 0 && x - last <= hold) g.fillRect(x, s(hi[last]), 1, 1); continue; }
      last = x; const y1 = s(hi[x]), y0 = s(lo[x]); g.fillRect(x, y1, 1, Math.max(1, y0 - y1));
    }
    if (t >= a && t <= b) { g.fillStyle = "#ffd36b"; g.fillRect(Math.min(SPARK_W - 1, ((t - a) / (b - a)) * SPARK_W), 0, 1, SPARK_H); }
  }
}
