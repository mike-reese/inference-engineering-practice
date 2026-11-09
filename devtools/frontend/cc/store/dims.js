// Dimensions: each row's place, and the stops per (dimension, tier), from the manifest's `dimensions` block (the
// registry's kinds.json, copied at import) and each kind's `place` (COMMAND_CENTER.md section 3.4).
// design/dimensions/stop_counts.py applies the same rules to the run's Parquet; the ccv check compares the counts.
//
// Built once per load (and again when a live merge re-orders the store). Rows are ids; times are ns from the run's t0.
// A stop list is {ids, t}: stop rows and their times, sorted by (t, id). Most stops sit at their row's start; a stop
// "at launch" sits at the start of the call that launched it (software layer: the kernel seen from the toolkit).
import { NONE16 } from "./columns.js";

const DETAIL = -1;
const tierName = (v) => v.split(" (")[0];
const lowerT = (t, x, lo = 0, hi = t.length) => { while (lo < hi) { const k = (lo + hi) >>> 1; if (t[k] < x) lo = k + 1; else hi = k; } return lo; };
const upperT = (t, x, lo = 0, hi = t.length) => { while (lo < hi) { const k = (lo + hi) >>> 1; if (t[k] <= x) lo = k + 1; else hi = k; } return lo; };

export class Dimensions {
  /** @param {import("./run.js").RunStore} s  @param {object} m the manifest */
  constructor(s, m) {
    if (!m.dimensions?.ladders || !m.kinds.every((k) => k.place)) throw new Error(`manifest ${m.run}: no dimensions or kind places (imported before P3; re-import it)`);
    this.s = s; this.d = m.dimensions; this.ladders = m.dimensions.ladders; this.dims = Object.keys(this.ladders);
    this.profiled = new Set(m.tools?.ncu?.event_ids ?? []);
    this.flowNames = this.d.flow.names; this.FLOW_NONE = this.d.flow.none;
    this.build();
  }

  build() {
    const s = this.s, N = s.N, kinds = s.kinds, ex = this.ex = new Int8Array(N).fill(DETAIL);
    // (start, id) order of every row, and one list per kind (transfers, kernels: no scan for "next transfer")
    this.all = s.allRows;
    this.byKind = kinds.map(() => []);
    for (const id of this.all) this.byKind[s.field("kind", id)].push(id);
    this.byKind = this.byKind.map((a) => Uint32Array.from(a));
    // the CPU side of kernel stops: causes of rows whose kind sits plainly at execution / kernel
    const plainKernel = kinds.filter((k) => typeof k.place.execution === "string" && tierName(k.place.execution) === "kernel").map((k) => k.code);
    this.side = new Uint8Array(N);
    for (const c of plainKernel) for (const id of this.byKind[c]) { const p = s.field("cause", id); if (p >= 0) this.side[p] = 1; }
    const E = this.ladders.execution, code = (v) => { const i = E.indexOf(tierName(v)); return i >= 0 ? i : DETAIL; };
    const nameHit = new Map();
    for (const k of kinds) {
      const v = k.place.execution, rows = this.byKind[k.code];
      if (typeof v === "string") { const c = code(v); for (const id of rows) ex[id] = c; continue; }
      const yes = code(v.then), no = code(v.else);
      let when;
      if (v.if === "top-level") when = (id) => s.field("tier", id) === k.tier;
      else if (v.if === "launch") when = (id) => this.side[id] === 1;
      else if (v.if === "profiled") when = (id) => this.profiled.has(id);
      else if (v.if === "module forward") {
        const rx = new RegExp(v.match);
        when = (id) => { const n = s.field("name", id); let h = nameHit.get(n); if (h === undefined) nameHit.set(n, (h = rx.test(s.nameText(n)))); return h; };
      } else throw new Error(`kind ${k.name}: unknown place rule ${v.if}`);
      for (const id of rows) ex[id] = when(id) ? yes : no;
    }
    // the thing at each hand-off level of a lane (container, process): nearest ancestor of the listed kinds
    const T = s.things, level = (ks) => Int32Array.from(T, (t) => { let x = t; while (x && !ks.includes(x.kind)) x = x.parent != null && x.parent >= 0 ? T[x.parent] : null; return x ? x.i : -1; });
    this.laneLevel = { container: level(this.d.handoff.container), process: level(this.d.handoff.process) };
    this.cache = new Map();
    this.aggregates();
  }

  /** Stops of (dim, tier): {ids, t}, sorted by (t, id). */
  stops(dim, tier) {
    const key = `${dim}/${tier}`; let out = this.cache.get(key);
    if (out) return out;
    const rule = this.d.stops[dim]?.[tier];
    if (!rule) throw new Error(`no stops for ${key} in the manifest's dimensions`);
    const s = this.s, ids = [];
    if (rule.place) { const c = this.ladders.execution.indexOf(rule.place); for (const id of this.all) if (this.ex[id] === c && !this.side[id]) ids.push(id); }
    else if (rule.group) {
      let last = null;
      for (const id of this.stops("execution", rule.of).ids) {
        const g = rule.group.map((c) => s.field(c, id)); if (g.some((x) => x < 0)) continue;
        if (!last || g.some((x, j) => x !== last[j])) ids.push(id);
        last = g;
      }
    } else if (rule.kinds) {
      const sets = rule.kinds.map((n) => s.kinds.find((k) => k.name === n)).filter(Boolean).map((k) => this.byKind[k.code]);
      const merged = sets.reduce((a, b) => s.merge(a, b), new Uint32Array(0));
      for (const id of merged) if (rule.if !== "profiled" || this.profiled.has(id)) ids.push(id);
    } else if (rule.as) {
      const [d, t] = rule.as.split("/"), base = this.stops(d, t);
      if (rule.at !== "launch") { this.cache.set(key, base); return base; }
      ids.push(...base.ids);
    } else ids.push(...this.handoffs(rule.handoff));
    const at = (id) => { if (rule.at === "launch") { const p = s.field("cause", id); if (p >= 0) return s.startOf[p]; } return s.startOf[id]; };
    const order = Uint32Array.from(ids.keys()).sort((a, b) => at(ids[a]) - at(ids[b]) || ids[a] - ids[b]);
    out = { ids: Uint32Array.from(order, (k) => ids[k]), t: Float64Array.from(order, (k) => at(ids[k])) };
    this.cache.set(key, out);
    return out;
  }

  /** Per request, the phase rows whose container, process or component differs from the request's previous one. */
  handoffs(lv) {
    const s = this.s, phase = this.ladders.execution.indexOf(this.d.handoff.rows), last = new Map(), out = [];
    const comp = this.d.handoff[lv] === "comp";
    for (const id of this.all) {
      if (this.ex[id] !== phase) continue;
      const r = s.field("req", id); if (r === NONE16) continue;
      let k;
      if (comp) { k = s.field("comp", id); if (k === NONE16) continue; } else { k = this.laneLevel[lv][s.field("lane", id)]; if (k < 0) continue; }
      if (last.has(r) && last.get(r) !== k) out.push(id);
      last.set(r, k);
    }
    return out;
  }

  /** {dim: {tier: stop count}}: what stop_counts.py --json writes for the run. */
  counts() { return Object.fromEntries(this.dims.map((d) => [d, Object.fromEntries(this.ladders[d].map((t) => [t, this.stops(d, t).ids.length]))])); }

  /** The next (dir +1) or previous (dir -1) stop of (dim, tier) after cursor {t, id}; ties at one t go by id. */
  step(dim, tier, c, dir) {
    const { ids, t } = this.stops(dim, tier);
    if (dir > 0) { let k = lowerT(t, c.t); while (k < t.length && t[k] === c.t && ids[k] <= c.id) k++; return k < t.length ? { t: t[k], id: ids[k] } : null; }
    let k = upperT(t, c.t) - 1; while (k >= 0 && t[k] === c.t && (c.id < 0 || ids[k] >= c.id)) k--;
    return k >= 0 ? { t: t[k], id: ids[k] } : null;
  }

  /**
   * The every-row walk (section 3.4). scope null: every row of the focused tier in time order across every process
   * (the stops, or for the hand-off tiers every phase row, as `walk` says). scope {process: thing index}: every row on
   * a lane under that process; scope {object: row id}: every row under that row (its descendants), in (start, id) order.
   */
  walkRows(dim, tier, scope = null) {
    const s = this.s;
    if (!scope) { const w = this.d.walk?.[dim]?.[tier]; return w ? this.stops(...w.split("/")) : this.stops(dim, tier); }
    const key = scope.process != null ? `process:${scope.process}` : `object:${scope.object}`;
    let out = this.cache.get(key);
    if (out) return out;
    let ids;
    if (scope.process != null) {
      const p = s.things[scope.process], under = (lane) => { const t = s.things[lane]; return t.pre >= p.pre && t.post <= p.post; };
      ids = this.all.filter((id) => under(s.field("lane", id)));
    } else {
      const acc = [], todo = [scope.object];
      while (todo.length) { const x = todo.pop(); for (const c of s.children(x)) { acc.push(c); todo.push(c); } }
      ids = s.sorted(Uint32Array.from(acc));
    }
    out = { ids, t: Float64Array.from(ids, (id) => s.startOf[id]) };
    this.cache.set(key, out);
    return out;
  }

  walk(dim, tier, c, dir, scope = null) {
    const { ids, t } = this.walkRows(dim, tier, scope);
    if (dir > 0) { let k = lowerT(t, c.t); while (k < t.length && t[k] === c.t && ids[k] <= c.id) k++; return k < t.length ? { t: t[k], id: ids[k] } : null; }
    let k = upperT(t, c.t) - 1; while (k >= 0 && t[k] === c.t && (c.id < 0 || ids[k] >= c.id)) k--;
    return k >= 0 ? { t: t[k], id: ids[k] } : null;
  }

  /** The tier of `to` aligned with (`from`, tier) in the alignment table. */
  aligned(from, tier, to) {
    const row = this.d.align.find((r) => r[from] === tier);
    return row ? row[to] : null;
  }

  /** Load-time aggregates: per component box, the starts of its rows (run count up to t), their summed durations
   *  and the flows it carries. */
  aggregates() {
    const s = this.s, K = s.things.length, starts = Array.from({ length: K }, () => []), durs = Array.from({ length: K }, () => []);
    this.compFlowMask = new Uint8Array(K);
    for (const id of this.all) {
      const c = s.field("comp", id); if (c === NONE16) continue;
      starts[c].push(s.startOf[id]); durs[c].push(s.endOf[id] - s.startOf[id]);
      const f = s.field("flow", id); if (f !== this.FLOW_NONE) this.compFlowMask[c] |= 1 << f;
    }
    this.compStarts = starts.map((a) => Float64Array.from(a));   // (start, id) order: already sorted
    this.compDurSum = durs.map((a) => { const p = new Float64Array(a.length + 1); a.forEach((d, i) => (p[i + 1] = p[i] + d)); return p; });
  }

  /** Rows of component box `comp` that started at or before t. */
  compRuns(comp, t) { return upperT(this.compStarts[comp], t); }

  /** Summed duration (ns) of the rows of component box `comp` that started at or before t. */
  compTime(comp, t) { return this.compDurSum[comp][this.compRuns(comp, t)]; }

  /** The flow names a component box carries over the whole run. */
  compFlows(comp) { return this.flowNames.filter((_, f) => this.compFlowMask[comp] & (1 << f)); }

  flowOf(id) { const f = this.s.field("flow", id); return f === this.FLOW_NONE ? null : this.flowNames[f]; }

  /** The innermost module row (execution / module) above a row, or -1: up its own parents (a graphs-on device row's
   *  inferred modules, M2), then up the parents of the call that launched it (a code run's module frames). */
  moduleOf(id) {
    const s = this.s, M = this.ladders.execution.indexOf("module"), c = s.field("cause", id);
    for (let x of [s.field("parent", id), this.side[c] ? c : -1]) for (let n = 0; x >= 0 && n < 400; n++, x = s.field("parent", x)) if (this.ex[x] === M) return x;
    return -1;
  }

  /** Whether a row is an inferred module (M2): matched to the code run's module frames, not recorded. */
  inferred(id) { return this.s.kinds[this.s.field("kind", id)].name === "inferred module"; }

  /** The hardware thing a row ran on (index into things), or -1: by kind first, else by its lane's kind. A stream
   *  lane sits under its GPU; a thread lane sits under its process, so its CPU is the one under the same host. */
  ranOn(id) {
    const s = this.s, kind = s.kinds[s.field("kind", id)].name, lane = s.things[s.field("lane", id)];
    const want = this.d.ran_on.kinds[kind] ?? this.d.ran_on.lanes[lane?.kind];
    if (!want) return -1;
    let host = null;
    for (let x = lane; x; x = x.parent != null && x.parent >= 0 ? s.things[x.parent] : null) {
      if (x.kind === want) return x.i;
      if (x.kind === "host") host = x;
    }
    return host ? s.things.find((t) => t.kind === want && t.pre >= host.pre && t.post <= host.post)?.i ?? -1 : -1;
  }

  /** gemm, attention, memory or other (kinds.json kernel_class: by kind, else by the short name), for device rows. */
  kernelClass(id) {
    const s = this.s, kind = s.kinds[s.field("kind", id)].name, name = s.nameText(s.field("name", id));
    this.classRx ??= this.d.kernel_class.map((c) => ({ ...c, rx: c.match ? new RegExp(c.match) : null }));
    for (const c of this.classRx) if ((c.kinds && c.kinds.includes(kind)) || (c.rx && c.rx.test(name)) || (!c.kinds && !c.rx)) return c.class;
    return null;
  }
}
