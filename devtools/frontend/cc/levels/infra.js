// L1 Infra: the run's containment tree laid out to fill the stage. Columns are the host's containers, network and GPU,
// in the order their first row starts (client, wire, server, GPU for a request); inside a column, one box per process
// with a tile per thread (or per GPU stream). A tile is lit while a row on that lane is active at the cursor, in the
// colour of that row's kind, so the stage reads "where is the work right now". Column headers carry the samples of
// their thing at the cursor (GPU metrics in replay; per-container samples appear when the run has them). The host's
// other hardware sits in a strip at the bottom; L7 draws it in detail. A live run's new things (a container, a thread)
// and new sample clocks rebuild the tree in frame() (the thing list and the metric catalog are the counters).
import { Boxes, palette } from "../scene/boxes.js";
import { roleOf, why, fmtValue } from "../scene/samples.js";
import { frameMeshes, title, windowOf, TITLE_H, LIT } from "./level.js";
import * as THREE from "three";

const PAD = 6, GAP = 6, HEAD = 17, GROUP_HEAD = 14, TILE_GAP = 2, TILE_ASPECT = 3.2, MIN_COL_W = 120, LINE_PX = 12;
const COLUMN_KINDS = new Set(["container", "network", "gpu"]);
const LANE_KINDS = new Set(["thread", "stream"]);
const SKIP_KINDS = new Set(["component map"]);
const GPU_ROLES = ["sm_active", "tensor", "dram_read", "mem_used"];
const C = palette({ column: "#1c2028", columnEdge: "#5e81ac", group: "#20252e", groupEdge: "#3a4252", tile: "#232934", tileEdge: "#303746", sel: "#ffffff", hw: "#20252e", hwEdge: "#3a4252", gpuEdge: "#8fb07a", netEdge: "#c9a95c" });

export function infraLevel(spec) { return new InfraLevel(spec); }

class InfraLevel {
  constructor({ name, key, homeTier, natural }) { Object.assign(this, { name, key, homeTier, natural, index: -1, seq: -1 }); }

  mount({ group, store, H, index }) {
    Object.assign(this, { group, store, index });
    this.kindColor = store.kinds.map((k) => new THREE.Color(k.color ?? "#888888"));
    this.kindEdge = store.kinds.map((k) => new THREE.Color(k.color ?? "#888888").lerp(new THREE.Color("#ffffff"), 0.2));   // close to the kind colour, so the white selection border stands out
    this.tree();
    this.resize(H);
  }

  /** Columns -> groups (a process, or the column itself for lanes directly under it) -> lanes; plus the hardware strip. */
  tree() {
    const s = this.store, T = s.things, kids = T.map(() => []);
    for (const t of T) if (t.parent >= 0) kids[t.parent].push(t);
    const lanesUnder = (t) => (LANE_KINDS.has(t.kind) ? [t] : kids[t.i].flatMap(lanesUnder));
    const host = T.find((t) => t.parent < 0);
    const cols = (host ? kids[host.i] : []).filter((t) => COLUMN_KINDS.has(t.kind)).map((col) => {
      const groups = [], direct = kids[col.i].filter((t) => LANE_KINDS.has(t.kind));
      if (direct.length) groups.push({ th: col, lanes: direct });
      for (const k of kids[col.i]) if (!LANE_KINDS.has(k.kind)) { const lanes = lanesUnder(k); if (lanes.length) groups.push({ th: k, lanes }); }
      return { th: col, groups, lanes: groups.flatMap((g) => g.lanes), first: Infinity };
    }).filter((c) => c.lanes.length || c.th.kind === "gpu");
    // Column order follows the first request through the machine: the column of its earliest row comes first.
    const colOf = new Int16Array(T.length).fill(-1); cols.forEach((c, ci) => c.lanes.forEach((l) => (colOf[l.i] = ci)));
    const r = s.chain(s.extent[0]).request;
    if (r) s.scan({ win: r.win }, (id) => { if (s.field("req", id) !== r.req) return; const ci = colOf[s.field("lane", id)]; if (ci >= 0) cols[ci].first = Math.min(cols[ci].first, s.startOf[id]); });
    this.columns = cols.sort((a, b) => a.first - b.first || a.th.pre - b.th.pre);
    this.hardware = (host ? kids[host.i] : []).filter((t) => !COLUMN_KINDS.has(t.kind) && !SKIP_KINDS.has(t.kind));
    this.host = host;
    this.lanes = this.columns.flatMap((c) => c.lanes);
    this.tileOf = new Int16Array(T.length).fill(-1); this.lanes.forEach((l, k) => (this.tileOf[l.i] = k));
    this.gpuMetrics = Object.fromEntries(this.columns.filter((c) => c.th.kind === "gpu").map((c) => [c.th.i, GPU_ROLES.map((r) => roleOf(s, r, c.th.i)).filter((i) => i >= 0)]));
    this.thingMetrics = (t) => this.gpuMetrics[t.i] ?? s.metrics.map((m, i) => (m.thing === t.i ? i : -1)).filter((i) => i >= 0).slice(0, 3);
    this.nThings = T.length; this.nMetrics = s.metrics.length;
  }

  resize(H) {
    this.H = H;
    const top = TITLE_H + PAD, hwH = this.hardware.length ? Math.max(40, Math.min(80, (H - top) * 0.16)) : 0, colH = H - top - PAD - (hwH ? hwH + GAP : 0);
    const nCol = this.columns.length, weights = this.columns.map((c) => Math.max(1.4, Math.sqrt(c.lanes.length)));
    const free = 1000 - 2 * PAD - GAP * (nCol - 1), wsum = weights.reduce((a, b) => a + b, 0);
    let widths = weights.map((w) => Math.max(MIN_COL_W, free * w / wsum)); const over = widths.reduce((a, b) => a + b, 0) / free; widths = widths.map((w) => w / over);
    for (const b of [this.frames, this.tiles, this.hw]) b?.dispose();
    this.frames = new Boxes(nCol + this.columns.reduce((a, c) => a + c.groups.length, 0), { inset: 1.2, order: 1 });
    this.tiles = new Boxes(this.lanes.length, { inset: 1.4, order: 3 });
    this.hw = new Boxes(this.hardware.length, { inset: 1.2, order: 1 });
    let x = PAD, fk = 0;
    this.colRects = []; this.groupRects = [];
    this.columns.forEach((c, ci) => {
      const w = widths[ci], edge = c.th.kind === "gpu" ? C.gpuEdge : c.th.kind === "network" ? C.netEdge : C.columnEdge;
      this.frames.place(fk, x, top, w, colH); this.frames.paint(fk++, C.column, edge); this.colRects.push([x, top, w, colH]);
      const inner = colH - HEAD - PAD, gw = c.groups.map((g) => g.lanes.length + 1.5), gs = gw.reduce((a, b) => a + b, 0);
      const minH = GROUP_HEAD + 18, hs = gw.map((g) => Math.max(minH, (inner - GAP * (c.groups.length - 1)) * g / gs)), scale = Math.min(1, (inner - GAP * (c.groups.length - 1)) / hs.reduce((a, b) => a + b, 0));
      let y = top + HEAD;
      c.groups.forEach((g, gi) => {
        const gh = hs[gi] * scale, solo = g.th === c.th;
        if (!solo) { this.frames.place(fk, x + PAD / 2, y, w - PAD, gh); this.frames.paint(fk, C.group, C.groupEdge); }
        else this.frames.place(fk, 0, 0, 0, 0);
        fk++; this.groupRects.push({ g, rect: [x + PAD / 2, y, w - PAD, gh], solo });
        const gx = x + PAD / 2 + 3, gy = y + (solo ? 2 : GROUP_HEAD), gW = w - PAD - 6, gH = gh - (solo ? 4 : GROUP_HEAD + 3);
        this.layoutTiles(g.lanes, gx, gy, gW, gH);
        y += gh + GAP;
      });
      x += w + GAP;
    });
    const hy = H - PAD - hwH, hwW = (1000 - 2 * PAD - GAP * Math.max(0, this.hardware.length - 1)) / Math.max(1, this.hardware.length);
    this.hardware.forEach((t, k) => { this.hw.place(k, PAD + k * (hwW + GAP), hy, hwW, hwH); this.hw.paint(k, C.hw, C.hwEdge); });
    this.group.clear();
    this.group.add(...frameMeshes(H), this.frames.mesh, this.hw.mesh, this.tiles.mesh);
    this.seq = -1;
  }

  /** Tiles for n lanes in a w x h area: the grid with the largest tiles at about TILE_ASPECT width to height. */
  layoutTiles(lanes, x, y, w, h) {
    const n = lanes.length; let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols), tw = w / cols, th = h / rows, score = Math.min(tw / TILE_ASPECT, th);
      if (!best || score > best.score) best = { cols, tw, th: Math.min(th, tw / 1.2, 46), score };
    }
    lanes.forEach((l, k) => { const cx = k % best.cols, cy = Math.floor(k / best.cols);
      this.tiles.place(this.tileOf[l.i], x + cx * best.tw + TILE_GAP / 2, y + cy * best.th + TILE_GAP / 2, best.tw - TILE_GAP, best.th - TILE_GAP); });
  }

  update(f) {
    const s = this.store, act = (this.act = s.activeBy("lane", f.cursor.t)), selLane = f.sel >= 0 ? s.field("lane", f.sel) : -1;
    const lightLanes = new Set((f.lit ?? []).map((id) => s.field("lane", id)));   // lanes holding a row frame.lit names
    this.lanes.forEach((l, k) => {
      const id = act[l.i], kind = id >= 0 ? s.field("kind", id) : -1;
      this.tiles.paint(k, kind >= 0 ? this.kindColor[kind] : C.tile, l.i === selLane ? C.sel : lightLanes.has(l.i) ? LIT : kind >= 0 ? this.kindEdge[kind] : C.tileEdge);
    });
    this.values = s.samplesAt(f.cursor.t);
  }

  frame(f, view) {
    this.px = view.px;
    if (!view.onScreen) return;
    if (this.store.things.length !== this.nThings || this.store.metrics.length !== this.nMetrics) { this.tree(); this.resize(this.H); }
    if (f.seq !== this.seq) { this.seq = f.seq; this.update(f); }
    title(this, f, view, windowOf(this, f, this.store));
    view.label(560, TITLE_H / 2, "lit: a row on that thread or stream is active at the cursor (colour: its kind)", "note", 430 * view.px);
    this.labels(view);
  }

  labels(view) {
    const s = this.store, px = view.px, line = LINE_PX / px, act = this.act, on = (lanes) => lanes.reduce((n, l) => n + (act[l.i] >= 0 ? 1 : 0), 0);
    this.columns.forEach((c, ci) => {
      const [x, y, w] = this.colRects[ci], wpx = w * px - 10;
      view.label(x + 4 / px, y + HEAD / 2, `${c.th.name} · ${on(c.lanes)} of ${c.lanes.length} ${c.th.kind === "gpu" ? "streams" : "threads"} active`, "group", wpx);
      const ms = this.thingMetrics(c.th);
      if (ms.length) {
        const fresh = ms.filter((i) => !Number.isNaN(this.values[i]));
        const text = fresh.length ? fresh.map((i) => `${s.metrics[i].label} ${fmtValue(this.values[i], s.metrics[i].unit)}`).join(" · ") : why(s, ms[0]);
        const r = this.colRects[ci]; view.label(x + 4 / px, r[1] + r[3] - line * 0.8, text, "note", wpx);
      }
    });
    for (const { g, rect, solo } of this.groupRects) if (!solo && rect[3] * px >= 14) view.label(rect[0] + 4 / px, rect[1] + GROUP_HEAD / 2, `${g.th.name} · ${on(g.lanes)} of ${g.lanes.length} active`, "lane", rect[2] * px - 8);
    this.lanes.forEach((l, k) => {
      const [x, y, w, h] = this.tiles.rect(k), wpx = w * px - 6;
      if (wpx < 24 || h * px < 11) return;
      const two = h * px >= 2 * LINE_PX + 2, id = act[l.i];
      view.label(x + 3 / px, y + h / 2 - (two ? line / 2 : 0), l.key.split("/").pop(), "tile", wpx);
      if (two && id >= 0) view.label(x + 3 / px, y + h / 2 + line / 2, s.nameText(s.field("name", id)), "row", wpx);
    });
    this.hardware.forEach((t, k) => {
      const [x, y, w, h] = this.hw.rect(k), wpx = w * px - 8;
      view.label(x + 4 / px, y + Math.min(h / 2, line), t.name, "lane", wpx);
      const a = t.attrs ?? {}, more = a.cores ? `${a.cores} cores · ${a.threads} threads` : a.GBps ? `${a.GBps} GB/s` : t.kind;
      if (h * px >= 2 * LINE_PX + 4) view.label(x + 4 / px, y + Math.min(h / 2, line) + line, more, "note", wpx);
    });
  }

  pick({ x, y }) { const k = this.tiles.hit(x, y); return k >= 0 && this.act ? this.act[this.lanes[k].i] : -1; }

  dispose() { this.group.clear(); this.frames.dispose(); this.tiles.dispose(); this.hw.dispose(); }
}
