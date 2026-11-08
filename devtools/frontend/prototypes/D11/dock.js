import { state, subscribe, setDock, select, selectMetric, now, tierName, data, DIM_COLOR } from "./model.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ms = (us, d = 3) => (us / 1000).toFixed(d);
const json = (o) => `<pre class="json">${esc(JSON.stringify(o, null, 2))}</pre>`;
const ARCH_IDS = new Set(data.ARCH.map((a) => a.id)), HW_IDS = new Set(data.HW.map((h) => h.id));
const SEG_COLORS = ["#58a6ff", "#3fb950", "#d29922", "#bc8cff", "#f778ba"];

const CSS = `
#dock { display:flex; flex-direction:column; position:relative; }
.dk-bar { display:flex; align-items:center; gap:4px; padding:0 8px; border-bottom:1px solid var(--line); min-height:33px; background:var(--bg); }
.dk-bar nav button { background:none; border:0; color:var(--dim); font:inherit; cursor:pointer; padding:6px 8px; }
.dk-bar nav button.on { color:var(--text); border-bottom:2px solid var(--accent); }
.dk-bar nav { display:flex; flex-shrink:0; }
.dk-bar .sp { flex:1; min-width:0; text-align:right; color:var(--dim); font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dk-bar > button { background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:4px; font:inherit; padding:1px 8px; cursor:pointer; }
.dk-bar > button.on { border-color:var(--accent); color:var(--accent); }
.dk-body { flex:1; min-height:0; overflow:auto; padding:8px 12px; }
.dk-grip { position:absolute; z-index:5; background:transparent; }
body.dock-bottom .dk-grip { left:0; right:0; top:-3px; height:6px; cursor:ns-resize; }
body.dock-right .dk-grip { top:0; bottom:0; left:-3px; width:6px; cursor:ew-resize; }
.dk-grip:hover { background:var(--accent); }
body.dock-closed .dk-body, body.dock-closed .dk-grip { display:none; }
body.dock-closed.dock-right .dk-bar { flex-direction:column; padding:4px 0; } body.dock-closed.dock-right .dk-bar > :not(.dk-collapse) { display:none; }
.dk-sel { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:12px; }
body.dock-right .dk-sel, body.dock-right .dk-cp { grid-template-columns:1fr; }
.dk-sel .detail, .dk-sel .nowcol { border:1px solid var(--line); border-radius:6px; padding:8px 10px; min-width:0; }
.dk-sel h3 { margin:2px 0 6px; font-size:14px; }
.label { color:var(--dim); font-size:11px; text-transform:uppercase; margin:8px 0 4px; } .label:first-child { margin-top:0; }
.dim { color:var(--dim); }
a.go { color:var(--accent); cursor:pointer; text-decoration:none; } a.go:hover { text-decoration:underline; }
a.go.on { color:#e3b341; }
ol.path { margin:2px 0; padding-left:18px; } ol.path li::marker { color:var(--dim); }
.kv { border-collapse:collapse; } .kv td { padding:1px 10px 1px 0; border-bottom:1px solid var(--line); white-space:nowrap; } .kv td:first-child { color:var(--dim); }
.chips { display:flex; flex-wrap:wrap; gap:3px; margin-bottom:6px; } .chips span { background:#1d2633; border:1px solid #2d5a8a; border-radius:3px; padding:0 4px; font-size:11px; }
pre.json, pre.payload { background:var(--panel); border:1px solid var(--line); padding:6px; max-height:30vh; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font-size:11px; margin:0 0 6px; }
.dk-body pre.json, .dk-body pre.payload { background:var(--bg); }
table.sched, table.metrics { border-collapse:collapse; } table.sched td, table.sched th { padding:1px 6px; border-bottom:1px solid var(--line); text-align:left; }
table.metrics { width:100%; margin-top:6px; } table.metrics td, table.metrics th { text-align:left; padding:2px 8px 2px 0; border-bottom:1px solid var(--line); white-space:nowrap; }
table.metrics th { color:var(--dim); font-weight:normal; } table.metrics tr[data-m] { cursor:pointer; } table.metrics tr.on td { color:var(--accent); }
table.metrics th.scr, table.metrics td.scr { background:#58a6ff10; } table.metrics th.ref, table.metrics td.ref { background:#3fb95010; }
table.metrics tr.on td.inp a { color:#f778ba; }
.bar { display:inline-block; width:80px; height:6px; background:var(--line); border-radius:3px; overflow:hidden; vertical-align:middle; } .bar span { display:block; height:100%; background:var(--accent); }
.card { background:var(--panel); border:1px solid var(--line); border-left:4px solid var(--up); border-radius:4px; padding:6px 8px; margin-top:6px; }
.card .title { font-weight:bold; display:flex; gap:6px; align-items:center; } .card .state { margin-left:auto; font-weight:normal; color:var(--dim); }
.card .image { color:var(--dim); font-size:11px; }
.pdot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:4px; }
.segbar { display:flex; height:22px; margin:4px 0; } .seg { color:#0f1115; font-size:10px; overflow:hidden; cursor:pointer; padding-left:2px; white-space:nowrap; }
.seg.on { outline:2px solid #fff; outline-offset:-2px; }
.segleg { display:flex; flex-wrap:wrap; gap:4px 12px; font-size:11px; color:var(--dim); } .segleg i { display:inline-block; width:10px; height:10px; margin-right:4px; vertical-align:middle; }
details { border:1px solid var(--line); border-radius:6px; padding:6px; margin-bottom:8px; } summary { cursor:pointer; }
.dk-cp { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:8px; }
.dk-cp .ph { border:1px dashed var(--line); border-radius:6px; padding:8px; } .dk-cp .ph b { display:block; }
.dk-cp .ph .tag { color:var(--starting); font-size:11px; }
`;

function kindOf(x) {
  if (!x) return null;
  if (ARCH_IDS.has(x.id)) return { dim: "architecture", tier: data.LADDERS.architecture[x.tier] };
  if (HW_IDS.has(x.id)) return { dim: "hardware", tier: data.LADDERS.hardware[x.tier] };
  if (x.id.startsWith("x")) return { dim: "hardware", tier: "transfer (kernel traffic)" };
  return { dim: "execution", tier: data.LADDERS.execution[x.tier] };
}
const link = (id, text) => `<a class="go ${id === state.sel ? "on" : ""}" data-sel="${esc(id)}">${esc(text ?? data.byId.get(id)?.name ?? id)}</a>`;
const chain = (id) => { const out = []; for (let x = data.byId.get(id); x; x = data.byId.get(x.parent)) out.unshift(x); return out; };

/** The data a step carries, in the v1 Trace style: token IDs as chips, text as text, SSE events, the scheduler table. */
function inspect(comp, d) {
  const chips = (a) => `<div class="chips">${a.map((t) => `<span>${esc(t)}</span>`).join("")}</div>`;
  const parts = [], rest = { ...d };
  for (const key of ["token_ids", "prompt_token_ids", "new_token_ids"]) {
    if (Array.isArray(d[key])) { parts.push(`<div class="label">${key} (${d[key].length})</div>${chips(d[key])}`); delete rest[key]; }
  }
  if (typeof d.text === "string") { parts.push(`<div class="label">templated text (what the tokenizer reads)</div><pre class="payload">${esc(d.text)}</pre>`); delete rest.text; }
  for (const key of ["body", "new_text", "headers"]) if (typeof d[key] === "string") { parts.push(`<div class="label">${key}</div><pre class="payload">${esc(d[key])}</pre>`); delete rest[key]; }
  if (Array.isArray(d.events)) { parts.push(`<div class="label">SSE events</div><pre class="payload">${esc(d.events.join(""))}</pre>`); delete rest.events; }
  if (Array.isArray(d.table)) {
    parts.push(`<div class="label">scheduler decision</div><table class="sched"><tr><th>cid</th><th>state</th><th>prompt</th><th>KV blocks</th></tr>
      ${d.table.map((r) => `<tr><td>${r.cid}</td><td>${esc(r.state)}</td><td>${r.prompt_len}</td><td>${r.kv_blocks}</td></tr>`).join("")}</table>`);
    delete rest.table;
  }
  if (Object.keys(rest).length) parts.push(json(rest));
  return parts.join("");
}

function detail(x) {
  if (!x) return `<p class="dim">Nothing selected. Step with ← → or click a stop, a tier, or a thing in the world.</p>`;
  const k = kindOf(x);
  const span = x.t0 != null ? `<div>at <b>${ms(x.t0)} ms</b> from send${x.t1 != null ? `, lasts <b>${ms(x.t1 - x.t0)} ms</b> (${(x.t1 - x.t0).toFixed(0)} µs)` : ""}</div>` : "";
  const parts = [`<div class="label" style="color:${DIM_COLOR[k.dim]}">${k.dim} · ${esc(k.tier)}</div><h3>${esc(x.name ?? x.what)}</h3>${span}`];
  const p = x.comp && data.PAYLOADS[x.comp];
  if (p) parts.push(`<div class="label">payload at ${esc(data.byId.get(x.comp)?.name)} (scratch, I02A request shape)</div>${inspect(x.comp, p)}`);
  if (x.gpu) {
    const g = x.gpu;
    parts.push(`<div class="label">kernel</div><table class="kv">
      <tr><td>grid</td><td>${g.grid} blocks</td></tr><tr><td>SMs</td><td>${g.sms} of 36</td></tr>
      <tr><td>DRAM</td><td>${g.dramMB} MB</td></tr><tr><td>L2</td><td>${g.l2MB} MB</td></tr>
      <tr><td>occupancy</td><td>${(g.occ * 100).toFixed(0)}% <span class="bar"><span style="width:${g.occ * 100}%"></span></span></td></tr>
      <tr><td>kind</td><td>${g.kind}</td></tr><tr><td>profiled</td><td>${g.profiled ? "yes (Nsight Compute)" : "no"}</td></tr>
      <tr><td>launch call</td><td><code>${esc(x.launch)}</code> at ${ms(x.cpuT)} ms (CPU), runs ${ms(x.t0 - x.cpuT)} ms later</td></tr></table>`);
  }
  if (k.dim === "execution") {
    parts.push(`<div class="label">up the execution ladder</div><ol class="path">${chain(x.id).map((u) =>
      `<li><span class="dim">${data.LADDERS.execution[u.tier]}</span> ${link(u.id)}</li>`).join("")}</ol>`);
    const proc = data.processOf(x.comp);
    parts.push(`<div class="label">architecture: where it runs</div><ol class="path">${chain(x.comp).filter((a) => a.tier >= 2).map((a) =>
      `<li><span class="dim">${data.LADDERS.architecture[a.tier]}</span> ${a.id === proc ? `<span class="pdot" style="background:${data.PROCESS_COLOR[proc]}"></span>` : ""}${link(a.id)}</li>`).join("")}</ol>`);
    parts.push(`<div class="label">hardware it ran on</div><div>${x.hw.map((h) => link(h)).join(" · ")}</div>`);
  }
  if (x.from) parts.push(`<table class="kv"><tr><td>from</td><td>${link(x.from)}</td></tr><tr><td>to</td><td>${link(x.to)}</td></tr><tr><td>bytes</td><td>${x.bytes} B</td></tr></table>`);
  if (k.dim !== "execution" && x.parent) parts.push(`<div class="label">parents</div><ol class="path">${chain(x.id).slice(0, -1).map((a) => `<li>${link(a.id)}</li>`).join("")}</ol>`);
  if (k.dim === "architecture") {
    const c = data.CONTAINERS.find((c) => c.id === x.id);
    if (c) parts.push(card(c, now().sampleIndex));
    const ran = data.EXEC.filter((u) => u.tier === 2 && chain(u.comp).some((a) => a.id === x.id));
    if (ran.length) parts.push(`<div class="label">phases here (${ran.length})</div><div>${ran.map((u) => link(u.id, `${ms(u.t0)} ${u.name}`)).join("<br>")}</div>`);
  }
  return parts.join("");
}

function card(c, i) {
  const mib = (b) => (b / 2 ** 20).toFixed(0);
  return `<div class="card"><div class="title">${esc(c.service)}<span class="state">${c.state}${c.health ? ` · ${c.health}` : ""}</span></div>
    <div class="image">${esc(c.image)} · ${esc(c.project)}</div>
    <div>cpu ${c.cpu[i].toFixed(1)}% · mem ${mib(c.mem[i])} / ${mib(c.memLimit)} MiB${c.rx ? ` · rx ${c.rx[i].toFixed(0)} tx ${c.tx[i].toFixed(0)} B/s` : ""}</div>
    ${c.gpu ? `<div style="color:var(--accent)">GPU held: ${c.gpu.mib} MiB · ${esc(c.gpu.program)} pid ${c.gpu.pid} · util ${c.gpu.util[i].toFixed(0)}%</div>` : ""}</div>`;
}

function nowCol() {
  const n = now(), smp = n.sample;
  const bar = (v) => `<span class="bar"><span style="width:${Math.round(v * 100)}%"></span></span> ${Math.round(v * 100)}%`;
  const exec = n.exec.map((u, i) => `<tr><td>${data.LADDERS.execution[i]}</td><td>${u ? link(u.id) : "–"}</td></tr>`).join("");
  const proc = n.process, cont = n.archPath.find((id) => data.byId.get(id)?.tier === 2);
  const c = data.CONTAINERS.find((c) => c.id === cont);
  return `<div class="label">now at t = ${ms(state.t)} ms (everything true at the cursor)</div>
    <div class="label" style="color:${DIM_COLOR.execution}">execution</div><table class="kv">${exec}</table>
    <div class="label" style="color:${DIM_COLOR.hardware}">hardware · sample ${n.sampleIndex}, every 100 <span style="text-transform:none">µs</span> (state, not a stop)</div>
    <table class="kv"><tr><td>SM active</td><td>${smp.smActive}/36</td></tr><tr><td>GPU util</td><td>${bar(smp.gpuUtil)}</td></tr>
      <tr><td>DRAM bw</td><td>${bar(smp.dram)}</td></tr><tr><td>PCIe</td><td>${bar(smp.pcie)}</td></tr><tr><td>CPU</td><td>${bar(smp.cpu)}</td></tr>
      <tr><td>VRAM</td><td>${smp.vramGiB} GiB</td></tr>
      <tr><td>kernel</td><td>${n.kernel ? link(n.kernel.id) : "none running"}</td></tr>
      <tr><td>transfer</td><td>${n.transfers.map((x) => link(x.id, `${x.what}, ${x.bytes} B`)).join("<br>") || "none in flight"}</td></tr></table>
    <div class="label" style="color:${DIM_COLOR.architecture}">architecture</div>
    <ol class="path">${n.archPath.map((id) => `<li>${id === proc ? `<span class="pdot" style="background:${data.PROCESS_COLOR[proc]}"></span>` : ""}${link(id)}</li>`).join("")}</ol>
    ${c ? card(c, n.sampleIndex) : ""}`;
}

function ttftSegments(val) {
  const M = Object.fromEntries(data.METRICS.map((m) => [m.id, m]));
  const v = (id) => val(M[id]);
  return [
    ["server + network outside engine", v("ttft.wire") - v("ttft.engine"), "ttft.wire", "TTFT wire - TTFT engine"],
    ["engine queue", v("queue"), "queue", "Queue"],
    ["prefill", v("prefill"), "prefill", "Prefill forward"],
    ["engine rest (sample, emit)", v("ttft.engine") - v("queue") - v("prefill"), "ttft.engine", "TTFT engine - queue - prefill"],
    ["client receive", v("ttft.client") - v("ttft.wire"), "ttft.client", "TTFT client - TTFT wire"],
  ].map(([name, value, id, formula], i) => ({ name, value: Math.max(0, value), id, formula, color: SEG_COLORS[i] }));
}

function segbar(title, segs, unit) {
  const total = segs.reduce((a, s) => a + s.value, 0);
  return `<div class="label">${title}</div><div class="segbar">${segs.map((s) => `<span class="seg ${state.metric === s.id ? "on" : ""}" data-m="${s.id}"
      style="width:${(100 * s.value) / total}%;background:${s.color}" title="${esc(s.name)} = ${esc(s.formula)}: ${unit(s.value)}">${unit(s.value)}</span>`).join("")}</div>
    <div class="dim">client TTFT ${unit(total)} = the ${segs.length} segments above (click one)</div>`;
}

function metrics() {
  const lit = state.metric;
  const segs = `${segbar("TTFT split · <span style='color:#58a6ff'>scratch</span> (this timeline)", ttftSegments((m) => m.value), (us) => `${ms(us)} ms`)}
    ${segbar(`TTFT split · <span style='color:#3fb950'>measured</span> (run ${data.REFERENCE_RUN})`, ttftSegments((m) => m.ref.ms * 1000), (us) => `${ms(us)} ms`)}
    <div class="segleg">${ttftSegments((m) => m.value).map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)} = ${esc(s.formula)}</span>`).join("")}</div>`;
  const rows = data.METRICS.map((m) => `<tr data-m="${m.id}" class="${lit === m.id ? "on" : ""}">
    <td>${esc(m.name)}</td><td>${esc(m.clock)}</td><td><code>${esc(m.formula)}</code></td>
    <td class="scr">${ms(m.value)} ms <span class="dim">(${m.value.toFixed(0)} µs)</span></td>
    <td class="inp">${m.inputs.map((id) => link(id, data.byId.get(id).name.slice(0, 28))).join("<br>")}</td>
    <td class="ref">${m.ref.ms.toFixed(3)} ms</td><td class="ref dim">${esc(m.ref.src)}</td></tr>`).join("");
  return `<details open><summary>metrics as they are calculated (I02A)</summary>${segs}
    <table class="metrics"><tr><th>metric</th><th>clock</th><th>formula</th><th class="scr">scratch value (this timeline)</th><th>inputs (click)</th>
      <th class="ref" colspan="2">measured, run ${esc(data.REFERENCE_RUN)} · source</th></tr>${rows}</table>
    <div class="dim">Scratch values are computed on this prototype's made-up timeline. Measured values come from the real I02A run, for reference only; they are not on this timeline.</div></details>`;
}

function controlPlane() {
  const ph = (name, what) => `<div class="ph"><b>${name}</b><span class="tag">placeholder · visuals TBD (owner)</span><div class="dim">${what}</div></div>`;
  return `<div class="label">outside the world: the control plane</div><div class="dk-cp">
    ${ph("Run picker", `which run the world shows · now: scratch data (reference ${esc(data.REFERENCE_RUN)})`)}
    ${ph("Rep launcher", "start a rep or experiment (v1 Run tab)")}
    ${ph("Compare", "split into two worlds, one run each")}
    ${ph("Logs", "container logs at the cursor")}
    ${ph("Tools", "Grafana, Prometheus, Nsight Systems / Compute")}
    ${ph("Lifecycle", "container start, health, stop")}</div>`;
}

const TABS = [["selection", "Selection"], ["metrics", "Metrics"], ["control", "Control plane"]];

export function mountDock(el) {
  const css = document.createElement("style"); css.textContent = CSS; document.head.append(css);
  el.innerHTML = `<div class="dk-grip" title="drag to resize"></div><div class="dk-bar"></div><div class="dk-body"></div>`;
  const bar = el.querySelector(".dk-bar"), body = el.querySelector(".dk-body"), grip = el.querySelector(".dk-grip");

  el.addEventListener("click", (e) => {
    const a = e.target.closest("[data-sel]");
    if (a) { e.stopPropagation(); select(a.dataset.sel); return; }
    const m = e.target.closest("[data-m]");
    if (m) { selectMetric(m.dataset.m); return; }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "tab") setDock({ tab: b.dataset.tab, open: true });
    else if (b.dataset.act === "pos") setDock({ pos: b.dataset.pos });
    else if (b.dataset.act === "open") setDock({ open: !state.dock.open });
  });

  grip.addEventListener("pointerdown", (e) => {
    grip.setPointerCapture(e.pointerId);
    const right = state.dock.pos === "right", root = document.documentElement.style;
    const move = (ev) => right ? root.setProperty("--dock-w", `${Math.max(300, innerWidth - ev.clientX)}px`)
      : root.setProperty("--dock-h", `${Math.max(120, Math.min(innerHeight - 200, innerHeight - ev.clientY))}px`);
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", () => grip.removeEventListener("pointermove", move), { once: true });
  });

  subscribe((s) => {
    const d = s.dock, x = data.byId.get(s.sel);
    bar.innerHTML = `<nav>${TABS.map(([id, name]) => `<button data-act="tab" data-tab="${id}" class="${d.tab === id ? "on" : ""}">${name}</button>`).join("")}</nav>
      <span class="sp">${x ? `selected: ${esc(x.name ?? x.what)} · ` : ""}t = ${ms(s.t)} ms · ${s.focus} › ${esc(tierName())}</span>
      <button data-act="pos" data-pos="bottom" class="${d.pos === "bottom" ? "on" : ""}" title="dock at the bottom">⬓</button>
      <button data-act="pos" data-pos="right" class="${d.pos === "right" ? "on" : ""}" title="dock on the right">◨</button>
      <button class="dk-collapse" data-act="open" title="${d.open ? "collapse" : "expand"} the dock">${d.open ? "▾" : "▴"}</button>`;
    if (!d.open) return;
    const top = body.scrollTop;
    body.innerHTML = d.tab === "metrics" ? metrics() : d.tab === "control" ? controlPlane()
      : `<div class="dk-sel"><section class="detail">${detail(x)}</section><section class="nowcol">${nowCol()}</section></div>`;
    body.scrollTop = top;
  });
}
