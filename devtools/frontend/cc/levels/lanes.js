// L3 Trace, L4 Iteration, L5 Model ops: one lanes level, three specs. Lanes are the things that hold rows of the
// level's tiers, grouped under their parent thing (containment, Euler order); a lane has one sub-row per nesting
// depth (capped). Bars come from the shared GPU rows; zoom and pan set uniforms only. Text is CSS2D at a fixed
// screen size: group headers, lane names in the left gutter, and a row's name once its bar is wide enough to read.
// Picks are analytic: lane band from y, then a window scan of that lane around t. A live run's rows, lanes and layers
// are counted in frame() as the store gains them (store.N and the thing list are the counters).
import * as THREE from "three";
import { setWindow } from "../scene/rows_gpu.js";
import { Boxes } from "../scene/boxes.js";
import { frameMeshes, title, windowOf, TITLE_H, LIT } from "./level.js";

const GUTTER = 150, PAD = 4, X0 = GUTTER, XW = 1000 - GUTTER - PAD;
const GROUP_H = 13, MAX_SUB = 6, MAX_SUB_H = 22, MAX_LANE_THINGS = 4096;
const ROW_LABELS = 160, ROW_LABEL_PX = 56, TEXT_PX = 12, LANE_TEXT_PX = 9, PICK_PX = 4, MAX_BANDS = 2000;   // lane names: 11 px glyphs fit 9 px
const MAX_LIT = 256, LIT_MIN_PX = 3;
const BAND_EVEN = new THREE.Color("#2b3344"), BAND_ODD = new THREE.Color("#222833");   // sRGB hex: vertex colors are linear
const WHITE = new THREE.Color("#ffffff");

/** @typedef {{name: string, key: string, homeTier: number, tiers: [number, number], lanes: (thing: any) => boolean,
 *   layers?: boolean, natural: (store: any, t: number) => [number, number] | null}} LaneSpec */

/** @param {LaneSpec} spec @returns {import("./level.js").Level} */
export function lanesLevel(spec) { return new LanesLevel(spec); }

class LanesLevel {
  constructor(spec) {
    this.spec = spec; this.name = spec.name; this.key = spec.key; this.homeTier = spec.homeTier; this.natural = spec.natural; this.index = -1; this.px = 1; this.win = null;
    this.seenN = 0; this.nThings = -1; this.litN = 0;   // rows and things counted so far; lit boxes placed last frame
  }

  mount({ group, store, gpu, H, index }) {
    Object.assign(this, { group, store, gpu, index, H });
    this.countAll();
    this.cursor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: "#ffd36b", depthTest: false, side: THREE.DoubleSide }));
    this.cursor.renderOrder = 4;
    this.lit = new Boxes(MAX_LIT, { inset: 1, order: 3.5 });
    if (this.spec.layers) { this.bands = layerBands(store); this.bandMesh = bandMesh(); }
    this.layout();
  }

  /** Lanes from the per-thing counts (things that hold rows of the level's tiers), the lane texture sized to the thing list, then the y layout. */
  layout() {
    const s = this.store, nT = s.things.length;
    if (nT > MAX_LANE_THINGS) throw new Error(`lanes: ${nT} things, the lane texture holds ${MAX_LANE_THINGS}`);
    this.lanes = s.things.filter((th) => this.count[th.i] > 0 && this.spec.lanes(th)).sort((a, b) => a.pre - b.pre)
      .map((th) => ({ th, sub: Math.min(MAX_SUB, this.deep[th.i] + 1), y0: 0, h: 0, u: 0 }));
    this.laneOf = new Int16Array(nT).fill(-1); this.lanes.forEach((l, k) => (this.laneOf[l.th.i] = k));
    if (nT !== this.nThings) {
      const w = Math.max(1, nT);
      this.laneTex?.dispose();
      this.laneData = new Float32Array(w * 4);
      this.laneTex = new THREE.DataTexture(this.laneData, w, 1, THREE.RGBAFormat, THREE.FloatType);
      if (!this.rows) this.rows = this.gpu.view(this.laneTex, w, this.spec.tiers, X0, XW);
      else { const u = this.rows.material.uniforms; u.uLanes.value = this.laneTex; u.uNLanes.value = w; }
      this.nThings = nT;
    }
    this.resize(this.H);
  }

  /** Per thing: the rows of the level's tiers and their deepest depth, over every held row. */
  countAll() {
    const s = this.store, [lo, hi] = this.spec.tiers, nT = s.things.length;
    this.count = new Uint32Array(nT); this.deep = new Uint16Array(nT);
    s.scan({ win: s.extent, minTier: lo, maxTier: hi }, (id) => { const L = s.field("lane", id); this.count[L]++; this.deep[L] = Math.max(this.deep[L], s.field("depth", id)); });
    this.seenN = s.N; this.seenRev = s.rev;
  }

  /** Count the rows the store gained since the last call (a live run); lay out again when a lane appears or deepens or the thing list grows. A seal that
   *  changed tiers or depths (store.rev) counts every row again. */
  grow() {
    if (this.store.rev !== this.seenRev) { this.countAll(); this.layout(); return; }
    const s = this.store, nT = s.things.length, [lo, hi] = this.spec.tiers;
    if (nT > this.count.length) { const c = new Uint32Array(nT), d = new Uint16Array(nT); c.set(this.count); d.set(this.deep); this.count = c; this.deep = d; }
    let relayout = nT !== this.nThings, layers = false;
    for (let id = this.seenN; id < s.N; id++) {
      const r = s.field("tier", id); if (r < lo || r > hi) continue;
      const L = s.field("lane", id), dep = s.field("depth", id);
      if (this.count[L]++ === 0 || (dep > this.deep[L] && this.deep[L] < MAX_SUB - 1)) relayout = true;
      if (dep > this.deep[L]) this.deep[L] = dep;
      if (r === 5 && s.field("layer", id) >= 0) layers = true;
    }
    this.seenN = s.N;
    if (layers && this.bands) this.bands = layerBands(s);
    if (relayout) this.layout();
  }

  resize(H) {
    this.H = H;
    const parents = new Set(this.lanes.map((l) => l.th.parent)).size, top = TITLE_H + 2;
    const subs = this.lanes.reduce((a, l) => a + l.sub, 0), u = Math.min(MAX_SUB_H, (H - top - PAD - parents * GROUP_H) / Math.max(1, subs));
    this.groups = []; this.laneData.fill(0);
    let y = top, prev = null;
    for (const l of this.lanes) {
      if (l.th.parent !== prev) { prev = l.th.parent; this.groups.push({ name: this.store.things[prev]?.name ?? "run", y }); y += GROUP_H; }
      Object.assign(l, { y0: y, u, h: u * l.sub }); y += l.h;
      this.laneData.set([l.y0, u, l.sub - 1, 1], l.th.i * 4);
    }
    this.bottom = y; this.laneTex.needsUpdate = true;
    if (this.stripeMesh) { this.stripeMesh.geometry.dispose(); this.stripeMesh.material.dispose(); }
    this.stripeMesh = this.stripes();
    this.group.clear();
    this.group.add(...frameMeshes(H), this.stripeMesh, this.rows.group, this.cursor, this.lit.mesh);
    if (this.bandMesh) this.group.add(this.bandMesh);
  }

  /** Alternate lane shading and the group header bars, one static mesh per layout. */
  stripes() {
    const pos = [], col = [], quad = (x0, y0, x1, y1, c) => { pos.push(x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y0, 0, x1, y1, 0, x0, y1, 0); for (let k = 0; k < 6; k++) col.push(c.r, c.g, c.b); };
    const odd = new THREE.Color("#20242c"), head = new THREE.Color("#2a303b");
    this.lanes.forEach((l, k) => { if (k % 2) quad(0, l.y0, 1000, l.y0 + l.h, odd); });
    for (const g of this.groups) quad(0, g.y, 1000, g.y + GROUP_H, head);
    const geo = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)).setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, depthTest: false, side: THREE.DoubleSide }));
    m.renderOrder = 1; return m;
  }

  frame(f, view) {
    if (this.store.N !== this.seenN || this.store.rev !== this.seenRev || this.store.things.length !== this.nThings) this.grow();
    this.px = view.px;
    const win = (this.win = windowOf(this, f, this.store)), [a, b] = win, xOf = (t) => X0 + (t - a) / (b - a) * XW;
    setWindow(this.rows.material, win, 1 / view.px, f.sel);
    const cx = xOf(f.cursor.t);
    this.cursor.visible = cx >= X0 && cx <= X0 + XW;
    this.cursor.position.set(cx, (TITLE_H + this.H) / 2, 0); this.cursor.scale.set(2 / view.px, this.H - TITLE_H, 1);
    const unlit = this.drawLit(f, xOf, view.px);
    if (this.bands) this.drawBands(win, view, xOf);
    if (!view.onScreen) return;
    title(this, f, view, win);
    if (unlit) view.label(560, TITLE_H / 2, `lit: ${unlit} rows in view not drawn (at most ${MAX_LIT})`, "note", 420 * view.px);
    const textOk = (h, min = TEXT_PX) => h * view.px >= min;
    for (const g of this.groups) view.label(6, g.y + GROUP_H / 2, g.name, "group", GUTTER * view.px - 10);
    for (const l of this.lanes) if (textOk(l.h, LANE_TEXT_PX)) view.label(6, l.y0 + Math.min(l.h, l.u * 1.5) / 2, l.th.name, "lane", GUTTER * view.px - 10);
    // Sub-rows tall enough for text: every row is named. Shorter (a small stage, many lanes): only the outermost row
    // of each lane is named, in the lane's top text line, so the high-level names stay readable.
    const every = textOk(this.lanes[0]?.u ?? 0), s = this.store, [lo, hi] = this.spec.tiers; let n = 0;
    s.scan({ win, minTier: lo, maxTier: hi }, (id) => {
      const k = this.laneOf[s.field("lane", id)]; if (!(k >= 0)) return;
      const l = this.lanes[k], sub = Math.min(s.field("depth", id), l.sub - 1);
      if (!every && (sub > 0 || !textOk(l.h))) return;
      const x0 = Math.max(X0, xOf(s.startOf[id])), x1 = Math.min(X0 + XW, xOf(s.endOf[id])), w = (x1 - x0) * view.px;
      if (w < ROW_LABEL_PX) return;
      const y = every ? l.y0 + (sub + 0.5) * l.u : l.y0 + TEXT_PX / view.px / 2;
      if (view.label(x0 + 3 / view.px, y, s.nameText(s.field("name", id)), "row", w - 6)) n++;
      return n < ROW_LABELS;
    });
  }

  /**
   * Lit rows (frame.lit) of this level's tiers on its lanes: a box over each bar in view, at least 3 px wide, so a 2 µs
   * kernel in a 10 s window still shows. Returns how many lit rows in view had no box left (more than MAX_LIT).
   */
  drawLit(f, xOf, px) {
    const s = this.store, [lo, hi] = this.spec.tiers, [a, b] = this.win, m = LIT_MIN_PX / px;
    let n = 0, over = 0;
    for (const id of f.lit ?? []) {
      const r = s.field("tier", id), k = this.laneOf[s.field("lane", id)];
      if (r < lo || r > hi || !(k >= 0) || s.endOf[id] < a || s.startOf[id] > b) continue;
      if (n === MAX_LIT) { over++; continue; }
      const l = this.lanes[k], sub = Math.min(s.field("depth", id), l.sub - 1);
      const x0 = Math.min(Math.max(X0, xOf(s.startOf[id])), X0 + XW - m), x1 = Math.max(Math.min(X0 + XW, xOf(s.endOf[id])), x0 + m);
      this.lit.place(n, x0, l.y0 + sub * l.u, x1 - x0, l.u); this.lit.paint(n++, LIT, WHITE);
    }
    for (let k = n; k < this.litN; k++) this.lit.place(k, 0, 0, 0, 0);
    this.litN = n;
    return over;
  }

  /** L5: one shaded band per decoder layer of each iteration, behind the stream lanes, labelled when wide enough. */
  drawBands(win, view, xOf) {
    const { S, E, L, maxDur } = this.bands, [a, b] = win, pos = this.bandMesh.geometry.attributes.position, col = this.bandMesh.geometry.attributes.color;
    const y0 = this.lanes[0]?.y0 ?? TITLE_H, y1 = this.bottom;
    let lo = 0, hi = S.length; while (lo < hi) { const k = (lo + hi) >>> 1; if (S[k] < a - maxDur) lo = k + 1; else hi = k; }
    let n = 0;
    for (let k = lo; k < S.length && S[k] <= b && n < MAX_BANDS; k++) {
      if (E[k] < a) continue;
      const x0 = Math.max(X0, xOf(S[k])), x1 = Math.min(X0 + XW, xOf(E[k]));
      if ((x1 - x0) * view.px < 1) continue;
      pos.array.set([x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y0, 0, x1, y1, 0, x0, y1, 0], n * 18);
      const c = L[k] % 2 ? BAND_ODD : BAND_EVEN;
      for (let v = 0; v < 6; v++) col.array.set([c.r, c.g, c.b], n * 18 + v * 3);
      if (view.onScreen && (x1 - x0) * view.px >= 30) view.label(x0 + 2 / view.px, y0 - 5, `${(x1 - x0) * view.px >= 60 ? "layer " : ""}${L[k]}`, "band", (x1 - x0) * view.px - 4);
      n++;
    }
    if (view.onScreen) view.label(560, TITLE_H / 2, "bands: decoder layer (Inferred at import: 2 RMSNorm kernels per layer)", "note", 420 * view.px);
    this.bandMesh.geometry.setDrawRange(0, n * 6); pos.needsUpdate = true; col.needsUpdate = true;
  }

  pick({ x, y }) {
    if (!this.win || x < X0 || x > X0 + XW) return -1;
    const l = this.lanes.find((q) => y >= q.y0 && y < q.y0 + q.h); if (!l) return -1;
    const s = this.store, sub = Math.min(l.sub - 1, Math.floor((y - l.y0) / l.u)), [a, b] = this.win, [lo, hi] = this.spec.tiers;
    const t = a + (x - X0) / XW * (b - a), tol = PICK_PX / this.px / XW * (b - a);
    let best = -1, bd = Infinity, bdur = Infinity;
    s.scan({ win: [t - tol, t + tol], lane: l.th.i, minTier: lo, maxTier: hi }, (id) => {
      if (Math.min(s.field("depth", id), l.sub - 1) !== sub) return;
      const st = s.startOf[id], en = s.endOf[id], d = t < st ? st - t : t > en ? t - en : 0;
      if (d < bd || (d === bd && en - st < bdur)) { best = id; bd = d; bdur = en - st; }
    });
    return best;
  }

  dispose() { this.group.clear(); this.rows.material.dispose(); this.laneTex.dispose(); this.lit.dispose(); }
}

/**
 * Decoder-layer bands from the hot `layer` column (a device op's decoder layer, Inferred at import by the RMSNorm
 * heuristic of trace/adapters/nsys.py layer_of; -1 where it gives none): per iteration and layer, the span of its ops.
 */
function layerBands(store) {
  const bands = new Map();
  store.scan({ win: store.extent, minTier: 5, maxTier: 5, starts: true }, (id) => {
    const it = store.field("iter", id), layer = store.field("layer", id); if (it < 0 || layer < 0) return;
    const key = `${it}:${layer}`, s = store.startOf[id], e = store.endOf[id], bnd = bands.get(key);
    if (bnd) { bnd[0] = Math.min(bnd[0], s); bnd[1] = Math.max(bnd[1], e); } else bands.set(key, [s, e, layer]);
  });
  const list = [...bands.values()].sort((x, y) => x[0] - y[0]);
  return { S: Float64Array.from(list, (x) => x[0]), E: Float64Array.from(list, (x) => x[1]), L: Int32Array.from(list, (x) => x[2]), maxDur: list.reduce((m, x) => Math.max(m, x[1] - x[0]), 0) };
}

function bandMesh() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_BANDS * 18), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_BANDS * 18), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setDrawRange(0, 0);
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, depthTest: false, side: THREE.DoubleSide }));
  m.renderOrder = 2; m.frustumCulled = false; return m;
}
