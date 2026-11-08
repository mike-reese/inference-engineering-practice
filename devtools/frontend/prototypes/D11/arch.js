// Architecture lens (COMMAND_CENTER_DIMENSIONS.md section 2): v1 Infrastructure cards and the v1 Components map,
// rebuilt here. Only v1's look is copied (style.css, views/infra.js, views/components_map.js); nothing is imported.
import { state, subscribe, setTier, select, now, metricInputs, data, DIM_COLOR } from "./model.js";

const { LADDERS, ARCH, EXEC, CONTAINERS, PROCESS_COLOR, SAMPLES, byId } = data;

const CSS = `
.al { padding:8px 10px 16px; }
.al .label { color:var(--dim); font-size:11px; text-transform:uppercase; margin-bottom:6px; }
.al .tiers { display:flex; gap:2px; margin:0 0 10px; padding:3px; border:1px solid var(--line); border-radius:6px; }
.al .tiers.focus { border-color:${DIM_COLOR.architecture}; box-shadow:0 0 0 1px ${DIM_COLOR.architecture}55; }
.al .tiers .dim-name { color:${DIM_COLOR.architecture}; font-size:11px; align-self:center; padding:0 6px 0 4px; writing-mode:vertical-rl; transform:rotate(180deg); }
.al .tiers button { flex:1; background:none; border:0; color:var(--dim); font:inherit; font-size:10.5px; line-height:1.2; cursor:pointer; padding:3px 2px; border-radius:4px; }
.al .tiers button b { display:block; font-size:12px; }
.al .tiers button:hover { color:var(--text); }
.al .tiers button.on { color:var(--text); background:${DIM_COLOR.architecture}33; box-shadow:inset 0 -2px 0 ${DIM_COLOR.architecture}; }
.al .host, .al .project, .al .network { border:1px solid var(--line); border-radius:6px; padding:8px; margin-bottom:10px; }
.al .network { border-style:dashed; }
.al .network > .label[data-sel] { cursor:pointer; } .al .network > .label[data-sel]:hover { color:var(--text); }
.al .cards { display:flex; flex-direction:column; gap:8px; }
.al .cards.compact { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
.al .card { background:var(--panel); border:1px solid var(--line); border-left:4px solid var(--dim); border-radius:4px; padding:8px; cursor:pointer; }
.al .card:hover { border-color:var(--accent); }
.al .card.up { border-left-color:var(--up); } .al .card.starting { border-left-color:var(--starting); } .al .card.down { border-left-color:var(--down); }
.al .card.here { box-shadow:0 0 0 1px #e3b341; } .al .card.sel { border-color:${DIM_COLOR.architecture}; }
.al .card.metric { box-shadow:0 0 0 2px ${DIM_COLOR.execution}; }
.al .compact .card { padding:5px 6px; min-width:0; }
.al .compact .title { white-space:nowrap; } .al .compact .title .state { flex:none; }
.al .compact .svc { overflow:hidden; text-overflow:ellipsis; }
.al .title { font-weight:bold; display:flex; gap:6px; align-items:center; }
.al .state { margin-left:auto; font-weight:normal; color:var(--dim); }
.al .dot { width:8px; height:8px; border-radius:50%; background:var(--dim); flex:none; }
.al .up .dot { background:var(--up); } .al .starting .dot { background:var(--starting); } .al .down .dot { background:var(--down); }
.al .image { color:var(--dim); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.al .row { display:flex; align-items:center; gap:6px; margin-top:4px; }
.al .row .k { flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.al .net { color:var(--dim); font-size:11px; }
.al .gpuheld { margin-top:6px; color:var(--accent); }
.al .spark { flex:none; } .al .spark polyline { fill:none; stroke:var(--accent); stroke-width:1.5; }
.al .spark .cur { stroke:#e3b341; stroke-width:1; } .al .spark circle { fill:#e3b341; }
.al .compact .spark { width:60px; height:16px; }
.al .bar { display:inline-block; width:160px; flex:none; height:6px; background:var(--line); border-radius:3px; overflow:hidden; }
.al .bar span { display:block; height:100%; background:var(--accent); }
.al .procs { margin-top:6px; border-top:1px solid var(--line); padding-top:4px; }
.al .proc { display:flex; gap:6px; align-items:center; padding:2px 4px; border-radius:3px; cursor:pointer; font-size:12px; }
.al .proc:hover { background:#ffffff0d; } .al .proc.sel { outline:1px solid ${DIM_COLOR.architecture}; }
.al .proc.here { background:#e3b34122; } .al .proc i { width:10px; height:10px; border-radius:2px; flex:none; }
.al .proc .now { margin-left:auto; color:#e3b341; font-size:11px; }
.al .none { color:var(--dim); font-size:11px; font-style:italic; }
.al .compmap { width:100%; height:auto; background:var(--panel); border:1px solid var(--line); border-radius:6px; display:block; }
.al .compmap .bound rect { fill:none; stroke:var(--dim); stroke-width:1.5; }
.al .compmap .bound.container rect { stroke:#8a90a0; stroke-width:2; fill:rgba(88,166,255,0.03); }
.al .compmap .bound.process rect { stroke-dasharray:6 4; } .al .compmap .bound.ipc rect { stroke-dasharray:2 4; }
.al .compmap .bound.network rect { stroke-dasharray:8 4; stroke:#39c5cf; }
.al .compmap .bound text { fill:var(--dim); font-size:10px; }
.al .compmap .bound[data-sel] { cursor:pointer; }
.al .compmap .bound.sel rect { stroke:${DIM_COLOR.architecture}; stroke-width:2.5; }
.al .compmap .edge { fill:none; stroke:#3a4150; stroke-width:1.5; } .al .compmap .edge.hot { stroke:#e3b341; stroke-width:3; }
.al .compmap marker path { fill:#5a6170; }
.al .compmap .cbox { cursor:pointer; } .al .compmap .cbox rect { fill:#10141b; stroke:var(--line); }
.al .compmap .cbox:hover rect { stroke:var(--accent); }
.al .compmap .cbox.seen rect { stroke:#2d5a8a; }
.al .compmap .cbox.metric rect { stroke:${DIM_COLOR.execution}; stroke-width:2.5; fill:#12202e; }
.al .compmap .cbox.prev rect { stroke:var(--dim); stroke-dasharray:4 3; }
.al .compmap .cbox.on rect { stroke:#e3b341; stroke-width:3; fill:#2a2412; }
.al .compmap .cbox.sel rect { stroke:${DIM_COLOR.architecture}; }
.al .compmap .cbox text { pointer-events:none; } .al .compmap .cl { fill:var(--text); font-size:11px; font-weight:bold; }
.al .compmap .co { fill:var(--dim); font-size:8.5px; } .al .compmap .cs { fill:#58a6ff; font-size:8.5px; }
.al .compmap .cbox.on .cs { fill:#ffd479; }
.al .compmap .packet circle { fill:#e3b341; stroke:#fff; stroke-width:1.5; }
.al .compmap .packet text { fill:#ffd479; font-size:10px; paint-order:stroke; stroke:#0f1115; stroke-width:3px; }
.al .crumb { color:var(--dim); font-size:11px; margin-bottom:8px; }
.al .crumb b { color:var(--text); font-weight:normal; }
.al .layers { display:flex; flex-direction:column; gap:6px; margin-bottom:12px; }
.al .layer { background:var(--panel); border:1px solid var(--line); border-left:4px solid ${DIM_COLOR.architecture}88; border-radius:4px; padding:7px 8px; cursor:pointer; }
.al .layer:hover { border-color:var(--accent); } .al .layer.sel { border-color:${DIM_COLOR.architecture}; }
.al .layer.on { border-left-color:#e3b341; background:#2a2412; }
.al .layer .what { color:var(--dim); font-size:11px; margin-top:2px; } .al .layer .now { color:#ffd479; margin-top:4px; }
.al .arrow { text-align:center; color:var(--dim); font-size:11px; line-height:1; }
`;

const MiB = 2 ** 20;
const fmt = {
  pct: (v) => `${v.toFixed(0)} %`,
  mib: (b) => `${(b / MiB).toFixed(0)} MiB`,
  gib: (mib) => `${(mib / 1024).toFixed(2)} GiB`,
  rate: (bps) => (bps < 1024 ? `${bps.toFixed(0)} B/s` : `${(bps / 1024).toFixed(1)} KiB/s`),
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const ancestor = (id, tier) => { let x = byId.get(id); while (x && x.tier > tier) x = byId.get(x.parent); return x?.tier === tier ? x.id : null; };

/** Series up to the cursor sample, with a marker at the cursor. Fixed pixel size so the marker stays round. */
function spark(values, si, w = 160, h = 24, max = Math.max(...values, 1e-9)) {
  const x = (i) => (w * i) / Math.max(1, values.length - 1), y = (v) => h - 2 - ((h - 4) * v) / max;
  const pts = values.slice(0, si + 1).map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}"/>
    <line class="cur" x1="${x(si)}" x2="${x(si)}" y1="0" y2="${h}"/><circle cx="${x(si)}" cy="${y(values[si])}" r="2.5"/></svg>`;
}
const bar = (f) => `<span class="bar"><span style="width:${Math.min(100, 100 * f).toFixed(1)}%"></span></span>`;
const status = (c) => (c.state !== "running" ? ["down", c.state] : c.health === "starting" ? ["starting", "starting"]
  : c.health === "unhealthy" ? ["down", "unhealthy"] : ["up", c.health ?? "running"]);

// ---------------- container cards (v1 Infrastructure)
function card(c, ctx, mode) {
  const [cls, label] = status(c), si = ctx.si;
  const flags = `${cls}${ctx.here === c.id ? " here" : ""}${state.sel === c.id ? " sel" : ""}${ctx.metricCards.has(c.id) ? " metric" : ""}`;
  if (mode === "compact") return `<div class="card ${flags}" data-sel="${c.id}" title="${esc(c.image)}">
    <div class="title"><i class="dot"></i><span class="svc">${esc(c.service)}</span><span class="state">${spark(c.cpu, si, 60, 16)}</span></div></div>`;
  const shares = c.sharesNetnsWith && CONTAINERS.find((o) => o.id === c.sharesNetnsWith);
  const net = shares ? `uses the network namespace of <b>${esc(shares.service)}</b>`
    : c.rx ? `↓ ${fmt.rate(c.rx[si])} ↑ ${fmt.rate(c.tx[si])} · ${esc(c.networks.join(", "))}` : esc(c.networks.join(", "));
  const g = c.gpu;
  const gpu = g ? `<div class="gpuheld">GPU held ${fmt.gib(g.mib)} · ${esc(g.program)} pid ${g.pid}</div>
    <div class="row"><span class="k">GPU util ${fmt.pct(g.util[si])}</span>${spark(g.util, si, 160, 24, 100)}</div>` : "";
  const procs = mode === "process" ? procList(ARCH.filter((p) => p.tier === 3 && p.parent === c.id), ctx) : "";
  return `<div class="card ${flags}" data-sel="${c.id}">
    <div class="title"><i class="dot"></i>${esc(c.service)}<span class="state">${esc(label)}</span></div>
    <div class="image">${esc(c.image)}</div>
    <div class="row"><span class="k">CPU ${fmt.pct(c.cpu[si])}</span>${spark(c.cpu, si)}</div>
    <div class="row"><span class="k">mem ${(c.mem[si] / MiB).toFixed(0)} / ${fmt.mib(c.memLimit)}</span>${bar(c.mem[si] / c.memLimit)}</div>
    <div class="row net">${net}</div>${gpu}${procs}</div>`;
}

function procList(procs, ctx) {
  if (!procs.length) return `<div class="procs"><div class="none">processes: not in the scratch data</div></div>`;
  return `<div class="procs"><div class="label">processes</div>${procs.map((p) => `<div class="proc${ctx.proc === p.id ? " here" : ""}${state.sel === p.id ? " sel" : ""}" data-sel="${p.id}">
    <i style="background:${PROCESS_COLOR[p.id] ?? "#8a90a0"}"></i>${esc(p.name)}${ctx.proc === p.id ? `<span class="now">at the cursor</span>` : ""}</div>`).join("")}</div>`;
}

function projects(ctx, mode) {
  const byProject = new Map();
  for (const c of CONTAINERS) (byProject.has(c.project) ? byProject : byProject.set(c.project, [])).get(c.project).push(c);
  return [...byProject].map(([name, cs]) => {
    const nets = new Map();
    for (const c of cs) {
      if (c.sharesNetnsWith) continue;
      const n = c.networks[0] ?? "none";
      if (!nets.has(n)) nets.set(n, []);
      nets.get(n).push(c, ...cs.filter((o) => o.sharesNetnsWith === c.id));
    }
    const boxes = [...nets].map(([n, members]) => {
      const netThing = ARCH.find((a) => a.tier === 2 && a.name === `network ${n}`);
      const bridge = mode === "process" && netThing ? procList(ARCH.filter((p) => p.tier === 3 && p.parent === netThing.id), ctx) : "";
      return `<div class="network"><div class="label"${netThing ? ` data-sel="${netThing.id}"` : ""}>network ${esc(n)}</div>${bridge}
        <div class="cards${mode === "compact" ? " compact" : ""}">${members.map((c) => card(c, ctx, mode)).join("")}</div></div>`;
    });
    return `<section class="project"><div class="label">project ${esc(name)}</div>${boxes.join("")}</section>`;
  }).join("");
}

// ---------------- component map (v1 Components), laid out by hand for the 440 px column
const W = 420, H = 460;
// [id, owner, x, y, w, h]
const BOXES = [
  ["b.sdk", "openai · chat.completions stream", 16, 32, 114, 44],
  ["b.transport", "httpx HTTPTransport", 136, 32, 114, 44],
  ["b.eth0", "veth pair · tcpdump", 276, 32, 126, 44],
  ["b.asgi", "uvicorn + FastAPI", 24, 134, 240, 40],
  ["b.detok", "HF decode_incrementally", 272, 134, 124, 40],
  ["b.tokenizer", "HF Jinja template + encode", 24, 184, 120, 40],
  ["b.llm_api", "generate_async", 148, 184, 120, 40],
  ["b.ipc", "pyzmq · pickle", 148, 256, 120, 40],
  ["b.fetch", "ExecutorRequestQueue", 24, 328, 120, 40],
  ["b.scheduler", "capacity + micro-batch", 148, 328, 120, 40],
  ["b.responses", "_enqueue_responses", 272, 328, 124, 40],
  ["b.forward", "PyTorchModelEngine", 24, 392, 120, 40],
  ["b.sampler", "TorchSampler", 148, 392, 120, 40],
  ["b.kv", "KVCacheManager", 272, 392, 124, 40],
].map(([id, owner, x, y, w, h]) => ({ id, owner, x, y, w, h, label: byId.get(id).name }));
const BOX = Object.fromEntries(BOXES.map((b) => [b.id, b]));
// [arch id or null, label, x, y, w, h, kind]
const BOUNDS = [
  ["c.client", "client container", 8, 8, 250, 76, "container"],
  ["c.net", "network ie-i02a_default", 266, 8, 146, 76, "network"],
  ["c.server", "server container (trtllm-serve)", 8, 94, 404, 358, "container"],
  ["p.http", "trtllm-serve: HTTP + LLM API", 16, 114, 388, 118, "process"],
  [null, "ZMQ over tcp://127.0.0.1", 16, 238, 388, 62, "ipc"],
  ["p.worker", "executor worker (MPI-spawned)", 16, 306, 388, 138, "process"],
];
const BEND = { "b.eth0>b.sdk": 34 };

const PHASES = EXEC.filter((u) => u.tier === 2).sort((a, b) => a.t0 - b.t0);
const REQ = EXEC.find((u) => u.tier === 0);
const nextIteration = (a, b) => a.parent !== b.parent && byId.get(a.parent).tier === 1 && byId.get(b.parent).tier === 1;
const EDGES = [...new Set([REQ, ...PHASES].slice(1).flatMap((u, i, all) => {
  const p = i ? PHASES[i - 1] : REQ;
  return p.comp === u.comp || (i && nextIteration(p, u)) ? [] : [`${p.comp}>${u.comp}`];
}))];

const center = (b) => [b.x + b.w / 2, b.y + b.h / 2];
const border = (b, dx, dy) => Math.min(b.w / 2 / Math.abs(dx || 1e-9), b.h / 2 / Math.abs(dy || 1e-9));
function edgePath(key) {
  const [a, b] = key.split(">").map((id) => BOX[id]);
  const [x1, y1] = center(a), [x2, y2] = center(b), dx = x2 - x1, dy = y2 - y1;
  const s = border(a, dx, dy), e = 1 - border(b, -dx, -dy);
  const bend = BEND[key];
  if (bend) {
    const p1 = [a.x + a.w / 2 - 20, a.y + a.h], p2 = [b.x + b.w / 2 + 20, b.y + b.h];
    return `M${p1} Q${(p1[0] + p2[0]) / 2},${p1[1] + bend} ${p2}`;
  }
  return `M${x1 + dx * s},${y1 + dy * s} L${x1 + dx * e},${y1 + dy * e}`;
}

function compMap(ctx) {
  const lit = (id) => [id === ctx.comp && "on", id === ctx.prev && id !== ctx.comp && "prev", ctx.seen.has(id) && "seen",
    ctx.metricComps.has(id) && "metric", state.sel === id && "sel"].filter(Boolean).join(" ");
  const bounds = BOUNDS.map(([id, label, x, y, w, h, kind]) => {
    const color = PROCESS_COLOR[id] ? ` style="stroke:${PROCESS_COLOR[id]}"` : "";
    return `<g class="bound ${kind}${state.sel === id ? " sel" : ""}"${id ? ` data-sel="${id}"` : ""}><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8"${color}/>
      <text x="${x + 6}" y="${y + 13}">${esc(label)}</text></g>`;
  }).join("");
  const hot = `${ctx.prev}>${ctx.comp}`;
  const edges = EDGES.map((k) => `<path class="edge${k === hot ? " hot" : ""}" d="${edgePath(k)}" marker-end="url(#al-arrow)"/>`).join("");
  const boxes = BOXES.map((b) => {
    const n = ctx.counts.get(b.id) ?? 0;
    const stat = b.id === ctx.comp ? ctx.phase?.name ?? "" : n ? `${n}× so far` : "";
    const chars = Math.floor((b.w - 10) / 5.2);
    return `<g class="cbox ${lit(b.id)}" data-box="${b.id}"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="5"/>
      <text class="cl" x="${b.x + 5}" y="${b.y + 13}">${esc(clip(b.label, Math.floor((b.w - 10) / 6.6)))}</text>
      <text class="co" x="${b.x + 5}" y="${b.y + 24}">${esc(clip(b.owner, chars))}</text>
      <text class="cs" x="${b.x + 5}" y="${b.y + b.h - 5}">${esc(clip(stat, chars))}</text>
      <title>${esc(b.label)} · ${esc(b.owner)}</title></g>`;
  }).join("");
  return `<svg class="compmap" viewBox="0 0 ${W} ${H}">
    <defs><marker id="al-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z"/></marker></defs>${bounds}<g>${edges}</g>${boxes}<g class="packets"></g></svg>`;
}

function packet(svg, from, to, label) {
  const a = BOX[from], b = BOX[to], layer = svg?.querySelector(".packets");
  if (!a || !b || !layer) return;
  const [x1, y1] = center(a), [x2, y2] = center(b);
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.setAttribute("class", "packet");
  g.innerHTML = `<circle r="6"/><text x="9" y="-8">${esc(clip(label, 40))}</text>`;
  layer.replaceChildren(g);
  const start = performance.now(), dur = 360;
  const step = (t) => {
    const f = Math.min(1, (t - start) / dur), e = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
    g.setAttribute("transform", `translate(${x1 + (x2 - x1) * e},${y1 + (y2 - y1) * e})`);
    if (f < 1 && g.isConnected) requestAnimationFrame(step); else g.remove();
  };
  requestAnimationFrame(step);
}

// ---------------- software layer (tier 5), under b.forward
function layers(ctx) {
  const k = ctx.kernel ?? EXEC.filter((u) => u.tier === 5 && u.t0 <= state.t).at(-1);
  const live = !!ctx.kernel, mod = k && byId.get(k.parent), layer = mod && byId.get(mod.parent);
  const tag = live ? "" : k ? " (last kernel before the cursor)" : "";
  const L = [
    ["sw.toolkit", "builds the op and calls the runtime", k && `${layer?.name ?? ""} · ${mod.name}${tag}`],
    ["sw.runtime", "queues the launch on a CUDA stream", k && `${k.launch} at ${k.cpuT} µs (CPU side)${tag}`],
    ["sw.device", "runs on the SMs", k && `${k.name} · grid ${k.gpu.grid} · ${k.gpu.sms} of 36 SMs${tag}`],
  ];
  return `<div class="crumb">host › <b>server container</b> › <b>executor worker</b> › <b>model forward</b></div>
    <div class="layers">${L.map(([id, what, nowText], i) => `${i ? `<div class="arrow">▼</div>` : ""}
      <div class="layer${live ? " on" : ""}${state.sel === id ? " sel" : ""}" data-sel="${id}">
        <div>${esc(byId.get(id).name)}</div><div class="what">${what}</div>
        <div class="now">${nowText ? esc(nowText) : "no kernel yet"}</div></div>`).join("")}</div>`;
}

// ---------------- lens
function context() {
  const n = now(), comp = n.comp, phase = n.exec[2];
  const prevPhase = phase && [...PHASES].reverse().find((u) => u.t0 < phase.t0 && u.comp !== comp);
  const counts = new Map(), seen = new Set();
  for (const u of PHASES) if (u.t0 <= state.t) { counts.set(u.comp, (counts.get(u.comp) ?? 0) + 1); seen.add(u.comp); }
  const mi = metricInputs(), metricComps = new Set([...mi].map((id) => byId.get(id)?.comp).filter(Boolean));
  return { si: n.sampleIndex, comp, phase, prev: prevPhase?.comp ?? null, counts, seen, kernel: n.kernel,
    here: ancestor(comp, 2), proc: n.process, metricComps, metricCards: new Set([...metricComps].map((c) => ancestor(c, 2))) };
}

function render(root, ctx) {
  const tier = state.tiers.architecture;
  const strip = `<div class="tiers${state.focus === "architecture" ? " focus" : ""}"><span class="dim-name">arch</span>${LADDERS.architecture.map((name, i) =>
    `<button data-tier="${i}" class="${i === tier ? "on" : ""}" title="architecture tier ${i + 1}: ${name}"><b>${i + 1}</b>${name}</button>`).join("")}</div>`;
  let body;
  if (tier <= 1) {
    const host = `<section class="host"><div class="label" data-sel="host">${esc(byId.get("host").name)}</div>${projects(ctx, "compact")}</section>`;
    body = tier === 0 ? `<section class="host"><div class="label" data-sel="fleet">${esc(byId.get("fleet").name)}</div>${host}</section>` : host;
  } else if (tier === 2) body = projects(ctx, "full");
  else if (tier === 3) body = projects(ctx, "process");
  else if (tier === 4) body = `<div class="label">components · the request's path</div>${compMap(ctx)}`;
  else body = `<div class="label">software layer · under model forward</div>${layers(ctx)}<div class="label">components</div>${compMap(ctx)}`;
  root.innerHTML = `<div class="al">${strip}${body}</div>`;
}

export function mountArch(el) {
  if (!document.getElementById("arch-lens-css")) {
    const s = document.createElement("style"); s.id = "arch-lens-css"; s.textContent = CSS; document.head.append(s);
  }
  el.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tier], [data-box], [data-sel]");
    if (!t) return;
    if (t.dataset.tier) return setTier("architecture", Number(t.dataset.tier));
    if (t.dataset.box) {
      const id = t.dataset.box, mine = PHASES.filter((u) => u.comp === id);
      const unit = mine.find((u) => u.t0 > state.t + 1e-6) ?? mine[0];
      return select(unit ? unit.id : id);
    }
    select(t.dataset.sel);
  });
  let lastComp = null;
  subscribe(() => {
    const ctx = context();
    render(el, ctx);
    if (lastComp && ctx.comp !== lastComp && ctx.prev) packet(el.querySelector(".compmap"), ctx.prev, ctx.comp, ctx.phase?.name ?? "");
    lastComp = ctx.comp;
  });
}
