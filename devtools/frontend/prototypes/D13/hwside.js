// The hardware cutout on the right, rebuilt after v2 (cc/sidebar/sidebar.js). Rows are grouped by the source and period
// the real store reads them from. Values here are the 100 µs scratch samples, labelled "scratch"; rows the store has but
// scratch does not are greyed with the reason. Sparklines span state.bounds, so they zoom with the execution tier.
import { state, subscribe, select, setTier, data } from "./model.js";

const { SAMPLES, CONTAINERS, LADDERS } = data;
const SPARK_W = 240, SPARK_H = 20, PERIOD = 100;
const server = CONTAINERS.find((c) => c.id === "c.server");
const at = (t) => Math.max(0, Math.min(SAMPLES.length - 1, Math.floor(t / PERIOD)));
const pct = (v) => `${v * 100 < 10 ? (v * 100).toFixed(1) : (v * 100).toFixed(0)} %`;
const NOT_SCRATCH = "not in scratch data", NOT_COLLECTED = "missing: not collected";

/** Hardware tiers: 0 system, 2 device, 3 unit. `thing` is what a click selects. */
const GROUPS = [
  { title: "Nsight Systems GPU metrics · 10 kHz", rows: [
    { label: "SMs active", tier: 3, thing: "sm0", lo: 0, hi: 36, v: (i) => SAMPLES[i].smActive, fmt: (v) => `${v} of 36 SMs` },
    { label: "DRAM bandwidth", tier: 3, thing: "mc0", lo: 0, hi: 1, v: (i) => SAMPLES[i].dram, fmt: pct },
    { label: "PCIe throughput", tier: 2, thing: "pcie", lo: 0, hi: 1, v: (i) => SAMPLES[i].pcie, fmt: pct },
  ] },
  { title: "nvidia-smi query · 100 ms", rows: [
    { label: "GPU utilization", tier: 2, thing: "gpu", lo: 0, hi: 1, v: (i) => SAMPLES[i].gpuUtil, fmt: pct },
    { label: "GPU memory used", tier: 2, thing: "vram", lo: 0, hi: 16, v: (i) => SAMPLES[i].vramGiB, fmt: (v) => `${v.toFixed(1)} GiB` },
  ] },
  { title: "NVML · 500 ms", rows: [
    { label: "SM clock", tier: 3, thing: "sm0", missing: NOT_SCRATCH },
    { label: "power", tier: 2, thing: "gpu", missing: NOT_SCRATCH },
    { label: "GPU temperature", tier: 2, thing: "gpu", missing: NOT_SCRATCH },
  ] },
  { title: "host · CPU and memory", rows: [
    { label: "CPU utilization", tier: 0, thing: "cpu", lo: 0, hi: 1, v: (i) => SAMPLES[i].cpu, fmt: pct },
    { label: "L3 bandwidth", tier: 3, thing: "l3", missing: NOT_COLLECTED, ev: "no source" },
    { label: "RAM bandwidth", tier: 2, thing: "ram", missing: NOT_COLLECTED, ev: "no source" },
  ] },
  { title: "Docker stats · about 1 s (live only)", sub: server.service + " container", rows: [
    { label: "server CPU", tier: 0, thing: "c.server", lo: 0, hi: Math.max(100, ...server.cpu), v: (i) => server.cpu[i], fmt: (v) => `${v.toFixed(0)} %` },
    { label: "server memory", tier: 0, thing: "c.server", lo: 0, hi: server.memLimit, v: (i) => server.mem[i], fmt: (v) => `${(v / 2 ** 30).toFixed(1)} GiB` },
    { label: "server GPU utilization", tier: 2, thing: "gpu", lo: 0, hi: 100, v: (i) => server.gpu.util[i], fmt: (v) => `${v.toFixed(0)} %` },
    { label: "server VRAM held", tier: 2, thing: "vram", lo: 0, hi: 16, v: (i) => server.gpu.vramGiB[i], fmt: (v) => `${v.toFixed(1)} GiB` },
  ] },
];
const ROWS = GROUPS.flatMap((g) => g.rows.map((r) => Object.assign(r, { group: g })));

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
  el.innerHTML = `<h2>Hardware</h2><p class="hint">At the cursor · sparkline over the window</p><p class="hint win"></p>`;
  const winEl = el.querySelector(".win");
  for (const g of GROUPS) {
    const sec = document.createElement("section");
    sec.innerHTML = `<h3>${g.title}${g.sub ? ` <small>· ${g.sub}</small>` : ""}</h3>`;
    for (const r of g.rows) {
      const row = document.createElement("div");
      row.className = "hwrow" + (r.missing ? " stale" : "");
      row.setAttribute("role", "button");
      row.title = `${r.label} · tier: ${LADDERS.hardware[r.tier]}`;
      row.innerHTML = `<span class="nm"></span><span class="val"></span><div class="sp"><canvas aria-hidden="true"></canvas><div class="cur"></div></div>
        <span class="ev"></span><span class="why"></span>`;
      row.querySelector(".nm").textContent = r.label;
      row.querySelector(".ev").textContent = r.missing ? `${r.ev ?? g.title} · ${LADDERS.hardware[r.tier]}` : `scratch · 100 µs · ${LADDERS.hardware[r.tier]}`;
      row.querySelector(".why").textContent = r.missing ?? "";
      if (r.missing) row.querySelector(".val").textContent = "–";
      row.addEventListener("click", () => { setTier("hardware", r.tier); select(r.thing); });
      const cv = row.querySelector("canvas");
      cv.width = SPARK_W * devicePixelRatio; cv.height = SPARK_H * devicePixelRatio;
      Object.assign(r, { row, val: row.querySelector(".val"), cur: row.querySelector(".cur"), sp: row.querySelector(".sp"), g: cv.getContext("2d") });
      sec.append(row);
    }
    el.append(sec);
  }
  let shownIdx = -1;
  return subscribe((s, ch) => {
    const [a, b] = s.bounds;
    if (ch.bounds) {
      winEl.textContent = `window: ${(a / 1000).toFixed(2)} to ${(b / 1000).toFixed(2)} ms (${LADDERS.execution[s.tiers.execution]})`;
      ROWS.forEach((r) => draw(r, a, b));
    }
    if (ch.focus || ch.tiers) ROWS.forEach((r) => r.row.classList.toggle("tier", s.focus === "hardware" && r.tier === s.tiers.hardware));
    if (ch.sel) ROWS.forEach((r) => r.row.classList.toggle("sel", r.thing === s.sel));
    if (ch.t || ch.bounds) {
      const x = Math.max(0, Math.min(1, (s.t - a) / (b - a || 1)));
      for (const r of ROWS) r.cur.style.transform = `translateX(${x * (r.sp.clientWidth - 1)}px)`;
      const i = at(s.t);
      if (i !== shownIdx) { shownIdx = i; for (const r of ROWS) if (!r.missing) r.val.textContent = r.fmt(r.v(i)); }
    }
  });
}

/** Min-max bar per pixel column over [a, b]; a column narrower than one sample holds that sample's value. */
function draw(r, a, b) {
  const g = r.g, k = devicePixelRatio, y = (v) => SPARK_H - ((v - r.lo) / (r.hi - r.lo)) * (SPARK_H - 2) - 1;
  g.setTransform(k, 0, 0, k, 0, 0); g.clearRect(0, 0, SPARK_W, SPARK_H);
  g.fillStyle = "#262a32"; g.fillRect(0, 0, SPARK_W, SPARK_H);
  if (r.missing) return;
  g.fillStyle = "#7fb0ff";
  const per = (b - a) / SPARK_W;
  for (let x = 0; x < SPARK_W; x++) {
    const i0 = at(a + x * per), i1 = Math.max(i0, at(a + (x + 1) * per - 1e-6));
    let lo = Infinity, hi = -Infinity;
    for (let i = i0; i <= i1; i++) { const v = r.v(i); if (v < lo) lo = v; if (v > hi) hi = v; }
    const y1 = y(hi), y0 = y(lo); g.fillRect(x, y1, 1, Math.max(1, y0 - y1));
  }
}
