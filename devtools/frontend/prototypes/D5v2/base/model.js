// The seven zoom levels, built from store queries (D1 C over D2 B records). No run data is bundled with the page.
// Each level is content in local coordinates (x -500..500, y -300..300, y down) plus the item it opens at the cursor.
// Levels: 1 Infrastructure, 2 Components, 3 Trace, 4 Iteration, 5 Model ops (GPU work), 6 Kernel, 7 Hardware.
import * as api from "./api.js";
import { state } from "./state.js";

export const NAMES = ["Infrastructure", "Components", "Trace", "Iteration", "Model ops", "Kernel", "Hardware"];
export const COL = { frame: "#4c566a", card: "#5e81ac", proc: "#434c5e", thread: "#3b4252", comp: "#81a1c1", lane: "#2e3440", stamp: "#88c0d0",
  zmq: "#ebcb8b", iter: "#a3be8c", kv: "#b48ead", nvtx: "#5e6b7d", call: "#3a9c6a", kernel: "#2457c5", copy: "#c2507a", set: "#8a8f98",
  bar: "#b48ead", cpu: "#4c566a", core: "#5e81ac", cache: "#8fbcbb", ram: "#a3be8c", nvme: "#d08770", chip: "#4c566a", sm: "#394150",
  l2: "#8fbcbb", mc: "#81a1c1", vram: "#3b4252", link: "#ebcb8b", board: "#262a33", gpu: "#3b4252", hw: "#3b4252", req: "#d08770" };
const MINW = 0.4;   // drawn minimum width (local units, 0.04% of a window): narrower spans would be sub-pixel at fit
const item = (x0, y0, x1, y1, col, lab, o = {}) => ({ x0, y0, x1: Math.max(x1, x0 + MINW), y1, col, lab, ...o });
const TRACE_KINDS = "component stamp,client request,client event,client transport,network frame,engine timestamp,engine iteration";

/** @typedef {{x0:number,y0:number,x1:number,y1:number,col:string,lab:string,id?:string,eid?:string,t0?:number,t1?:number,header?:boolean,lane?:boolean,peer?:boolean,info?:string}} Item */
/** @typedef {{name:string, items:Item[], open:?Item, X?:(t:number)=>number, win?:number[], links?:Item[][], hw?:boolean}} Level */

export const D = { run: "", meta: null, things: [], byId: new Map(), trace: [], iters: [], shares: [], zmq: [], req: null, iterCache: new Map(), ncuCache: new Map(), elk: new Map() };

export async function load(run) {
  D.run = run;
  const [meta, things, req] = await Promise.all([api.meta(run), api.q(run, "things"), api.event(run, "client/request/measured")]);
  D.meta = meta; D.things = things; things.forEach((t) => D.byId.set(t.id, t));
  if (!req) throw new Error("the run has no 'client/request/measured' event");
  D.req = { s: req.event.start_ns, e: req.event.end_ns, eid: req.event.eid };
  const w = { t0: D.req.s - 2e6, t1: D.req.e + 2e6 };
  const [trace, shares, zmq] = await Promise.all([
    api.q(run, "events", { ...w, kind: TRACE_KINDS, cols: "id,eid,what,thing_id,kind,name,start_ns,end_ns,iteration,request_id,args" }),
    api.q(run, "shares"), api.q(run, "links/window", { ...w, kind: "zmq,network" })]);
  trace.forEach((e) => { e.a = e.args ? JSON.parse(e.args) : {}; delete e.args; e.end = e.end_ns ?? e.start_ns; });
  D.trace = trace; D.shares = shares; D.zmq = zmq;
  // iterations of the measured request: the NVTX forward-step range plus every stamp the scheduler tied to it
  const byIt = new Map();
  for (const e of trace) if (e.iteration != null && e.request_id && e.request_id.endsWith("-measured")) {
    const r = byIt.get(e.iteration) ?? { n: e.iteration, s: Infinity, e: -Infinity, fwd: null, nvtx: null };
    r.s = Math.min(r.s, e.start_ns); r.e = Math.max(r.e, e.end);
    if (e.kind === "engine iteration") r.nvtx = e; if (e.a.box === "forward") r.fwd = e.start_ns; byIt.set(e.iteration, r); }
  for (const e of trace) if (e.kind === "engine iteration" && byIt.has(e.iteration)) { const r = byIt.get(e.iteration); r.nvtx = e; r.s = Math.min(r.s, e.start_ns); r.e = Math.max(r.e, e.end); }
  D.iters = [...byIt.values()].sort((a, b) => a.s - b.s);
  D.iters.forEach((r) => { const sh = shares.find((s) => s.iteration === r.n && s.request_id && s.request_id.endsWith("-measured")); r.share = sh;
    r.phase = sh && sh.tokens > 1 ? "prefill" : "decode"; });
  // window: send -> the later of the last iteration and the last token event. The response close comes ~10 s later in
  // a profiled run (the profiler's data flush at cudaProfilerStop, Observed), so it is not used as the window end.
  const lastTok = Math.max(...trace.filter((e) => e.request_id?.endsWith("-measured") && e.kind === "client event").map((e) => e.start_ns));
  D.t0 = D.req.s; D.t1 = Math.max(lastTok, ...D.iters.map((r) => r.e)) + 2e6;
  return D;
}

// ---------------- things helpers
export const containerOf = (thing) => { let t = D.byId.get(thing); while (t && !["container", "network"].includes(t.kind)) t = D.byId.get(t.parent_id); return t ? t.id : null; };
const children = (id) => D.things.filter((t) => t.parent_id === id);

// ---------------- the open chain at the cursor
export function iterAt(t) { let j = 0; D.iters.forEach((it, k) => { if (it.s <= t) j = k; }); return D.iters[j]; }
export async function iterDetail(it) {
  if (D.iterCache.has(it.n)) return D.iterCache.get(it.n);
  const cols = "id,eid,what,thing_id,parent_id,kind,name,start_ns,end_ns,iteration,code_origin,args";
  const [gpu, nvtx] = await Promise.all([
    api.q(D.run, "events", { iteration: it.n, kind: "kernel,memcpy,memset,cuda runtime call", cols }),
    api.q(D.run, "events", { t0: it.nvtx ? it.nvtx.start_ns : it.s, t1: it.nvtx ? it.nvtx.end : it.e, kind: "nvtx range", cols })]);
  const ev = [...gpu, ...nvtx].map((e) => ({ ...e, a: e.args ? JSON.parse(e.args) : {}, end: e.end_ns ?? e.start_ns }));
  const s = Math.min(...ev.map((e) => e.start_ns), it.nvtx ? it.nvtx.start_ns : it.s), e = Math.max(...ev.map((x) => x.end), it.nvtx ? it.nvtx.end : it.e);
  const links = await api.q(D.run, "links/window", { t0: s, t1: e, kind: "cuda launch" });
  const r = { ev, s, e, links, kernels: ev.filter((x) => x.kind === "kernel").sort((a, b) => a.start_ns - b.start_ns) };
  D.iterCache.set(it.n, r); if (D.iterCache.size > 40) D.iterCache.delete(D.iterCache.keys().next().value);
  return r;
}
export function kernelAt(det, t) { let k = det.kernels[0] || null; for (const x of det.kernels) if (x.start_ns <= t) k = x; else break; return k; }
export async function ncu(kernel) {
  if (!kernel) return null; if (D.ncuCache.has(kernel.id)) return D.ncuCache.get(kernel.id);
  const r = D.meta.counts.profiles ? await api.q(D.run, "profiles", { event: kernel.id }) : [];
  const m = Object.fromEntries(r.map((x) => [x.metric, x])); const o = r.length ? m : null; D.ncuCache.set(kernel.id, o); return o;
}

// ---------------- ELK placement for the spatial levels (frozen D5 sub-choice: ELK, licence accepted)
async function elk(key, nodes, edges) {
  if (D.elk.has(key)) return D.elk.get(key);
  const K = {}; nodes.forEach((n) => (K[n.parent] ??= []).push(n)); const pos = {};
  const mk = (n) => { const ch = K[n.id] || []; const o = { id: n.id, labels: [{ text: n.label }] };
    if (ch.length) { o.children = ch.map(mk); o.layoutOptions = { "elk.algorithm": "layered", "elk.hierarchyHandling": "SEPARATE_CHILDREN",
      "elk.padding": "[top=34,left=12,bottom=12,right=12]", "elk.spacing.nodeNode": "14", "elk.layered.spacing.nodeNodeBetweenLayers": "26", "elk.direction": n.kind === "thread" ? "DOWN" : "RIGHT" }; }
    else { o.width = 160; o.height = 40; } return o; };
  const t0 = performance.now();
  const res = await new ELK().layout({ id: "root", layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT", "elk.json.shapeCoords": "ROOT", "elk.padding": "[top=10,left=10,bottom=10,right=10]" },
    children: (K[undefined] || K[null] || []).map(mk), edges: [] });
  (function walk(n) { for (const c of n.children || []) { pos[c.id] = { x: c.x, y: c.y, w: c.width, h: c.height }; walk(c); } })(res);
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const p of Object.values(pos)) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + p.w); y1 = Math.max(y1, p.y + p.h); }
  const k = Math.min(960 / (x1 - x0), 560 / (y1 - y0)), f = (p) => [-(x1 - x0) * k / 2 + (p.x - x0) * k, -(y1 - y0) * k / 2 + (p.y - y0) * k, p.w * k, p.h * k];
  const out = { pos: Object.fromEntries(Object.entries(pos).map(([id, p]) => [id, f(p)])), ms: performance.now() - t0 };
  D.elk.set(key, out); return out;
}

// ---------------- the levels
const lanesOf = (cont) => { const set = new Set(D.trace.map((e) => e.thing_id)); return [...set].filter((th) => containerOf(th) === cont).sort(); };
const fmt = (ns) => ns >= 1e6 ? (ns / 1e6).toFixed(3) + " ms" : (ns / 1e3).toFixed(2) + " µs";

/** @returns {Promise<Level[]>} */
export async function build(t) {
  const L = [], cont = state.container;
  // L1 Infrastructure: host > containers > processes, and the host hardware things (Observed inventory)
  { const hwKinds = new Set(["board", "cpu", "host memory", "chipset", "nvme", "gpu"]);
    const nodes = [{ id: "host", label: D.byId.get("host")?.name || "host", kind: "host" }];
    for (const t of D.things) {
      if (["container", "network"].includes(t.kind) || (t.kind === "process" && containerOf(t.id))) nodes.push({ id: t.id, parent: t.parent_id, label: `${t.kind}: ${t.name}`, kind: t.kind });
      else if (hwKinds.has(t.kind) && t.parent_id === "host") nodes.push({ id: t.id, parent: "host", label: `${t.kind}: ${t.name}`, kind: t.kind }); }
    const E = await elk("infra", nodes), it = [];
    for (const n of nodes) { const p = E.pos[n.id]; if (!p) continue; const [x, y, w, h] = p, card = n.kind === "container" || n.kind === "network";
      it.push(item(x, y, x + w, y + h, card ? COL.card : hwKinds.has(n.kind) ? COL.hw : n.kind === "process" ? COL.proc : COL.frame, n.label,
        { id: n.id, peer: card, header: !card && n.kind !== "process" && !hwKinds.has(n.kind), info: D.byId.get(n.id)?.evidence })); }
    L.push({ name: NAMES[0], items: it, open: it.find((i) => i.id === cont) || null }); }
  // L2 Components: the open container's processes > threads > component boxes (boxes named by the stamps, Observed)
  { const nodes = [{ id: cont, label: D.byId.get(cont)?.name || cont, kind: "container" }];
    const boxes = new Map();
    for (const e of D.trace) if (e.a.box && containerOf(e.thing_id) === cont) boxes.set(e.thing_id + "#" + e.a.box, { th: e.thing_id, box: e.a.box, owner: e.a.owner });
    for (const p of children(cont)) { nodes.push({ id: p.id, parent: cont, label: `process: ${p.name}`, kind: "process" });
      for (const th of children(p.id)) { if (!D.trace.some((e) => e.thing_id === th.id)) continue;
        nodes.push({ id: th.id, parent: p.id, label: `thread: ${th.name}`, kind: "thread" });
        for (const b of boxes.values()) if (b.th === th.id) nodes.push({ id: b.th + "#" + b.box, parent: th.id, label: b.box, kind: "component" }); } }
    const E = await elk("comp:" + cont, nodes), it = [];
    for (const n of nodes) { const p = E.pos[n.id]; if (!p) continue; const [x, y, w, h] = p, leaf = n.kind === "component";
      it.push(item(x, y, x + w, y + h, leaf ? COL.comp : n.kind === "thread" ? COL.thread : COL.proc, n.label + (leaf ? ` · ${boxes.get(n.id)?.owner || ""}` : ""),
        { id: n.id, header: !leaf, comp: leaf, thing: leaf ? boxes.get(n.id).th : n.id, box: leaf ? boxes.get(n.id).box : null })); }
    const at = (th) => it.find((i) => i.id === th);
    const links = []; const seen = new Set();
    for (const l of D.zmq) { const k = l.from_thing + ">" + l.to_thing; if (seen.has(k)) continue; seen.add(k); const a = at(l.from_thing), b = at(l.to_thing); if (a && b) links.push([a, b]); }
    L.push({ name: NAMES[1], items: it, open: it.find((i) => i.box === "forward") || it.find((i) => i.comp) || it[1] || null, links }); }
  // L3 Trace: lanes of the open container over the measured request, plus the engine iterations row
  const it = iterAt(t);
  { const lanes = lanesOf(cont), its = [], rows = lanes.length + (cont === "host/server" ? 1 : 0) || 1, rh = Math.min(50, 560 / rows);
    const X = (x) => -480 + (x - D.t0) / (D.t1 - D.t0) * 960; let y = -280, op = null;
    its.push(item(-500, -300, 500, 300, COL.frame, `Trace · ${D.byId.get(cont)?.name} · measured request · ${fmt(D.t1 - D.t0)}`, { header: true }));
    for (const th of lanes) { its.push(item(-490, y, 490, y + rh - 4, COL.lane, th, { header: true, lane: true }));
      for (const e of D.trace) if (e.thing_id === th && e.kind !== "engine iteration" && e.end >= D.t0 && e.start_ns <= D.t1)
        its.push(item(X(Math.max(e.start_ns, D.t0)), y + rh * 0.3, X(Math.min(e.end, D.t1)), y + rh - 6, /ZMQ/.test(e.name) ? COL.zmq : e.kind === "client request" ? COL.req : COL.stamp, e.name,
          { t0: e.start_ns, t1: e.end, eid: e.eid, info: e.what }));
      y += rh; }
    if (cont === "host/server") { its.push(item(-490, y, 490, y + rh - 4, COL.lane, "engine iterations (NVTX forward step + its stamps)", { header: true, lane: true }));
      for (const r of D.iters) { const b = item(X(r.s), y + rh * 0.3, X(r.e), y + rh - 6, COL.iter, `it ${r.n}`, { t0: r.s, t1: r.e, eid: r.nvtx?.eid, peer: true,
        info: `iteration ${r.n} · ${r.phase} · ${fmt(r.e - r.s)}` }); its.push(b); if (r === it) op = b; } }
    L.push({ name: NAMES[2], items: its, open: op, win: [D.t0, D.t1], X }); }
  // L4 Iteration: the server's stamp lanes in the open iteration, plus the KV blocks of the request (kv_cache stamps)
  const det = await iterDetail(it);
  { const its = [], X = (x) => -480 + (x - it.s) / (it.e - it.s) * 960, lanes = lanesOf("host/server"); let y = -270, op = null;
    its.push(item(-500, -300, 500, 300, COL.frame, `iteration ${it.n} · ${it.phase} · ${fmt(it.e - it.s)}`, { header: true }));
    const rh = Math.min(66, 480 / Math.max(1, lanes.length));
    for (const th of lanes) { const evs = D.trace.filter((e) => e.thing_id === th && e.end >= it.s && e.start_ns <= it.e); if (!evs.length) continue;
      its.push(item(-490, y, 490, y + rh - 6, COL.lane, th, { header: true, lane: true }));
      for (const e of evs) { const b = item(X(Math.max(e.start_ns, it.s)), y + rh * 0.33, X(Math.min(e.end, it.e)), y + rh - 10, /ZMQ/.test(e.name) ? COL.zmq : e.kind === "engine iteration" ? COL.iter : COL.stamp, e.name,
        { t0: e.start_ns, t1: e.end, eid: e.eid, info: e.what }); its.push(b); if (e.a.box === "forward") { b.col = COL.kernel; b.lab = "model forward launched → GPU work"; op = b; } }
      y += rh; }
    const kv = D.trace.filter((e) => e.a.box === "kv_cache" && e.iteration === it.n);
    its.push(item(-490, y, 490, y + 54, COL.lane, "KV cache: this request's blocks (kv_cache stamps)", { header: true, lane: true }));
    for (const k of kv) { const rq = (k.a.stamp?.requests || [])[0] || {}; its.push(item(X(k.start_ns), y + 20, X(k.start_ns) + 40, y + 50, COL.kv, `${k.name}: ${(rq.blocks || []).length} blocks`,
      { t0: k.start_ns, t1: k.end, eid: k.eid, info: `${k.what} blocks ${JSON.stringify(rq.blocks || [])}; free blocks ${k.a.stamp?.free_blocks ?? "not recorded"}` })); }
    L.push({ name: NAMES[3], items: its, open: op || its[1] || null, win: [it.s, it.e], X }); }
  // L5 Model ops: the iteration's GPU work and the CPU calls that launch it (nsys, same clock); aten ops need the code level
  const k = kernelAt(det, t);
  { const its = [], X = (x) => -480 + (x - det.s) / (det.e - det.s) * 960, idx = new Map(); let op = null;
    its.push(item(-500, -300, 500, 300, COL.frame, `GPU work of iteration ${it.n} · ${fmt(det.e - det.s)} · PyTorch operators: Unavailable at this trace level (TRACE=code)`, { header: true }));
    const lanes = [...new Set(det.ev.map((e) => e.thing_id))].sort((a, b) => (a.startsWith("gpu") - b.startsWith("gpu")) || a.localeCompare(b));
    const rh = Math.min(110, 540 / Math.max(1, lanes.length)); let y = -265;
    for (const th of lanes) { its.push(item(-490, y, 490, y + rh - 6, COL.lane, th, { header: true, lane: true }));
      for (const e of det.ev) { if (e.thing_id !== th) continue; const half = e.kind === "nvtx range" && !/_forward_step/.test(e.name);
        const b = item(X(e.start_ns), y + 18 + (half ? (rh - 24) / 2 : 0), X(e.end), y + rh - 8, { kernel: COL.kernel, memcpy: COL.copy, memset: COL.set, "cuda runtime call": COL.call, "nvtx range": COL.nvtx }[e.kind] || COL.frame,
          e.name, { t0: e.start_ns, t1: e.end, eid: e.eid, peer: e.kind === "kernel", info: e.what + (e.a.graph ? ` · CUDA graph ${e.a.graph}` : "") });
        its.push(b); idx.set(e.id, b); if (k && e.id === k.id) op = b; }
      y += rh; }
    const links = det.links.map((l) => [idx.get(l.from_id), idx.get(l.to_id)]).filter(([a, b]) => a && b);
    L.push({ name: NAMES[4], items: its, open: op, win: [det.s, det.e], X, links }); }
  // L6 Kernel: the kernel at the cursor and its Nsight Compute counters (tied by launch order: Inferred) or Unavailable
  const nc = await ncu(k);
  { const its = []; its.push(item(-500, -300, 500, 300, COL.frame, `kernel: ${k ? k.name : "none"}`, { header: true }));
    if (k) its.push(item(-480, -250, 480, -170, COL.kernel, `${fmt(k.end - k.start_ns)} on ${k.thing_id} · ${k.eid}${k.a.graph ? ` · CUDA graph ${k.a.graph}` : ""} (nsys, Observed)`, { t0: k.start_ns, t1: k.end, eid: k.eid, info: k.what }));
    if (nc) { const v = (m) => nc[m]?.value ?? 0, B = [["DRAM read", v("dram__bytes_op_read.sum")], ["DRAM write", v("dram__bytes_op_write.sum")], ["L2", v("lts__t_bytes.sum")], ["L1", v("l1tex__t_bytes.sum")]];
      const tot = Math.max(1, ...B.map((b) => b[1])); let y = -140;
      for (const [n, b] of B) { its.push(item(-480, y, -480 + Math.max(8, 960 * b / tot), y + 50, COL.bar, `${n} ${kib(b)}`, { info: `Observed by Nsight Compute replay; ${nc["gpu__time_duration.sum"]?.evidence || ""}` })); y += 62; }
      its.push(item(-480, y, 480, y + 50, COL.chip, `grid ${v("launch__grid_size")} · block ${v("launch__block_size")} · SM ${v("sm__throughput.avg.pct_of_peak_sustained_elapsed").toFixed(1)}% · DRAM ${v("dram__throughput.avg.pct_of_peak_sustained_elapsed").toFixed(1)}% · replay ${v("gpu__time_duration.sum")} ns`, {})); }
    else its.push(item(-480, -140, 480, -60, COL.chip, D.meta.ncu ? `Nsight Compute counters: Unavailable for iteration ${it.n} (replayed iteration ${D.meta.ncu.iteration} only)` : "Nsight Compute: no tied profile in this run", {}));
    const hwb = item(-480, 160, 480, 280, COL.gpu, `runs on: ${D.byId.get("gpu0")?.name || "GPU"} → hardware level`, { id: "gpu0" }); its.push(hwb);
    L.push({ name: NAMES[5], items: its, open: hwb, kernel: k, ncu: nc }); }
  L.push({ name: NAMES[6], items: hardware(), hw: true, open: null });
  return L;
}
export const kib = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + " MiB" : (b / 1024).toFixed(1) + " KiB";

// L7: the machine's things (inventory, Observed or labeled) drawn as parts; positions are a drawing choice
function hardware() {
  const it = [], T = (id) => D.byId.get(id) || { name: id, attrs: "{}" }, A = (x0, y0, x1, y1, c, lab, o) => it.push(item(x0, y0, x1, y1, c, lab, o || {}));
  const at = (id) => JSON.parse(T(id).attrs || "{}"), g = at("gpu0");
  A(-500, -300, 500, 300, COL.board, `board: ${T("host/board").name}`, { header: true, id: "host/board", info: T("host/board").evidence });
  A(-480, -270, -150, 0, COL.cpu, `CPU ${T("host/cpu").name}`, { header: true, id: "host/cpu", info: T("host/cpu").evidence });
  const c = at("host/cpu"); for (let i = 0; i < (c.cores || 8); i++) A(-470 + (i % 4) * 80, -230 + Math.floor(i / 4) * 85, -400 + (i % 4) * 80, -160 + Math.floor(i / 4) * 85, COL.core, `core ${i}`, { id: "host/cpu#core" + i });
  A(-470, -55, -160, -10, COL.cache, `L3 ${c.l3 || ""}`, { id: "host/cpu#l3" });
  A(-480, 30, -150, 120, COL.ram, T("host/ram").name + " (modules Unavailable)", { id: "host/ram", info: T("host/ram").evidence });
  A(-480, 170, -330, 280, COL.chip, T("host/chipset").name, { id: "host/chipset", info: T("host/chipset").evidence });
  A(-300, 170, -150, 280, COL.nvme, T("host/nvme").name, { id: "host/nvme", info: T("host/nvme").evidence });
  A(-145, -175, -65, -125, COL.link, T("host/pcie-gpu").name, { id: "host/pcie-gpu", info: T("host/pcie-gpu").evidence });
  A(-60, -290, 490, 290, COL.gpu, `${T("gpu0").name} · CC ${g.cc} · ${g.sms} SMs`, { header: true, id: "gpu0", info: T("gpu0").evidence });
  A(-50, -260, 300, 90, COL.chip, "SMs (grid arrangement is a drawing choice; die placement Unavailable)", { header: true, id: "gpu0#die" });
  const sms = D.things.filter((t) => t.kind === "SM");
  sms.forEach((s, i) => { const x = -40 + (i % 6) * 56, y = -225 + Math.floor(i / 6) * 52; A(x, y, x + 50, y + 46, COL.sm, s.name, { id: s.id, sm: i, info: s.evidence }); });
  A(-40, 100, 300, 140, COL.l2, T("gpu0/l2").name, { id: "gpu0/l2", info: T("gpu0/l2").evidence });
  D.things.filter((t) => t.kind === "memory controller").forEach((m, i) => A(-40 + i * 86, 150, 36 + i * 86, 190, COL.mc, m.name, { id: m.id, info: m.evidence }));
  A(320, -260, 480, 280, COL.vram, T("gpu0/vram").name, { header: true, id: "gpu0/vram", info: T("gpu0/vram").evidence });
  D.things.filter((t) => t.kind === "copy engine").forEach((m, i) => A(-40 + i * 90, 200, 40 + i * 90, 270, COL.chip, m.name, { id: m.id, info: m.evidence }));
  return it;
}

// ---------------- what is true at the cursor (summary panel, hardware flows): one state query + one samples query
export async function atCursor(t, levels) {
  const it = iterAt(t), L6 = levels[5] || {}, k = L6.kernel, inK = k && t >= k.start_ns && t <= k.end;
  const [st, sm] = await Promise.all([api.q(D.run, "state", { t }), api.q(D.run, "samples", { t0: t - 150000, t1: t + 150000,
    metric: "SMs Active [Throughput %],Tensor Active [Throughput %],DRAM Read Bandwidth [Throughput %],DRAM Write Bandwidth [Throughput %],PCIe RX Throughput [Throughput %],PCIe TX Throughput [Throughput %],memory.used,pcie.link.gen.current" })]);
  const s = {}; for (const r of sm) (s[r.metric] ??= []).push(r.value);
  const mean = Object.fromEntries(Object.entries(s).map(([m, v]) => [m, v.reduce((a, b) => a + b, 0) / v.length]));
  const kv = D.trace.filter((e) => e.a.box === "kv_cache" && e.start_ns <= t && e.request_id?.endsWith("-measured")).pop();
  const toks = D.trace.filter((e) => e.name === "event: token" && e.start_ns <= t && e.request_id?.endsWith("-measured")).length;
  return { t, it, k, inK, nc: L6.ncu, lanes: st.filter((r) => containerOf(r.thing_id) || r.thing_id.startsWith("gpu")), s: mean, kv, toks };
}
