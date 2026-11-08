// The one transport bar: run picker, live dot, level buttons, back / play / forward, pace, rate, grain name, cursor
// text, the overview strip (whole run, window brush) and the detail strip (the window; every stop at the grain is a
// tick, so what you see is what you step). Wheel on the detail strip zooms the window, drag scrubs, a click on a tick
// lands on that row. Every control calls a Control intent; the bar draws only from Frames.
import { listRuns } from "../store/run.js";
import { perf } from "../perf.js";

const TICK_SNAP_PX = 5;
const RUNS_POLL_MS = 5000;   // the backend looks for new run folders every second
// the live pill: following the head, live but not following (L follows), the live writer ended, a final run
const LIVE_DOT = { follow: ["#3fb950", "live: following the head (L stops)"], paused: ["#d29922", "live: not following (L follows the head)"],
  ended: ["#8b949e", "live run ended; waiting for the final import"], final: ["", "final run"] };
const TIER_COLOR = ["#e0b84a", "#58b368", "#4a8fe0", "#9b6fd6", "#d6896f", "#e05a7a", "#7f8a96"];
/** Rows lit by Control.light (a hover on a Metrics input); levels/level.js LIT is this colour for the scene. Magenta:
 *  no kind, tier, active, current or selected colour is near it (the active edges are cyan and blue). */
export const LIT_CSS = "#ff3df0";

export const fmtMs = (ns) => `${(ns / 1e6).toFixed(6)} ms`;
export const fmtSpan = (ns) => (ns >= 1e9 ? `${(ns / 1e9).toFixed(3)} s` : ns >= 1e6 ? `${(ns / 1e6).toFixed(3)} ms` : `${(ns / 1e3).toFixed(1)} µs`);

export class ControlBar {
  /** @param {HTMLElement} el @param {import("../store/run.js").RunStore} store @param {import("./control.js").Control} control */
  constructor(el, store, control, levels) {
    this.store = store; this.control = control; this.levels = levels; this.ticks = { t: new Float64Array(1024), id: new Int32Array(1024), n: 0 };
    el.innerHTML = `<div class="transport">
      <select id="run" aria-label="Run"></select><span id="live" class="dot" title="final run"></span>
      <span id="levels" role="group" aria-label="Levels">${levels.map((l, i) => `<button data-level="${i}" aria-label="${i + 1} ${l.name}">${i + 1} ${l.name}</button>`).join("")}</span>
      <button id="back" aria-label="Step back">◀</button><button id="play" aria-label="Play">▶ play</button><button id="next" aria-label="Step forward">▶|</button>
      <label>pace <select id="pace" aria-label="Pace"><option value="time">time</option><option value="events">events</option></select></label>
      <label>rate <select id="rate" aria-label="Rate">${[0.25, 0.5, 1, 2, 4].map((r) => `<option value="${r}"${r === 1 ? " selected" : ""}>×${r}</option>`).join("")}</select></label>
      <span id="grain" title="step grain: the finest tier whose stops are at least 6 px apart in this window"></span>
      <span id="tlabel"></span><button id="keys" aria-label="Keys">?</button></div>
      <canvas id="overview" aria-label="Run overview"></canvas><canvas id="detail" aria-label="Timeline window"></canvas>`;
    const $ = (q) => el.querySelector(q);
    this.$ = { run: $("#run"), live: $("#live"), play: $("#play"), grain: $("#grain"), tlabel: $("#tlabel"), pace: $("#pace"), rate: $("#rate"), levels: $("#levels") };
    this.over = $("#overview"); this.detail = $("#detail");
    const act = (intent, fn) => (e) => { perf.input(intent, e.timeStamp); fn(e); };
    $("#back").onclick = act("step", () => control.step(-1));
    $("#next").onclick = act("step", () => control.step(+1));
    this.$.play.onclick = act("play", () => control.togglePlay());
    this.$.pace.onchange = () => control.setPace(this.$.pace.value);
    this.$.rate.onchange = () => control.setRate(Number(this.$.rate.value));
    this.$.levels.onclick = (e) => { const b = e.target.closest("button"); if (b) { perf.input("focus", e.timeStamp); control.focusLevel(Number(b.dataset.level)); } };
    $("#keys").onclick = () => document.querySelector("#help")?.toggleAttribute("hidden");
    this.$.run.onchange = () => control.openRun(this.$.run.value);
    // the picker lists runs as they start and end: a new live run appears, an imported one loses its mark
    const list = () => listRuns().then((runs) => {
      const html = runs.map((r) => `<option value="${r.run}"${r.run === store.run ? " selected" : ""}>${r.status === "live" ? "● " : ""}${r.run}${r.status === "live" ? " (live)" : ""}</option>`).join("");
      if (html !== this.runsHtml && document.activeElement !== this.$.run) { this.runsHtml = html; this.$.run.innerHTML = html; }   // never under an open list
    }).catch((e) => console.error("runs", e));
    list(); setInterval(list, RUNS_POLL_MS);
    this.bindDetail(); this.bindOverview();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(this.detail);
    control.subscribe((f) => this.frame(f));
  }

  resize() {
    for (const c of [this.over, this.detail]) { const r = c.getBoundingClientRect(); c.width = Math.round(r.width * devicePixelRatio); c.height = Math.round(r.height * devicePixelRatio); }
    this.overBase = null;
    this.control.setPx(Math.round(this.detail.getBoundingClientRect().width));
    if (this.f) this.frame(this.f, true);
  }

  /** Detail strip: x -> t over the frame's window. */
  tAt(e) { const r = this.detail.getBoundingClientRect(), [a, b] = this.f.win; return a + (e.clientX - r.left) / r.width * (b - a); }

  bindDetail() {
    const d = this.detail;
    d.addEventListener("wheel", (e) => {
      e.preventDefault(); perf.input(e.deltaX && !e.deltaY ? "pan" : "zoom", e.timeStamp);
      if (e.shiftKey || (e.deltaX && !e.deltaY)) this.control.pan((e.deltaX || e.deltaY) / d.getBoundingClientRect().width * (this.f.win[1] - this.f.win[0]));
      else this.control.zoom(Math.exp(e.deltaY * 0.0015), this.tAt(e));
    }, { passive: false });
    let down = null;
    d.addEventListener("pointerdown", (e) => { d.setPointerCapture(e.pointerId); down = { x: e.clientX, moved: false }; });
    d.addEventListener("pointermove", (e) => {
      if (!down) return;
      if (Math.abs(e.clientX - down.x) > 2) down.moved = true;
      if (down.moved) { perf.input("scrub", e.timeStamp); this.control.seek(this.tAt(e)); }
    });
    d.addEventListener("pointerup", (e) => {
      if (!down) return; const moved = down.moved; down = null;
      if (moved) return;
      perf.input("scrub", e.timeStamp);
      const hit = this.nearestTick(e);
      if (hit) this.control.seekRow(hit); else this.control.seek(this.tAt(e));
    });
  }

  nearestTick(e) {
    const r = this.detail.getBoundingClientRect(), [a, b] = this.f.win, x = e.clientX - r.left, { t, id, n } = this.ticks;
    let best = -1, bd = TICK_SNAP_PX;
    for (let k = 0; k < n; k++) { const dx = Math.abs((t[k] - a) / (b - a) * r.width - x); if (dx <= bd) { bd = dx; best = k; } }
    return best < 0 ? null : { t: t[best], id: id[best] };
  }

  bindOverview() {
    const o = this.over; let grab = null;
    const tAt = (e) => { const r = o.getBoundingClientRect(), [a, b] = this.store.extent; return a + (e.clientX - r.left) / r.width * (b - a); };
    o.addEventListener("pointerdown", (e) => {
      o.setPointerCapture(e.pointerId); perf.input("pan", e.timeStamp);
      const t = tAt(e), [a, b] = this.f.win, w = b - a;
      grab = t >= a && t <= b ? t - a : w / 2;
      this.control.setWindow(t - grab, t - grab + w);
    });
    o.addEventListener("pointermove", (e) => { if (!grab && grab !== 0) return; perf.input("pan", e.timeStamp); const t = tAt(e), w = this.f.win[1] - this.f.win[0]; this.control.setWindow(t - grab, t - grab + w); });
    o.addEventListener("pointerup", () => (grab = null));
  }

  frame(f, force = false) {
    this.f = f;
    const c = f.changed;
    if (c.data) this.overBase = null;   // live rows landed: the overview density is redrawn from the store
    if (force || c.cursor || c.win || c.grain || c.px || c.data || c.lit) {
      const n = this.store.count(f.win, f.grain);
      this.$.tlabel.textContent = `${fmtMs(f.cursor.t)} / ${fmtMs(this.store.head())} · window ${fmtSpan(f.win[1] - f.win[0])}`;
      this.$.grain.textContent = `grain: ${f.grainName} · ${n} in view`;
      this.drawDetail(f); this.drawOverview(f);
    }
    if (force || c.live || c.data) {
      const [color, title] = LIVE_DOT[this.store.status !== "live" ? "final" : this.store.live?.ended ? "ended" : f.live ? "follow" : "paused"];
      this.$.live.style.background = color; this.$.live.title = title; this.$.live.setAttribute("aria-label", title);
    }
    if (force || c.play) { this.$.play.textContent = f.play.on ? "⏸ pause" : "▶ play"; this.$.play.setAttribute("aria-label", f.play.on ? "Pause" : "Play"); }
    if (force || c.focus) for (const b of this.$.levels.children) b.classList.toggle("on", Number(b.dataset.level) === f.focus);
  }

  drawDetail(f) {
    const cv = this.detail, g = cv.getContext("2d"), W = cv.width, H = cv.height, dpr = devicePixelRatio, [a, b] = f.win, w = b - a;
    g.fillStyle = "#101216"; g.fillRect(0, 0, W, H);
    const tk = this.ticks; tk.n = 0;
    const col = new Uint8Array(W);   // ticks closer than a pixel share a column; the coarsest tier there wins the colour
    this.store.scan({ win: f.win, maxTier: f.grain, starts: true }, (id) => {
      const s = this.store.startOf[id];
      if (tk.n === tk.t.length) { const t2 = new Float64Array(tk.n * 2), i2 = new Int32Array(tk.n * 2); t2.set(tk.t); i2.set(tk.id); tk.t = t2; tk.id = i2; }
      tk.t[tk.n] = s; tk.id[tk.n++] = id;
      const x = Math.min(W - 1, Math.max(0, Math.floor((s - a) / w * W))), r = this.store.field("tier", id) + 1;
      if (!col[x] || r < col[x]) col[x] = r;
    });
    for (let x = 0; x < W; x++) if (col[x]) {
      const r = col[x] - 1, h = H * (0.9 - 0.08 * r);
      g.fillStyle = TIER_COLOR[r]; g.fillRect(x, H - h, Math.max(1, dpr), h);
    }
    if (f.sel >= 0) { const s = this.store.startOf[f.sel]; if (s >= a && s <= b) { g.strokeStyle = "#ffffff"; g.lineWidth = dpr; g.strokeRect((s - a) / w * W - 3 * dpr, 1, 6 * dpr, H - 2); } }
    g.fillStyle = LIT_CSS;   // lit rows (a hover on a Metrics input): a mark over each start in the window
    for (const id of f.lit ?? []) { const s = this.store.startOf[id]; if (s >= a && s <= b) g.fillRect((s - a) / w * W - dpr, 0, 3 * dpr, H * 0.45); }
    const cx = (f.cursor.t - a) / w * W;
    g.fillStyle = "#ffd36b"; g.fillRect(cx - dpr, 0, 2 * dpr, H);
  }

  drawOverview(f) {
    const cv = this.over, g = cv.getContext("2d"), W = cv.width, H = cv.height, [a, b] = this.store.extent, x = (t) => (t - a) / (b - a) * W;
    if (this.overBase && Math.abs(b - this.overEnd) > (b - a) / W) this.overBase = null;   // a live head moved a pixel or more
    if (!this.overBase) {
      this.overEnd = b;
      const base = this.overBase = new OffscreenCanvas(W, H), o = base.getContext("2d");
      o.fillStyle = "#101216"; o.fillRect(0, 0, W, H);
      const dens = new Uint32Array(W);
      this.store.scan({ win: this.store.extent, maxTier: 2, starts: true }, (id) => { dens[Math.min(W - 1, Math.floor(x(this.store.startOf[id])))]++; });
      const max = Math.max(1, ...dens);
      o.fillStyle = "#4a8fe0"; for (let i = 0; i < W; i++) if (dens[i]) { const h = H * 0.7 * Math.log1p(dens[i]) / Math.log1p(max); o.fillRect(i, H - h, 1, h); }
      o.fillStyle = "rgba(224,184,74,0.25)";
      this.store.scan({ win: this.store.extent, maxTier: 0 }, (id) => { const x0 = x(this.store.startOf[id]), x1 = x(this.store.endOf[id]); o.fillRect(x0, 0, Math.max(1, x1 - x0), H * 0.3); });
    }
    g.drawImage(this.overBase, 0, 0);
    const x0 = x(f.win[0]), x1 = x(f.win[1]), dpr = devicePixelRatio;
    g.fillStyle = "rgba(255,211,107,0.18)"; g.fillRect(x0, 0, Math.max(2 * dpr, x1 - x0), H);
    g.strokeStyle = "#ffd36b"; g.lineWidth = dpr; g.strokeRect(x0, 0.5, Math.max(2 * dpr, x1 - x0), H - 1);
    g.fillStyle = LIT_CSS; for (const id of f.lit ?? []) g.fillRect(x(this.store.startOf[id]) - dpr, 0, 2 * dpr, H * 0.5);
    g.fillStyle = "#ffffff"; g.fillRect(x(f.cursor.t) - dpr / 2, 0, dpr, H);
  }
}
