// Architecture view, rebuilt from v1 (devtools/frontend/views/components_map.js, components.js, infra.js, style.css).
// The arrays, the SVG and card markup, the class names and the CSS rules are copied verbatim; nothing is imported.
// Built once per (tier, size); a cursor change only toggles v1's classes, sets text and moves v1's packet.
import { state, subscribe, select, now, metricInputs, data } from "./model.js";

const { ARCH, EXEC, CONTAINERS, PAYLOADS, HW, SAMPLES, FLOWS, FLOW_COLOR, flowsOf, byId } = data;

// ---------------- v1 style.css rules, scoped under .v1arch
const V1_CSS = `
.label { color: var(--dim); font-size: 11px; text-transform: uppercase; margin-bottom: 6px; }
.infra { position: relative; display: grid; grid-template-columns: 1fr 560px; gap: 48px; }
.links { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.links path { fill: none; stroke: var(--accent); stroke-width: 2; stroke-dasharray: 6 4; }
.host, .project, .network, .gpu, .events { border: 1px solid var(--line); border-radius: 6px; padding: 10px; margin-bottom: 12px; }
.network { border-style: dashed; }
.cards { display: flex; flex-wrap: wrap; gap: 10px; }
.card { width: 270px; background: var(--panel); border: 1px solid var(--line); border-left: 4px solid var(--dim); border-radius: 4px; padding: 8px; }
.card.up { border-left-color: var(--up); } .card.starting { border-left-color: var(--starting); } .card.down { border-left-color: var(--down); }
.title { font-weight: bold; display: flex; gap: 6px; align-items: center; }
.state { margin-left: auto; font-weight: normal; color: var(--dim); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dim); }
.up .dot { background: var(--up); } .starting .dot { background: var(--starting); } .down .dot { background: var(--down); }
.image, .port { color: var(--dim); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
.gpuheld { margin-top: 6px; color: var(--accent); }
.spark { width: 120px; height: 24px; } .spark polyline { fill: none; stroke: var(--accent); stroke-width: 1.5; }
.bar { display: inline-block; width: 80px; height: 6px; background: var(--line); border-radius: 3px; overflow: hidden; }
.bar span { display: block; height: 100%; background: var(--accent); }
.gpu table { border-collapse: collapse; width: 100%; } .gpu th { white-space: nowrap; text-align: left; color: var(--dim); font-weight: normal; padding: 3px 6px 3px 0; }
.gpu ul, .events ul { margin: 0; padding-left: 16px; }
.gpu td { white-space: nowrap; padding-right: 8px; }
.dim { color: var(--dim); }
.infra .card[data-service] { cursor: pointer; } .infra .card[data-service]:hover { border-color: var(--accent); }
.compmap { width: 100%; height: auto; max-height: 72vh; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
.compmap .bound rect { fill: none; stroke: var(--dim); stroke-width: 1.5; }
.compmap .bound.container rect { stroke: #8a90a0; stroke-width: 2; fill: rgba(88,166,255,0.03); }
.compmap .bound.process rect { stroke-dasharray: 6 4; } .compmap .bound.ipc rect { stroke-dasharray: 2 4; }
.compmap .bound.network rect { stroke-dasharray: 8 4; stroke: #39c5cf; } .compmap .bound.gpu rect { stroke: #3fb950; }
.compmap .bound text { fill: var(--dim); font-size: 11px; }
.compmap .bound.focus rect { stroke: var(--accent); stroke-width: 3; } .compmap .bound.dimmed { opacity: 0.45; }
.compmap .edge { stroke: #3a4150; stroke-width: 1.5; } .compmap .edge.hot { stroke: #e3b341; stroke-width: 3; }
.compmap marker path { fill: #3a4150; }
.compmap .cbox { cursor: pointer; } .compmap .cbox rect { fill: #10141b; stroke: var(--line); }
.compmap .cbox.seen rect { stroke: #2d5a8a; } .compmap .cbox.on rect { stroke: #e3b341; stroke-width: 3; fill: #2a2412; }
.compmap .cbox.prev rect { stroke: var(--dim); stroke-dasharray: 4 3; }
.compmap .cbox text { pointer-events: none; } .compmap .cl { fill: var(--text); font-size: 11.5px; font-weight: bold; }
.compmap .co { fill: var(--dim); font-size: 9.5px; } .compmap .cs { fill: #58a6ff; font-size: 9.5px; }
.compmap .packet circle { fill: #e3b341; stroke: #fff; stroke-width: 1.5; }
.compmap .packet text { fill: #ffd479; font-size: 11px; paint-order: stroke; stroke: #0f1115; stroke-width: 3px; }
.nowis { margin: 6px 0; color: #ffd479; }
.compmap .cbox.driven rect { stroke: #3fb950; stroke-width: 3; fill: #13261a; }
.compmap .edge.drives { stroke-dasharray: 3 3; }
.compmap .cbox.lit rect { stroke: #f778ba; stroke-width: 3; }
`;
const CSS = `.v1arch { height: 100%; overflow: auto; padding: 16px; font: 13px/1.4 ui-monospace, monospace; color: var(--text); container-type: inline-size; }
.v1arch.lens { padding: 8px; }
.v1arch .mapfit { display: flex; justify-content: center; align-items: flex-start; }
.v1arch .mapfit .compmap { max-height: none; }
.v1arch .swrows { margin-top: 12px; }
.v1arch [data-sel] { cursor: pointer; }
.v1arch .flowkey { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px 16px; margin-top: 6px; color: var(--dim); font-size: 11px; }
.v1arch .flowkey i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
${V1_CSS.trim().split("\n").map((l) => l.replace(/(^|\} )([^{}]+)\{/g, (m, a, sel) => `${a}${sel.split(",").map((s) => `.v1arch ${s.trim()}`).join(", ")} {`)).join("\n")}
@container (max-width: 900px) { .v1arch .infra { grid-template-columns: 1fr; } .v1arch .links { display: none; } }`;

// ---------------- v1 components_map.js, verbatim
const W = 1400, H = 700;
// [id, label, owner, x, y, w, h]
const BOXES = [
  ["locust", "Locust user", "locust · gevent", 30, 70, 230, 46],
  ["send_one", "send_one", "scripts/chat_client.py", 30, 132, 230, 46],
  ["sdk", "OpenAI SDK", "openai · chat.completions stream", 30, 194, 230, 46],
  ["transport", "HTTP transport", "httpx2 HTTPTransport + ObservedTransport", 30, 256, 230, 46],
  ["eth0", "bridge → eth0", "veth pair · tcpdump", 300, 256, 150, 46],
  ["asgi", "ASGI server", "uvicorn + ServerArrivalTimeMiddleware", 500, 76, 390, 40],
  ["validate", "request validation", "FastAPI + pydantic", 500, 134, 180, 40],
  ["parse", "message parsing", "TensorRT-LLM serve", 500, 184, 180, 40],
  ["template", "chat template", "HF tokenizer Jinja template", 500, 234, 180, 40],
  ["tokenizer", "tokenizer", "HF fast tokenizer encode", 500, 284, 180, 40],
  ["llm_api", "LLM API handoff", "GenerationExecutor.generate_async", 500, 334, 180, 40],
  ["proxy", "executor proxy", "GenerationExecutorProxy.submit", 500, 384, 180, 40],
  ["postprocess", "SSE post-processor", "chat_stream_post_processor", 710, 284, 180, 40],
  ["detokenize", "detokenizer", "HF decode_incrementally", 710, 334, 180, 40],
  ["ipc_req", "ZMQ request socket", "pyzmq · pickle", 540, 460, 150, 40],
  ["ipc_rsp", "ZMQ result socket", "pyzmq · pickle", 720, 460, 150, 40],
  ["worker", "worker submit", "BaseWorker → LlmRequest", 500, 540, 150, 40],
  ["fetch", "request queue", "ExecutorRequestQueue", 670, 540, 150, 40],
  ["scheduler", "scheduler", "capacity + micro-batch (C++)", 840, 540, 150, 40],
  ["kv_cache", "KV cache manager", "KVCacheManager (C++ blocks)", 840, 594, 150, 40],
  ["forward", "model forward", "PyTorchModelEngine · CUDA graphs", 1010, 540, 150, 40],
  ["sampler", "sampler", "TorchSampler", 1010, 594, 150, 40],
  ["update", "token update", "PyExecutor._update_requests", 1010, 648, 150, 40],
  ["responses", "responses", "PyExecutor._enqueue_responses", 840, 648, 150, 40],
  ["gpu", "GPU kernels", "RTX 5060 Ti · CUDA", 1220, 548, 160, 40],
  ["kvpool", "KV pool (VRAM)", "blocks of 32 tokens", 1220, 602, 160, 40],
];
const BOX = Object.fromEntries(BOXES.map(([id, label, owner, x, y, w, h]) => [id, { id, label, owner, x, y, w, h }]));
// Boundaries: [key, label, x, y, w, h, kind]
const BOUNDS = [
  ["client", "client container", 14, 30, 262, 290, "container"],
  ["network", "network ie-i02a-l1_default", 284, 226, 182, 96, "network"],
  ["server", "server container", 482, 30, 718, 668, "container"],
  ["http", "trtllm-serve process: HTTP, LLM API, proxy", 492, 52, 410, 380, "process"],
  ["zmq", "ZMQ over tcp://127.0.0.1 (between processes)", 524, 440, 362, 70, "ipc"],
  ["worker", "executor worker process (MPI-spawned): PyExecutor loop", 492, 518, 700, 176, "process"],
  ["host", "host GPU", 1208, 520, 184, 140, "gpu"],
];
const EDGES = [
  ["locust", "send_one"], ["send_one", "sdk"], ["sdk", "transport"], ["transport", "eth0"], ["eth0", "asgi"],
  ["asgi", "validate"], ["validate", "parse"], ["parse", "template"], ["template", "tokenizer"], ["tokenizer", "llm_api"],
  ["llm_api", "proxy"], ["proxy", "ipc_req"], ["ipc_req", "worker"], ["worker", "fetch"], ["fetch", "scheduler"],
  ["scheduler", "kv_cache"], ["kv_cache", "kvpool"], ["kv_cache", "forward"], ["forward", "gpu"], ["forward", "sampler"],
  ["sampler", "update"], ["update", "responses"], ["responses", "ipc_rsp"], ["ipc_rsp", "detokenize"],
  ["detokenize", "postprocess"], ["postprocess", "asgi"],
];
const DRIVES = { forward: "gpu", sampler: "gpu", kv_cache: "kvpool" };
const escape = (text) => String(text ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ms = (v, digits = 2) => (v == null ? "–" : `${Number(v).toFixed(digits)}`);
const center = (b) => [b.x + b.w / 2, b.y + b.h / 2];
const statText = (s) => (!s?.n ? "" : s.ms > 0 ? `${s.n}× · ${ms(s.ms, 3)} ms in all` : `${s.n}× (instants)`);
// D12 additions on the v1 map: each bound and box names the scratch architecture thing it is (for clicks and beams).
const BOUND_SEL = { client: "c.client", network: "c.net", server: "c.server", http: "p.http", worker: "p.worker", host: "gpu" };
// Owner ruling 2026-11-08: each box carries a stripe with one segment per flow it serves (flows overlap in time).
const STRIPE = Object.fromEntries(BOXES.map(([id]) => [id, flowsOf(`b.${id}`)]));
function mapSVG({ labels = {} } = {}) {
  const bounds = BOUNDS.map(([k, label, x, y, w, h, kind]) => `<g class="bound ${kind}  " data-bound="${k}" data-sel="${BOUND_SEL[k] ?? ""}">
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/>
    <text x="${x + 8}" y="${y + 15}">${escape(label)}${labels[k] ? ` · ${escape(labels[k])}` : ""}</text></g>`).join("");
  const edges = EDGES.map(([a, b]) => {
    const [x1, y1] = center(BOX[a]), [x2, y2] = center(BOX[b]);
    return `<line class="edge ${DRIVES[a] === b ? "drives" : ""}" data-edge="${a}>${b}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#cm-arrow)"/>`;
  }).join("");
  const boxes = BOXES.map(([id, label, owner, x, y, w, h]) => `<g class="cbox   " data-box="${id}" data-id="b.${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5"/>
      ${STRIPE[id].map((f, i, a) => `<rect class="fseg" x="${x + 1.5}" y="${y + 1.5 + (i * (h - 3)) / a.length}" width="4" height="${(h - 3) / a.length}" style="fill:${FLOW_COLOR[f]};stroke:none"/>`).join("")}
      <rect class="fon" x="${x + 1.5}" y="${y + 1.5}" width="4" height="${h - 3}" style="stroke:none;display:none"/>
      <text class="cl" x="${x + 6}" y="${y + 14}">${escape(label)}</text>
      <text class="co" x="${x + 6}" y="${y + 26}">${escape(owner)}</text>
      <text class="cs" x="${x + 6}" y="${y + h - 4}" data-stat="${id}"></text>
      <title>${escape(label)} · ${escape(owner)}</title></g>`).join("");
  return `<svg class="compmap" viewBox="0 0 ${W} ${H}">
    <defs><marker id="cm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z"/></marker></defs>
    ${bounds}<g class="edges">${edges}</g>${boxes}<g class="packets"></g></svg>`;
}

function packet(svg, from, to, label, duration = 320, flow = "") {
  const a = BOX[from], b = BOX[to];
  if (!svg || !b) return;
  const layer = svg.querySelector(".packets");
  layer.querySelectorAll(`[data-flow="${flow}"]`).forEach((n) => n.remove());
  const [x2, y2] = center(b), [x1, y1] = a ? center(a) : [x2, y2];
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.setAttribute("class", "packet"); g.dataset.flow = flow;
  g.innerHTML = `<circle r="7"/><text x="10" y="-9"${FLOW_COLOR[flow] ? ` style="fill:${FLOW_COLOR[flow]}"` : ""}>${escape(label.slice(0, 70))}</text>`;
  layer.appendChild(g);
  const start = performance.now();
  const step = (t) => {
    const f = Math.min(1, (t - start) / duration), e = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
    g.setAttribute("transform", `translate(${x1 + (x2 - x1) * e},${y1 + (y2 - y1) * e})`);
    if (f < 1 && g.isConnected) requestAnimationFrame(step); else g.remove();
  };
  requestAnimationFrame(step);
}

// ---------------- scratch phases on the v1 map
const PHASES = EXEC.filter((u) => u.tier === 2).sort((a, b) => a.t0 - b.t0);
const REQ = EXEC.find((u) => u.tier === 0);
const boxOf = (u) => u?.comp?.slice(2) ?? null;
const ids = (a) => (a ? `[${a.slice(0, 6).join(", ")}${a.length > 6 ? ", …" : ""}]` : "");
/** v1 dataForm, fed from the scratch PAYLOADS: what the request is in this step. */
function dataForm(box, phase, kernel) {
  const d = PAYLOADS[`b.${box}`] ?? {}, name = phase?.name ?? "", first = phase?.parent === REQ.id;
  switch (box) {
    case "transport": return first ? `POST ${d.bytes} B JSON` : name;
    case "eth0": return first ? `${d.direction} · ${d.bytes} B · ${d.frame}` : name;
    case "template": return `${d.text.length} characters of templated text`;
    case "tokenizer": return `${d.prompt_token_ids.length} token IDs ${ids(d.prompt_token_ids)}`;
    case "llm_api": return `request_id ${d.request_id} · max_tokens ${d.sampling.max_tokens}`;
    case "ipc_req": return `${d.bytes} B pickled`;
    case "scheduler": return `context ${first ? 1 : 0} · generation ${first ? 0 : 1} · cid ${d.table[0].cid}`;
    case "forward": return kernel ? kernel.name : name;
    case "sampler": return `new_token_ids ${ids(d.new_token_ids)}`;
    case "detokenize": return `${ids(PAYLOADS["b.sampler"].new_token_ids)} → ${JSON.stringify(d.new_text)}`;
    case "postprocess": return `${d.events.length} SSE event(s)`;
    case "sdk": return name.startsWith("SDK yields") ? `chunk: ${JSON.stringify(d.event.choices[0].delta.content)}` : name;
    default: return name;
  }
}

// ---------------- v1 infra.js, verbatim where the scratch data has the value
const MiB = 1024 * 1024;
const fmt = {
  pct: (v) => (v == null ? "–" : `${v.toFixed(0)} %`),
  mib: (bytes) => `${(bytes / MiB).toFixed(0)} MiB`,
  gib: (mib) => `${(mib / 1024).toFixed(2)} GiB`,
  rate: (bps) => (bps == null ? "–" : bps < 1024 ? `${bps.toFixed(0)} B/s` : `${(bps / 1024).toFixed(1)} KiB/s`),
};
const HISTORY = 120; // v1 keeps about 120 samples of history per series
const sparkPoints = (values = [], max) => values.map((v, i) => `${i},${30 - (30 * (v ?? 0)) / (max || Math.max(...values, 1))}`).join(" ");
const spark = (key) => `<svg class="spark" viewBox="0 0 120 30" preserveAspectRatio="none" data-spark="${key}"><polyline points=""/></svg>`;
const bar = (key) => `<span class="bar"><span data-bar="${key}" style="width:0%"></span></span>`;
const history = (series, si) => series.slice(Math.max(0, si + 1 - HISTORY), si + 1);
function status(c) {
  if (c.state !== "running") return ["down", c.state];
  if (c.health === "starting") return ["starting", "starting"];
  if (c.health === "unhealthy") return ["down", "unhealthy"];
  return ["up", c.health ?? "running"];
}
const byIdC = Object.fromEntries(CONTAINERS.map((c) => [c.id, c]));
const PROCS = ARCH.filter((a) => a.tier === 3);

function card(c, withProcs) {
  const [cls, label] = status(c);
  const net = c.sharesNetnsWith
    ? `uses the network namespace of <b>${byIdC[c.sharesNetnsWith]?.service ?? c.sharesNetnsWith}</b>`
    : "";
  const gpu = c.gpu ? `<div class="gpuheld">GPU ${fmt.gib(c.gpu.mib)} · ${c.gpu.program} pid ${c.gpu.pid}</div>` : "";
  const procs = withProcs ? PROCS.filter((p) => p.parent === c.id) : [];
  const plist = withProcs ? `<div class="label" style="margin-top:6px">processes</div>${procs.length
    ? procs.map((p) => `<div class="row" data-sel="${p.id}" data-proc="${p.id}"><span>${escape(p.name)}</span></div>`).join("")
    : `<div class="dim">not in the scratch data</div>`}` : "";
  return `<div class="card ${cls}" data-id="${c.id}" data-sel="${c.id}" data-project="${c.project}" data-service="${c.service}"
    title="open the components inside this container">
    <div class="title"><i class="dot"></i>${c.service}<span class="state">${label}</span></div>
    <div class="image">${c.image}</div>
    <div class="row"><span data-v="cpu"></span> ${spark("cpu")}</div>
    <div class="row"><span data-v="mem"></span> ${bar("mem")}</div>
    <div class="row net"${c.sharesNetnsWith ? "" : ` data-v="net" data-nets="${c.networks.join(", ")}"`}>${net}</div>
    ${gpu}${plist}<div class="nowis" data-now="${c.id}"></div>
  </div>`;
}

function project(name, containers, withProcs) {
  const networks = {};
  for (const c of containers) {
    if (c.sharesNetnsWith) continue;
    const net = c.networks[0] ?? "none";
    (networks[net] ??= []).push(c, ...containers.filter((o) => o.sharesNetnsWith === c.id));
  }
  const boxes = Object.entries(networks).map(([net, members]) => {
    const thing = ARCH.find((a) => a.tier === 2 && a.name === `network ${net}`);
    const bridge = withProcs && thing ? PROCS.filter((p) => p.parent === thing.id)
      .map((p) => `<div class="row" data-sel="${p.id}" data-proc="${p.id}"><span>${escape(p.name)}</span></div>`).join("") : "";
    return `<div class="network">
      <div class="label"${thing ? ` data-sel="${thing.id}"` : ""}>network ${net}</div>${bridge}
      <div class="cards">${members.map((c) => card(c, withProcs)).join("")}</div>
    </div>`;
  });
  return `<section class="project"><div class="label">project ${name}</div>${boxes.join("")}</section>`;
}

const VRAM_MIB = 16 * 1024; // "GDDR7 16 GiB" in the scratch hardware
const PCIE = HW.find((h) => h.id === "pcie").name.replace("PCIe ", "");
function gpuPanel() {
  const rows = [
    ["memory", "vram", true, true], ["any kernel running", "sm", true, true], ["memory read/write", "dram", true, true],
    ["power", "power", false, false], ["PCIe", "pcie", false, true], ["clocks", "clocks", false, false], ["temperature", "temp", false, false],
  ];
  const holders = CONTAINERS.filter((c) => c.gpu).map((c) => `<li>${fmt.gib(c.gpu.mib)} · ${c.gpu.program} · ${c.service}</li>`);
  return `<section class="gpu" id="gpu" data-sel="gpu"><div class="label">host GPU · scratch, 0.1 ms samples</div>
    <table>${rows.map(([k, key, b, s]) => `<tr><th>${k}</th><td data-g="${key}">–</td><td>${b ? bar(key) : ""}</td><td>${s ? spark(key) : ""}</td></tr>`).join("")}</table>
    <div class="label">GPU memory held by</div><ul>${holders.join("")}</ul></section>`;
}

function infraHTML(withProcs) {
  const projects = {};
  for (const c of CONTAINERS) (projects[c.project] ??= []).push(c);
  return `<div class="infra">
    <div class="projects">${Object.entries(projects).map(([n, cs]) => project(n, cs, withProcs)).join("")}</div>
    <div class="side">${gpuPanel()}</div>
    <svg class="links"></svg></div>`;
}

const LAYERS = [["sw.toolkit", "builds the op and calls the runtime"], ["sw.runtime", "queues the launch on a CUDA stream"], ["sw.device", "runs on the SMs"]];
const layersHTML = () => `<div class="swrows"><div class="label">software layer · under model forward</div><div class="cards">${LAYERS.map(([id, what]) =>
  `<div class="card up" data-sel="${id}" data-id="${id}"><div class="title"><i class="dot"></i>${escape(byId.get(id).name)}</div>
    <div class="image">${what}</div><div class="nowis" data-layer="${id}"></div></div>`).join("")}</div></div>`;

const ancestor = (id, tier) => { let x = byId.get(id); while (x && x.tier > tier) x = byId.get(x.parent); return x?.tier === tier ? x.id : null; };
const setText = (el, s) => { if (el && el.textContent !== s) el.textContent = s; };

// ---------------- the view
export function mountArch(el, { size = "lens" } = {}) {
  if (!document.getElementById("v1arch-css")) {
    const s = document.createElement("style"); s.id = "v1arch-css"; s.textContent = CSS; document.head.append(s);
  }
  let built = null, v = null, shown = null;

  const onClick = (e) => {
    const t = e.target.closest("[data-box], [data-sel]");
    if (!t || !el.contains(t)) return;
    if (t.dataset.box) {
      const mine = PHASES.filter((u) => boxOf(u) === t.dataset.box);
      const unit = mine.find((u) => u.t0 > state.t + 1e-6) ?? mine[0];
      return select(unit ? unit.id : `b.${t.dataset.box}`);
    }
    if (t.dataset.sel) select(t.dataset.sel);
  };
  el.addEventListener("click", onClick);

  function labels() {
    const describe = (c) => (c ? `${c.image} · ${c.state}` : "");
    const worker = CONTAINERS.find((c) => c.gpu)?.gpu.pid;
    return { client: describe(byIdC["c.client"]), server: describe(byIdC["c.server"]),
      worker: worker ? `pid ${worker}` : "" };
  }

  function fitMap() {
    if (!v?.svg) return;
    const wrap = v.svg.parentElement, rows = el.querySelector(".swrows"), key = el.querySelector(".flowkey");
    const pad = size === "full" ? 32 : 16;
    const aw = el.clientWidth - pad, ah = el.clientHeight - pad - (rows ? rows.offsetHeight + 12 : 0) - (key ? key.offsetHeight + 6 : 0);
    const w = Math.max(100, Math.min(aw, (ah * W) / H));
    v.svg.style.width = `${w}px`; v.svg.style.height = `${(w * H) / W}px`;
    wrap.style.width = `${aw}px`;
  }

  function drawLinks() { // v1 InfraView.drawLinks: a line from each container that holds GPU memory to the GPU panel
    const svg = el.querySelector("svg.links"), infra = el.querySelector(".infra"), gpu = el.querySelector("#gpu");
    if (!svg || !infra || !gpu) return;
    const origin = infra.getBoundingClientRect(), g = gpu.getBoundingClientRect();
    svg.innerHTML = CONTAINERS.filter((c) => c.gpu).map((c) => {
      const card_ = el.querySelector(`.card[data-id="${c.id}"]`);
      if (!card_) return "";
      const r = card_.getBoundingClientRect();
      const x1 = r.right - origin.left, y1 = r.top + r.height / 2 - origin.top;
      const x2 = g.left - origin.left, y2 = g.top + 30 - origin.top;
      return `<path d="M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}"/>`;
    }).join("");
  }

  function build() {
    const tier = state.tiers.architecture;
    if (built === tier) return false;
    built = tier;
    let body;
    const key = `<div class="flowkey">${FLOWS.map(([f, l]) => `<span><i style="background:${FLOW_COLOR[f]}"></i>${escape(l)}</span>`).join("")}</div>`;
    if (tier >= 4) body = `<div class="mapfit">${mapSVG({ labels: labels() })}</div>${key}${tier >= 5 ? layersHTML() : ""}`;
    else {
      const infra = infraHTML(tier === 3);
      if (tier >= 2) body = infra;
      else {
        const host = `<section class="host"><div class="label" data-sel="host">${escape(byId.get("host").name)}</div>${infra}</section>`;
        body = tier === 0 ? `<section class="host"><div class="label" data-sel="fleet">${escape(byId.get("fleet").name)}</div>${host}</section>` : host;
      }
    }
    el.innerHTML = `<div class="v1arch ${size}">${body}</div>`;
    const q = (s) => [...el.querySelectorAll(s)];
    v = { tier, svg: el.querySelector("svg.compmap"),
      boxes: new Map(q(".cbox").map((g) => [g.dataset.box, { g, stat: g.querySelector("[data-stat]"), fon: g.querySelector(".fon") }])),
      edges: q(".edge"),
      cards: q(".card[data-project]").map((n) => ({ n, c: byIdC[n.dataset.id], now: n.querySelector("[data-now]"),
        v: (k) => n.querySelector(`[data-v="${k}"]`), spark: (k) => n.querySelector(`[data-spark="${k}"] polyline`), bar: (k) => n.querySelector(`[data-bar="${k}"]`) })),
      procs: q("[data-proc]"), layers: q("[data-layer]"),
      gpu: el.querySelector("#gpu"), si: -1 };
    shown = null;
    fitMap(); drawLinks();
    return true;
  }

  /** The phases at the cursor (flows overlap, so there can be several), each with the box it came from. */
  function context() {
    const n = now(), ev = state.playing && state.playEvent ? byId.get(state.playEvent) : null;
    let phases = n.phases.length ? n.phases : [ev?.tier === 2 ? ev : n.exec[2]].filter(Boolean);
    const kernel = ev?.tier === 5 ? ev : n.kernel;
    const active = phases.map((p) => {
      const before = PHASES.filter((q) => q !== p && q.t1 <= p.t0 + 1e-6 && q.comp !== p.comp);
      const from = before.reduce((m, q) => (!m || q.t1 > m.t1 || (q.t1 === m.t1 && q.flow === p.flow) ? q : m), null);
      return { p, box: boxOf(p), prev: boxOf(from), flow: p.flow };
    });
    const on = new Set(active.map((a) => a.box)), prev = new Set(active.map((a) => a.prev).filter((b) => b && !on.has(b)));
    const stats = {};
    for (const u of PHASES) {
      if (u.t0 > state.t) break;
      const s = (stats[boxOf(u)] ??= { n: 0, ms: 0 }); s.n += 1; s.ms += (u.t1 - u.t0) / 1000;
    }
    const driven = new Set();
    if (kernel || on.has("sampler")) driven.add("gpu");
    if (on.has("kv_cache")) driven.add("kvpool");
    const lit = new Set([...metricInputs()].map((id) => boxOf(byId.get(id))).filter(Boolean));
    const comps = active.map((a) => a.p.comp);
    return { n, si: n.sampleIndex, active, on, prev, kernel, stats, driven, lit, comps,
      procs: new Set(comps.map((c) => ancestor(c, 3))), cards: new Set(comps.map((c) => ancestor(c, 2))) };
  }

  function updateMap(ctx) {
    const flowOn = new Map(ctx.active.map((a) => [a.box, a.flow]));
    for (const [id, { g, stat, fon }] of v.boxes) {
      const s = ctx.stats[id], f = flowOn.get(id);
      g.classList.toggle("on", ctx.on.has(id));
      g.classList.toggle("prev", ctx.prev.has(id));
      g.classList.toggle("seen", !!s?.n);
      g.classList.toggle("driven", ctx.driven.has(id));
      g.classList.toggle("lit", ctx.lit.has(id));
      setText(stat, statText(s));
      const show = f && STRIPE[id].length ? "" : "none";
      if (fon.style.display !== show) fon.style.display = show;
      if (f && fon.style.fill !== FLOW_COLOR[f]) fon.style.fill = FLOW_COLOR[f];
    }
    const hot = new Set(ctx.active.flatMap((a) => [`${a.prev}>${a.box}`, `${a.box}>${a.prev}`]));
    for (const e of v.edges) e.classList.toggle("hot", hot.has(e.dataset.edge));
    const ids = ctx.active.map((a) => a.p.id).join();
    if (ids !== shown) {
      const was = shown === null ? null : new Set(shown.split(","));
      if (was) for (const a of ctx.active) if (!was.has(a.p.id)) packet(v.svg, a.prev, a.box, dataForm(a.box, a.p, ctx.kernel),
        state.playing ? Math.min(300, 900 / state.rate) : 320, a.flow);
      shown = ids;
    }
  }

  function updateLayers(ctx) {
    const k = ctx.kernel ?? EXEC.filter((u) => u.tier === 5 && u.t0 <= state.t).at(-1);
    const tag = ctx.kernel ? "" : k ? " (last kernel before the cursor)" : "";
    const mod = k && byId.get(k.parent), layer = mod && byId.get(mod.parent);
    const texts = [k && `${layer?.name ?? ""} · ${mod.name}${tag}`, k && `${k.launch} at ${k.cpuT} µs (CPU side)${tag}`,
      k && `${k.name} · grid ${k.gpu.grid} · ${k.gpu.sms} of 36 SMs${tag}`];
    v.layers.forEach((n, i) => setText(n, texts[i] ?? "no kernel yet"));
  }

  function updateInfra(ctx) {
    for (const { c, now: nowEl } of v.cards) {
      const here = ctx.comps.filter((x) => ancestor(x, 2) === c.id).map((x) => byId.get(x)?.name);
      setText(nowEl, here.length ? `the request is now at: ${here.join(" + ")}` : "");
    }
    for (const p of v.procs) setText(p.lastElementChild, `${byId.get(p.dataset.proc).name}${ctx.procs.has(p.dataset.proc) ? "  ◀ at the cursor" : ""}`);
    if (ctx.si === v.si) return;
    const si = ctx.si; v.si = si;
    for (const { c, v: val, spark: sp, bar: b } of v.cards) {
      const cpu = c.cpu[si], mem = c.mem[si];
      setText(val("cpu"), `CPU ${fmt.pct(cpu)}`);
      sp("cpu")?.setAttribute("points", sparkPoints(history(c.cpu, si)));
      setText(val("mem"), `mem ${fmt.mib(mem)} / ${fmt.mib(c.memLimit)}`);
      if (b("mem")) b("mem").style.width = `${Math.min(100, (100 * mem) / c.memLimit).toFixed(1)}%`;
      const nv = val("net"); if (nv) setText(nv, `↓ ${fmt.rate(c.rx?.[si])} ↑ ${fmt.rate(c.tx?.[si])} · ${nv.dataset.nets}`);
    }
    const g = v.gpu; if (!g) return;
    const s = SAMPLES[si], td = (k) => g.querySelector(`[data-g="${k}"]`);
    const set = (k, text, frac, series, max) => {
      setText(td(k), text);
      const bb = g.querySelector(`[data-bar="${k}"]`); if (bb) bb.style.width = `${Math.min(100, 100 * frac).toFixed(1)}%`;
      const p = g.querySelector(`[data-spark="${k}"] polyline`); if (p && series) p.setAttribute("points", sparkPoints(history(series, si), max));
    };
    set("vram", `${fmt.gib(s.vramGiB * 1024)} / ${fmt.gib(VRAM_MIB)}`, (s.vramGiB * 1024) / VRAM_MIB, SAMPLES.map((x) => x.vramGiB * 1024), VRAM_MIB);
    set("sm", fmt.pct(100 * s.gpuUtil), s.gpuUtil, SAMPLES.map((x) => 100 * x.gpuUtil), 100);
    set("dram", fmt.pct(100 * s.dram), s.dram, SAMPLES.map((x) => 100 * x.dram), 100);
    set("power", "– / – W", 0);
    set("pcie", `gen ${PCIE.replace("gen ", "").replace(" ", " ")} · ${s.pcie ? `busy ${fmt.pct(100 * s.pcie)}` : "↓ – ↑ –"} MB/s`, 0, SAMPLES.map((x) => x.pcie), 1);
    set("clocks", "SM –/– · mem –/– MHz", 0);
    set("temp", "– °C", 0);
  }

  function update() {
    const ctx = context();
    if (v.boxes.size) updateMap(ctx);
    if (v.layers.length) updateLayers(ctx);
    if (v.cards.length) updateInfra(ctx);
  }

  const unsub = subscribe((s, ch) => {
    if (ch.tiers || !v) build();
    update();
  });
  let rf = 0;
  const ro = new ResizeObserver(() => { cancelAnimationFrame(rf); rf = requestAnimationFrame(() => { fitMap(); drawLinks(); }); });
  ro.observe(el);
  return () => { unsub(); ro.disconnect(); cancelAnimationFrame(rf); el.removeEventListener("click", onClick); el.replaceChildren(); };
}
