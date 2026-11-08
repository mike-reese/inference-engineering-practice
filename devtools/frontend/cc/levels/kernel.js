// L6 Kernel: the device op at the cursor, read as cause and effect. Top: the op and its four neighbours on their GPU
// streams, with the CUDA call that launched each (the `cause` column) on its CPU thread and an arrow from call start
// to op start. Bottom left: what the op is (launch shape from its cold args). Bottom right: the Nsight Compute
// headline counters with their units, and "open in Nsight Compute" for the kernel; sections, rules and source stay in
// ncu-ui (design: Role). An op without counters says why ("not profiled").
import { Boxes, Links, palette } from "../scene/boxes.js";
import { fmtBytes, fmtValue } from "../scene/samples.js";
import { fmtSpan } from "../control/bar.js";
import { frameMeshes, LIT, title, windowOf, TITLE_H } from "./level.js";
import { openInNsight } from "../inspector/nsight.js";
import * as THREE from "three";

const GUTTER = 150, X0 = GUTTER, XW = 1000 - GUTTER - 10, LANE_H = 24, LANE_GAP = 4, NEIGHBOURS = 4, LINE_PX = 13, STATUS_MS = 8000;
const MAX_LANES = 8, MAX_OPS = 2 * NEIGHBOURS + 1;
/** The headline counters in reading order (registry/ncu.json measures); "%" rows are gauges, byte rows share one scale. */
const COUNTERS = ["duration (replay)", "achieved occupancy", "SM throughput", "memory throughput", "DRAM throughput", "DRAM read", "DRAM write", "L2 traffic", "L1 traffic"];
const C = palette({ lane: "#1d2129", laneEdge: "#262b35", op: "#2a3a5c", opEdge: "#3d5385", cur: "#2457c5", curEdge: "#ffd36b", call: "#244a39", callEdge: "#3a9c6a",
  sel: "#ffffff", arrow: "#8a93a3", arrowCur: "#ffd36b", track: "#232934", trackEdge: "#303746", gauge: "#4fb3d9", bytes: "#b48ead", dur: "#8fb07a" });

export function kernelLevel(spec) { return new KernelLevel(spec); }

class KernelLevel {
  constructor({ name, key, homeTier, natural }) { Object.assign(this, { name, key, homeTier, natural, index: -1, seq: -1, status: null }); }

  mount({ group, store, H, index, redraw }) {
    Object.assign(this, { group, store, index, redraw });
    this.kindColor = store.kinds.map((k) => new THREE.Color(k.color ?? "#888888").multiplyScalar(0.7));
    this.bars = new Boxes(MAX_LANES + 2 * MAX_OPS, { inset: 1.4, order: 3 });
    this.arrows = new Links(MAX_OPS, { order: 4 });
    this.gauges = new Boxes(2 * COUNTERS.length, { inset: 1, order: 3 });
    this.resize(H);
  }

  resize(H) {
    this.H = H; this.group.clear();
    this.group.add(...frameMeshes(H), this.bars.mesh, this.arrows.mesh, this.gauges.mesh);
    this.seq = -1;
  }

  /** The device op at the cursor and its neighbours in (start, id) order: the device rows at ordinals around it. */
  ops(f) {
    const s = this.store, d = f.chain.device; if (!d) return null;
    const ids = [];
    for (let k = d.ordinal - NEIGHBOURS; k <= d.ordinal + NEIGHBOURS; k++) { const id = s.idAt(5, k); if (id >= 0) ids.push(id); }
    return { cur: d.id, ids };
  }

  update(f) {
    const s = this.store, o = (this.o = this.ops(f));
    for (let k = 0; k < MAX_LANES + 2 * MAX_OPS; k++) this.bars.place(k, 0, 0, 0, 0);
    for (let k = 0; k < MAX_OPS; k++) this.arrows.set(k, 0, 0, 0, 0);
    for (let k = 0; k < 2 * COUNTERS.length; k++) this.gauges.place(k, 0, 0, 0, 0);
    if (!o) return;
    const win = (this.win = windowOf(this, f, s)), xOf = (t) => X0 + (t - win[0]) / (win[1] - win[0]) * XW, minW = 2 / Math.max(0.2, this.px ?? 1);
    const causes = o.ids.map((id) => s.field("cause", id)), lanes = [];
    for (const c of causes) if (c >= 0 && !lanes.includes(s.field("lane", c))) lanes.push(s.field("lane", c));
    const cpuLanes = lanes.length;
    for (const id of o.ids) if (!lanes.includes(s.field("lane", id))) lanes.push(s.field("lane", id));
    this.lanes = lanes.slice(0, MAX_LANES).map((lane, k) => ({ lane, cpu: k < cpuLanes, y: TITLE_H + 8 + k * (LANE_H + LANE_GAP) }));
    this.lanes.forEach((l, k) => { this.bars.place(k, 4, l.y, 992, LANE_H); this.bars.paint(k, C.lane, C.laneEdge); });
    const yOf = (lane) => this.lanes.find((l) => l.lane === lane)?.y;
    this.hits = [];
    // clip: a launch call that starts or ends outside the window still shows, pinned to the window's edge
    const lit = new Set(f.lit ?? []);
    const bar = (slot, id, fill, edge, clip = false) => {
      const y = yOf(s.field("lane", id)); if (y == null) return null;
      let x0 = Math.max(X0, xOf(s.startOf[id])), x1 = Math.min(X0 + XW, Math.max(xOf(s.endOf[id]), xOf(s.startOf[id]) + minW));
      if (clip) { x1 = Math.max(x1, X0 + minW); x0 = Math.min(x0, X0 + XW - minW); }
      if (x1 <= X0 || x0 >= X0 + XW) return null;
      this.bars.place(slot, x0, y + 3, Math.max(minW, x1 - x0), LANE_H - 6); this.bars.paint(slot, fill, f.sel === id ? C.sel : lit.has(id) ? LIT : edge);
      this.hits.push({ slot, id }); return [x0, y + LANE_H / 2];
    };
    o.ids.forEach((id, k) => {
      const cur = id === o.cur, kind = s.field("kind", id);
      const p = bar(MAX_LANES + k, id, cur ? C.cur : this.kindColor[kind], cur ? C.curEdge : C.opEdge);
      const q = causes[k] >= 0 ? bar(MAX_LANES + MAX_OPS + k, causes[k], C.call, cur ? C.curEdge : C.callEdge, true) : null;
      if (p && q) { this.arrows.set(k, q[0], q[1] + LANE_H / 2 - 3, p[0], p[1] - LANE_H / 2 + 3, cur ? 2 : 1, cur ? 8 : 5); this.arrows.paint(k, cur ? C.arrowCur : C.arrow); }
    });
    this.bottom = (this.lanes.at(-1)?.y ?? TITLE_H) + LANE_H + 14;
    const need = [...o.ids, ...causes.filter((c) => c >= 0)].filter((id) => s.detailCached(id) === undefined);
    if (need.length) s.detail(need).then(() => { this.seq = -1; this.redraw(); }).catch((e) => console.error("kernel: detail", e));
    this.counterRows();
  }

  /** Gauges for the current op's counters: % rows on a 0-100 track, byte rows on the scale of the largest byte row. */
  counterRows() {
    const d = this.store.detailCached(this.o.cur), vals = d?.counters?.values ?? [];
    const by = new Map(vals.map((v) => [v.measure, v])), rows = COUNTERS.map((m) => by.get(m)).filter(Boolean);
    const maxBytes = Math.max(1, ...rows.filter((r) => r.unit === "byte").map((r) => r.value));
    const x0 = 680, w = 200, y0 = this.bottom + 3 * LINE_PX / (this.px ?? 1) + 4, rh = Math.max(8, Math.min(26, (this.H - y0 - 6) / Math.max(1, rows.length)));
    this.counterLayout = { rows, x0, w, y0, rh };
    rows.forEach((r, k) => {
      const frac = r.unit === "%" ? r.value / 100 : r.unit === "byte" ? r.value / maxBytes : r.unit === "ns" ? Math.min(1, r.value / Math.max(1, this.durOf(this.o.cur) * 4)) : 0;
      const y = y0 + k * rh + 3, h = rh - 8, fill = r.unit === "%" ? C.gauge : r.unit === "byte" ? C.bytes : C.dur;
      this.gauges.place(2 * k, x0, y, w, h); this.gauges.paint(2 * k, C.track, C.trackEdge);
      this.gauges.place(2 * k + 1, x0, y, Math.max(0.5, w * Math.max(0, Math.min(1, frac))), h); this.gauges.paint(2 * k + 1, fill);
    });
  }

  durOf(id) { return this.store.endOf[id] - this.store.startOf[id]; }

  frame(f, view) {
    this.px = view.px;
    if (!view.onScreen) return;
    if (f.seq !== this.seq) { this.seq = f.seq; this.update(f); }
    title(this, f, view, windowOf(this, f, this.store));
    if (!this.o) { view.label(20, this.H / 2, "No device op in this run: kernels, copies and memsets come from an Nsight Systems capture (TRACE=timeline).", "stub", 900 * view.px); return; }
    this.labels(f, view);
  }

  labels(f, view) {
    const s = this.store, px = view.px, line = LINE_PX / px, id = this.o.cur, d = s.detailCached(id), cause = s.field("cause", id);
    view.label(560, TITLE_H / 2, "arrow: CUDA call start → device op start (cause, Observed: CUPTI correlation id)", "note", 430 * px);
    for (const l of this.lanes) view.label(8, l.y + LANE_H / 2, `${l.cpu ? "CPU " : "GPU "}${s.things[l.lane]?.key ?? ""}`, "lane", GUTTER * px - 12);
    for (const { slot, id: r } of this.hits) {
      const [x, y, w, h] = this.bars.rect(slot);
      if (w * px >= 50) view.label(x + 3 / px, y + h / 2, s.nameText(s.field("name", r)), "row", w * px - 6);
    }
    const a = d?.args ?? {}, kind = s.kinds[s.field("kind", id)]?.name ?? "", lane = s.things[s.field("lane", id)]?.key ?? "";
    const x = 14, w = (500 - x - 16) * px; let y = this.bottom;   // the card ends where the counters start (x 500)
    const put = (text, cls = "note") => { view.label(x, y, text, cls, w); y += line; };
    put(`${kind}: ${s.nameText(s.field("name", id))}`, "big"); y += line * 0.3;
    if (a.demangled) put(a.demangled);
    const layer = s.field("layer", id);
    put(`${lane} · iteration ${s.field("iter", id) >= 0 ? s.field("iter", id) : "–"}${layer >= 0 ? ` · decoder layer ${layer} (Inferred at import: 2 RMSNorm kernels per layer)` : ""}`);
    put(`Nsight Systems (run clock): start ${(s.startOf[id] / 1e6).toFixed(6)} ms · duration ${fmtSpan(this.durOf(id))}`);
    if (cause >= 0) put(`launched by ${s.nameText(s.field("name", cause))} on ${s.things[s.field("lane", cause)]?.key ?? "?"} · ${fmtSpan(s.startOf[id] - s.startOf[cause])} from call start to op start`);
    if (a.grid) put(`grid ${a.grid.join("×")} · block ${a.block?.join("×") ?? "?"} · ${a.registers ?? "?"} registers/thread · ${fmtBytes(a.shared_memory)} shared memory${a.graph_node != null ? ` · CUDA graph node ${a.graph_node}` : ""}`);
    else if (s.field("bytes", id) >= 0) put(`${fmtBytes(s.field("bytes", id))} moved`);
    if (d === undefined) put("loading the op's detail…");
    else if (d === null) put("the server holds no detail for this op");
    this.counterLabels(view, d);
  }

  counterLabels(view, d) {
    const px = view.px, line = LINE_PX / px, x = 500;
    let y = this.bottom;
    if (!d) return;
    if (!d.counters) {
      const n = this.store.tools.ncu?.kernels;
      view.label(x, y, "Nsight Compute: not profiled", "big", 480 * px); y += line * 1.3;
      view.label(x, y, n ? `ncu profiled iteration ${n.iteration} only (${n.tied} of its kernels tied to this run by launch order and name)` : "this run has no Nsight Compute profile (TRACE=kernels makes one)", "note", 480 * px);
      return;
    }
    // the button sits on the header line, so a short stage (big inspector) never pushes it out of the frame; its answer goes on the line below the note
    const bx = 1000 - 8 - 190 / px, by = this.bottom, room = (bx - x - 8) * px;
    view.label(x, y, `Nsight Compute: ${d.counters.kernel_name} · profile row ${d.counters.profile_row}`, "big", room); y += line;
    view.label(x, y, "replayed alone, caches flushed, base clocks; tied to this run by launch order (Inferred)", "note", room); y += line;
    if (this.status) view.label(x, y, this.status, "note", 480 * px);
    const { rows, x0, y0, rh } = this.counterLayout;
    rows.forEach((r, k) => {
      const yy = y0 + k * rh + rh / 2 - 1;
      view.label(x, yy, r.measure, "lane", (x0 - x - 6) * px);
      view.label(x0 + 206, yy, r.unit === "byte" ? fmtBytes(r.value) : r.unit === "ns" ? `${fmtSpan(r.value)} (nsys: ${fmtSpan(this.durOf(this.o.cur))})` : fmtValue(r.value, r.unit), "row", 110 * px);
    });
    if (d.open?.ncu) view.button(bx, by, "open in Nsight Compute ↗", () => this.open(d.open.ncu), "Open this kernel in Nsight Compute");
  }

  open(target) {
    this.status = "asking the runner…"; this.redraw();
    openInNsight(target).then(({ message }) => {
      this.status = message; this.redraw();
      setTimeout(() => { if (this.status === message) { this.status = null; this.redraw(); } }, STATUS_MS);
    });
  }

  pick({ x, y }) {
    const k = this.bars.hit(x, y), hit = this.hits?.find((h) => h.slot === k);
    if (hit) return hit.id;
    return this.o && y > (this.bottom ?? Infinity) - LINE_PX ? this.o.cur : -1;
  }

  dispose() { this.group.clear(); this.bars.dispose(); this.arrows.dispose(); this.gauges.dispose(); }
}
