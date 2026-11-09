// Execution units per execution tier (COMMAND_CENTER.md 2.3, 3.4): what the cursor is inside, and the playback
// bounds. A unit is a stop row of execution/<tier> with its [start, end]. A `group` stop rule (layer) makes one unit
// per group of consecutive `of` stops with the same group fields, from its first row's start to its last row's end,
// under the first row's id (the group's stop). Built lazily per tier; a live merge (RunStore N or rev) rebuilds.
const upperT = (a, x, lo = 0, hi = a.length) => { while (lo < hi) { const k = (lo + hi) >>> 1; if (a[k] <= x) lo = k + 1; else hi = k; } return lo; };
const LONG_SHARE = 0.01;   // the longest 1% of a tier's units are checked one by one; the rest by a start window

/** @typedef {{ids: Uint32Array, start: Float64Array, end: Float64Array, reach: number, long: Uint32Array}} TierUnits */

export class Units {
  /** @param {import("./run.js").RunStore} s */
  constructor(s) { this.s = s; this.key = ""; this.cache = new Map(); }

  /** Units of execution tier `tier` (index), by (start, id). reach: the longest unit outside `long` (indexes). */
  of(tier) {
    const s = this.s, key = `${s.N}/${s.rev}`;
    if (key !== this.key) { this.key = key; this.cache.clear(); }
    let u = this.cache.get(tier);
    if (u) return u;
    const name = s.dims.ladders.execution[tier], rule = s.dims.d.stops.execution[name];
    let ids, start, end;
    if (rule.group) {
      const base = s.dims.stops("execution", rule.of), I = [], A = [], B = [];
      let last = null;
      for (const id of base.ids) {
        const g = rule.group.map((c) => s.field(c, id));
        if (g.some((x) => x < 0)) continue;
        if (!last || g.some((x, j) => x !== last[j])) { I.push(id); A.push(s.startOf[id]); B.push(s.endOf[id]); }
        else B[B.length - 1] = Math.max(B[B.length - 1], s.endOf[id]);
        last = g;
      }
      ids = Uint32Array.from(I); start = Float64Array.from(A); end = Float64Array.from(B);
    } else {   // a place rule: the stops sit at their rows' starts, in (start, id) order already
      const st = s.dims.stops("execution", name);
      ids = st.ids; start = st.t; end = Float64Array.from(ids, (id) => s.endOf[id]);
    }
    const dur = Float64Array.from(start, (a, k) => end[k] - a).sort();
    const reach = dur.length ? dur[Math.min(dur.length - 1, Math.floor(dur.length * (1 - LONG_SHARE)))] : 0;
    const long = [];
    for (let k = 0; k < ids.length; k++) if (end[k] - start[k] > reach) long.push(k);
    u = { ids, start, end, reach, long: Uint32Array.from(long) };
    this.cache.set(tier, u);
    return u;
  }

  /** Indexes of every unit of `tier` holding t (start <= t < end), latest start first. */
  holding(tier, t) {
    const u = this.of(tier), out = [];
    for (let k = upperT(u.start, t) - 1; k >= 0 && u.start[k] >= t - u.reach; k--) if (u.end[k] > t) out.push(k);
    for (const k of u.long) if (u.start[k] <= t && u.end[k] > t && !out.includes(k)) out.push(k);
    return out.sort((a, b) => u.start[b] - u.start[a] || b - a);
  }

  /** The index of the latest-starting unit of `tier` holding t, or -1. */
  at(tier, t) {
    const u = this.of(tier);
    let best = -1;
    for (let k = upperT(u.start, t) - 1; k >= 0 && u.start[k] >= t - u.reach; k--) if (u.end[k] > t) { best = k; break; }
    for (const k of u.long) if (u.start[k] <= t && u.end[k] > t && (best < 0 || u.start[k] > u.start[best])) best = k;
    return best;
  }

  /** The index of the last unit of `tier` starting at or before t, or -1. */
  last(tier, t) { return upperT(this.of(tier).start, t) - 1; }

  /** Every row (any tier) starting in [a, b), in (start, id) order: a view of RunStore.allRows. */
  rowsIn([a, b]) {
    const s = this.s, all = s.allRows, at = (x) => { let lo = 0, hi = all.length; while (lo < hi) { const k = (lo + hi) >>> 1; if (s.startOf[all[k]] < x) lo = k + 1; else hi = k; } return lo; };
    return all.subarray(at(a), at(b));
  }
}
