// Per-block indexes, built once when a block is decoded. Rows inside a block are in (start, id) order, so every index
// below is a list of local row numbers in that order, and every query is a binary search on `start`.
import { N_TIERS, NONE16 } from "./columns.js";

/** Rows longer than this go to the block's `long` list; window scans look back this far plus that list. */
export const LONG_NS = 50e6;

/** Local row numbers 0..65535 in one shared buffer. A block holds at most 32,768 rows (the writer's BLOCK_ROWS), so its
 *  local row lists are Uint16; a tier index that holds every row of a block is a view of this buffer. */
const IDENTITY = Uint16Array.from({ length: 65536 }, (_, i) => i);

/** An empty list of `len` local row numbers of a block of n rows. */
export const localRows = (n, len) => new (n <= IDENTITY.length ? Uint16Array : Uint32Array)(len);

/**
 * @typedef {Uint16Array | Uint32Array} Local   local row numbers (Uint32 only past 65,536 rows in a block)
 * @typedef {{off: Uint32Array, rows: Local}} Csr   rows of key k are rows[off[k] .. off[k+1])
 * @typedef {{time: Float32Array, attr: Float32Array, ident: Float32Array, n: number}} GpuRows
 *   time: per row [startHi, startLo, endHi, endLo]; attr: [lane, kind, tier, depth]; ident: [id, name]
 * @typedef {{name: string, band: string, n: number, t: number[], cols: Record<string, any>,
 *   step: Local[], lane: Csr, comp: Csr, req: Csr, long: Local, gpu: GpuRows}} EventBlock
 */

/** @returns {EventBlock} */
export function indexEvents(header, cols, nThings, nReqs) {
  const n = header.rows, { start, end } = cols;
  const long = [];
  for (let i = 0; i < n; i++) if (end[i] - start[i] > LONG_NS) long.push(i);
  const longRows = localRows(n, long.length); longRows.set(long);
  return {
    name: header.block, band: header.band, n, t: header.t, cols, step: stepIndex(cols.tier, n),
    lane: csr(cols.lane, n, nThings), comp: csr(cols.comp, n, nThings), req: csr(cols.req, n, nReqs),
    long: longRows, gpu: gpuRows(cols, n),
  };
}

/** step[r]: the block's rows with tier <= r, in (start, id) order. The spine band (tiers 0..2) is step[2]. A tier that
 *  every row reaches (always the last) is the identity, a view of the shared buffer. */
function stepIndex(tier, n) {
  const cnt = new Uint32Array(N_TIERS);
  for (let i = 0; i < n; i++) cnt[tier[i]]++;
  const step = [], own = [];
  for (let r = 0, acc = 0; r < N_TIERS; r++) {
    acc += cnt[r];
    const all = acc === n && n <= IDENTITY.length;
    step.push(all ? IDENTITY.subarray(0, n) : localRows(n, acc)); own.push(!all);
  }
  const fill = new Uint32Array(N_TIERS);
  for (let i = 0; i < n; i++) for (let r = tier[i]; r < N_TIERS; r++) if (own[r]) step[r][fill[r]++] = i;
  return step;
}

/**
 * A seal's derived values for local row i (live runs): parent, cause, tier and depth in the columns and the GPU copy.
 * Returns true when the tier changed; the caller then calls restep(b) once for the block.
 */
export function setDerived(b, i, parent, cause, tier, depth) {
  const c = b.cols, moved = c.tier[i] !== tier;
  c.parent[i] = parent; c.cause[i] = cause; c.tier[i] = tier; c.depth[i] = depth;
  b.gpu.attr[i * 4 + 2] = tier; b.gpu.attr[i * 4 + 3] = depth;
  return moved;
}

/** Rebuild a block's tier indexes after tiers changed: a row that left or joined the spine band (tiers 0..2) moves. */
export function restep(b) { b.step = stepIndex(b.cols.tier, b.n); }

/** Rebuild a block's lane, comp and request indexes when the run's thing or request list grows (live runs). */
export function reindexKeys(b, nThings, nReqs) {
  const c = b.cols;
  b.lane = csr(c.lane, b.n, nThings); b.comp = csr(c.comp, b.n, nThings); b.req = csr(c.req, b.n, nReqs);
}

function csr(key, n, k) {
  const off = new Uint32Array(k + 1);
  for (let i = 0; i < n; i++) if (key[i] !== NONE16) off[key[i] + 1]++;
  for (let j = 0; j < k; j++) off[j + 1] += off[j];
  const rows = localRows(n, off[k]), at = off.slice(0, k);
  for (let i = 0; i < n; i++) if (key[i] !== NONE16) rows[at[key[i]]++] = i;
  return { off, rows };
}

/** Float32 hi/lo pairs keep a start exact relative to any window start on the GPU: (hi - winHi) + (lo - winLo). */
function gpuRows(c, n) {
  const time = new Float32Array(n * 4), attr = new Float32Array(n * 4), ident = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const s = c.start[i], e = c.end[i], sh = Math.fround(s), eh = Math.fround(e);
    time[i * 4] = sh; time[i * 4 + 1] = s - sh; time[i * 4 + 2] = eh; time[i * 4 + 3] = e - eh;
    attr[i * 4] = c.lane[i]; attr[i * 4 + 1] = c.kind[i]; attr[i * 4 + 2] = c.tier[i]; attr[i * 4 + 3] = c.depth[i];
    ident[i * 2] = c.id[i]; ident[i * 2 + 1] = c.name[i];
  }
  return { time, attr, ident, n };
}

/** Parents per entry of `ids.every`, the sampled start of each parent's children in `ids.child`. */
export const KIDS_EVERY = 64;

/**
 * Global id -> (block, local row), and every row with a parent, grouped by parent id (ascending) and in (start, id)
 * order inside a group. every[j] is where the children of parent j * KIDS_EVERY start in `child`; the children of p
 * are one run between every[p / KIDS_EVERY] and the next entry, found by a binary search on the parent column.
 */
export function indexIds(blocks, N) {
  const blk = new Uint16Array(N), row = localRows(Math.max(0, ...blocks.map((b) => b.n)), N), kids = new Uint32Array(N + 1);
  blocks.forEach((b, k) => { const { id, parent } = b.cols;
    for (let i = 0; i < b.n; i++) { blk[id[i]] = k; row[id[i]] = i; if (parent[i] >= 0) kids[parent[i] + 1]++; } });
  for (let j = 0; j < N; j++) kids[j + 1] += kids[j];
  const child = new Uint32Array(kids[N]), at = kids.slice(0, N);
  for (let id = 0; id < N; id++) { const b = blocks[blk[id]], p = b.cols.parent[row[id]]; if (p >= 0) child[at[p]++] = id; }
  const startOf = (id) => blocks[blk[id]].cols.start[row[id]];
  for (let p = 0; p < N; p++) {   // ids follow (start, source order) in a final generation; live ones may not
    const a = kids[p], b = kids[p + 1];
    for (let k = a + 1; k < b; k++) if (startOf(child[k]) < startOf(child[k - 1])) {
      child.subarray(a, b).sort((x, y) => startOf(x) - startOf(y) || x - y); break; }
  }
  const every = Uint32Array.from({ length: Math.floor(N / KIDS_EVERY) + 2 }, (_, j) => kids[Math.min(j * KIDS_EVERY, N)]);
  return { blk, row, child, every };
}
