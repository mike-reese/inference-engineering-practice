// RunStore: the one browser store of a run. It loads the manifest and every block, indexes them, and answers every
// query the page asks (step, grain, chain, state at t, window scans, samples). Callers never see a block, a CCVB
// header or a dictionary index; they see row ids, times (ns from the run's t0, integers) and plain objects.
//
// A live run (manifest status "live") also reads WS /api/v3/stream?run=&have=<manifest import.live.seq>: every binary
// frame is a CCVB delta block (events, or one sample group), merged with the same indexes as a loaded block. Frames
// queue as they arrive and merge in flush(), which Control calls at the start of an animation frame, so one frame
// draws the rows the writer appended. Text frames: seal, status, reload and generation (the final import wrote the
// next generation: the page reloads it). A seal frame's `derived` sets the parent, cause, tier and depth of held rows;
// `rev` counts those seals, so a view that indexes rows by tier or parent rebuilds when it changes.
import { decodeBlock } from "./codec.js";
import { indexEvents, indexIds, reindexKeys, setDerived, restep, LONG_NS } from "./block.js";
import { N_TIERS, NONE16 } from "./columns.js";
import { perf } from "../perf.js";

const API = "/api/v3";
const RECONNECT_MS = 1000;  // a dropped stream socket reconnects after 1 s with have = the last frame merged
const GAP_LIMIT_NS = 1e9;   // spacing statistics ignore gaps of 1 s or more (idle time between bursts)
const MIN_TICK_PX = 6;      // the grain is the finest tier whose median start gap is at least this many pixels
const FRESH_PERIODS = 2;    // a sample counts at t while it is at most two of its group's sample periods old
const DETAIL_MAX = 256;     // ids per GET detail (the route's limit)

/** @typedef {{t: number, id: number}} Cursor   t: integer ns from t0; id: the row the cursor sits on, -1 after a scrub */
/** @typedef {{id: number, win: [number, number]}} Unit */

export async function listRuns() {
  const r = await fetch(`${API}/runs`);
  if (!r.ok) throw new Error(`GET ${API}/runs: HTTP ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j.runs)) throw new Error(`GET ${API}/runs: no "runs" list`);
  return j.runs;
}

/** @param {string} run */
export async function openRun(run) {
  const base = `${API}/runs/${encodeURIComponent(run)}`;
  const r = await fetch(`${base}/manifest`);
  if (!r.ok) throw new Error(`GET ${base}/manifest: HTTP ${r.status}`);
  const m = parseManifest(await r.json());
  const raw = await Promise.all(m.blocks.map(async (b) => {
    const res = await fetch(`${base}/blocks/${m.generation}/${encodeURIComponent(b.name)}`);
    if (!res.ok) throw new Error(`GET block ${b.name}: HTTP ${res.status}`);
    const d = decodeBlock(await res.arrayBuffer(), b.name);
    if (d.header.rows !== b.rows) throw new Error(`CCVB ${b.name}: ${d.header.rows} rows, manifest says ${b.rows}`);
    d.group = b.group ?? b.name;   // a live run rewrites a sample group under a new block name at each seal
    return d;
  }));
  const store = new RunStore(m, raw, base);
  if (m.status === "live") {
    // the views mount after this: they start from every frame the writer holds, not from the last seal
    await store.connect(m.import?.live?.seq ?? 0);
    store.flush(); store.live.lat.length = 0;   // the replay is not live append latency
  }
  return store;
}

/** The manifest is the store's boundary: check the shape once, here. */
function parseManifest(m) {
  const need = (ok, what) => { if (!ok) throw new Error(`manifest: ${what}`); };
  need(m.schema === "ie-run/3", `schema ${m.schema}, expected ie-run/3`);
  need(typeof m.run === "string" && Number.isInteger(m.generation), "run and generation");
  need(m.status === "live" || m.status === "final", `status ${m.status}`);
  need(Array.isArray(m.tiers) && m.tiers.length === N_TIERS && m.tiers.every((x) => typeof x === "string"), "tiers: 7 names");
  need(Array.isArray(m.kinds) && m.kinds.every((k) => typeof k.name === "string" && Number.isInteger(k.tier)), "kinds: [{name, tier, color}]");
  need(Array.isArray(m.things) && m.things.every((t, i) => t.i === i && Number.isInteger(t.pre) && Number.isInteger(t.post)), "things: [{i, key, parent, kind, name, pre, post}] in index order");
  need(Array.isArray(m.names) && Array.isArray(m.requests) && Array.isArray(m.blocks), "names, requests and blocks lists");
  need(m.blocks.every((b) => typeof b.name === "string" && Number.isInteger(b.rows)), "blocks: [{name, rows, ...}]");
  return m;
}

const lower = (a, idx, t) => { let lo = 0, hi = idx.length; while (lo < hi) { const k = (lo + hi) >>> 1; if (a[idx[k]] < t) lo = k + 1; else hi = k; } return lo; };
const upper = (a, idx, t) => { let lo = 0, hi = idx.length; while (lo < hi) { const k = (lo + hi) >>> 1; if (a[idx[k]] <= t) lo = k + 1; else hi = k; } return lo; };
const upperArr = (a, t, lo = 0, hi = a.length) => { while (lo < hi) { const k = (lo + hi) >>> 1; if (a[k] <= t) lo = k + 1; else hi = k; } return lo; };
const lowerArr = (a, t, lo = 0, hi = a.length) => { while (lo < hi) { const k = (lo + hi) >>> 1; if (a[k] < t) lo = k + 1; else hi = k; } return lo; };

export class RunStore {
  constructor(m, raw, base) {
    this.base = base; this.run = m.run; this.generation = m.generation; this.status = m.status; this.t0 = m.t0_ns;
    this.tiers = m.tiers; this.kinds = m.kinds; this.things = m.things; this.names = m.names; this.requests = m.requests;
    this.linkKinds = m.link_kinds ?? [];
    this.metrics = [];   // the manifest's catalog entries in sample-column order: {code, metric, label, unit, thing, sidebar, ...}
    this.catalog = m.metrics ?? [];
    // manifest `tools` ({nsys: {run, path, ...}, ncu: {run, path, kernels, ...}}) and `source` ({run_dir, importer, live?}), as written
    this.tools = m.tools ?? {}; this.source = m.source ?? null; this.auxEntry = m.aux ?? null;
    this.listeners = new Set(); this.details = new Map(); this.inflight = new Map(); this.events = new Map();
    this.rev = 0;   // seals whose `derived` changed held rows; a seal also drops the detail cache (parents, cause, links)
    const nThings = m.things.length, nReqs = m.requests.length;
    this.blocks = []; this.sampleGroups = []; this.groups = new Map(); this.links = null;
    for (const { header, cols, group } of raw) {
      if (header.table === "events") this.blocks.push(indexEvents(header, cols, nThings, nReqs));
      else if (header.table === "links") this.links = cols;
      else this.sampleGroup(group ?? header.block, header, cols);
    }
    // a live run declares its clocks in the catalog before their first sample: hold one (empty) group per clock
    if (m.status === "live") for (const c of this.catalog) if (!this.groups.has(c.group)) {
      const codes = this.catalog.filter((x) => x.group === c.group).map((x) => x.code);
      this.sampleGroup(c.group, { block: c.group, rows: 0, metrics: codes },
        Object.fromEntries([["ts", new Float64Array(0)], ...codes.map((_, j) => [`m${j}`, new Float32Array(0)])]));
    }
    // live: the run-clock head at the writer's wall time of the newest frame, extrapolated between frames
    this.live = m.status === "live" ? { seq: m.import?.live?.seq ?? 0, head: m.head_ns, wall: null, ended: null, queue: [], lat: [] } : null;
    this.N = this.blocks.reduce((a, b) => a + b.n, 0);
    this.ids = indexIds(this.blocks, this.N);
    this.order();
    this.indexLinks();
  }

  /** Samples of one group (one clock), appended in time order; a live group grows in place (amortized). */
  sampleGroup(name, header, cols) {
    let g = this.groups.get(name);
    if (!g) {
      // The header lists catalog codes, not names: two GPUs report the same metric name.
      g = { name, n: 0, codes: header.metrics.slice(), first: this.metrics.length, tsBuf: new Float64Array(Math.max(64, header.rows)),
        colBufs: header.metrics.map(() => new Float32Array(Math.max(64, header.rows))), ts: null, cols: null };
      for (const code of header.metrics) {
        const c = this.catalog[code];
        if (c?.code !== code) throw new Error(`samples block ${header.block}: metric code ${code} is not in the manifest catalog`);
        this.metrics.push(c);
      }
      this.groups.set(name, g); this.sampleGroups.push(g);
    } else if (g.codes.join() !== header.metrics.join()) throw new Error(`samples ${header.block}: metrics ${header.metrics} differ from group ${name} (${g.codes})`);
    const k = header.rows, need = g.n + k;
    if (need > g.tsBuf.length) {
      const cap = Math.max(need, 2 * g.tsBuf.length), grow = (a, T) => { const b = new T(cap); b.set(a.subarray(0, g.n)); return b; };
      g.tsBuf = grow(g.tsBuf, Float64Array); g.colBufs = g.colBufs.map((c) => grow(c, Float32Array));
    }
    g.tsBuf.set(cols.ts, g.n); g.colBufs.forEach((c, j) => c.set(cols[`m${j}`], g.n));
    g.n = need; g.ts = g.tsBuf.subarray(0, g.n); g.cols = g.colBufs.map((c) => c.subarray(0, g.n));
    return g;
  }

  // ------------------------------------------------------------ live
  /** Open the stream socket; frames queue until flush(). `have` is the last frame the loaded manifest holds. Resolves
   *  when the writer has sent every frame it held at connect (caught_up), or the socket ended or said why. */
  connect(have) {
    const l = this.live, proto = location.protocol === "https:" ? "wss" : "ws";
    l.seq = have;
    const ws = new WebSocket(`${proto}://${location.host}${API}/stream?run=${encodeURIComponent(this.run)}&have=${have}`);
    ws.binaryType = "arraybuffer";
    l.ws = ws;
    let caught;
    const ready = new Promise((r) => (caught = r));
    ws.onmessage = (e) => {
      l.queue.push({ data: e.data, at: performance.timeOrigin + performance.now() });
      if (typeof e.data === "string" && JSON.parse(e.data).type !== "seal") caught();   // caught_up, status, generation, reload
      this.emit("wake");
    };
    ws.onclose = () => { caught(); if (l.ws === ws && !l.ended && !l.reloading) setTimeout(() => { if (l.ws === ws) this.connect(l.seq); }, RECONNECT_MS); };
    return ready;
  }

  on(name, fn) { (this.events.get(name) ?? this.events.set(name, new Set()).get(name)).add(fn); return () => this.events.get(name).delete(fn); }
  emit(name, arg) { for (const fn of this.events.get(name) ?? []) fn(arg); }

  /** Merge every queued frame. Returns {events, samples, derived} merged counts, or null when nothing changed. */
  flush() {
    const l = this.live; if (!l || !l.queue.length) return null;
    const frames = l.queue.splice(0), added = [], patches = [], nT = this.things.length, nR = this.requests.length;
    let events = 0, samples = 0, keys = false;
    for (const { data } of frames) {
      if (typeof data === "string") { const msg = JSON.parse(data); if (msg.type === "seal" && msg.derived) patches.push(msg.derived); this.onText(msg); continue; }
      const { header, cols } = decodeBlock(data, `live frame`);
      if (header.seq <= l.seq) continue;                      // held already (a reconnect replays from have)
      this.dicts(header.dict_delta ?? {});
      if (header.table === "events") {
        if (header.base_rows !== this.N + events) { console.error(`live: frame ${header.seq} starts at row ${header.base_rows}, expected ${this.N + events}`); this.reload("row gap"); return null; }
        const b = indexEvents(header, cols, this.things.length, this.requests.length);
        this.blocks.push(b); added.push(b.gpu); events += header.rows;
        // a row is known at the source once it ends (a span is written at its end): its end is its source time
        let lo = Infinity, hi = -Infinity; for (const e of cols.end) { if (e < lo) lo = e; if (e > hi) hi = e; }
        l.lat.push(["events", header, lo, hi]);
      } else if (header.table === "samples") {
        this.sampleGroup(header.group ?? header.block, header, cols); samples += header.rows;
        l.lat.push(["samples", header, cols.ts[0], cols.ts[header.rows - 1]]);
      }
      l.seq = header.seq; l.head = header.head_ns; l.wall = header.wall_ns / 1e6;
    }
    keys = this.things.length !== nT || this.requests.length !== nR;
    if (keys) for (const b of this.blocks) reindexKeys(b, this.things.length, this.requests.length);
    if (events) this.N = this.blocks.reduce((a, b) => a + b.n, 0);
    const derived = patches.length ? this.derive(patches) : null;
    if (l.reloading) return null;
    if (events || keys || derived) { this.ids = indexIds(this.blocks, this.N); this.order(); this.indexLinks(); }
    else this.extentLive();
    if (added.length || derived) for (const fn of this.listeners) fn({ added, changed: derived?.gpu ?? [] });
    if (derived) {
      this.rev++; this.details.clear(); this.inflight.clear();   // parents, cause and links of cached details may be stale
      this.emit("derived", derived.ids);
    }
    return events || samples || derived ? { events, samples, derived: derived?.ids.size ?? 0 } : null;
  }

  /**
   * Apply seal-time derivations ({ids, parent, cause, tier, depth}, parallel lists; a later seal wins) to the held
   * rows: columns, GPU copy, and the tier indexes of each block whose rows changed tier. Returns the changed ids and
   * the GPU copies to upload again, or null after asking for a reload when a seal names a row the page does not hold.
   */
  derive(patches) {
    const pi = new Int32Array(this.N).fill(-1), pj = new Int32Array(this.N);
    for (let p = 0; p < patches.length; p++) { const { ids } = patches[p];
      for (let j = 0; j < ids.length; j++) {
        const id = ids[j];
        if (!(Number.isInteger(id) && id >= 0 && id < this.N)) { console.error(`live: a seal derives row ${id}, the page holds ${this.N}`); this.reload("derived row not held"); return null; }
        pi[id] = p; pj[id] = j;
      } }
    const ids = new Set(), gpu = [];
    for (const b of this.blocks) {
      const { id } = b.cols; let hit = false, moved = false;
      for (let i = 0; i < b.n; i++) {
        const p = pi[id[i]]; if (p < 0) continue;
        const d = patches[p], j = pj[id[i]];
        if (setDerived(b, i, d.parent[j], d.cause[j], d.tier[j], d.depth[j])) moved = true;
        hit = true; ids.add(id[i]);
      }
      if (moved) restep(b);
      if (hit) gpu.push(b.gpu);
    }
    return { ids, gpu };
  }

  /** Dictionary growth carried by a frame: names and requests append ({from, add}); things and metrics are full lists. */
  dicts(d) {
    const grow = (list, x, what) => { if (!x) return; if (x.from > list.length) throw new Error(`live: ${what} delta from ${x.from}, held ${list.length}`); list.push(...x.add.slice(list.length - x.from)); };
    grow(this.names, d.names, "names"); grow(this.requests, d.requests, "requests");
    if (d.things) { if (d.things.length < this.things.length) throw new Error("live: the thing list shrank"); this.things = d.things; }
    if (d.metrics) { d.metrics.forEach((c, i) => { if (this.catalog[i]) Object.assign(this.catalog[i], c); else this.catalog[i] = c; }); }
  }

  onText(msg) {
    const l = this.live;
    if (msg.type === "seal") l.sealed = msg.seq;
    else if (msg.type === "caught_up") l.caughtUp = msg.seq;
    else if (msg.type === "generation") { l.ended = msg; l.reloading = true; this.emit("generation", msg); }
    else if (msg.type === "status") { l.ended = msg; this.emit("status", msg); }
    else if (msg.type === "reload") this.reload(msg.why);
  }

  reload(why) { const l = this.live; l.reloading = true; l.ws?.close(); this.emit("reload", why); }

  /** After Control drew the frame that merged live rows: writer-to-frame latency per merged frame, for PERF.report().
   *  append: frame submitted minus the writer's wall time at encode. source: minus the row's own time (a row's end, or
   *  the NVML read, CLOCK_MONOTONIC, carried over by the writer's mono-wall pair); oldest and newest row of the frame. */
  painted() {
    const l = this.live; if (!l?.lat.length) return;
    const now = performance.timeOrigin + performance.now();
    for (const [kind, h, first, last] of l.lat.splice(0)) {
      const wall = h.wall_ns / 1e6, monoToWall = (t) => wall - (h.mono_ns - (t + this.t0)) / 1e6;
      perf.sample(`live_append_${kind}`, now - wall);
      if (h.group) perf.sample(`live_append_${h.group}`, now - wall);   // per clock: the GPM bound is checked alone
      perf.sample(`live_source_${kind}_newest`, now - monoToWall(last));
      perf.sample(`live_source_${kind}_oldest`, now - monoToWall(first));
    }
  }

  /** Global (start, id) orders per exact tier, the spacing per tier, and the units the chain and natural windows use. */
  order() {
    const { blocks } = this;
    this.startOf = new Float64Array(this.N); this.endOf = new Float64Array(this.N);
    let first = Infinity, last = -Infinity;
    for (const b of blocks) { const { id, start, end } = b.cols;
      for (let i = 0; i < b.n; i++) { this.startOf[id[i]] = start[i]; this.endOf[id[i]] = end[i]; first = Math.min(first, start[i]); last = Math.max(last, end[i]); } }
    if (!Number.isFinite(first)) { first = 0; last = 0; }   // a live run before its first row
    this.extent = [first, last];
    this.extentLive();
    this.exact = [];
    for (let r = 0; r < N_TIERS; r++) {
      const ids = [];
      for (const b of blocks) { const { tier, id } = b.cols; for (const i of b.step[r]) if (tier[i] === r) ids.push(id[i]); }
      this.exact.push(this.sorted(Uint32Array.from(ids)));
    }
    this.gap = new Float64Array(N_TIERS);
    let merged = new Uint32Array(0);
    for (let r = 0; r < N_TIERS; r++) {
      merged = this.merge(merged, this.exact[r]);
      const gaps = new Float64Array(Math.max(0, merged.length - 1)); let k = 0;
      for (let i = 1; i < merged.length; i++) { const d = this.startOf[merged[i]] - this.startOf[merged[i - 1]]; if (d < GAP_LIMIT_NS) gaps[k++] = d; }
      const g = gaps.subarray(0, k).sort();
      this.gap[r] = k ? g[k >> 1] : Infinity;
      if (r > 0) this.gap[r] = Math.min(this.gap[r], this.gap[r - 1]);
    }
    const reqRows = [], iterRows = [];
    for (const id of this.exact[0]) if (this.field("req", id) !== NONE16) reqRows.push(id);
    // Iteration units are the derived `iteration` rows (scheduler stamp to the next one); a run without scheduler
    // stamps has none, and its chain carries no iteration.
    const ITER = this.kinds.find((k) => k.name === "iteration")?.code ?? -1;
    for (const id of this.exact[1]) if (this.field("kind", id) === ITER && this.field("iter", id) >= 0) iterRows.push(id);
    this.reqRows = Uint32Array.from(reqRows); this.iterRows = Uint32Array.from(iterRows);
    // An iteration value can recur (a later request, an engine restart), so each iteration row is its own unit: a row
    // with that value belongs to the latest occurrence starting at or before it. Device work launched in an iteration
    // runs past the next iteration's start and still extends the iteration that launched it.
    const occ = new Map();
    iterRows.forEach((id, k) => { const it = this.field("iter", id); (occ.get(it) ?? occ.set(it, []).get(it)).push(k); });
    this.iterLo = Float64Array.from(iterRows, (id) => this.startOf[id]); this.iterHi = Float64Array.from(iterRows, (id) => this.endOf[id]);
    for (const b of blocks) { const { iter, start, end } = b.cols;
      for (let i = 0; i < b.n; i++) {
        const ks = iter[i] >= 0 ? occ.get(iter[i]) : undefined; if (!ks) continue;
        let lo = 0, hi = ks.length; while (lo < hi) { const m = (lo + hi) >>> 1; if (this.startOf[iterRows[ks[m]]] <= start[i]) lo = m + 1; else hi = m; }
        const k = ks[Math.max(0, lo - 1)];
        if (start[i] < this.iterLo[k]) this.iterLo[k] = start[i]; if (end[i] > this.iterHi[k]) this.iterHi[k] = end[i];
      } }
  }

  sorted(ids) {
    const s = this.startOf;
    for (let i = 1; i < ids.length; i++) if (s[ids[i]] < s[ids[i - 1]] || (s[ids[i]] === s[ids[i - 1]] && ids[i] < ids[i - 1])) return ids.sort((a, b) => s[a] - s[b] || a - b);
    return ids;
  }

  merge(a, b) {
    const out = new Uint32Array(a.length + b.length), s = this.startOf; let i = 0, j = 0, k = 0;
    while (i < a.length && j < b.length) { const x = a[i], y = b[j]; out[k++] = s[x] < s[y] || (s[x] === s[y] && x < y) ? (i++, x) : (j++, y); }
    while (i < a.length) out[k++] = a[i++]; while (j < b.length) out[k++] = b[j++];
    return out;
  }

  indexLinks() {
    const N = this.N, csr = (key, n, val) => { const off = new Uint32Array(N + 1); for (let i = 0; i < n; i++) if (key(i) >= 0) off[key(i) + 1]++;
      for (let j = 0; j < N; j++) off[j + 1] += off[j]; const rows = new Uint32Array(off[N]), at = off.slice(0, N);
      for (let i = 0; i < n; i++) if (key(i) >= 0) rows[at[key(i)]++] = val(i); return { off, rows }; };
    const L = this.links, nL = L ? L.from.length : 0;
    this.linkFrom = csr((i) => L.from[i], nL, (i) => i); this.linkTo = csr((i) => L.to[i], nL, (i) => i);
    const cause = new Int32Array(N);
    for (const b of this.blocks) for (let i = 0; i < b.n; i++) cause[b.cols.id[i]] = b.cols.cause[i];
    this.causes = csr((id) => cause[id], N, (id) => id);
  }

  /** One hot column value of one row. */
  field(name, id) { const k = this.ids.blk[id]; return this.blocks[k].cols[name][this.ids.row[id]]; }

  /** @returns {{id, start, end, lane, comp, kind, tier, depth, req, iter, parent, cause, name, bytes, kindName, nameText, laneKey, request}} */
  row(id) {
    const b = this.blocks[this.ids.blk[id]], i = this.ids.row[id], c = b.cols, o = {};
    for (const k of Object.keys(c)) o[k] = c[k][i];
    o.kindName = this.kinds[o.kind]?.name; o.nameText = this.nameText(o.name); o.laneKey = this.things[o.lane]?.key;
    o.request = o.req === NONE16 ? null : this.requests[o.req];
    return o;
  }

  nameText(i) { const n = this.names[i]; return Array.isArray(n) ? n[0] : n; }

  /** Rows whose parent is `id`, in (start, id) order. */
  children(id) { return this.ids.child.subarray(this.ids.kids[id], this.ids.kids[id + 1]); }

  /**
   * The next (dir +1) or previous (dir -1) row in (start, id) order with tier <= r. Ties at one start are visited one
   * by one in id order. Returns null at the end of the run.
   * @param {Cursor} c @param {1|-1} dir @param {number} r @returns {Cursor|null}
   */
  step(c, dir, r) {
    let bt = dir > 0 ? Infinity : -Infinity, bid = -1;
    for (const b of this.blocks) {
      const idx = b.step[r]; if (!idx.length) continue;
      const { start, id } = b.cols;
      if (dir > 0) {
        let k = lower(start, idx, c.t);
        while (k < idx.length && start[idx[k]] === c.t && id[idx[k]] <= c.id) k++;
        if (k < idx.length) { const s = start[idx[k]], i = id[idx[k]]; if (s < bt || (s === bt && i < bid)) { bt = s; bid = i; } }
      } else {
        let k = upper(start, idx, c.t) - 1;
        while (k >= 0 && start[idx[k]] === c.t && (c.id < 0 || id[idx[k]] >= c.id)) k--;
        if (k >= 0) { const s = start[idx[k]], i = id[idx[k]]; if (s > bt || (s === bt && i > bid)) { bt = s; bid = i; } }
      }
    }
    return bid < 0 ? null : { t: bt, id: bid };
  }

  /** The step tier for a window: the finest tier whose median start gap is at least 6 px at this width. */
  grainFor(width, px) {
    for (let r = N_TIERS - 1; r > 0; r--) if (this.gap[r] < this.gap[r - 1] && this.gap[r] * px / width >= MIN_TICK_PX) return r;
    return 0;   // a tier whose spacing equals the next coarser one's (the envelope) loses the tie to the coarser tier
  }

  /** The widest window whose grain is tier r. */
  widthFor(r, px) { return this.gap[r] * px / MIN_TICK_PX; }

  /** Rows with tier <= r whose start is in [a, b). */
  count([a, b], r) {
    let n = 0;
    for (const blk of this.blocks) { const idx = blk.step[r]; n += lower(blk.cols.start, idx, b) - lower(blk.cols.start, idx, a); }
    return n;
  }

  /**
   * Visit rows in a window; fn(id) returning false stops the scan. Order: by block, then start.
   * q.starts: only rows whose start is in [a, b] (the step index of maxTier); otherwise every row overlapping [a, b].
   * q.lane: one lane only. q.minTier/maxTier: tier range (default 0..6).
   */
  scan(q, fn) {
    const [a, b] = q.win, lo = q.minTier ?? 0, hi = q.maxTier ?? N_TIERS - 1;
    for (const blk of this.blocks) {
      if (blk.t && (blk.t[0] > b || blk.t[2] < a)) continue;
      const { start, end, tier, id } = blk.cols;
      if (q.starts) {
        const idx = blk.step[hi];
        for (let k = lower(start, idx, a), e = upper(start, idx, b); k < e; k++) { const i = idx[k]; if (tier[i] >= lo && fn(id[i]) === false) return; }
        continue;
      }
      const list = q.lane == null ? null : blk.lane.rows.subarray(blk.lane.off[q.lane], blk.lane.off[q.lane + 1]);
      const visit = (i) => end[i] >= a && tier[i] >= lo && tier[i] <= hi && fn(id[i]) === false;
      if (list) { for (let k = lower(start, list, a - LONG_NS), e = upper(start, list, b); k < e; k++) if (visit(list[k])) return; }
      else for (let i = lowerArr(start, a - LONG_NS), e = upperArr(start, b); i < e; i++) if (visit(i)) return;
      for (const i of blk.long) if (start[i] < a - LONG_NS && (q.lane == null || blk.cols.lane[i] === q.lane) && visit(i)) return;
    }
  }

  /**
   * The row active at t per key of `field` ("lane", "comp" or "req"): the last row starting at or before t, walked up
   * its parents while it ended before t. -1 where nothing is active.
   */
  activeBy(field, t) {
    const K = field === "req" ? this.requests.length : this.things.length, out = new Int32Array(K).fill(-1);
    for (let k = 0; k < K; k++) {
      let best = -1, bs = -Infinity;
      for (const blk of this.blocks) {
        const { off, rows } = blk[field], a = off[k], e = off[k + 1]; if (a === e) continue;
        const j = upper(blk.cols.start, rows.subarray(a, e), t) - 1;
        if (j >= 0) { const i = rows[a + j], s = blk.cols.start[i], id = blk.cols.id[i]; if (s > bs || (s === bs && id > best)) { bs = s; best = id; } }
      }
      while (best >= 0 && this.endOf[best] < t) { const p = this.field("parent", best); best = p >= 0 && this.field(field, p) === k ? p : -1; }
      out[k] = best;
    }
    return out;
  }

  /** The request, iteration and device op at t. A unit's win is its [start, end]; an iteration's runs to the end of the device work it launched. */
  chain(t) {
    const last =(list) => { let lo = 0, hi = list.length; while (lo < hi) { const k = (lo + hi) >>> 1; if (this.startOf[list[k]] <= t) lo = k + 1; else hi = k; } return lo - 1; };
    const unit = (id) => ({ id, win: [this.startOf[id], this.endOf[id]] });
    let request = null, iteration = null, device = null;
    if (this.reqRows.length) { const k = Math.max(0, last(this.reqRows)), id = this.reqRows[k]; request = { ...unit(id), req: this.field("req", id), contains: this.startOf[id] <= t && t <= this.endOf[id] }; }
    if (this.iterRows.length) { const k = Math.max(0, last(this.iterRows)), id = this.iterRows[k];
      iteration = { id, iter: this.field("iter", id), win: [this.iterLo[k], this.iterHi[k]], contains: this.iterLo[k] <= t && t <= this.iterHi[k] }; }
    const dev = this.exact[5];
    if (dev.length) { let k = last(dev); if (k < 0 || (this.endOf[dev[k]] < t && k + 1 < dev.length)) k++; device = { ...unit(dev[k]), ordinal: k }; }
    return { request, iteration, device };
  }

  /** The row id of exactly tier r at ordinal k in (start, id) order (chain.device.ordinal is one), or -1 outside. */
  idAt(r, k) { const list = this.exact[r]; return k >= 0 && k < list.length ? list[k] : -1; }

  /** The window [first start, last end] of the rows of exactly tier r with ordinals from..to-1 (chain.device.ordinal is one). */
  span(r, from, to) {
    const list = this.exact[r]; if (!list.length) return null;
    const a = Math.max(0, Math.min(list.length - 1, from)), b = Math.max(a + 1, Math.min(list.length, to));
    let end = -Infinity; for (let k = a; k < b; k++) end = Math.max(end, this.endOf[list[k]]);
    return [this.startOf[list[a]], end];
  }

  /** Links touching a row (zmq, network, serves) plus its cause and the rows it caused. */
  linksOf(id) {
    const out = [], L = this.links;
    if (L) for (const s of [this.linkFrom, this.linkTo]) for (let k = s.off[id]; k < s.off[id + 1]; k++) { const i = s.rows[k]; out.push({ from: L.from[i], to: L.to[i], kind: this.linkKinds[L.kind[i]]?.name ?? `link ${L.kind[i]}` }); }
    const c = this.field("cause", id); if (c >= 0) out.push({ from: c, to: id, kind: "cause" });
    for (let k = this.causes.off[id]; k < this.causes.off[id + 1]; k++) out.push({ from: id, to: this.causes.rows[k], kind: "cause" });
    return out;
  }

  /**
   * Every metric's value at t, aligned with `metrics`: the last sample at or before t while it is fresh, at most two
   * sample periods of its group old. NaN where it is older (a gap, or past the end of a profiled range) or there is
   * none: never the last value seen.
   */
  samplesAt(t) {
    const out = new Float64Array(this.metrics.length).fill(NaN);
    for (const g of this.sampleGroups) {
      const k = upperArr(g.ts, t) - 1;
      if (k >= 0 && t - g.ts[k] <= FRESH_PERIODS * this.samplePeriod(g.first)) g.cols.forEach((c, j) => (out[g.first + j] = c[k]));
    }
    return out;
  }

  /** A metric's sampling period in ns: this run's measured median gap, else the registry period, else 1 s. */
  samplePeriod(metric) { const m = this.metrics[metric]; return m.period_ns_measured ?? (m.period_ms ?? 1000) * 1e6; }

  /** [first, last] sample time of a metric's group (one clock), or null when it has no sample yet. */
  sampleSpan(metric) { const g = this.groupOf(metric); return g.n ? [g.ts[0], g.ts[g.n - 1]] : null; }

  groupOf(metric) { return this.sampleGroups.find((x) => metric >= x.first && metric < x.first + x.codes.length); }

  /** Min and max of one metric per pixel column over a window (sparklines). */
  series(metric, [a, b], px) {
    const g = this.groupOf(metric), v = g.cols[metric - g.first];
    const lo = new Float32Array(px).fill(NaN), hi = new Float32Array(px).fill(NaN);
    for (let i = lowerArr(g.ts, a), e = upperArr(g.ts, b); i < e; i++) {
      const x = Math.min(px - 1, ((g.ts[i] - a) / (b - a) * px) | 0);
      if (!(v[i] >= lo[x])) lo[x] = v[i]; if (!(v[i] <= hi[x])) hi[x] = v[i];
    }
    return { lo, hi };
  }

  /**
   * Cold fields (eid, what, args, evidence, open, counters, ...) from the server, the one cache of them. Each id is
   * asked once: ids already held or on their way are not asked again; the rest go in requests of 256. Resolves to one
   * detail row per id, null for an id the server did not return. An answer that a seal overtook (rev changed) is not
   * cached: its rows resolve to null and the caller asks again.
   */
  async detail(ids) {
    const miss = [...new Set(ids)].filter((id) => !this.details.has(id) && !this.inflight.has(id)), rev = this.rev;
    for (let i = 0; i < miss.length; i += DETAIL_MAX) {
      const chunk = miss.slice(i, i + DETAIL_MAX);
      const p = fetch(`${this.base}/detail?ids=${chunk.join(",")}`).then(async (r) => {
        if (!r.ok) throw new Error(`GET detail: HTTP ${r.status}`);
        const rows = (await r.json()).rows;
        if (rev !== this.rev) return;
        for (const d of rows) this.details.set(d.id, d);
        for (const id of chunk) if (!this.details.has(id)) this.details.set(id, null);
      }).finally(() => { for (const id of chunk) if (this.inflight.get(id) === p) this.inflight.delete(id); });
      for (const id of chunk) this.inflight.set(id, p);
    }
    await Promise.all(ids.map((id) => this.inflight.get(id)));
    return ids.map((id) => this.details.get(id) ?? null);
  }

  /** A row's cold fields if detail() fetched them (null: the server has none); undefined if not fetched. No request. */
  detailCached(id) { return this.details.get(id); }

  /**
   * The run's aux.json (calculated metrics with their inputs, facts, measures), fetched once through the blocks route
   * under the name the manifest's `aux` entry gives. A manifest without that entry gets an empty one that says so.
   */
  aux() {
    const e = this.auxEntry;
    return (this.auxLoad ??= !e
      ? Promise.resolve({ metrics: [], measures: null, facts: {}, unavailable: [{ what: "aux.json", why: `the manifest of generation ${this.generation} (${this.status}) lists no aux entry` }] })
      : fetch(`${this.base}/blocks/${this.generation}/${encodeURIComponent(e.name)}`).then((r) => {
        if (!r.ok) throw new Error(`GET ${e.name}: HTTP ${r.status}`);
        return r.json();
      }));
  }

  /** The row id of a stable eid (URL selection), or null. */
  async resolve(eid) {
    const r = await fetch(`${this.base}/detail?eids=${encodeURIComponent(eid)}`);
    if (!r.ok) throw new Error(`GET detail by eid: HTTP ${r.status}`);
    const d = (await r.json()).rows[0];
    if (d) this.details.set(d.id, d);
    return d ? d.id : null;
  }

  /** The render seam: fn receives {added: GpuRows[]} now for every resident block, and again when rows arrive. */
  subscribe(fn) { this.listeners.add(fn); fn({ added: this.blocks.map((b) => b.gpu) }); return () => this.listeners.delete(fn); }

  /** A live run's extent runs to the head (the writer's clock now), so the cursor can follow it past the last row. */
  extentLive() {
    if (!this.live) return;
    let last = this.extent[1];
    for (const g of this.sampleGroups) if (g.n) last = Math.max(last, g.ts[g.n - 1]);
    this.extent = [this.extent[0], Math.max(last, this.head())];
  }

  /** The last time the run has data for; while live, the writer's head extrapolated by wall time since its frame. */
  head() {
    const l = this.live;
    if (!l || l.ended) return this.extent[1];
    return l.wall == null ? Math.max(this.extent[1], l.head) : l.head + 1e6 * (performance.timeOrigin + performance.now() - l.wall);
  }

  /** Resident bytes, for PERF.report(). */
  bytes() {
    let cols = 0, idx = 0, gpu = 0;
    for (const b of this.blocks) { for (const c of Object.values(b.cols)) cols += c.byteLength;
      for (const s of b.step) idx += s.byteLength; idx += b.lane.rows.byteLength + b.comp.rows.byteLength + b.req.rows.byteLength;
      gpu += b.gpu.time.byteLength + b.gpu.attr.byteLength + b.gpu.ident.byteLength; }
    const samples = this.sampleGroups.reduce((a, g) => a + g.ts.byteLength + g.cols.reduce((x, c) => x + c.byteLength, 0), 0);
    return { columns_mb: cols / 2 ** 20, indexes_mb: idx / 2 ** 20, gpu_mb: gpu / 2 ** 20, samples_mb: samples / 2 ** 20 };
  }
}
