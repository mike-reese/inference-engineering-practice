// The shared base every layout page runs: D6 store and URL, D1/D2 store queries (model.js), three.js scene (scene.js),
// and the DOM around the scene: header snap buttons, the Trace summary panel and the timeline with playback.
import { state, set, subscribe, setOrigin, readUrl } from "./state.js";
import * as model from "./model.js";
import { D, NAMES } from "./model.js";
import * as api from "./api.js";
import { Scene } from "./scene.js";
import { opts } from "../layouts.js";
import { Flyout } from "./flyout.js";
import { panelOpen } from "./levels.js";
import { router } from "/static/views/util.js";

const DEFAULT_RUN = "I02A-TRACE-timeline_20261107T172848Z_f2ac52";   // the combined capture (stamps + nsys, ncu tied)
const $ = (q) => document.querySelector(q);
const esc = (s) => String(s ?? "—").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const fmt = (ns) => Math.abs(ns) >= 1e6 ? (ns / 1e6).toFixed(3) + " ms" : (ns / 1e3).toFixed(2) + " µs";
const QP = new URLSearchParams(location.search);

export function shell(title, extra = "") {
  document.body.innerHTML = `<header><b>${title}</b><span id="snaps"></span>${extra}<a class="btn" href="../index.html">all layouts</a></header>
  <div id="main"><div id="stage"></div><aside id="side"><div id="sum"><div class="muted">loading from the store…</div></div></aside></div>
  <footer><button id="back">◀</button><button id="play">▶ play</button><button id="next">▶|</button> speed <select id="speed">${[1, 5, 20, 100].map((v) => `<option ${v === 20 ? "selected" : ""}>${v}</option>`).join("")}</select> steps/s
  <canvas id="tl"></canvas><span id="tlabel" class="muted"></span></footer>`;
}

/** @param {object} layout one of ../layouts.js  @param {string} view its name (URL #<view>) */
export async function app(layout, view) {
  const t0 = performance.now();
  const run = QP.get("run") || DEFAULT_RUN;
  set({ view, run }, { fromUrl: true });
  await model.load(run); setOrigin(D.t0);
  const u = readUrl();
  set({ t: u.t ?? (D.iters[1] || D.iters[0]).s + 200e3, sel: u.sel ?? null, container: u.container ?? "host/server" }, { fromUrl: true });
  const sc = new Scene($("#stage"), layout); window.SC = sc;
  // the v1 panels: a container card opens its components in the next level; v1 tab links move the camera
  sc.onPanelOpen = (project, service) => { const id = D.things.find((t) => t.kind === "container" && (t.name === service || t.id.endsWith("/" + service)))?.id;
    if (id) set({ container: id }); setTimeout(() => sc.snap(1), 50); };
  // v1 navigation (links, pickers, row clicks) inside the scene: places in the world move the camera; the other tabs
  // open in the flyout. The v1 views call router (views/util.js); this page points it here.
  const fly = new Flyout($("#side"), $("#sum")); window.FLY_OUT = fly;
  const PLACES = { infra: 0, components: 1, trace: 2 };
  router.go = (hash) => { const [n, ...ps] = hash.split("/").map(decodeURIComponent);
    if (n in PLACES) { if (n !== "infra" && ps.length) panelOpen(n, ps); sc.snap(PLACES[n]); fly.open("summary", []); }
    else if (!fly.open(n, ps)) console.warn("no place or tab for", hash); };
  router.hash = () => fly.hash();
  let levels = [], key = "", busy = null, again = false;

  // ---------- rebuild the levels when the open chain changes (container, iteration or kernel at the cursor)
  const chainKey = async () => { const it = model.iterAt(state.t), det = await model.iterDetail(it), k = model.kernelAt(det, state.t); return `${state.container}|${it.n}|${k?.id}`; };
  async function rebuild() {
    if (busy) { again = true; return busy; }
    busy = (async () => { do { again = false; const k = await chainKey(); if (k === key) continue; key = k; const tb = performance.now();
      const fRef = sc.P.length && layout.focus ? layout.focus(sc.P, sc) : 0, old = sc.P[fRef];
      levels = await model.build(state.t); sc.setLevels(levels); window.LEVELS = levels;
      if (opts.follow && old && sc.P[fRef] && (old.cx !== sc.P[fRef].cx || old.cy !== sc.P[fRef].cy || old.z !== sc.P[fRef].z)) {
        const dx = sc.P[fRef].cx - old.cx, dz = sc.P[fRef].cy - old.cy, dy = sc.P[fRef].z - old.z;
        sc.camera.position.x += dx; sc.camera.position.z += dz; sc.camera.position.y += dy; sc.controls.target.x += dx; sc.controls.target.z += dz; sc.controls.target.y += dy; sc.anchoring = true; sc.controls.update(); sc.anchoring = false; }
      restyle(); sc.cursor(state.t); applySel(); (window.RB ??= []).push(performance.now() - tb); } while (again); busy = null; })();
    return busy;
  }
  function restyle() { levels.forEach((l, i) => { if (l.hw) return; sc.recolor(i, (b) => b === l.open ? { dim: 0.45 } : b.peer && l.open ? { dim: opts.sib === "dim" ? 0.6 : opts.sib === "hide" ? 1 : 0 } : null); }); }
  function applySel() { if (!state.sel) return sc.select(null); for (let i = levels.length - 1; i >= 0; i--) { const b = levels[i].items.find((x) => x.eid === state.sel || x.id === state.sel); if (b) return sc.select(i, b); } sc.select(null); }

  // ---------- cursor: cheap path (cursor lines, lit parts, panel) unless the open chain changed
  let cq = 0;
  async function onCursor() {
    await rebuild(); sc.cursor(state.t); timeline();
    const my = ++cq, c = await model.atCursor(state.t, levels); if (my !== cq) return;
    light(c); summary(c);
  }
  function light(c) {
    const act = new Set(c.lanes.filter((r) => r.active).map((r) => { const e = D.trace.find((x) => x.id === r.id); return e && e.a.box ? r.thing_id + "#" + e.a.box : null; }).filter(Boolean));
    if (levels[1]) sc.recolor(1, (b) => (b.comp && act.has(b.id) ? { col: "#ffd36b" } : null));
    const hw = levels[6]; if (!hw) return; const sms = D.things.filter((t) => t.kind === "SM").length, g = (m) => c.nc?.[m]?.value;
    const nsm = c.inK && c.nc ? Math.min(sms, g("launch__grid_size") || 0) : Math.round((c.s["SMs Active [Throughput %]"] || 0) / 100 * sms);
    sc.recolor(6, (b) => (b.sm != null && b.sm < nsm ? { col: "#5e81ac" } : null));
    const at = (id) => hw.items.find((b) => b.id === id), lw = (b) => (b > 0 ? Math.log2(b / 1024 + 1) * 1.6 : 0), F = [];
    if (c.inK && c.nc) { F.push([at("gpu0/vram"), at("gpu0/l2"), lw(g("dram__bytes_op_read.sum")), "#88c0d0"], [at("gpu0/l2"), at("gpu0#die"), lw(g("lts__t_bytes.sum")), "#a3be8c"], [at("gpu0#die"), at("gpu0/vram"), lw(g("dram__bytes_op_write.sum")), "#d08770"]); }
    else if (c.s["DRAM Read Bandwidth [Throughput %]"] != null) F.push([at("gpu0/vram"), at("gpu0/l2"), c.s["DRAM Read Bandwidth [Throughput %]"] / 5, "#88c0d0"]);
    if (c.s["PCIe RX Throughput [Throughput %]"] != null) F.push([at("host/cpu"), at("host/pcie-gpu"), c.s["PCIe RX Throughput [Throughput %]"] * 2, "#ebcb8b"]);
    sc.flows(6, F.filter((f) => f[0] && f[1]));
    c.nsm = nsm; c.sms = sms;
  }
  function summary(c) {
    const it = c.it, sh = it.share, m = D.meta.measures["iteration share"], k = c.k, g = (x) => c.nc?.[x]?.value;
    const lane = (r) => `<tr><td>${esc(r.thing_id)}</td><td>${r.active ? `<b>${esc(r.name)}</b> (active)` : `last: ${esc(r.name)} (${fmt(c.t - (r.end_ns ?? r.start_ns))} ago)`}</td></tr>`;
    $("#sum").innerHTML = `<div class="sh">At the cursor: ${fmt(c.t - D.t0)} from the request start</div>
    <div>iteration <b>${it.n}</b> · ${it.phase} · ${fmt(it.e - it.s)} <span class="tag">Observed stamps + NVTX</span></div>
    <div>iteration share of this request: <b>${sh ? sh.share.toFixed(3) : "—"}</b> (${sh ? `${sh.tokens} of ${sh.iteration_tokens} tokens` : "no scheduler stamp"}) <span class="tag">Calculated</span>
      <details><summary>formula</summary><code>${esc(m?.formula)}</code><div class="muted">${esc(m?.evidence)} · additivity: ${esc(m?.additivity)}</div></details></div>
    <div>kernel ${c.inK ? "running" : "last started"}: <b>${esc(k?.name)}</b> ${k ? fmt(k.end - k.start_ns) : ""} <span class="tag">Observed nsys</span><div class="muted">${esc(k?.eid)}</div></div>
    ${c.nc ? `<div>bytes: DRAM read ${model.kib(g("dram__bytes_op_read.sum"))} · write ${model.kib(g("dram__bytes_op_write.sum"))} · L2 ${model.kib(g("lts__t_bytes.sum"))} <span class="tag">Observed ncu replay, tie Inferred</span></div>` : `<div class="muted">kernel counters: Unavailable outside iteration ${D.meta.ncu?.iteration ?? "—"}</div>`}
    <div>KV: ${c.kv ? `${((c.kv.a.stamp?.requests || [])[0]?.blocks || []).length} blocks; pool free ${c.kv.a.stamp?.free_blocks ?? "not recorded"}` : "no blocks yet"} <span class="tag">Observed kv_cache stamp</span></div>
    ${Object.keys(c.s).length ? `<div>GPU (nsys metrics, ±150 µs): SMs active ${(c.s["SMs Active [Throughput %]"] ?? NaN).toFixed(0)}% · tensor ${(c.s["Tensor Active [Throughput %]"] ?? NaN).toFixed(0)}% · DRAM read ${(c.s["DRAM Read Bandwidth [Throughput %]"] ?? NaN).toFixed(0)}% · PCIe RX ${(c.s["PCIe RX Throughput [Throughput %]"] ?? NaN).toFixed(0)}% <span class="tag">Observed</span></div>` : ""}
    <div>SMs lit: ${c.nsm ?? "—"} of ${c.sms ?? "—"} (${c.inK && c.nc ? "ncu grid size, Inferred" : "nsys SMs Active × SM count, Calculated"})</div>
    <div>tokens streamed to the client so far: ${c.toks} <span class="tag">Observed</span></div>
    <table>${c.lanes.filter((r) => !r.thing_id.startsWith("server pid 0")).slice(0, 40).map(lane).join("")}</table>
    <div id="selbox"></div>
    <div class="sh">Store</div><div class="muted">run ${esc(D.run)} · ${D.meta.counts.events} events · query p50 ${Object.entries(api.timings).map(([p, v]) => `${p} ${med(v).toFixed(0)} ms`).join(" · ")}</div>`;
    selPanel();
  }
  async function selPanel() { const box = $("#selbox"); if (!box || !state.sel) return; const e = state.sel.includes("/") && !D.byId.has(state.sel) ? await api.event(D.run, state.sel) : null;
    const th = D.byId.get(state.sel);
    box.innerHTML = `<div class="sh">Selected</div>` + (e ? `<div><b>${esc(e.event.name)}</b><br><code>${esc(e.event.eid)}</code><br>${esc(e.event.what)}<br><span class="muted">${esc(e.event.evidence)}</span>
      ${e.parents.length ? `<div class="muted">inside: ${e.parents.map((p) => esc(p.name)).join(" ← ")}</div>` : ""}</div>` : th ? `<div><b>${esc(th.name)}</b> · ${esc(th.kind)}<br><code>${esc(th.id)}</code><br><span class="muted">${esc(th.evidence)}</span></div>` : `<div><code>${esc(state.sel)}</code></div>`); }
  const med = (v) => { const b = v.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)] || 0; };

  // ---------- timeline (DOM canvas, outside the scene) and playback
  const tl = $("#tl"), tctx = tl.getContext("2d"); let scrub = false;
  function timeline() { const d = devicePixelRatio || 1, w = tl.clientWidth, h = tl.clientHeight; tl.width = w * d; tl.height = h * d; tctx.setTransform(d, 0, 0, d, 0, 0); tctx.clearRect(0, 0, w, h);
    const X = (t) => (t - D.t0) / (D.t1 - D.t0) * w; tctx.fillStyle = "#a3be8c88"; D.iters.forEach((it) => tctx.fillRect(X(it.s), 6, Math.max(1, X(it.e) - X(it.s) - 1), h - 12));
    tctx.fillStyle = "#88c0d0"; D.trace.forEach((e) => { if (e.start_ns >= D.t0 && e.start_ns <= D.t1) tctx.fillRect(X(e.start_ns), h - 6, 1, 4); }); tctx.fillStyle = "#e5484d"; tctx.fillRect(X(state.t) - 1, 0, 2, h);
    $("#tlabel").textContent = `${fmt(state.t - D.t0)} / ${fmt(D.t1 - D.t0)} · step: ${deepest() >= 4 ? "kernels" : "stamps"}`; }
  const setT = (e) => { const r = tl.getBoundingClientRect(); set({ t: D.t0 + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (D.t1 - D.t0) }); };
  tl.onpointerdown = (e) => { scrub = true; setT(e); tl.setPointerCapture(e.pointerId); }; tl.onpointermove = (e) => scrub && setT(e); tl.onpointerup = () => (scrub = false);
  const deepest = () => (layout.focus ? layout.focus(sc.P, sc) : 0);
  const stampT = D.trace.filter((e) => e.start_ns >= D.t0 && e.start_ns <= D.t1).map((e) => e.start_ns).sort((a, b) => a - b);
  async function go(dir) { let st = stampT;
    if (deepest() >= 4) { const it = model.iterAt(state.t), det = await model.iterDetail(it); st = det.kernels.map((k) => k.start_ns);
      const j = D.iters.indexOf(it), nx = D.iters[j + dir]; if (nx) st = dir > 0 ? [...st, nx.s] : [nx.s, ...st]; }
    let k = dir > 0 ? st.findIndex((x) => x > state.t + 1) : st.findLastIndex((x) => x < state.t - 1); if (k < 0) k = dir > 0 ? st.length - 1 : 0; set({ t: st[k] }); }
  let timer = null;
  function play() { if (timer) { clearInterval(timer); timer = null; $("#play").textContent = "▶ play"; set({ playing: false }); return; }
    $("#play").textContent = "⏸ pause"; set({ playing: true }); timer = setInterval(() => { if (state.t >= D.t1) return play(); go(1); }, 1000 / state.speed); }
  $("#back").onclick = () => go(-1); $("#next").onclick = () => go(1); $("#play").onclick = play;
  $("#speed").onchange = (e) => { set({ speed: +e.target.value }); if (timer) { play(); play(); } };
  window.PLAY = (sp) => { set({ speed: sp }); play(); };

  // ---------- header snap buttons, toggles
  $("#snaps").innerHTML = NAMES.map((n, i) => `<button data-i="${i}">${i + 1} ${n}</button>`).join("");
  $("#snaps").onclick = (e) => { const i = e.target.dataset.i; if (i != null) sc.snap(+i); };
  window.SNAP = (i) => sc.snap(i);
  for (const k of ["fade", "sib"]) { const el = $("#" + k); if (el) el.onchange = (e) => { opts[k] = e.target.value; restyle(); sc.request(); }; }
  const fo = $("#follow"); if (fo) fo.onchange = (e) => { opts.follow = e.target.checked; };

  // ---------- pointer: MapControls pans, dollies and orbits; a click without a drag picks (Raycaster)
  const cv = $("#stage"); let down = null; const inPanel = (e) => e.composedPath().some((n) => n.classList?.contains("v1panel"));
  cv.addEventListener("pointerdown", (e) => (down = inPanel(e) ? null : { x: e.clientX, y: e.clientY }));
  cv.addEventListener("pointerup", (e) => { if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return; down = null;
    const h = sc.pick(e.clientX, e.clientY); if (!h) return; const b = h.b, patch = { sel: b.eid || b.id || null };
    if (h.L === 0 && b.peer && b.id) patch.container = b.id;
    if (b.t0 != null) { const l = levels[h.L]; patch.t = l.X && l.win ? Math.max(b.t0, Math.min(b.t1 ?? b.t0, l.win[0] + (h.lx + 480) / 960 * (l.win[1] - l.win[0]))) : b.t0; }
    set(patch); });
  // input-to-frame measurement (the owner's 16 ms rule): wheel timestamp -> end of the frame that drew it
  let pend = []; window.LATS = []; window.LATH = []; window.FT = [];
  cv.addEventListener("wheel", (e) => pend.push([e.timeStamp, performance.now()]), { passive: true, capture: true });
  sc.onFrame.push((ta, tb) => { window.FT.push(tb - ta); for (const [ts, th] of pend) { window.LATS.push(tb - ts); window.LATH.push(tb - th); } pend = []; });
  let zt = 0; sc.controls.addEventListener("change", () => { clearTimeout(zt); zt = setTimeout(() => { const c = sc.camera.position, g = sc.controls.target; set({ z: [c.x, c.y, c.z, g.x, g.y, g.z] }); }, 120); timelineLabelOnly(); });
  const timelineLabelOnly = () => { $("#tlabel").textContent = `${fmt(state.t - D.t0)} / ${fmt(D.t1 - D.t0)} · step: ${deepest() >= 4 ? "kernels" : "stamps"}`; };

  // ---------- store -> view
  subscribe(async (keys) => {
    if (keys.has("t") || keys.has("container")) onCursor();
    if (keys.has("sel")) { applySel(); selPanel(); }
    if (keys.has("z") && state.z && !sc._settingZ) { const c = sc.camera.position; if (state.z[0] !== c.x || state.z[1] !== c.y || state.z[2] !== c.z) sc.setCamera(state.z); }
  });

  // ---------- bench hooks: fly L1 -> L7 through the snap poses
  window.FLY = (N = 300) => new Promise((done) => { const T = []; const n = levels.length - (layout.views ? 1 : 0);
    for (let i = 0; i < n; i++) { sc.snap(i); T.push([sc.camera.position.clone(), sc.controls.target.clone()]); }
    const seg = T.length - 1, iv = []; let f = 0, last = 0; window.FT = [];
    const step = (now) => { const u = f / (N - 1) * seg, k = Math.min(seg - 1, Math.floor(u)), w = u - k, [A, At] = T[k], [B, Bt] = T[k + 1];
      const ha = A.y - At.y, hb = B.y - Bt.y, h = Math.exp(Math.log(ha) + (Math.log(hb) - Math.log(ha)) * w), ww = Math.abs(hb - ha) > 0 ? (ha - h) / (ha - hb) : w;
      const tg = At.clone().lerp(Bt, ww); sc.anchoring = true; sc.controls.target.copy(tg); sc.camera.position.set(tg.x, tg.y + h, tg.z + h * 1e-6); sc.controls.update(); sc.anchoring = false; sc.request();
      if (last) iv.push(now - last); last = now;
      if (++f < N) requestAnimationFrame(step); else requestAnimationFrame(() => { const q = (a, p) => { const b = a.slice().sort((x, y) => x - y); return +(b[Math.min(b.length - 1, Math.floor(b.length * p))] ?? NaN).toFixed(2); };
        done({ frames: N, frame_p50: q(iv, 0.5), frame_p95: q(iv, 0.95), draw_p50: q(window.FT, 0.5), draw_p95: q(window.FT, 0.95), draw_max: q(window.FT, 1) }); }); };
    requestAnimationFrame(step); });

  await rebuild();
  if (u.z) sc.setCamera(u.z); else sc.snap(0);
  history.replaceState(null, "", location.pathname + location.search + `#${view}?t=${Math.round(state.t - D.t0)}`);
  onCursor();
  window.QT = api.timings; window.DEEPEST = deepest; window.T_FIRST = performance.now() - t0; window.READY = true;
}
