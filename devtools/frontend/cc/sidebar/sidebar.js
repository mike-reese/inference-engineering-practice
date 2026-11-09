// The hardware cutout on the right (COMMAND_CENTER.md 2.1, 3.2; D13 hwside.js). One row per sidebar metric of the
// run's catalog (manifest `metrics`, sidebar: true), grouped by clock: one source, one sampling period. Each row shows
// its value at the cursor, a min-max sparkline over state.bounds (it zooms with the execution tier), and its source
// and measured period. A row with no fresh sample at the cursor is greyed with the reason; a value its unit cannot
// hold is shown as recorded and flagged. A click focuses hardware and selects the thing the metric is sampled on.
import { state, subscribe, select, focus, store, tierName } from "../control/control.js";
import { evidence, fmtValue, implausible, why, sourceOf, periodOf } from "./samples.js";

const SPARK_W = 240, SPARK_H = 20;
const isPct = (u) => u === "%" || u === "Throughput %";

const CSS = `
#hw { padding:8px 10px; }
#hw h2 { font-size:13px; color:var(--text); margin:0 0 2px; }
#hw .hint { color:var(--dim); font-size:11px; margin:0 0 6px; }
#hw h3 { font-size:11px; font-weight:600; color:#a9bddb; margin:10px 0 4px; }
#hw h3 small { font-weight:normal; color:var(--dim); }
.hwrow { display:grid; grid-template-columns:minmax(0,1fr) auto; grid-template-areas:"nm val" "spark spark" "ev ev" "why why";
  column-gap:6px; padding:3px 4px 5px; border-bottom:1px solid var(--line); cursor:pointer; border-left:2px solid transparent; }
.hwrow:hover { background:#1f232c; }
.hwrow .nm { grid-area:nm; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.hwrow .val { grid-area:val; font-size:12px; color:#ffd36b; font-variant-numeric:tabular-nums; }
.hwrow .sp { grid-area:spark; position:relative; height:${SPARK_H}px; margin-top:2px; }
.hwrow canvas { width:100%; height:${SPARK_H}px; display:block; }
.hwrow .cur { position:absolute; top:0; left:0; width:1px; height:100%; background:#ffd36b; will-change:transform; }
.hwrow .ev { grid-area:ev; font-size:10px; color:var(--dim); }
.hwrow .why { grid-area:why; font-size:10px; color:#c9a26b; }
.hwrow.stale .nm, .hwrow.stale .val { color:var(--dim); }
.hwrow.stale canvas { opacity:0.5; } .hwrow.stale .cur { display:none; }
.hwrow.tier { border-left-color:var(--hw); background:rgba(245,166,35,0.07); }
.hwrow.sel { outline:1px solid var(--hw); outline-offset:-1px; }
`;

export function mountHardwareSide(el) {
  if (!document.getElementById("hwside-css")) document.head.insertAdjacentHTML("beforeend", `<style id="hwside-css">${CSS}</style>`);
  el.innerHTML = `<h2>Hardware</h2><p class="hint">At the cursor · sparkline over the window</p><p class="hint win"></p><div class="rows"></div>`;
  const winEl = el.querySelector(".win"), rowsEl = el.querySelector(".rows");
  let S = null, ROWS = [];

  /** One row per sidebar metric (index into S.metrics), grouped by sample group (one clock), in catalog order. */
  function build() {
    rowsEl.replaceChildren(); ROWS = [];
    if (!S) { rowsEl.innerHTML = `<p class="hint">no run open</p>`; return; }
    const groups = Map.groupBy(S.metrics.map((m, i) => ({ m, i })).filter((x) => x.m.sidebar), (x) => x.m.group);
    if (!groups.size) rowsEl.innerHTML = `<p class="hint">this run has no hardware samples</p>`;
    for (const [, list] of groups) {
      const sec = document.createElement("section");
      // one clock per group; its rows can still read different sources (host: /proc/stat and /proc/meminfo)
      sec.innerHTML = `<h3></h3>`;
      sec.querySelector("h3").textContent = `${[...new Set(list.map(({ m }) => sourceOf(m)))].join(" + ")} · ${periodOf(S, list[0].i)}`;
      for (const { m, i } of list) {
        const thing = S.things[m.thing];
        const row = document.createElement("div");
        row.className = "hwrow"; row.setAttribute("role", "button");
        row.title = `${m.label} · ${m.metric} · on ${thing?.name ?? "no thing"}`;
        row.innerHTML = `<span class="nm"></span><span class="val"></span><div class="sp"><canvas aria-hidden="true"></canvas><div class="cur"></div></div>
          <span class="ev"></span><span class="why"></span>`;
        row.querySelector(".nm").textContent = m.label;
        row.querySelector(".ev").textContent = evidence(S, i);
        row.addEventListener("click", () => { focus("hardware"); if (thing) select(thing.key); });
        const cv = row.querySelector("canvas");
        cv.width = SPARK_W * devicePixelRatio; cv.height = SPARK_H * devicePixelRatio;
        const r = { m, i, key: thing?.key ?? null, row, val: row.querySelector(".val"), why: row.querySelector(".why"), cur: row.querySelector(".cur"),
          sp: row.querySelector(".sp"), g: cv.getContext("2d"), lo: 0, hi: 100, spark: null };
        // sparkline scale: 0-100 for percents, else the metric's range over the run, widened by every spark drawn later
        if (!isPct(m.unit)) { r.lo = Infinity; r.hi = -Infinity; widen(r, S.series(i, S.extent, 256)); }
        ROWS.push(r); sec.append(row);
      }
      rowsEl.append(sec);
    }
  }

  return subscribe((s, ch) => {
    if (ch.rev || ch.session) { const now = store(); if (now !== S) { S = now; build(); } }
    const [a, b] = s.bounds;
    if (ch.bounds || ch.rev || ch.session) {
      winEl.textContent = S ? `window: ${(a / 1e6).toFixed(2)} to ${(b / 1e6).toFixed(2)} ms (${tierName("execution")})` : "";
      for (const r of ROWS) { r.spark = S.series(r.i, [a, b], SPARK_W); widen(r, r.spark); draw(r, a, b); }
    }
    if (ch.sel || ch.rev || ch.session) for (const r of ROWS) r.row.classList.toggle("sel", r.key != null && r.key === s.sel);
    if (ch.t || ch.bounds || ch.rev || ch.session) {
      const x = Math.max(0, Math.min(1, (s.t - a) / (b - a || 1)));
      for (const r of ROWS) r.cur.style.transform = `translateX(${x * (r.sp.clientWidth - 1)}px)`;
      const v = S ? S.samplesAt(s.t) : null;
      for (const r of ROWS) {
        const y = v[r.i], stale = Number.isNaN(y), bad = stale ? "" : implausible(y, r.m.unit);
        r.row.classList.toggle("stale", stale);
        r.val.textContent = fmtValue(y, r.m.unit);
        r.why.textContent = stale ? why(S, r.i) : bad;
      }
    }
  });

  function widen(r, { lo, hi }) {
    if (isPct(r.m.unit)) return;
    for (let x = 0; x < lo.length; x++) { if (lo[x] < r.lo) r.lo = lo[x]; if (hi[x] > r.hi) r.hi = hi[x]; }
    if (!(r.hi > r.lo)) r.hi = r.lo + 1;
  }

  /** Min-max bar per pixel column over [a, b]; between sparse samples the last value holds while it is fresh (two
   *  sample periods, as RunStore.samplesAt). */
  function draw(r, a, b) {
    const g = r.g, k = devicePixelRatio, { lo, hi } = r.spark, y = (v) => SPARK_H - ((v - r.lo) / (r.hi - r.lo)) * (SPARK_H - 2) - 1;
    g.setTransform(k, 0, 0, k, 0, 0); g.clearRect(0, 0, SPARK_W, SPARK_H);
    g.fillStyle = "#262a32"; g.fillRect(0, 0, SPARK_W, SPARK_H);
    g.fillStyle = "#7fb0ff";
    const hold = Math.floor((2 * S.samplePeriod(r.i)) / ((b - a) / SPARK_W));
    let last = -1;
    for (let x = 0; x < SPARK_W; x++) {
      if (Number.isNaN(hi[x])) { if (last >= 0 && x - last <= hold) g.fillRect(x, y(hi[last]), 1, 1); continue; }
      last = x; const y1 = y(hi[x]), y0 = y(lo[x]); g.fillRect(x, y1, 1, Math.max(1, y0 - y1));
    }
  }
}
