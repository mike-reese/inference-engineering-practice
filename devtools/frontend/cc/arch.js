// Architecture view (D13 arch.js, rebuilt from v1 components_map.js, components.js, infra.js, style.css). The CSS
// rules, the SVG and card markup and the class names are copied verbatim; every value comes from the shown run
// (COMMAND_CENTER.md 7.1, 7.2): the component map, containers, processes and the GPU are manifest things, box runs and
// stripes the store's load-time aggregate, payloads the cold args of each row, gauges the run's samples.
// Built once per (store, tier); a cursor change only toggles v1's classes, sets text and moves v1's packet.
import { state, subscribe, select, now, store, units, metricInputs, FLOW_COLOR } from "./control/control.js";
import { fmtValue, sourceOf, periodOf } from "./sidebar/samples.js";
import { NONE16 } from "./store/columns.js";
import { perf } from "./perf.js";

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
.v1arch .gpu td[data-g="pcie"] { white-space: normal; }
.v1arch .flowkey { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px 16px; margin-top: 6px; color: var(--dim); font-size: 11px; }
.v1arch .flowkey i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
${V1_CSS.trim().split("\n").map((l) => l.replace(/(^|\} )([^{}]+)\{/g, (m, a, sel) => `${a}${sel.split(",").map((s) => `.v1arch ${s.trim()}`).join(", ")} {`)).join("\n")}
@container (max-width: 900px) { .v1arch .infra { grid-template-columns: 1fr; } .v1arch .links { display: none; } }`;

const NS = "http://www.w3.org/2000/svg";
const escape = (text) => String(text ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ms = (v, digits = 2) => (v == null ? "–" : `${Number(v).toFixed(digits)}`);
const center = (b) => [b.x + b.w / 2, b.y + b.h / 2];
const statText = (n, ns) => (!n ? "" : ns > 0 ? `${n}× · ${ms(ns / 1e6, 3)} ms in all` : `${n}× (instants)`);
const setText = (el, s) => { if (el && el.textContent !== s) el.textContent = s; };
const upper = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const k = (lo + hi) >>> 1; if (a[k] <= x) lo = k + 1; else hi = k; } return lo; };
const under = (t, a) => t.pre >= a.pre && t.post <= a.post;
const FLOW_LABEL = { "request in": "request in: client to the engine queue", prefill: "prefill: build the KV cache, first token",
  decode: "decode loop: one token per pass", "stream out": "stream out: token back to the user" };
const LAYER_ORDER = ["toolkit", "runtime", "device code"];   // a launch goes toolkit -> runtime -> device code (doc 3.3)
const PREV_SCAN = 64;   // the request's phase rows looked back through for the box a step came from
const HISTORY = 120;    // v1 keeps about 120 samples of history per series

// ---------------- the run's architecture, built once per store: component map, containers, processes, GPU
const models = new WeakMap(), phaseIdx = new WeakMap();
function modelOf(S) {
  const key = `${S.things.length}/${S.metrics.length}`;
  let m = models.get(S);
  if (!m || m.key !== key) models.set(S, (m = buildModel(S, key)));
  return m;
}
function buildModel(S, key) {
  const T = S.things, byKind = (k) => T.filter((t) => t.kind === k);
  const map = byKind("component map")[0] ?? null;
  const xywh = (a) => ({ x: a.x, y: a.y, w: a.w, h: a.h });
  const boxes = byKind("component").map((t) => ({ i: t.i, thing: t.key, key: t.attrs.key, label: t.name, owner: t.attrs.owner, flows: S.dims.compFlows(t.i), ...xywh(t.attrs) }));
  const bounds = byKind("boundary").map((t) => ({ i: t.i, thing: t.key, key: t.attrs.key, kind: t.attrs.kind, label: t.name, ...xywh(t.attrs) }));
  const metric = (name, thing) => S.metrics.findIndex((m) => m.metric === name && m.thing === thing);
  const procs = byKind("process");
  const ce = S.kinds.find((k) => k.name === "container event")?.code;
  const evRows = ce == null ? [] : S.dims.byKind[ce];
  const containers = byKind("container").map((t) => {
    const events = [];
    for (const id of evRows) if (S.field("lane", id) === t.i) events.push({ t: S.startOf[id], name: S.nameText(S.field("name", id)) });
    const ps = procs.filter((p) => under(p, t));
    return { t, key: t.key, name: t.name, project: t.attrs?.project ?? null, events, health: events.some((e) => e.name.startsWith("health_status")),
      docker: t.attrs?.docker ?? null, image: t.attrs?.image ?? null, networks: t.attrs?.networks ?? null, netns: t.attrs?.netns ?? null, memLimit: t.attrs?.mem_limit ?? null,
      cpu: metric("docker.cpu_pct", t.i), mem: metric("docker.mem_bytes", t.i), rx: metric("docker.rx_rate", t.i), tx: metric("docker.tx_rate", t.i),
      procs: ps, gpu: ps.map((p) => ({ p, m: metric("gpu.app.memory.used", p.i) })).filter((x) => x.m >= 0) };
  });
  for (const c of containers) c.sharesWith = c.netns ? containers.find((o) => o.docker === c.netns) ?? null : null;
  const networks = byKind("network").map((t) => ({ t, key: t.key, name: t.name, procs: procs.filter((p) => under(p, t)) }));
  const g = byKind("gpu")[0] ?? null;
  const first = (...names) => { for (const n of names) { const i = metric(n, g?.i); if (i >= 0) return i; } return -1; };
  const gpu = g && { t: g, vram: g.attrs?.vram_bytes ?? null, sms: g.attrs?.sms ?? byKind("SM").length,
    mem: first("nvml.memory.used", "memory.used"), util: first("utilization.gpu"), memutil: first("utilization.memory"),
    power: first("nvml.power.draw", "power.draw"), gen: first("pcie.link.gen.current"), clock: first("nvml.clocks.sm", "clocks.sm"),
    temp: first("nvml.temperature.gpu", "temperature.gpu"), rx: first("nvml.pcie.rx"), tx: first("nvml.pcie.tx") };
  // software layers: the kinds the registry places at architecture / software layer, by layer
  const layers = LAYER_ORDER.map((name) => ({ name, kinds: S.kinds.filter((k) => k.place?.architecture === `software layer (${name})`).map((k) => k.name) }));
  return { key, map, size: map?.attrs?.size ?? [1400, 700], edges: map?.attrs?.edges ?? [], drives: map?.attrs?.drives ?? {},
    boxes, bounds, box: new Map(boxes.map((b) => [b.key, b])), boxOfThing: new Map(boxes.map((b) => [b.i, b])),
    containers, networks, gpu, layers, host: byKind("host") };
}

/** Phase rows by request (the box a step came from), by box (a click goes to the box's next row), the processes
 *  that carry them, and which container or process each boundary of the map stands for. Rebuilt when rows change. */
function phasesOf(S, M) {
  const key = `${S.N}/${S.rev}/${M.key}`;
  let x = phaseIdx.get(S);
  if (x?.key === key) return x;
  const P = S.dims.ladders.execution.indexOf("phase"), u = units(P), L = S.dims.laneLevel;
  const byReq = new Map(), pos = new Map(), box = new Map(), procs = new Set(), votes = new Map();
  const vote = (b, thing) => { if (thing < 0) return; const m = votes.get(b) ?? votes.set(b, new Map()).get(b); m.set(thing, (m.get(thing) ?? 0) + 1); };
  const boundsOf = new Map(M.boxes.map((b) => [b.i, M.bounds.filter((B) => under(S.things[b.i], S.things[B.i]))]));
  for (const id of u.ids) {
    const r = S.field("req", id), c = S.field("comp", id), lane = S.field("lane", id);
    if (r !== NONE16) { const a = byReq.get(r) ?? byReq.set(r, []).get(r); pos.set(id, a.length); a.push(id); }
    if (L.process[lane] >= 0) procs.add(L.process[lane]);
    if (c === NONE16) continue;
    (box.get(c) ?? box.set(c, []).get(c)).push(id);
    for (const B of boundsOf.get(c) ?? []) vote(B.key, B.kind === "process" ? L.process[lane] : B.kind === "container" || B.kind === "network" ? L.container[lane] : -1);
  }
  const bound = new Map();
  for (const B of M.bounds) {
    const role = S.things.find((t) => t.attrs?.role?.boundary === B.thing);
    const top = [...(votes.get(B.key) ?? [])].sort((a, b) => b[1] - a[1])[0];
    const i = role ? role.i : B.kind === "gpu" ? M.gpu?.t.i ?? -1 : top ? top[0] : -1;
    if (i >= 0) bound.set(B.key, S.things[i]);
  }
  x = { key, byReq, pos, procs, bound,
    byBox: new Map([...box].map(([c, ids]) => [c, { ids: Uint32Array.from(ids), t: Float64Array.from(ids, (id) => S.startOf[id]) }])) };
  phaseIdx.set(S, x);
  return x;
}

/** D13's rule on real rows: the phase of the same request that ended last before p started, in another box (a tie
 *  goes to the same flow). */
function prevOf(S, X, p, comp) {
  const r = S.field("req", p.id), a = r === NONE16 ? null : X.byReq.get(r), k = X.pos.get(p.id);
  if (!a || k == null) return -1;
  const flow = S.field("flow", p.id);
  let best = -1;
  for (let j = k - 1; j >= Math.max(0, k - PREV_SCAN); j--) {
    const q = a[j], c = S.field("comp", q);
    if (c === NONE16 || c === comp || S.endOf[q] > p.t0) continue;
    if (best < 0 || S.endOf[q] > S.endOf[best] || (S.endOf[q] === S.endOf[best] && S.field("flow", q) === flow)) best = q;
  }
  return best;
}

// ---------------- v1 components_map.js markup on the run's component map
function mapSVG(M, X) {
  const [W, H] = M.size;
  const bounds = M.bounds.map((b) => `<g class="bound ${b.kind}  " data-bound="${b.key}" data-sel="${escape(X.bound.get(b.key)?.key ?? "")}">
    <rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="8"/>
    <text x="${b.x + 8}" y="${b.y + 15}">${escape(b.label)}<tspan data-blabel="${b.key}"></tspan></text></g>`).join("");
  const edges = M.edges.map(([a, b]) => {
    const A = M.box.get(a), B = M.box.get(b); if (!A || !B) return "";
    const [x1, y1] = center(A), [x2, y2] = center(B);
    return `<line class="edge ${M.drives[a] === b ? "drives" : ""}" data-edge="${a}>${b}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#cm-arrow)"/>`;
  }).join("");
  const boxes = M.boxes.map(({ key, thing, label, owner, x, y, w, h, flows }) => `<g class="cbox   " data-box="${key}" data-id="${escape(thing)}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5"/>
      ${flows.map((f, i, a) => `<rect class="fseg" x="${x + 1.5}" y="${y + 1.5 + (i * (h - 3)) / a.length}" width="4" height="${(h - 3) / a.length}" style="fill:${FLOW_COLOR[f]};stroke:none"/>`).join("")}
      <rect class="fon" x="${x + 1.5}" y="${y + 1.5}" width="4" height="${h - 3}" style="stroke:none;display:none"/>
      <text class="cl" x="${x + 6}" y="${y + 14}">${escape(label)}</text>
      <text class="co" x="${x + 6}" y="${y + 26}">${escape(owner)}</text>
      <text class="cs" x="${x + 6}" y="${y + h - 4}" data-stat="${key}"></text>
      <title>${escape(label)} · ${escape(owner)}</title></g>`).join("");
  return `<svg class="compmap" viewBox="0 0 ${W} ${H}">
    <defs><marker id="cm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z"/></marker></defs>
    ${bounds}<g class="edges">${edges}</g>${boxes}<g class="packets"></g></svg>`;
}

/** v1's packet: a dot moving from one box to the next, labelled with what the request is at that step. Returns the
 *  label so a payload fetched later can fill it in. */
function packet(svg, M, from, to, label, duration = 320, flow = "") {
  const a = M.box.get(from), b = M.box.get(to);
  if (!svg || !b) return null;
  const layer = svg.querySelector(".packets");
  layer.querySelectorAll(`[data-flow="${flow}"]`).forEach((n) => n.remove());
  const [x2, y2] = center(b), [x1, y1] = a ? center(a) : [x2, y2];
  const g = document.createElementNS(NS, "g");
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
  return g.querySelector("text");
}

// ---------------- v1 dataForm on the cold args of each row: what the request is in this step
const idsText = (a) => (a ? `[${a.slice(0, 6).join(", ")}${a.length > 6 ? ", …" : ""}]` : "");
const req0 = (st) => st?.requests?.[0];
/** box key -> (stamp, args, row name, kernel name) => text; a box without an entry shows the row's name. */
const FORM = {
  eth0: (st, a, name) => (a?.direction != null ? `${a.direction} · ${a.bytes} B · ${a.frame_len} B frame` : name),
  asgi: (st, a, name) => (st?.path ? `${st.method} ${st.path}` : st?.text != null ? `SSE frame ${st.bytes} B` : name),
  validate: (st, a, name) => (st?.messages ? `${st.messages.length} messages · max_completion_tokens ${st.max_completion_tokens}` : name),
  parse: (st, a, name) => (st?.conversation ? `${st.conversation.length} messages → conversation` : name),
  template: (st, a, name) => (st?.text != null ? `${st.text.length} characters of templated text` : name),
  tokenizer: (st, a, name) => (st?.token_ids ? `${st.token_ids.length} token IDs ${idsText(st.token_ids)}` : name),
  llm_api: (st, a, name) => (st?.prompt_token_ids ? `${st.prompt_token_ids.length} prompt token IDs · max_tokens ${st.max_tokens}` : name),
  proxy: (st, a, name) => (st?.prompt_tokens != null ? `${st.prompt_tokens} prompt tokens · request sent` : name),
  ipc_req: (st, a, name) => (st?.pickled_bytes != null ? `${st.pickled_bytes} B pickled` : name),
  worker: (st, a, name) => (st?.prompt_token_ids ? `LlmRequest · ${st.prompt_token_ids.length} prompt tokens · max_tokens ${st.max_tokens}` : name),
  fetch: (st, a, name) => (st?.requests ? `${st.requests.length} request(s) taken from the queue` : name),
  scheduler: (st, a, name) => (st?.context ? `context ${st.context.length} · generation ${st.generation.length}${req0(st) ? ` · cid ${req0(st).cid}` : ""}` : name),
  kv_cache: (st, a, name) => (req0(st)?.blocks ? `blocks ${idsText(req0(st).blocks)} · ${st.free_blocks} free` : name),
  forward: (st, a, name, kernel) => kernel ?? name,
  update: (st, a, name) => (req0(st)?.last_token_id != null ? `token ${req0(st).last_token_id} appended · ${req0(st).num_tokens} tokens` : name),
  ipc_rsp: (st, a, name) => (st?.pickled_bytes != null ? `${st.pickled_bytes} B pickled` : name),
  detokenize: (st, a, name) => (st?.new_token_ids ? `${idsText(st.new_token_ids)} → ${JSON.stringify(st.new_text)}` : name),
  postprocess: (st, a, name) => (st?.events ? `${st.events.length} SSE event(s)` : name),
  sdk: (st, a, name) => (a?.kind === "token" ? `chunk: ${JSON.stringify(a.content)}` : name),
};
function dataForm(S, box, id, kernel) {
  const name = S.nameText(S.field("name", id)), args = S.detailCached(id)?.args ?? null;
  const f = FORM[box];
  return f ? f(args?.stamp, args, name, kernel != null ? S.nameText(S.field("name", kernel.id)) : null) : name;
}

// ---------------- v1 infra.js, on the run's containers and samples
const MiB = 1024 * 1024;
const fmt = {
  pct: (v) => (v == null || Number.isNaN(v) ? "–" : `${v.toFixed(0)} %`),
  mib: (bytes) => (bytes == null || Number.isNaN(bytes) ? "–" : `${(bytes / MiB).toFixed(0)} MiB`),
  gib: (mib) => (mib == null || Number.isNaN(mib) ? "–" : `${(mib / 1024).toFixed(2)} GiB`),
  rate: (bps) => (bps == null || Number.isNaN(bps) ? "–" : bps < 1024 ? `${bps.toFixed(0)} B/s` : `${(bps / 1024).toFixed(1)} KiB/s`),
};
const sparkPoints = (values, max) => {
  const top = max || Math.max(1, ...Array.from(values, (v) => (Number.isFinite(v) ? v : 0)));
  return Array.from(values, (v, i) => `${i},${30 - (30 * (Number.isFinite(v) ? v : 0)) / top}`).join(" ");
};
const spark = (key) => `<svg class="spark" viewBox="0 0 120 30" preserveAspectRatio="none" data-spark="${key}"><polyline points=""/></svg>`;
const bar = (key) => `<span class="bar"><span data-bar="${key}" style="width:0%"></span></span>`;
/** The last HISTORY samples of catalog metric i at or before t. */
function history(S, i, t) { const g = S.groupOf(i), k = upper(g.ts, t); return g.cols[i - g.first].subarray(Math.max(0, k - HISTORY), k); }

/** v1's status(c) on the run's container events: [class, label] at t. */
const LIFE = { create: ["down", "created"], kill: ["down", "killed"], stop: ["down", "exited"], die: ["down", "exited"], destroy: ["down", "removed"],
  "health_status: healthy": ["up", "healthy"], "health_status: unhealthy": ["down", "unhealthy"], "health_status: starting": ["starting", "starting"] };
function status(c, t) {
  if (!c.events.length) return ["", "status not recorded"];
  let st = ["down", "not created yet"];
  for (const e of c.events) {
    if (e.t > t) break;
    st = e.name === "start" ? (c.health ? ["starting", "starting"] : ["up", "running"]) : LIFE[e.name] ?? st;
  }
  return st;
}
const procLabel = (p) => `${p.name}${p.attrs?.role ? ` · ${p.attrs.role.name}` : ""}`;
const procRow = (p) => `<div class="row" data-sel="${escape(p.key)}" data-proc="${escape(p.key)}"><span>${escape(procLabel(p))}</span></div>`;
function procList(procs, X) {
  const main = procs.filter((p) => p.attrs?.role || X.procs.has(p.i)), rest = procs.filter((p) => !main.includes(p));
  return `<div class="label" style="margin-top:6px">processes</div>${!procs.length ? `<div class="dim">no process recorded</div>` : ""}${main.map(procRow).join("")}${rest.length
    ? `<details><summary class="dim">${rest.length} more process${rest.length > 1 ? "es" : ""}</summary>${rest.map(procRow).join("")}</details>` : ""}`;
}

function card(c, withProcs, X) {
  const gpu = c.gpu.length ? `<div class="gpuheld" data-v="gpu"></div>` : "";
  const net = c.netns ? `uses the network namespace of <b>${escape(c.sharesWith?.name ?? c.netns)}</b>` : "";
  return `<div class="card" data-id="${escape(c.key)}" data-sel="${escape(c.key)}" data-project="${escape(c.project ?? "")}" data-service="${escape(c.key)}"
    title="open the components inside this container">
    <div class="title"><i class="dot"></i>${escape(c.name)}<span class="state"></span></div>
    <div class="image"${c.image ? "" : ` title="the run has no topology.json"`}>${escape(c.image ?? "image not recorded")}</div>
    <div class="row"><span data-v="cpu"></span> ${spark("cpu")}</div>
    <div class="row"><span data-v="mem"></span>${c.memLimit ? ` ${bar("mem")}` : ""}</div>
    <div class="row net"${c.netns ? "" : ` data-v="net"`}>${net}</div>
    ${gpu}${withProcs ? procList(c.procs, X) : ""}<div class="nowis" data-now="${escape(c.key)}"></div>
  </div>`;
}

/** D13's project: one box per network (topology.json), each container drawn with the containers that join its network
 *  namespace. */
function project(name, containers, withProcs, X) {
  const nets = new Map();
  for (const c of containers) {
    if (containers.includes(c.sharesWith)) continue;
    const net = c.networks?.[0] ?? null;
    (nets.get(net) ?? nets.set(net, []).get(net)).push(c, ...containers.filter((o) => o.sharesWith === c));
  }
  return `<section class="project"><div class="label">project ${escape(name ?? "not recorded")}</div>${[...nets].map(([net, cs]) => `<div class="network">
      <div class="label"${net ? "" : ` title="the run has no topology.json"`}>${net ? `network ${escape(net)}` : "network not recorded"}</div>
      <div class="cards">${cs.map((c) => card(c, withProcs, X)).join("")}</div>
    </div>`).join("")}</section>`;
}
const networkBox = (n, withProcs) => `<div class="network" data-id="${escape(n.key)}"><div class="label" data-sel="${escape(n.key)}">${escape(n.name)}</div>
  ${withProcs ? n.procs.map(procRow).join("") : ""}<div class="nowis" data-now="${escape(n.key)}"></div></div>`;

function gpuPanel(S, M) {
  const G = M.gpu; if (!G) return "";
  const rows = [
    ["memory", "vram", true, true], ["any kernel running", "sm", true, true], ["memory read/write", "dram", true, true],
    ["power", "power", false, false], ["PCIe", "pcie", false, true], ["clocks", "clocks", false, false], ["temperature", "temp", false, false],
  ];
  const src = G.mem >= 0 ? `${sourceOf(S.metrics[G.mem])}, ${periodOf(S, G.mem)}` : "no GPU samples in this run";
  return `<section class="gpu" id="gpu" data-sel="${escape(G.t.key)}"><div class="label">host GPU · ${escape(src)}</div>
    <table>${rows.map(([k, key, b, s]) => `<tr><th>${k}</th><td data-g="${key}">–</td><td>${b ? bar(key) : ""}</td><td>${s ? spark(key) : ""}</td></tr>`).join("")}</table>
    <div class="label">GPU memory held by</div><ul data-held></ul></section>`;
}

function infraHTML(S, M, X, withProcs) {
  const projects = new Map();
  for (const c of M.containers) (projects.get(c.project) ?? projects.set(c.project, []).get(c.project)).push(c);
  return `<div class="infra">
    <div class="projects">${[...projects].map(([n, cs]) => project(n, cs, withProcs, X)).join("")}${M.networks.map((n) => networkBox(n, withProcs)).join("")}</div>
    <div class="side">${gpuPanel(S, M)}</div>
    <svg class="links"></svg></div>`;
}

const layersHTML = (M) => `<div class="swrows"><div class="label">software layer · under model forward</div><div class="cards">${M.layers.map((L) =>
  `<div class="card up" data-layer="${L.name}"><div class="title"><i class="dot"></i>${escape(L.name)}</div>
    <div class="image">${escape(L.kinds.join(", "))}</div><div class="nowis"></div></div>`).join("")}</div></div>`;

// ---------------- the view
export function mountArch(el, { size = "lens" } = {}) {
  if (!document.getElementById("v1arch-css")) {
    const s = document.createElement("style"); s.id = "v1arch-css"; s.textContent = CSS; document.head.append(s);
  }
  let built = null, v = null, shown = null, S = null, M = null;

  const onClick = (e) => {
    const t = e.target.closest("[data-box], [data-sel]");
    if (!t || !el.contains(t) || !S) return;
    if (t.dataset.box) {
      const b = M.box.get(t.dataset.box), list = b && phasesOf(S, M).byBox.get(b.i);
      if (list?.ids.length) { const k = upper(list.t, state.t); return select(list.ids[k < list.ids.length ? k : 0]); }
      return b && select(b.thing);
    }
    if (t.dataset.sel) select(t.dataset.sel);
  };
  el.addEventListener("click", onClick);

  function fitMap() {
    if (!v?.svg) return;
    const [W, H] = M.size, wrap = v.svg.parentElement, rows = el.querySelector(".swrows"), key = el.querySelector(".flowkey");
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
    svg.innerHTML = M.containers.filter((c) => c.gpu.length).map((c) => {
      const card_ = v.cards.find((x) => x.c === c)?.n;
      if (!card_) return "";
      const r = card_.getBoundingClientRect();
      const x1 = r.right - origin.left, y1 = r.top + r.height / 2 - origin.top;
      const x2 = g.left - origin.left, y2 = g.top + 30 - origin.top;
      return `<path d="M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}"/>`;
    }).join("");
  }

  function build() {
    const s = store(), tier = state.tiers.architecture;
    if (!s) {
      if (built !== "none") { built = "none"; S = M = v = null; el.innerHTML = `<div class="v1arch ${size}"><div class="dim">no run open</div></div>`; }
      return false;
    }
    const m = modelOf(s), key = `${s.run}|${s.generation}|${tier}|${m.key}`;
    if (key === built) return false;
    built = key; S = s; M = m;
    const X = phasesOf(S, M);
    let body;
    const key_ = `<div class="flowkey">${S.dims.flowNames.map((f) => `<span><i style="background:${FLOW_COLOR[f]}"></i>${escape(FLOW_LABEL[f] ?? f)}</span>`).join("")}</div>`;
    if (tier >= 4) body = M.map ? `<div class="mapfit">${mapSVG(M, X)}</div>${key_}${tier >= 5 ? layersHTML(M) : ""}` : `<div class="dim">no component map in this run</div>`;
    else {
      const infra = infraHTML(S, M, X, tier === 3);
      if (tier >= 2) body = infra;
      else {
        const gpus = (h) => S.things.filter((g) => g.kind === "gpu" && under(g, h)).map((g) => `, ${g.name}`).join("");
        const hosts = M.host.map((h) => `<section class="host"><div class="label" data-sel="${escape(h.key)}">host: ${escape(h.name + gpus(h))}</div>${infra}</section>`).join("");
        body = tier === 0 ? `<section class="host"><div class="label">fleet · ${M.host.length} host${M.host.length === 1 ? "" : "s"} in this run</div>${hosts}</section>` : hosts;
      }
    }
    el.innerHTML = `<div class="v1arch ${size}">${body}</div>`;
    const q = (s_) => [...el.querySelectorAll(s_)];
    v = { tier, svg: el.querySelector("svg.compmap"),
      boxes: new Map(q(".cbox").map((g) => [g.dataset.box, { g, b: M.box.get(g.dataset.box), stat: g.querySelector("[data-stat]"), fon: g.querySelector(".fon") }])),
      edges: q(".edge"), blabels: q("[data-blabel]").map((n) => ({ n, B: M.bounds.find((b) => b.key === n.dataset.blabel) })),
      cards: q(".card[data-project]").map((n) => ({ n, c: M.containers.find((c) => c.key === n.dataset.id), state: n.querySelector(".state"), now: n.querySelector("[data-now]"),
        v: (k) => n.querySelector(`[data-v="${k}"]`), spark: (k) => n.querySelector(`[data-spark="${k}"] polyline`), bar: (k) => n.querySelector(`[data-bar="${k}"]`) })),
      nets: q(".network[data-id]").map((n) => ({ n, key: n.dataset.id, now: n.querySelector("[data-now]") })),
      procs: q("[data-proc]").map((n) => ({ n, p: S.things.find((t) => t.key === n.dataset.proc) })),
      layers: q("[data-layer]").map((n) => ({ n, now: n.querySelector(".nowis") })),
      gpu: el.querySelector("#gpu"), si: -1 };
    shown = null;
    fitMap(); drawLinks();
    return true;
  }

  const unitOf = (id) => ({ id, t0: S.startOf[id], t1: S.endOf[id] });
  /** The phases at the cursor (flows overlap, so there can be several), each with the box it came from. */
  function context() {
    const n = now(), E = S.dims.ladders.execution, P = E.indexOf("phase"), K = E.indexOf("kernel"), X = phasesOf(S, M);
    const pe = state.playing && state.playEvent != null ? state.playEvent : null;
    const phases = n.phases.length ? n.phases : [pe != null && S.dims.ex[pe] === P ? unitOf(pe) : n.exec[P]].filter(Boolean);
    const kernel = pe != null && S.dims.ex[pe] === K ? unitOf(pe) : n.kernel;
    const boxOf = (id) => M.boxOfThing.get(S.field("comp", id))?.key ?? null;
    const active = phases.map((p) => {
      const c = S.field("comp", p.id), q = c === NONE16 ? -1 : prevOf(S, X, p, c);
      return { p, box: boxOf(p.id), prev: q >= 0 ? boxOf(q) : null, flow: S.dims.flowOf(p.id) ?? "" };
    });
    const on = new Set(active.map((a) => a.box).filter(Boolean)), prev = new Set(active.map((a) => a.prev).filter((b) => b && !on.has(b)));
    // driven: what an on box drives (the map's drives), and the boxes of the kernel-tier rows running at the cursor
    const driven = new Set([...on].map((b) => M.drives[b]).filter(Boolean));
    for (const x of [kernel, ...n.transfers]) { const b = x && boxOf(x.id); if (b) driven.add(b); }
    const lit = new Set([...metricInputs()].map(boxOf).filter(Boolean));
    const lanes = active.map((a) => S.field("lane", a.p.id)), L = S.dims.laneLevel;
    return { n, si: n.sampleIndex, active, on, prev, kernel, driven, lit,
      procs: new Set(lanes.map((l) => L.process[l]).filter((x) => x >= 0)), where: lanes.map((l, j) => [L.container[l], active[j]]) };
  }

  function updateMap(ctx) {
    const flowOn = new Map(ctx.active.map((a) => [a.box, a.flow])), t = state.t;
    for (const [id, { g, b, stat, fon }] of v.boxes) {
      const n = S.dims.compRuns(b.i, t), f = flowOn.get(id);
      g.classList.toggle("on", ctx.on.has(id));
      g.classList.toggle("prev", ctx.prev.has(id));
      g.classList.toggle("seen", n > 0);
      g.classList.toggle("driven", ctx.driven.has(id));
      g.classList.toggle("lit", ctx.lit.has(id));
      setText(stat, statText(n, n ? S.dims.compTime(b.i, t) : 0));
      const show = f && b.flows.length ? "" : "none";
      if (fon.style.display !== show) fon.style.display = show;
      if (f && fon.style.fill !== FLOW_COLOR[f]) fon.style.fill = FLOW_COLOR[f];
    }
    const hot = new Set(ctx.active.flatMap((a) => [`${a.prev}>${a.box}`, `${a.box}>${a.prev}`]));
    for (const e of v.edges) e.classList.toggle("hot", hot.has(e.dataset.edge));
    const X = phasesOf(S, M);
    for (const { n, B } of v.blabels) {
      const th = X.bound.get(B.key), c = th && M.containers.find((x) => x.t.i === th.i);
      setText(n, c ? ` · ${status(c, t)[1]}` : th?.attrs?.pid != null ? ` · pid ${th.attrs.pid}` : "");
    }
    const ids = ctx.active.map((a) => a.p.id).join();
    if (ids !== shown) {
      const was = shown === null ? null : new Set(shown.split(","));
      if (was) for (const a of ctx.active) if (a.box && !was.has(String(a.p.id))) {
        const text = packet(v.svg, M, a.prev, a.box, dataForm(S, a.box, a.p.id, ctx.kernel), state.playing ? Math.min(300, 900 / state.rate) : 320, a.flow);
        if (text && S.detailCached(a.p.id) === undefined) {
          const s = S, box = a.box, id = a.p.id, k = ctx.kernel;
          s.detail([id]).then(() => { if (text.isConnected && store() === s) setText(text, dataForm(s, box, id, k).slice(0, 70)); }, (e) => console.error(e));
        }
      }
      shown = ids;
    }
  }

  function updateLayers(ctx) {
    const E = S.dims.ladders.execution, K = E.indexOf("kernel"), MOD = E.indexOf("module");
    const k = ctx.kernel ?? ctx.n.exec[K];
    const tag = ctx.kernel ? "" : k ? " (last kernel before the cursor)" : "";
    const name = (id) => S.nameText(S.field("name", id));
    let texts = ["no kernel yet", "no kernel yet", "no kernel yet"], sels = [null, null, null];
    if (k) {
      const cause = S.field("cause", k.id), layer = S.field("layer", k.id);
      let mod = -1;
      for (let x = cause >= 0 ? cause : S.field("parent", k.id); x >= 0; x = S.field("parent", x)) if (S.dims.ex[x] === MOD) { mod = x; break; }
      const d = S.detailCached(k.id), grid = d?.args?.grid, blocks = grid ? grid.reduce((a, b) => a * b, 1) : null, sms = M.gpu?.sms;
      const bytes = S.field("bytes", k.id);
      const dev = grid ? `${name(k.id)} · grid ${grid.join("×")} · ${Math.min(sms, blocks)} of ${sms} SMs (inferred from the grid)`
        : bytes > 0 ? `${name(k.id)} · ${bytes} B` : name(k.id);
      texts = [mod >= 0 ? `${layer >= 0 ? `layer ${layer} · ` : ""}${name(mod)}${tag}` : `no module row above this kernel${tag}`,
        cause >= 0 ? `${name(cause)} at ${(S.startOf[cause] / 1e6).toFixed(3)} ms (CPU side)${tag}` : `no launch call recorded for this kernel${tag}`,
        `${dev}${tag}`];
      sels = [mod >= 0 ? mod : null, cause >= 0 ? cause : null, k.id];
      if (d === undefined) { const s = S; s.detail([k.id]).then(() => { if (store() === s && v?.layers.length) updateLayers(context()); }, (e) => console.error(e)); }
    }
    v.layers.forEach(({ n, now: nowEl }, i) => {
      setText(nowEl, texts[i]);
      if (sels[i] == null) n.removeAttribute("data-sel"); else n.dataset.sel = sels[i];
    });
  }

  function updateInfra(ctx) {
    const t = state.t;
    for (const { n, c, state: st, now: nowEl } of v.cards) {
      const [cls, label] = status(c, t);
      const want = `card ${cls}`; if (n.className !== want) n.className = want;
      setText(st, label);
      const here = ctx.where.filter(([ci, a]) => ci === c.t.i && a.box).map(([, a]) => M.box.get(a.box).label);
      setText(nowEl, here.length ? `the request is now at: ${here.join(" + ")}` : "");
    }
    for (const { key, now: nowEl } of v.nets) {
      const i = S.things.find((x) => x.key === key)?.i, here = ctx.where.filter(([ci, a]) => ci === i && a.box).map(([, a]) => M.box.get(a.box).label);
      setText(nowEl, here.length ? `the request is now at: ${here.join(" + ")}` : "");
    }
    for (const { n, p } of v.procs) setText(n.lastElementChild, `${procLabel(p)}${ctx.procs.has(p.i) ? "  ◀ at the cursor" : ""}`);
    if (ctx.si === v.si) return;
    v.si = ctx.si;
    const s = ctx.n.sample, val = (i) => (i >= 0 ? s[i] : NaN);
    for (const { c, v: el_, spark: sp, bar: b } of v.cards) {
      setText(el_("cpu"), `CPU ${fmt.pct(val(c.cpu))}`);
      sp("cpu")?.setAttribute("points", c.cpu >= 0 ? sparkPoints(history(S, c.cpu, t)) : "");
      const mem = val(c.mem);
      setText(el_("mem"), `mem ${fmt.mib(mem)}${c.memLimit ? ` / ${fmt.mib(c.memLimit)}` : ""}`);
      if (b("mem")) b("mem").style.width = `${Number.isNaN(mem) ? 0 : Math.min(100, (100 * mem) / c.memLimit).toFixed(1)}%`;
      const nv = el_("net"); if (nv) setText(nv, `↓ ${fmt.rate(val(c.rx))} ↑ ${fmt.rate(val(c.tx))}${c.networks?.length ? ` · ${c.networks.join(", ")}` : ""}`);
      const gv = el_("gpu");
      if (gv) {
        const held = c.gpu.map((x) => ({ ...x, mib: val(x.m) })).filter((x) => x.mib > 0);
        setText(gv, held.length ? `GPU ${fmt.gib(held.reduce((a, x) => a + x.mib, 0))} · ${held.map((x) => x.p.name).join(", ")}` : "GPU – (no sample at the cursor)");
      }
    }
    const g = v.gpu, G = M.gpu; if (!g || !G) return;
    const td = (k) => g.querySelector(`[data-g="${k}"]`);
    const set = (k, text, frac, i, max) => {
      setText(td(k), text);
      const bb = g.querySelector(`[data-bar="${k}"]`); if (bb) bb.style.width = `${Math.min(100, 100 * (Number.isFinite(frac) ? frac : 0)).toFixed(1)}%`;
      const p = g.querySelector(`[data-spark="${k}"] polyline`); if (p) p.setAttribute("points", i >= 0 ? sparkPoints(history(S, i, t), max) : "");
    };
    const vramMiB = G.vram != null ? G.vram / MiB : null;
    set("vram", `${fmt.gib(val(G.mem))} / ${fmt.gib(vramMiB)}`, val(G.mem) / vramMiB, G.mem, vramMiB);
    set("sm", fmt.pct(val(G.util)), val(G.util) / 100, G.util, 100);
    set("dram", fmt.pct(val(G.memutil)), val(G.memutil) / 100, G.memutil, 100);
    set("power", fmtValue(val(G.power), "W"), 0, -1);
    const gen = val(G.gen);
    const kbs = (i) => (i >= 0 && Number.isFinite(val(i)) ? Math.round(val(i)) : "–");
    set("pcie", `gen ${Number.isNaN(gen) ? "–" : gen} · ↓${kbs(G.rx)} ↑${kbs(G.tx)} KB/s`, 0, G.rx);
    set("clocks", `SM ${fmtValue(val(G.clock), "MHz")}`, 0, -1);
    set("temp", fmtValue(val(G.temp), "°C"), 0, -1);
    const held = M.containers.flatMap((c) => c.gpu.map((x) => ({ ...x, c, mib: val(x.m) }))).filter((x) => x.mib > 0);
    const ul = g.querySelector("[data-held]"), html = held.map((x) => `<li>${fmt.gib(x.mib)} · ${escape(x.p.name)} · ${escape(x.c.name)}</li>`).join("") || `<li class="dim">no process of the run's containers at the cursor</li>`;
    if (ul.innerHTML !== html) ul.innerHTML = html;
  }

  function update() {
    if (!v) return;
    const ctx = context();
    if (v.boxes.size) updateMap(ctx);
    if (v.layers.length) updateLayers(ctx);
    if (v.cards.length || v.nets.length) updateInfra(ctx);
  }

  const unsub = subscribe(() => { const t0 = performance.now(); build(); update(); perf.sample("arch_update", performance.now() - t0); });
  let rf = 0;
  const ro = new ResizeObserver(() => { cancelAnimationFrame(rf); rf = requestAnimationFrame(() => { fitMap(); drawLinks(); }); });
  ro.observe(el);
  return () => { unsub(); ro.disconnect(); cancelAnimationFrame(rf); el.removeEventListener("click", onClick); el.replaceChildren(); };
}
