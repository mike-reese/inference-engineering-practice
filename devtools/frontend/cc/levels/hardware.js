// L7 Hardware: the machine's inventory things laid out along the data path (host CPU and RAM, PCIe, the GPU's copy
// engines, SMs, L2, memory controllers, VRAM), lit from what the run measured at the cursor. Replay reads the Nsight
// Systems GPU metrics (10 kHz); live reads NVML GPM (100 ms): both through the sample roles (scene/samples.js).
// SMs: "SMs active %" x the SM count lights that many SM boxes (a count: which SMs is not recorded). Memory
// controllers: DRAM read + write %. PCIe: RX/TX %. Copy engines: the memcpy rows active at the cursor. A live run's new
// things or sample clocks rebuild the inventory and the roles in frame() (the thing list and the catalog are the counters).
import { Boxes, Links, palette } from "../scene/boxes.js";
import { roleOf, why, evidence, fmtValue, fracOf, implausible } from "../scene/samples.js";
import { frameMeshes, title, windowOf, TITLE_H, LIT } from "./level.js";
import * as THREE from "three";

const ROLE_NAMES = ["sm_active", "tensor", "dram_read", "dram_write", "pcie_rx", "pcie_tx", "sm_clock", "mem_used"];

const LINE_PX = 12;
const C = palette({ part: "#20252e", partEdge: "#3a4252", gpu: "#1a1e25", gpuEdge: "#8fb07a", host: "#1c2028", hostEdge: "#5e81ac",
  sm: "#232934", smEdge: "#303746", smOn: "#2f9e5f", smOnEdge: "#7fdba6", mcOn: "#b84a74", pcieOn: "#4fb3d9", ceOn: "#c2507a", vramUsed: "#3d4f6e",
  link: "#2c323d", sel: "#ffffff", stale: "#1b1e24" });

export function hardwareLevel(spec) { return new HardwareLevel(spec); }

class HardwareLevel {
  constructor({ name, key, homeTier, natural }) { Object.assign(this, { name, key, homeTier, natural, index: -1, seq: -1 }); }

  mount({ group, store, H, index }) {
    Object.assign(this, { group, store, index, H });
    this.memcpy = store.kinds.find((k) => k.name === "memcpy")?.code ?? -1;
    this.kernel = store.kinds.find((k) => k.name === "kernel")?.code ?? -1;
    this.inventory();
  }

  /** The inventory things (GPU parts, host CPU, RAM, PCIe link) and the metric that fills each role on this GPU, then the layout. */
  inventory() {
    const s = this.store, T = s.things, gpu = T.find((t) => t.kind === "gpu"), inGpu = (t) => gpu && t.pre > gpu.pre && t.post <= gpu.post;
    const of = (kind, under = inGpu) => T.filter((t) => t.kind === kind && under(t)).sort((a, b) => a.pre - b.pre);
    const host = (t) => !gpu || !inGpu(t);
    this.inv = { gpu, sms: of("SM"), l2: of("L2 cache")[0], mcs: of("memory controller"), vram: of("VRAM")[0], ces: of("copy engine"),
      cpu: of("cpu", host)[0], ram: of("host memory", host)[0], pcie: T.find((t) => t.kind === "bus link" && gpu && t.attrs?.ends?.includes(gpu.key)) };
    this.m = Object.fromEntries(ROLE_NAMES.map((r) => [r, roleOf(s, r, gpu?.i ?? null)]));
    this.nThings = T.length; this.nMetrics = s.metrics.length;
    this.resize(this.H);
  }

  resize(H) {
    this.H = H;
    const v = this.inv, top = TITLE_H + 8, h = H - top - 8, R = (this.R = {});
    R.cpu = [8, top + 4, 132, h * 0.44]; R.ram = [8, top + h * 0.56, 132, h * 0.44 - 4];
    R.pcie = [152, top + h * 0.3, 62, h * 0.4];
    R.gpu = [226, top, 766, h];
    const it = top + 24, ih = h - 30;
    const ceH = Math.min(70, (ih - 10) / 2); R.ces = v.ces.map((_, k) => [236, it + ih / 2 - ceH - 5 + k * (ceH + 10), 84, ceH]);
    R.smArea = [330, it, 400, ih];
    R.l2 = [740, it, 50, ih];
    const mcH = (ih - 6 * Math.max(0, v.mcs.length - 1)) / Math.max(1, v.mcs.length); R.mcs = v.mcs.map((_, k) => [800, it + k * (mcH + 6), 74, mcH]);
    R.vram = [884, it, 100, ih];
    const n = v.sms.length; let best = { cols: 1, size: 0 };
    for (let cols = 1; cols <= n; cols++) { const rows = Math.ceil(n / cols), size = Math.min(400 / cols, ih / rows); if (size > best.size) best = { cols, size }; }
    R.sms = v.sms.map((_, k) => [330 + (k % best.cols) * best.size + 2, it + Math.floor(k / best.cols) * best.size + 2, best.size - 4, best.size - 4]);
    for (const b of [this.frames, this.parts, this.links]) b?.dispose();
    this.frames = new Boxes(2, { inset: 1.5, order: 1 });
    this.frames.place(0, ...R.gpu); this.frames.paint(0, C.gpu, C.gpuEdge);
    this.frames.place(1, 2, top, 214, h); this.frames.paint(1, C.host, C.hostEdge);
    // parts: cpu, ram, pcie, l2, vram, vram-used level, then copy engines, memory controllers, SMs
    this.slot = { cpu: 0, ram: 1, pcie: 2, l2: 3, vram: 4, used: 5, ce: 6, mc: 6 + R.ces.length, sm: 6 + R.ces.length + R.mcs.length };
    this.parts = new Boxes(this.slot.sm + R.sms.length, { inset: 1.6, order: 3 });
    const P = this.parts, place = (k, r) => r && P.place(k, ...r);
    place(0, R.cpu); place(1, R.ram); place(2, R.pcie); place(3, R.l2); place(4, R.vram); P.place(5, 0, 0, 0, 0);
    R.ces.forEach((r, k) => P.place(this.slot.ce + k, ...r)); R.mcs.forEach((r, k) => P.place(this.slot.mc + k, ...r)); R.sms.forEach((r, k) => P.place(this.slot.sm + k, ...r));
    const mid = (r) => [r[0] + r[2] / 2, r[1] + r[3] / 2];
    this.flows = [["cpu", R.cpu, R.pcie], ["pcie", R.pcie, R.ces[0] ?? R.smArea], ["sm", R.smArea, R.l2], ...R.mcs.map((r) => ["mc", R.l2, r]), ...R.mcs.map((r) => ["mc", r, R.vram])];
    this.links = new Links(this.flows.length, { order: 2 });
    this.flows.forEach(([, a, b], k) => { const [ax, ay] = mid(a), [bx, by] = mid(b); this.links.set(k, a[0] + a[2], b === R.vram || a === R.l2 ? by : ay, b[0], by, 3, 0); this.links.paint(k, C.link); });
    this.group.clear();
    this.group.add(...frameMeshes(H), this.frames.mesh, this.links.mesh, this.parts.mesh);
    this.seq = -1;
  }

  update(f) {
    const s = this.store, t = f.cursor.t, v = (this.vals = s.samplesAt(t)), m = this.m, P = this.parts, S = this.slot;
    const val = (r) => (m[r] >= 0 ? v[m[r]] : NaN), unit = (r) => s.metrics[m[r]]?.unit;
    // a selected (or lit) kernel outlines the busy SMs only while it runs at the cursor (the samples are device-wide)
    const runs = (id) => s.field("kind", id) === this.kernel && s.startOf[id] <= t && t <= s.endOf[id];
    const selRuns = f.sel >= 0 && runs(f.sel), litRuns = (f.lit ?? []).some(runs);
    for (const k of ["cpu", "ram", "pcie", "l2", "vram"]) P.paint(S[k], C.part, C.partEdge);
    const sm = fracOf(val("sm_active"), unit("sm_active")), nOn = Number.isNaN(sm) ? -1 : Math.round(sm * this.inv.sms.length);
    this.smOn = nOn;
    this.inv.sms.forEach((_, k) => P.paint(S.sm + k, nOn < 0 ? C.stale : k < nOn ? C.smOn : C.sm, selRuns && k < nOn ? C.sel : litRuns && k < nOn ? LIT : k < nOn ? C.smOnEdge : C.smEdge));
    const dram = (Number.isNaN(val("dram_read")) ? 0 : val("dram_read")) + (Number.isNaN(val("dram_write")) ? 0 : val("dram_write")), dramOk = !Number.isNaN(val("dram_read"));
    this.inv.mcs.forEach((_, k) => P.paint(S.mc + k, dramOk ? mix(C.part, C.mcOn, Math.min(1, dram / 100)) : C.stale, C.partEdge));
    const pcie = Math.max(fracOf(val("pcie_rx"), unit("pcie_rx")) || 0, fracOf(val("pcie_tx"), unit("pcie_tx")) || 0);
    P.paint(S.pcie, mix(C.part, C.pcieOn, pcie), C.partEdge);
    this.flows.forEach(([kind], k) => this.links.paint(k, kind === "sm" && nOn > 0 ? C.smOn : kind === "mc" && dram > 0.5 ? mix(C.link, C.mcOn, Math.min(1, dram / 50)) : kind === "pcie" && pcie > 0 ? C.pcieOn : C.link));
    const used = val("mem_used"), total = (this.inv.gpu?.attrs?.vram_bytes ?? NaN) / 2 ** 20, r = this.R.vram;
    if (!Number.isNaN(used) && total > 0) { const fh = r[3] * Math.min(1, used / total); P.place(S.used, r[0] + 3, r[1] + r[3] - fh, r[2] - 6, fh - 3); P.paint(S.used, C.vramUsed); }
    else P.place(S.used, 0, 0, 0, 0);
    this.copies = [];
    if (this.memcpy >= 0) s.scan({ win: [t, t], minTier: 5, maxTier: 5 }, (id) => { if (s.field("kind", id) === this.memcpy) this.copies.push(id); });
    this.inv.ces.forEach((_, k) => P.paint(S.ce + k, k < this.copies.length ? C.ceOn : C.part, f.sel >= 0 && this.copies[k] === f.sel ? C.sel : f.lit?.includes(this.copies[k]) ? LIT : C.partEdge));
    this.dev = f.chain.device;
  }

  frame(f, view) {
    this.px = view.px;
    if (!view.onScreen) return;
    if (this.store.things.length !== this.nThings || this.store.metrics.length !== this.nMetrics) this.inventory();
    if (f.seq !== this.seq) { this.seq = f.seq; this.update(f); }
    title(this, f, view, windowOf(this, f, this.store));
    this.labels(view);
  }

  labels(view) {
    const s = this.store, px = view.px, line = LINE_PX / px, v = this.vals, m = this.m, R = this.R, inv = this.inv;
    const txt = (r) => (m[r] >= 0 && !Number.isNaN(v[m[r]]) ? (implausible(v[m[r]], s.metrics[m[r]].unit) ? "invalid in the source" : fmtValue(v[m[r]], s.metrics[m[r]].unit)) : null);
    const ev = (r) => (m[r] >= 0 ? evidence(s, m[r]) : "not measured in this run");
    const at = (r, dy, text, cls = "note") => view.label(r[0] + 4 / px, r[1] + dy, text, cls, r[2] * px - 8);
    view.label(560, TITLE_H / 2, `lit from samples at the cursor: ${ev("sm_active")}`, "note", 430 * px);
    at(R.gpu, 10, `${inv.gpu?.name ?? "GPU"}${txt("sm_clock") ? ` · ${s.metrics[m.sm_clock].label} ${txt("sm_clock")}` : ""}`, "group");
    const sm = txt("sm_active"), area = R.smArea, below = area[1] + area[3] + 1;
    view.label(area[0], area[1] - 6, sm ? `SMs active ${sm} × ${inv.sms.length} SMs → ${this.smOn} lit (a count; which SMs is not recorded)` : `SMs: ${m.sm_active >= 0 ? why(s, m.sm_active) : "no SM metric in this run"}`, "note", 400 * px);
    if (txt("tensor")) view.label(area[0], Math.min(this.H - 6, below + 2), `tensor cores active ${txt("tensor")}`, "note", 400 * px);
    if (R.sms[0] && R.sms[0][2] * px >= 30) inv.sms.forEach((t, k) => at(R.sms[k], R.sms[k][3] / 2, `SM ${k}`, "tile"));
    at(R.l2, 10, "L2", "box"); if (R.l2[3] * px > 60) at(R.l2, 10 + line, (inv.l2?.name ?? "").replace(/^L2 cache /, ""));
    if (R.l2[3] * px > 90) at(R.l2, 10 + 2.2 * line, "no sampled L2 counter");
    const dr = txt("dram_read"), dw = txt("dram_write");
    inv.mcs.forEach((t, k) => { at(R.mcs[k], R.mcs[k][3] / 2 - (k === 0 ? line / 2 : 0), `MC ${k}`, "tile"); });
    if (R.mcs[0]) at(R.mcs[0], R.mcs[0][3] / 2 + line / 2, dr ? `DRAM r ${dr} w ${dw ?? "–"}` : "no DRAM sample");
    at(R.vram, 10, inv.vram?.name ?? "VRAM", "box");
    if (txt("mem_used")) at(R.vram, 10 + line, `${txt("mem_used")} used`);
    at(R.vram, R.vram[3] - line, ev("mem_used"));
    R.ces.forEach((r, k) => {
      at(r, r[3] / 2 - line / 2, inv.ces[k]?.name ?? `copy engine ${k}`, "tile");
      const id = this.copies[k]; if (id != null) at(r, r[3] / 2 + line / 2, `${s.nameText(s.field("name", id))}`);
    });
    if (R.ces.length) view.label(R.ces[0][0], R.ces[0][1] - line, this.copies.length ? `${this.copies.length} copy active (engine order Inferred)` : "copies: memcpy rows at the cursor", "note", 100 * px);
    at(R.pcie, 10, "PCIe", "box"); at(R.pcie, 10 + line, txt("pcie_rx") ? `RX ${txt("pcie_rx")}` : "no PCIe sample"); if (txt("pcie_tx")) at(R.pcie, 10 + 2 * line, `TX ${txt("pcie_tx")}`);
    if (inv.pcie) view.label(R.pcie[0], R.pcie[1] + R.pcie[3] + line, inv.pcie.name, "note", 200 * px);
    at(R.cpu, 10, "CPU", "box"); at(R.cpu, 10 + line, inv.cpu?.name ?? ""); if (inv.cpu?.attrs?.cores) at(R.cpu, 10 + 2 * line, `${inv.cpu.attrs.cores} cores · ${inv.cpu.attrs.threads} threads`);
    at(R.cpu, 10 + 3 * line, "no CPU samples in this run");
    at(R.ram, 10, inv.ram?.name ?? "host RAM", "box");
  }

  pick({ x, y }) {
    const k = this.parts.hit(x, y), S = this.slot; if (k < 0) return -1;
    if (k >= S.ce && k < S.mc) return this.copies[k - S.ce] ?? -1;
    const d = this.dev, s = this.store;
    if (k >= S.sm && d && s.field("kind", d.id) === this.kernel && this.smOn > 0) return d.id;
    return -1;
  }

  dispose() { this.group.clear(); this.frames.dispose(); this.parts.dispose(); this.links.dispose(); }
}

const tmp = new THREE.Color();
/** a lerped toward b by u (0..1); a fresh colour per call site is not needed: Boxes copies the components. */
function mix(a, b, u) { return tmp.copy(a).lerp(b, Math.max(0, Math.min(1, u))); }
