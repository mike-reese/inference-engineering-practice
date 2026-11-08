import { state, subscribe, setDock, select, seek, step, selectMetric, goBack, goForward, now, tierName, stops, eventsIn, togglePlay, setPace, setRate,
  metricInputs, setWorld, data, DIM_COLOR } from "./model.js";
import { repOf, runOf, kindOf as runKind, whenOf, esc as escS } from "./session.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ms = (us, d = 3) => (us / 1000).toFixed(d);
const span = (us) => (us >= 1000 ? `${ms(us)} ms` : `${us.toFixed(0)} µs`);
const json = (o) => `<pre class="json">${esc(JSON.stringify(o, null, 2))}</pre>`;
const tag = (t) => `<span class="tag">${esc(t)}</span>`;
const ARCH_IDS = new Set(data.ARCH.map((a) => a.id)), HW_IDS = new Set(data.HW.map((h) => h.id));
const SEG_COLORS = ["#58a6ff", "#3fb950", "#d29922", "#bc8cff", "#f778ba"];
const TIER_COLOR = ["#e0b84a", "#58b368", "#4a8fe0", "#9b6fd6", "#d6896f", "#e05a7a", "#7f8a96"];
const rowY = (u) => 3 + 5 * (u.tier ?? 6);
const RATES = [0.25, 0.5, 1, 2, 4];
const OLD_TAB = { selection: "selected", control: "run" };

const CSS = `
#bar { display:flex; flex-direction:column; position:relative; font:12px/1.35 system-ui, sans-serif; background:var(--bg); }
#bar button, #bar select { font:inherit; cursor:pointer; }
.b-tabs { display:flex; flex-wrap:wrap; gap:4px; padding:4px 8px; border-bottom:1px solid var(--line); align-items:center; }
.b-tabs button, .b-transport button, .b-transport select { background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:5px; padding:1px 9px; }
.b-tabs button.on { border-color:#5e81ac; background:#5e81ac; color:#fff; }
.b-tabs .b-hist { padding:1px 7px; } .b-tabs .b-hist:disabled { opacity:.35; cursor:default; }
.b-tabs .b-hist + .b-hist { margin-right:8px; }
.b-tabs .sp { flex:1; min-width:0; color:var(--dim); font-size:11px; text-align:right; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.b-body { flex:1; min-height:0; overflow:auto; padding:6px 12px 10px; }
.b-transport { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:4px 8px 2px; border-top:1px solid var(--line); }
.b-transport button.on { border-color:#ffd36b; color:#ffd36b; }
.b-transport label { color:var(--dim); }
.b-grain { color:#9fc3ff; margin-left:6px; }
.b-tlabel { font-family:ui-monospace, monospace; font-size:12px; flex:1 1 0; min-width:120px; text-align:right; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.b-strips { padding:0 8px 6px; display:grid; gap:3px; }
.b-strips svg { width:100%; display:block; border-radius:3px; background:#101216; }
.b-over { height:14px; cursor:pointer; } .b-detail { height:40px; cursor:crosshair; touch-action:none; }
.b-strips line, .b-strips rect.mk { vector-effect:non-scaling-stroke; }
.b-grip { position:absolute; z-index:5; }
body.dock-bottom .b-grip { left:0; right:0; top:-3px; height:6px; cursor:ns-resize; }
body.dock-right .b-grip { top:0; bottom:0; left:-3px; width:6px; cursor:ew-resize; }
.b-grip:hover { background:#5e81ac; }
body.dock-closed .b-tabs, body.dock-closed .b-body, body.dock-closed .b-grip, body.dock-closed .b-over { display:none; }
body.dock-closed .b-detail { height:24px; }
body.dock-closed.dock-right #bar .b-strips, body.dock-closed.dock-right .b-transport > :not(.b-collapse) { display:none; }
body.dock-closed.dock-right .b-transport { border:0; padding:4px 2px; }
body.dock-bottom #bar { flex-direction:column; }
.b-body h3 { font-size:13px; margin:2px 0 6px; } .b-body p { margin:4px 0; }
.b-body .cols { display:grid; grid-template-columns:repeat(auto-fit, minmax(340px, 1fr)); gap:4px 20px; }
.b-body table { border-collapse:collapse; }
.b-body table.kv td { padding:1px 10px 1px 0; border-bottom:1px solid #22262e; white-space:nowrap; } .b-body table.kv td:first-child { color:var(--dim); }
.b-body table.rows { width:100%; }
.b-body table.rows th { text-align:left; color:var(--dim); font-weight:500; border-bottom:1px solid var(--line); padding:2px 8px 2px 0; position:sticky; top:-6px; background:var(--bg); white-space:nowrap; }
.b-body table.rows td { border-bottom:1px solid #22262e; padding:1px 8px 1px 0; vertical-align:top; }
.b-body tr.on td { background:#3a3220; } .b-body tr.sel td { box-shadow:inset 0 0 0 1px #fff; } .b-body tr.past td { color:#c5ccd6; }
.b-body tr[data-sel] { cursor:pointer; } .b-body tr[data-sel]:hover td { background:#ffffff0a; }
.b-body th.num { text-align:right; } .b-body td.num { text-align:right; font-family:ui-monospace, monospace; white-space:nowrap; }
.b-body code, .b-body pre { font-family:ui-monospace, monospace; font-size:11px; }
.b-body .tag { font-size:10px; padding:0 5px; border-radius:8px; border:1px solid var(--line); color:var(--dim); white-space:nowrap; }
.label { color:var(--dim); font-size:11px; text-transform:uppercase; margin:8px 0 4px; } .label:first-child { margin-top:0; }
.dim, .muted { color:var(--dim); }
a.go { color:#9fc3ff; cursor:pointer; text-decoration:none; } a.go:hover { text-decoration:underline; } a.go.on { color:#ffd36b; }
a.seek { color:#ffd36b; cursor:pointer; margin-left:3px; }
ol.path { margin:2px 0; padding-left:18px; } ol.path li::marker { color:var(--dim); }
.chips { display:flex; flex-wrap:wrap; gap:3px; margin-bottom:6px; } .chips span { background:#1d2633; border:1px solid #2d5a8a; border-radius:3px; padding:0 4px; font-size:11px; font-family:ui-monospace, monospace; }
pre.json, pre.payload { background:var(--panel); border:1px solid var(--line); border-radius:4px; padding:6px; max-height:30vh; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; margin:0 0 6px; }
table.sched td, table.sched th { padding:1px 6px; border-bottom:1px solid var(--line); text-align:left; }
table.metrics { width:100%; margin-top:6px; } table.metrics td, table.metrics th { text-align:left; padding:2px 8px 2px 0; border-bottom:1px solid var(--line); white-space:nowrap; }
table.metrics th { color:var(--dim); font-weight:normal; } table.metrics tr[data-m] { cursor:pointer; } table.metrics tr.on td { color:#9fc3ff; }
table.metrics th.scr, table.metrics td.scr { background:#58a6ff10; } table.metrics th.ref, table.metrics td.ref { background:#3fb95010; }
table.metrics tr.on td.inp a { color:#f778ba; }
.meter { display:inline-block; width:80px; height:6px; background:var(--line); border-radius:3px; overflow:hidden; vertical-align:middle; } .meter span { display:block; height:100%; background:#58a6ff; }
.card { background:var(--panel); border:1px solid var(--line); border-left:4px solid var(--up); border-radius:4px; padding:6px 8px; margin-top:6px; }
.card .title { font-weight:600; display:flex; gap:6px; align-items:center; } .card .state { margin-left:auto; font-weight:normal; color:var(--dim); }
.card .image { color:var(--dim); font-size:11px; }
.pdot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:4px; }
.segbar { display:flex; height:22px; margin:4px 0; } .seg { color:#0f1115; font-size:10px; overflow:hidden; cursor:pointer; padding-left:2px; white-space:nowrap; }
.seg.on { outline:2px solid #fff; outline-offset:-2px; }
.segleg { display:flex; flex-wrap:wrap; gap:4px 12px; font-size:11px; color:var(--dim); } .segleg i { display:inline-block; width:10px; height:10px; margin-right:4px; vertical-align:middle; }
.b-body details { border:1px solid var(--line); border-radius:6px; padding:6px; margin-bottom:8px; } .b-body summary { cursor:pointer; }
.b-cp { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:8px; }
.b-cp .ph { border:1px dashed var(--line); border-radius:6px; padding:8px; } .b-cp .ph b { display:block; }
.b-cp .ph .tg { color:var(--starting); font-size:11px; }
`;

// ---------------------------------------------------------------- shared helpers (D11 Selection content, kept whole)
function kindOf(x) {
  if (!x) return null;
  if (ARCH_IDS.has(x.id)) return { dim: "architecture", tier: data.LADDERS.architecture[x.tier] };
  if (HW_IDS.has(x.id)) return { dim: "hardware", tier: data.LADDERS.hardware[x.tier] };
  if (x.id.startsWith("x")) return { dim: "hardware", tier: "transfer (kernel traffic)" };
  return { dim: "execution", tier: data.LADDERS.execution[x.tier] };
}
const link = (id, text) => `<a class="go ${id === state.sel ? "on" : ""}" data-sel="${esc(id)}">${esc(text ?? data.byId.get(id)?.name ?? id)}</a>`;
const seekLink = (t) => `<a class="seek" data-seek="${t}" title="move the cursor here">↦</a>`;
const chain = (id) => { const out = []; for (let x = data.byId.get(id); x; x = data.byId.get(x.parent)) out.unshift(x); return out; };

function inspect(d) {
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

function kernelTable(x) {
  const g = x.gpu;
  return `<table class="kv">
    <tr><td>grid</td><td>${g.grid} blocks</td></tr><tr><td>SMs</td><td>${g.sms} of 36</td></tr>
    <tr><td>DRAM</td><td>${g.dramMB} MB</td></tr><tr><td>L2</td><td>${g.l2MB} MB</td></tr>
    <tr><td>occupancy</td><td>${(g.occ * 100).toFixed(0)}% <span class="meter"><span style="width:${g.occ * 100}%"></span></span></td></tr>
    <tr><td>kind</td><td>${g.kind}</td></tr><tr><td>profiled</td><td>${g.profiled ? "yes (Nsight Compute)" : "no"}</td></tr>
    <tr><td>launch call</td><td><code>${esc(x.launch)}</code> at ${ms(x.cpuT)} ms (CPU), runs ${ms(x.t0 - x.cpuT)} ms later</td></tr></table>`;
}

function card(c, i) {
  const mib = (b) => (b / 2 ** 20).toFixed(0);
  return `<div class="card"><div class="title">${esc(c.service)}<span class="state">${c.state}${c.health ? ` · ${c.health}` : ""}</span></div>
    <div class="image">${esc(c.image)} · ${esc(c.project)}</div>
    <div>cpu ${c.cpu[i].toFixed(1)}% · mem ${mib(c.mem[i])} / ${mib(c.memLimit)} MiB${c.rx ? ` · rx ${c.rx[i].toFixed(0)} tx ${c.tx[i].toFixed(0)} B/s` : ""}</div>
    ${c.gpu ? `<div style="color:#9fc3ff">GPU held: ${c.gpu.mib} MiB · ${esc(c.gpu.program)} pid ${c.gpu.pid} · util ${c.gpu.util[i].toFixed(0)}%</div>` : ""}</div>`;
}

// ---------------------------------------------------------------- Selected
const selected = {
  key: "selected", label: "Selected",
  deps: (s) => { const c = data.CONTAINERS.some((c) => c.id === s.sel); return [s.sel, c ? now().sampleIndex : 0]; },
  render(el, s) {
    const x = data.byId.get(s.sel);
    if (!x) { el.innerHTML = `<p class="muted">Nothing selected. Step with ← →, click a stop on the timeline, a tier, or a thing in the world.</p>`; return; }
    const k = kindOf(x);
    const when = x.t0 != null ? `<div>at <b>${ms(x.t0)} ms</b> from send${x.t1 != null ? `, lasts <b>${ms(x.t1 - x.t0)} ms</b> (${(x.t1 - x.t0).toFixed(0)} µs)` : ""} ${seekLink(x.t0)}</div>` : "";
    const left = [`<div class="label" style="color:${DIM_COLOR[k.dim]}">${k.dim} · ${esc(k.tier)}</div><h3>${esc(x.name ?? x.what)}</h3>${when}`];
    const right = [];
    const p = x.comp && data.PAYLOADS[x.comp];
    if (p) right.push(`<div class="label">payload at ${esc(data.byId.get(x.comp)?.name)} ${tag("scratch, I02A request shape")}</div>${inspect(p)}`);
    if (x.gpu) left.push(`<div class="label">kernel</div>${kernelTable(x)}`);
    if (k.dim === "execution") {
      left.push(`<div class="label">up the execution ladder</div><ol class="path">${chain(x.id).map((u) =>
        `<li><span class="dim">${data.LADDERS.execution[u.tier]}</span> ${link(u.id)}</li>`).join("")}</ol>`);
      const proc = data.processOf(x.comp);
      if (x.flow) left.push(`<div class="label">flow</div><div><span class="pdot" style="background:${data.FLOW_COLOR[x.flow]}"></span>${esc(data.FLOWS.find(([f]) => f === x.flow)[1])}</div>`);
      left.push(`<div class="label">architecture: where it runs</div><ol class="path">${chain(x.comp).filter((a) => a.tier >= 2).map((a) =>
        `<li><span class="dim">${data.LADDERS.architecture[a.tier]}</span> ${link(a.id)}</li>`).join("")}</ol>`);
      left.push(`<div class="label">hardware it ran on</div><div>${x.hw.map((h) => link(h)).join(" · ")}</div>`);
    }
    if (x.from) left.push(`<table class="kv"><tr><td>from</td><td>${link(x.from)}</td></tr><tr><td>to</td><td>${link(x.to)}</td></tr><tr><td>bytes</td><td>${x.bytes} B</td></tr></table>`);
    if (k.dim !== "execution" && x.parent) left.push(`<div class="label">parents</div><ol class="path">${chain(x.id).slice(0, -1).map((a) => `<li>${link(a.id)}</li>`).join("")}</ol>`);
    if (k.dim === "architecture") {
      const c = data.CONTAINERS.find((c) => c.id === x.id);
      if (c) right.push(card(c, now().sampleIndex));
      const ran = data.EXEC.filter((u) => u.tier === 2 && chain(u.comp).some((a) => a.id === x.id));
      if (ran.length) right.push(`<div class="label">phases here (${ran.length})</div><div>${ran.map((u) => link(u.id, `${ms(u.t0)} ${u.name}`)).join("<br>")}</div>`);
    }
    el.innerHTML = `<div class="cols"><div>${left.join("")}</div><div>${right.join("")}</div></div>`;
  },
};

// ---------------------------------------------------------------- At cursor
function sampleBlock(n) {
  const smp = n.sample, meter = (v) => `<span class="meter"><span style="width:${Math.round(v * 100)}%"></span></span> ${Math.round(v * 100)}%`;
  const cont = n.archPath.find((id) => data.byId.get(id)?.tier === 2), c = data.CONTAINERS.find((c) => c.id === cont);
  return `<div class="label" style="color:${DIM_COLOR.hardware}">hardware · sample ${n.sampleIndex}, every 100 <span style="text-transform:none">µs</span> (state, not a stop)</div>
    <table class="kv"><tr><td>SM active</td><td>${smp.smActive}/36</td></tr><tr><td>GPU util</td><td>${meter(smp.gpuUtil)}</td></tr>
      <tr><td>DRAM bw</td><td>${meter(smp.dram)}</td></tr><tr><td>PCIe</td><td>${meter(smp.pcie)}</td></tr><tr><td>CPU</td><td>${meter(smp.cpu)}</td></tr>
      <tr><td>VRAM</td><td>${smp.vramGiB} GiB</td></tr></table>${c ? card(c, n.sampleIndex) : ""}`;
}
const atCursor = {
  key: "cursor", label: "At cursor",
  deps: (s) => { const n = now(); return [s.sel, n.phases.map((u) => u.id).join(), n.exec.map((u) => u?.id).join(), n.kernel?.id, n.transfers.map((x) => x.id).join(), n.archPath.join()]; },
  render(el, s) {
    const n = now(), proc = n.process;
    const exec = n.exec.map((u, i) => `<tr><td>${data.LADDERS.execution[i]}</td><td>${u ? link(u.id) : "–"}</td></tr>`).join("");
    el.innerHTML = `<div class="cols"><div>
        <h3><span class="ac-t">${ms(s.t, 3)}</span> ms <span class="muted">from send · everything true at the cursor</span></h3>
        <div class="label" style="color:${DIM_COLOR.execution}">execution</div><table class="kv">${exec}</table>
        <div class="label">flows running now</div><div>${n.phases.map((u) => `<div><span class="pdot" style="background:${data.FLOW_COLOR[u.flow]}"></span>${link(u.id)}</div>`).join("") || "–"}</div>
        <div class="label" style="color:${DIM_COLOR.architecture}">architecture</div>
        <ol class="path">${n.archPath.map((id) => `<li>${link(id)}</li>`).join("")}</ol>
      </div><div>
        <table class="kv"><tr><td>kernel</td><td>${n.kernel ? link(n.kernel.id) : "none running"}</td></tr>
          <tr><td>transfer</td><td>${n.transfers.map((x) => link(x.id, `${x.what}, ${x.bytes} B`)).join("<br>") || "none in flight"}</td></tr></table>
        <div class="ac-smp" data-i="${n.sampleIndex}">${sampleBlock(n)}</div></div></div>`;
  },
  tick(el, s) {
    el.querySelector(".ac-t").textContent = ms(s.t, 3);
    const box = el.querySelector(".ac-smp"), n = now();
    if (box && Number(box.dataset.i) !== n.sampleIndex) { box.dataset.i = n.sampleIndex; box.innerHTML = sampleBlock(n); }
  },
};

// ---------------------------------------------------------------- Metrics
function ttftSegments(val) {
  const M = Object.fromEntries(data.METRICS.map((m) => [m.id, m])), v = (id) => val(M[id]);
  return [
    ["server + network outside engine", v("ttft.wire") - v("ttft.engine"), "ttft.wire", "TTFT wire - TTFT engine"],
    ["engine queue", v("queue"), "queue", "Queue"],
    ["prefill", v("prefill"), "prefill", "Prefill forward"],
    ["engine rest (sample, emit)", v("ttft.engine") - v("queue") - v("prefill"), "ttft.engine", "TTFT engine - queue - prefill"],
    ["client receive", v("ttft.client") - v("ttft.wire"), "ttft.client", "TTFT client - TTFT wire"],
  ].map(([name, value, id, formula], i) => ({ name, value: Math.max(0, value), id, formula, color: SEG_COLORS[i] }));
}
function segbar(title, segs) {
  const total = segs.reduce((a, s) => a + s.value, 0);
  return `<div class="label">${title}</div><div class="segbar">${segs.map((s) => `<span class="seg ${state.metric === s.id ? "on" : ""}" data-m="${s.id}"
      style="width:${(100 * s.value) / total}%;background:${s.color}" title="${esc(s.name)} = ${esc(s.formula)}: ${ms(s.value)} ms">${ms(s.value)} ms</span>`).join("")}</div>
    <div class="dim">client TTFT ${ms(total)} ms = the ${segs.length} segments above (click one)</div>`;
}
const metricsTab = {
  key: "metrics", label: "Metrics",
  deps: (s) => [s.metric, s.sel],
  render(el, s) {
    const lit = s.metric;
    const rows = data.METRICS.map((m) => `<tr data-m="${m.id}" class="${lit === m.id ? "on" : ""}">
      <td>${esc(m.name)}</td><td>${esc(m.clock)}</td><td><code>${esc(m.formula)}</code></td>
      <td class="scr">${ms(m.value)} ms <span class="dim">(${m.value.toFixed(0)} µs)</span></td>
      <td class="inp">${m.inputs.map((id) => link(id, data.byId.get(id).name.slice(0, 28))).join("<br>")}</td>
      <td class="ref">${m.ref.ms.toFixed(3)} ms</td><td class="ref dim">${esc(m.ref.src)}</td></tr>`).join("");
    el.innerHTML = `<p class="muted">Metrics as they are calculated (I02A). Click a metric or a split segment: its inputs light on the timeline and in the world.
      The run's results, lessons and key moments: <a class="go" data-world="rep">Rep world ▸</a></p>
      <div class="cols"><div>${segbar("TTFT split · <span style='color:#58a6ff'>scratch</span> (this timeline)", ttftSegments((m) => m.value))}</div>
      <div>${segbar(`TTFT split · <span style='color:#3fb950'>measured</span> (run ${esc(data.REFERENCE_RUN)})`, ttftSegments((m) => m.ref.ms * 1000))}</div></div>
      <div class="segleg">${ttftSegments((m) => m.value).map((x) => `<span><i style="background:${x.color}"></i>${esc(x.name)} = ${esc(x.formula)}</span>`).join("")}</div>
      <table class="metrics"><tr><th>metric</th><th>clock</th><th>formula</th><th class="scr">scratch value (this timeline)</th><th>inputs (click)</th>
        <th class="ref" colspan="2">measured, run ${esc(data.REFERENCE_RUN)} · source</th></tr>${rows}</table>
      <p class="dim">Scratch values are computed on this prototype's made-up timeline. Measured values come from the real I02A run, for reference only; they are not on this timeline.</p>`;
  },
};

// ---------------------------------------------------------------- Tokens
const TOKENS = data.EXEC.filter((u) => u.tier === 1).map((it) => {
  const kids = data.EXEC.filter((u) => u.parent === it.id && u.tier === 2), find = (re) => kids.find((u) => re.test(u.name));
  return { it, engine: find(/^sample \(greedy\)/), wire: find(/^network: SSE frame/), client: find(/^SDK yields the token/) };
});
const tokensTab = {
  key: "tokens", label: "Tokens",
  deps: (s) => [s.sel],
  render(el) {
    const send = data.EXEC.find((u) => u.tier === 0).t0, text = data.PAYLOADS["b.detokenize"]?.new_text ?? "…";
    el.innerHTML = `<p><b>request</b> · ${TOKENS.length} tokens drawn · each read on three clocks: engine (sample done), wire (SSE frame on eth0), client (SDK yields).
        Text: <code>${esc(JSON.stringify(text))}</code> ${tag("scratch: one payload for every token")}</p>
      <table class="rows tokens"><tr><th>#</th><th>iteration</th><th class="num">engine: sample done</th><th class="num">wire: SSE frame</th><th class="num">client: SDK yields</th>
        <th class="num">client gap to previous</th><th class="num">wire − engine</th><th class="num">client − wire</th><th></th></tr>
      ${TOKENS.map(({ it, engine, wire, client }, k) => `<tr data-row="${client.id}" data-t="${engine.t0}">
        <td>${k + 1}</td><td>${link(it.id, it.name.split(":")[0])}</td>
        <td class="num">${link(engine.id, `${ms(engine.t1 - send)} ms`)}</td><td class="num">${link(wire.id, `${ms(wire.t0 - send)} ms`)}</td>
        <td class="num">${link(client.id, `${ms(client.t1 - send)} ms`)}</td>
        <td class="num">${k ? `${ms(client.t1 - TOKENS[k - 1].client.t1)} ms` : "TTFT"}</td>
        <td class="num">${ms(wire.t0 - engine.t1)} ms</td><td class="num">${ms(client.t1 - wire.t0)} ms</td>
        <td>${seekLink(engine.t0)}</td></tr>`).join("")}</table>
      <p class="muted">Times from send on the scratch timeline. The row lights when the cursor has reached that token's sample.</p>`;
  },
  tick(el, s) {
    let last = null;
    for (const tr of el.querySelectorAll("tr[data-row]")) { const on = Number(tr.dataset.t) <= s.t; tr.classList.toggle("past", on); tr.classList.remove("on"); if (on) last = tr; }
    last?.classList.add("on");
  },
};

// ---------------------------------------------------------------- Kernels
const KERNELS = data.EXEC.filter((u) => u.tier === 5).sort((a, b) => a.t0 - b.t0);
const kernelsTab = {
  key: "kernels", label: "Kernels",
  deps: () => [],
  render(el, s) {
    const anc = (u, tier) => chain(u.id).find((x) => x.tier === tier);
    el.innerHTML = `<p><b>${KERNELS.length} kernels</b> · ${TOKENS.length} iterations × 2 drawn decoder layers + LM head · ${KERNELS.filter((k) => k.gpu.profiled).length} profiled (iteration 2) · click a row to select it</p>
      <table class="rows kernels"><tr><th>#</th><th>iteration</th><th>layer</th><th>module</th><th>kernel</th><th class="num">µs</th><th class="num">grid</th><th class="num">SMs</th>
        <th class="num">DRAM MB</th><th class="num">L2 MB</th><th class="num">occupancy</th><th>profiled</th><th>launch</th><th></th></tr>
      ${KERNELS.map((k, i) => { const g = k.gpu, L = anc(k, 3);
        return `<tr data-sel="${k.id}" data-row="${k.id}"><td>${i + 1}</td><td>${anc(k, 1).name.split(":")[0].replace("iteration ", "")}</td><td>${L ? L.name.split(" ")[2] : "–"}</td>
          <td>${esc(anc(k, 4).name)}</td><td>${esc(k.name)}</td><td class="num">${(k.t1 - k.t0).toFixed(0)}</td><td class="num">${g.grid}</td><td class="num">${g.sms}/36</td>
          <td class="num">${g.dramMB}</td><td class="num">${g.l2MB}</td><td class="num">${(g.occ * 100).toFixed(0)}%</td><td>${g.profiled ? "yes" : "no"}</td>
          <td><code>${esc(k.launch)}</code> <span class="muted">@ ${ms(k.cpuT)} ms</span></td><td>${seekLink(k.t0)}</td></tr>`; }).join("")}</table>`;
    kernelsTab.tick(el, s);
  },
  tick(el, s) {
    const cur = now().kernel?.id;
    for (const tr of el.querySelectorAll("tr[data-row]")) { tr.classList.toggle("on", tr.dataset.row === cur); tr.classList.toggle("sel", tr.dataset.row === s.sel); }
  },
};

// ---------------------------------------------------------------- Run
function session(s) {
  const ss = s.session, rep = repOf(ss.rep);
  const run = (id, tag) => { const r = runOf(id); return `<tr><td>${tag}</td><td><code>${escS(id)}</code> ${r ? `${escS(runKind(r))} · ${whenOf(r)}${r.result ? "" : " · results not computed"}` : ""}</td></tr>`; };
  return `<table class="kv"><tr><td>mode</td><td>${ss.mode}${ss.mode === "live" ? ` · recorded ${Math.round(100 * s.head / data.END)}% · simulated` : ""}</td></tr>
    <tr><td>rep</td><td>${escS(ss.rep)} · ${escS(rep?.title)}</td></tr>
    ${ss.mode === "compare" ? run(ss.run, "run A") + run(ss.runB, "run B") : run(ss.run, "run")}
    ${ss.mode === "live" ? `<tr><td>action</td><td>${escS(ss.live?.action?.label)} ${escS(JSON.stringify(ss.live?.options ?? {}))}</td></tr>` : ""}</table>
    <p><a class="go" data-world="rep">Rep world ▸</a> <span class="muted">results, lessons, key moments</span></p>`;
}
const runTab = {
  key: "run", label: "Run",
  deps: (s) => [s.session],
  render(el, s) {
    const per = data.LADDERS.execution.map((name, i) => `${data.EXEC.filter((u) => u.tier === i).length} ${name}`).join(" · ");
    const ph = (name, what) => `<div class="ph"><b>${name}</b><span class="tg">placeholder · visuals TBD (owner)</span><div class="dim">${what}</div></div>`;
    el.innerHTML = `<div class="cols"><div>
        <h3>scratch run <span class="muted">this prototype's made-up timeline</span></h3>
        <table class="kv"><tr><td>model</td><td>Qwen-like, 2 of 24 decoder layers drawn</td></tr>
          <tr><td>request</td><td>${esc(data.EXEC.find((u) => u.tier === 0).name)}</td></tr>
          <tr><td>iterations</td><td>${TOKENS.length} (prefill, then decode)</td></tr><tr><td>length</td><td>${ms(data.END)} ms</td></tr>
          <tr><td>units</td><td>${per}</td></tr><tr><td>transfers</td><td>${data.TRANSFERS.length}</td></tr>
          <tr><td>samples</td><td>${data.SAMPLES.length}, every 100 µs (state, not stops)</td></tr>
          <tr><td>containers</td><td>${data.CONTAINERS.map((c) => esc(c.service)).join(", ")}</td></tr></table>
      </div><div>
        <h3>reference run <span class="muted">measured</span></h3>
        <table class="kv"><tr><td>run</td><td><code>${esc(data.REFERENCE_RUN)}</code></td></tr>
          ${data.METRICS.map((m) => `<tr><td>${esc(m.name)}</td><td>${m.ref.ms.toFixed(3)} ms ${tag(m.ref.src)}</td></tr>`).join("")}</table>
        <p class="muted">Measured values are for reference only; they are not on the scratch timeline.</p>
      </div></div>
      <div class="label">session · opened from the header (Load, Launch, Compare)</div><div class="b-cp">${session(s)}</div>
      <div class="label">outside the world: still placeholders</div><div class="b-cp">
        ${ph("Logs", "container logs at the cursor")}
        ${ph("Tools", "Grafana, Prometheus, Nsight Systems / Compute")}
        ${ph("Lifecycle", "container start, health, stop")}</div>`;
  },
};

const TABS = [selected, atCursor, metricsTab, tokensTab, kernelsTab, runTab];
const tabOf = (s) => TABS.find((t) => t.key === (OLD_TAB[s.dock.tab] ?? s.dock.tab)) ?? TABS[0];

// ---------------------------------------------------------------- the bar
export function mountBar(el) {
  const css = document.createElement("style"); css.textContent = CSS; document.head.append(css);
  el.innerHTML = `<div class="b-grip" title="drag to resize"></div>
    <div class="b-tabs" role="tablist"><button data-act="hist-back" class="b-hist" aria-label="Back" title="back to the previous selection and tab ([)">←</button><button data-act="hist-fwd" class="b-hist" aria-label="Forward" title="forward again (])">→</button>${TABS.map((t) => `<button role="tab" data-act="tab" data-tab="${t.key}">${t.label}</button>`).join("")}
      <span class="sp"></span><button data-act="pos" class="b-pos"></button><button data-act="big" title="enlarge or shrink the bar" aria-label="enlarge or shrink the bar">⤢</button></div>
    <div class="b-body" role="tabpanel"></div>
    <div class="b-transport">
      <button class="b-collapse" data-act="open"></button>
      <button data-act="back" aria-label="Step back" title="previous stop of the focused tier (←)">◀</button>
      <button data-act="play" class="b-play" aria-label="Play"></button>
      <button data-act="next" aria-label="Step forward" title="next stop of the focused tier (→)">▶|</button>
      <label>pace <select class="b-pace" aria-label="Pace" title="events: visit every event in the bounds · time: real time across the bounds (T)">
        <option value="events">events</option><option value="time">time</option></select></label>
      <label>rate <select class="b-rate" aria-label="Rate">${RATES.map((r) => `<option value="${r}">×${r}</option>`).join("")}</select></label>
      <span class="b-grain"></span><span class="b-tlabel"></span></div>
    <div class="b-strips"><svg class="b-over" aria-label="Run overview" preserveAspectRatio="none"></svg>
      <svg class="b-detail" aria-label="Timeline" preserveAspectRatio="none"></svg></div>`;
  const $ = (q) => el.querySelector(q);
  const tabs = $(".b-tabs"), body = $(".b-body"), sp = $(".sp"), grip = $(".b-grip");
  const play = $(".b-play"), pace = $(".b-pace"), rate = $(".b-rate"), grain = $(".b-grain"), tlabel = $(".b-tlabel");
  const over = $(".b-over"), detail = $(".b-detail");
  let deps = null, win = [0, data.END], marks = null, size = { h: null, w: null };

  el.addEventListener("mousedown", (e) => { if (e.target.closest("button")) e.preventDefault(); });
  el.addEventListener("click", (e) => {
    const wd = e.target.closest("[data-world]");
    if (wd) { e.stopPropagation(); setWorld(wd.dataset.world); return; }
    const sk = e.target.closest("[data-seek]");
    if (sk) { e.stopPropagation(); seek(Number(sk.dataset.seek)); return; }
    const a = e.target.closest("[data-sel]");
    if (a) { e.stopPropagation(); select(a.dataset.sel); return; }
    const m = e.target.closest("[data-m]");
    if (m) { selectMetric(m.dataset.m); return; }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "tab") setDock({ tab: b.dataset.tab, open: true });
    else if (act === "pos") setDock({ pos: state.dock.pos === "bottom" ? "right" : "bottom" });
    else if (act === "big") setDock({ big: !state.dock.big });
    else if (act === "open") setDock({ open: !state.dock.open });
    else if (act === "hist-back") goBack();
    else if (act === "hist-fwd") goForward();
    else if (act === "play") togglePlay();
    else if (act === "back") step(-1);
    else if (act === "next") step(+1);
  });
  pace.onchange = () => { setPace(pace.value); pace.blur(); };
  rate.onchange = () => { setRate(Number(rate.value)); rate.blur(); };

  grip.addEventListener("pointerdown", (e) => {
    grip.setPointerCapture(e.pointerId);
    const right = state.dock.pos === "right";
    const move = (ev) => {
      if (right) size.w = `${Math.max(300, innerWidth - ev.clientX - 270)}px`; else size.h = `${Math.max(140, Math.min(innerHeight - 200, innerHeight - ev.clientY))}px`;
      applySize(state);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", () => grip.removeEventListener("pointermove", move), { once: true });
  });
  function applySize(s) {
    const root = document.documentElement.style;
    root.setProperty("--bar-h", s.dock.big ? "60vh" : size.h ?? "380px");
    root.setProperty("--bar-w", s.dock.big ? "62vw" : size.w ?? "440px");
  }

  // timeline: x in µs (viewBox), so a t-only change moves two attributes and nothing else
  const tAt = (svg, e, [a, b]) => { const r = svg.getBoundingClientRect(); return a + ((e.clientX - r.left) / r.width) * (b - a); };
  let drag = null;
  detail.addEventListener("pointerdown", (e) => { detail.setPointerCapture(e.pointerId); drag = { x: e.clientX, moved: false }; });
  detail.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x) > 2) drag.moved = true;
    if (drag.moved) seek(tAt(detail, e, win));
  });
  detail.addEventListener("pointerup", (e) => {
    if (!drag) return; const moved = drag.moved; drag = null;
    if (moved) return;
    const t = tAt(detail, e, win), r = detail.getBoundingClientRect(), pxPerUs = r.width / (win[1] - win[0]);
    let best = null;
    for (const s of stops()) if (s.t >= win[0] && s.t <= win[1] && (!best || Math.abs(s.t - t) < Math.abs(best.t - t))) best = s;
    if (best && Math.abs(best.t - t) * pxPerUs <= 6) { select(best.ref); seek(best.t); } else seek(t);
  });
  over.addEventListener("click", (e) => seek(tAt(over, e, [0, data.END])));

  function windowOf(s) {
    const [b0, b1] = s.bounds, pad = Math.max((b1 - b0) * 0.1, data.END / 2000);
    return [b0 - pad, b1 + pad];
  }

  function drawStatic(s) {
    const E = data.END, [b0, b1] = s.bounds, col = DIM_COLOR[s.focus], lit = metricInputs();
    win = windowOf(s);
    const [a, b] = win, w = b - a, inWin = (t) => t >= a && t <= b;
    const smp = data.SAMPLES.map((x) => `<rect x="${x.t}" width="100" y="${14 - 13 * x.gpuUtil}" height="${13 * x.gpuUtil}" fill="#3fb950" opacity=".35"/>`).join("");
    over.setAttribute("viewBox", `0 0 ${E} 14`);
    over.innerHTML = `${smp}<rect x="${b0}" width="${Math.max(E / 600, b1 - b0)}" y="0" height="14" fill="#ffd36b" opacity=".22"/>
      <rect class="mk" x="${b0}" width="${Math.max(E / 600, b1 - b0)}" y="0.5" height="13" fill="none" stroke="#ffd36b" stroke-width="1"/>
      <line class="cur" x1="${s.t}" x2="${s.t}" y1="0" y2="14" stroke="#fff" stroke-width="1"/>
      <rect class="fut" x="${s.head}" width="${E - s.head}" y="0" height="14" fill="#0b0f16" opacity=".85"/>`;
    const S = stops().filter((x) => inWin(x.t)), ev = data.EXEC.concat(data.TRANSFERS).filter((u) => u.t1 >= a && u.t0 <= b);
    const litR = [...lit].map((id) => data.byId.get(id)).filter((u) => u && inWin(u.t0))
      .map((u) => `<rect x="${u.t0}" width="${Math.max(w / 300, Math.min(b, u.t1) - u.t0)}" y="0" height="40" fill="#ff3df0" opacity=".22"/>`).join("");
    const sel = data.byId.get(s.sel);
    detail.setAttribute("viewBox", `${a} 0 ${w} 40`);
    detail.innerHTML = `<rect x="${b0}" width="${b1 - b0}" y="0" height="40" fill="#ffd36b" opacity=".08"/>
      <line x1="${b0}" x2="${b0}" y1="0" y2="40" stroke="#ffd36b" stroke-width="1.5"/><line x1="${b1}" x2="${b1}" y1="0" y2="40" stroke="#ffd36b" stroke-width="1.5"/>
      ${ev.map((u) => `<rect x="${u.t0}" width="${Math.max(w / 800, u.t1 - u.t0)}" y="${rowY(u)}" height="3.5" fill="${TIER_COLOR[u.tier ?? 6]}" opacity=".85"><title>${esc(u.name ?? u.what)}</title></rect>`).join("")}
      ${litR}
      ${S.map((x) => `<line x1="${x.t}" x2="${x.t}" y1="0" y2="40" stroke="${col}" stroke-width="${S.length > 200 ? 1 : 2}" opacity=".9"/>`).join("")}
      ${sel?.t0 != null && inWin(sel.t0) ? `<line x1="${sel.t0}" x2="${sel.t0}" y1="0" y2="40" stroke="#fff" stroke-width="5" opacity=".35"/>` : ""}
      <g class="pe"></g>
      <line class="cur" x1="${s.t}" x2="${s.t}" y1="0" y2="40" stroke="#ffd36b" stroke-width="2"/>`;
    marks = { oc: over.querySelector(".cur"), dc: detail.querySelector(".cur"), pe: detail.querySelector(".pe"), n: S.length };
    grain.textContent = `grain: ${s.focus} › ${tierName()} · ${S.length} in view · ${eventsIn().length} events in bounds`;
    grain.style.color = col;
  }

  function drawPlayEvent(s) {
    const u = data.byId.get(s.playEvent);
    marks.pe.innerHTML = u && u.t1 >= win[0] && u.t0 <= win[1]
      ? `<rect class="mk" x="${u.t0}" width="${Math.max((win[1] - win[0]) / 400, u.t1 - u.t0)}" y="${rowY(u) - 1}" height="5.5" fill="none" stroke="#fff" stroke-width="1.5"/><line x1="${u.t0}" x2="${u.t0}" y1="0" y2="40" stroke="#3fb950" stroke-width="2"/>` : "";
  }

  function drawCursor(s) {
    marks.oc.setAttribute("x1", s.t); marks.oc.setAttribute("x2", s.t);
    const fut = over.querySelector(".fut"); if (fut) { fut.setAttribute("x", s.head); fut.setAttribute("width", data.END - s.head); }
    marks.dc.setAttribute("x1", s.t); marks.dc.setAttribute("x2", s.t);
    const [b0, b1] = s.bounds, ev = data.byId.get(s.playEvent);
    tlabel.textContent = `${ms(s.t)} / ${ms(data.END)} ms · bounds ${ms(b0)}–${ms(b1)} (${span(b1 - b0)})${s.playing && ev ? ` · at ${ev.name ?? ev.what}` : ""}`;
  }

  subscribe((s, ch) => {
    const tab = tabOf(s);
    if (ch.dock) {
      for (const b of tabs.querySelectorAll("[data-tab]")) { const on = b.dataset.tab === tab.key; b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on)); }
      $(".b-pos").textContent = s.dock.pos === "bottom" ? "dock → right" : "dock ↓ bottom";
      $(".b-collapse").textContent = s.dock.open ? "▾" : "▴"; $(".b-collapse").title = s.dock.open ? "collapse the bar" : "expand the bar";
      applySize(s);
    }
    if (ch.playing) { play.textContent = s.playing ? "⏸ pause" : "▶ play"; play.classList.toggle("on", s.playing); play.setAttribute("aria-label", s.playing ? "Pause" : "Play"); }
    if (ch.nav) { const [hb, hf] = tabs.querySelectorAll(".b-hist"); hb.disabled = !s.nav.back; hf.disabled = !s.nav.fwd; }
    if (ch.pace) pace.value = s.pace;
    if (ch.rate) rate.value = String(s.rate);
    if (ch.focus || ch.tiers || ch.bounds || ch.sel || ch.metric) drawStatic(s);
    if (ch.focus || ch.tiers || ch.bounds || ch.sel || ch.metric || ch.playEvent) drawPlayEvent(s);
    if (ch.t || ch.bounds || ch.playEvent || ch.playing || ch.head) drawCursor(s);
    if (ch.sel) { const x = data.byId.get(s.sel); sp.textContent = x ? `selected: ${x.name ?? x.what}` : ""; }
    if (!s.dock.open) { deps = null; return; }
    const d = [tab.key, ...tab.deps(s)];
    if (!deps || d.length !== deps.length || d.some((v, i) => v !== deps[i])) {
      const top = deps && deps[0] === d[0] ? body.scrollTop : 0; deps = d;
      tab.render(body, s); tab.tick?.(body, s); body.scrollTop = top;
    } else if (ch.t || ch.sel) tab.tick?.(body, s);
  });
}
