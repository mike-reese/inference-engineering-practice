// The spine's hardware lens (D13 worlds/spine.js hardwareSvg) on real data, in D13's 44 x 23 box (y down) with its
// positions and styles. What it shows comes from the shown run: the inventory (manifest things), the samples at the
// cursor (RunStore.samplesAt), the copy and kernel rows, and a kernel's grid, launch call and Nsight Compute counters
// (RunStore.detail). A part the run does not record says so; nothing is filled in.
import { state, stops, select, setTier, DIM_COLOR } from "../../control/control.js";
import { roleOf, fmtValue, fmtBytes, fmtSpan, sourceOf } from "../../sidebar/samples.js";
import { CLASS_COL, sampleWindow, unitLabel } from "./bands.js";

const HWC = DIM_COLOR.hardware;
const GREY = "#8a96a8", VRAMC = "#7aa2ff", CACHE = "#4fd1e8", COPYC = "#58d68d", NETC = "#b48ef0", PANEL = "#2a3446";
const BIG = 1.1, SUB = 0.72;   // CSS font sizes of text.big (bold) and text.sub, in box units, for fitting text
const ms = (ns) => `${(ns / 1e6).toFixed(3)} ms`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const upperT = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const k = (lo + hi) >>> 1; if (a[k] <= x) lo = k + 1; else hi = k; } return lo; };
const lowerT = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const k = (lo + hi) >>> 1; if (a[k] < x) lo = k + 1; else hi = k; } return lo; };
const keyNum = (t) => +(t.key.match(/(\d+)$/)?.[1] ?? 0);
/** s cut with "…" to about `w` box units at a font size (an average glyph is about 0.55 of the size wide). */
const fit = (s, w, size) => { const n = Math.floor(w / (size * 0.55)); return s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s; };
/** The words of s in lines of at most `chars` characters, at most `max` lines; the last kept line ends "…" when cut. */
function wrap(s, chars, max) {
  if (max <= 0) return [];
  const out = []; let line = "";
  for (const w of s.split(/\s+/)) {
    const next = line ? `${line} ${w}` : w;
    if (next.length <= chars) line = next; else { if (line) out.push(line); line = w.length > chars ? `${w.slice(0, chars - 1)}…` : w; }
  }
  if (line) out.push(line);
  if (out.length <= max) return out;
  const keep = out.slice(0, max), l = keep[max - 1]; keep[max - 1] = l.length < chars ? `${l}…` : `${l.slice(0, chars - 1)}…`;
  return keep;
}
/** A copy's direction from its kind and name: nsys says "host to device", the torch trace "Memcpy HtoD (...)". */
const DIRS = [[/\bHtoD\b|host to device/i, "host", "device"], [/\bDtoH\b|device to host/i, "device", "host"],
  [/\bDtoD\b|device to device/i, "device", "device"], [/memset/i, null, "device"]];
function copyDir(S, id) {
  const s = `${S.kinds[S.field("kind", id)].name} ${S.nameText(S.field("name", id))}`;
  for (const [rx, from, to] of DIRS) if (rx.test(s)) return { from, to };
  return { from: null, to: null };
}

/** The run's hardware things and the catalog indexes the lens reads (-1: not in this run), per store and catalog size. */
const INV = new WeakMap();
function inventory(S) {
  let v = INV.get(S);
  if (v && v.n === S.metrics.length) return v;
  const T = S.things, one = (kind) => T.find((t) => t.kind === kind) ?? null, gpu = one("gpu");
  const kids = (kind) => (gpu ? T.filter((t) => t.kind === kind && t.parent === gpu.i).sort((a, b) => keyNum(a) - keyNum(b)) : []);
  const metric = (name) => S.metrics.findIndex((m) => m.metric === name), cpus = [];
  for (let i = 0, m; (m = metric(`host.cpu.busy.cpu${i}`)) >= 0; i++) cpus.push(m);
  const links = T.filter((t) => t.kind === "bus link");
  v = { n: S.metrics.length, hosts: T.filter((t) => t.kind === "host").length, gpus: T.filter((t) => t.kind === "gpu").length,
    host: one("host"), board: one("board"), cpu: one("cpu"), ram: one("host memory"), chipset: one("chipset"), nvme: one("nvme"),
    network: one("network"), gpu, vram: one("VRAM"), l2: one("L2 cache"), sms: kids("SM"), mcs: kids("memory controller"), ces: kids("copy engine"),
    /** The name (before " (") of the bus link between two things, or "". */
    link: (a, b) => { const l = a && b && links.find((x) => x.attrs?.ends?.includes(a.key) && x.attrs.ends.includes(b.key)); return l ? l.name.split(" (")[0] : ""; },
    m: { gpu: roleOf(S, "gpu_util"), sm: roleOf(S, "sm_active"), dr: roleOf(S, "dram_read"), dw: roleOf(S, "dram_write"),
      rx: roleOf(S, "pcie_rx"), tx: roleOf(S, "pcie_tx"), mem: roleOf(S, "mem_used"), cpu: metric("host.cpu.busy"),
      nvme: metric("nvme.busy"), ce0: metric("Async Copy Engine Active 0 [Throughput %]"), cpus } };
  INV.set(S, v);
  return v;
}

/** One drawing: D13's text, box and link helpers, writing SVG markup for the selection `sel`. */
function drawing(sel) {
  const out = [];
  const anchor = (c) => (c === 0 ? "start" : c === 1 ? "end" : "middle");
  const text = (x, y, s, cls = "", c = 0, fill) =>
    out.push(`<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor(c)}"${fill ? ` style="fill:${fill}"` : ""}>${esc(s)}</text>`);
  /** A box with a label over name lines; pick [thing key, hardware tier] makes it a click target; title is its tooltip. */
  function box(x, y, w, h, c, { lit = false, label, cls = "", op, pick, title, lines = [] } = {}) {
    const p = pick ? ` class="pk${pick[0] === sel ? " sel" : ""}" data-hw="${esc(pick[0])}" data-tier="${pick[1]}"` : "";
    out.push(`<g${p}><title>${esc(title ?? label ?? "")}</title><rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx=".25" fill="${c}"
      fill-opacity="${op ?? (lit ? 0.95 : 0.3)}"${lit ? ' stroke="#fff" stroke-width=".1"' : ""}/>`);
    const RH = cls === "big" ? 1.3 : 0.95, LH = 0.8, total = (label != null ? RH : 0) + lines.length * LH;
    let yy = y - total / 2;
    if (label != null) { out.push(`<text x="${x}" y="${yy + RH / 2}" class="${cls}${lit ? " dark" : ""}" text-anchor="middle">${esc(label)}</text>`); yy += RH; }
    for (const l of lines) { out.push(`<text x="${x}" y="${yy + LH / 2}" class="tiny${lit ? " dark" : ""}" text-anchor="middle">${esc(l)}</text>`); yy += LH; }
    out.push("</g>");
  }
  function link([x1, y1], [x2, y2], lit, c = "#9fb0c6", th = 0.35) {
    out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${lit ? c : "#3a475c"}" stroke-width="${lit ? th * 1.8 : th}" stroke-opacity="${lit ? 0.95 : 0.6}"/>`);
    if (lit) out.push(`<line class="flow" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#fff" stroke-width="${Math.min(1.3, th * 3)}"/>`);
  }
  return { out, text, box, link };
}

/**
 * The hardware pane of the spine's lens: draws the hardware tier of `state` into its svg, again only when what it
 * shows changed (draw(..., true) redraws anyway). A click on a part selects its thing and moves the hardware tier, as
 * in D13. onDetail runs when a kernel's cold fields arrive, so the owner can redraw.
 */
export class HardwareLens {
  constructor(svg, title, onDetail) {
    this.svg = svg; this.title = title; this.onDetail = onDetail; this.key = ""; this.pending = new Set();
    svg.addEventListener("click", (e) => {
      const g = e.target.closest("[data-hw]"); if (!g) return;
      select(g.dataset.hw); setTier("hardware", Number(g.dataset.tier));
    });
  }

  /** @param {import("../../store/run.js").RunStore | null} S @param {object} n control.now() @param {boolean} force */
  draw(S, n, force) {
    const tier = state.tiers.hardware, H = S?.dims.ladders.hardware;
    const [kid] = S ? this.kernelAt(S, n) : [-1];
    const devSt = S ? stops("hardware", H.indexOf("device")) : null, next = devSt ? upperT(devSt.t, state.t) : 0;
    const key = !S ? `none|${tier}` : [S.run, S.rev, tier, state.sel, kid, S.detailCached(kid) !== undefined, n.transfers.map((x) => x.id).join(),
      devSt.ids[next], tier < 5 ? n.sampleIndex : "", tier <= 2 ? [...n.hwActive].sort((a, b) => a - b).join() : ""].join("|");
    if (!force && key === this.key) return;
    this.key = key;
    this.title.textContent = H ? `hardware · ${tier + 1} ${H[tier]}` : "hardware";
    this.svg.innerHTML = S ? this.markup(S, n, tier, kid, devSt, next) : `<text x="0" y="0" class="big" text-anchor="middle">no run is open</text>`;
  }

  /** The kernel at the cursor, else the next one: [row id, "at the cursor" | "next kernel, starts …"], or [-1, ""]. */
  kernelAt(S, n) {
    const H = S.dims.ladders.hardware, unit = H.indexOf("unit"), kinds = S.dims.d.stops.hardware[H[unit]]?.kinds ?? [];
    if (n.kernel && kinds.includes(S.kinds[S.field("kind", n.kernel.id)].name)) return [n.kernel.id, "at the cursor"];
    const st = stops("hardware", unit), k = lowerT(st.t, state.t);
    return k < st.ids.length ? [st.ids[k], `next kernel, starts ${ms(st.t[k])}`] : [-1, ""];
  }

  /** A kernel's cold fields (grid, launch call, counters) if fetched (null: none); else undefined, fetched once. */
  detailOf(S, id) {
    if (id < 0) return null;
    const d = S.detailCached(id);
    if (d !== undefined) return d;
    if (!this.pending.has(id)) {
      this.pending.add(id);
      S.detail([id]).then(() => { this.pending.delete(id); this.key = ""; this.onDetail?.(); }, (e) => { this.pending.delete(id); console.error(e); });
    }
    return undefined;
  }

  markup(S, n, tier, kid, devSt, next) {
    const inv = inventory(S), M = inv.m, sel = state.sel, nSM = inv.gpu?.attrs?.sms ?? inv.sms.length;
    const { out, text, box, link } = drawing(sel);
    const val = (i) => (i >= 0 ? n.sample[i] : NaN);
    const about = (i) => `${S.metrics[i].label ?? S.metrics[i].metric}: ${sourceOf(S.metrics[i])}, every ${fmtSpan(S.samplePeriod(i))}`;
    const dram = M.dr < 0 && M.dw < 0 ? NaN : (M.dr >= 0 ? val(M.dr) : 0) + (M.dw >= 0 ? val(M.dw) : 0);
    const tr = n.transfers.map((x) => ({ ...x, ...copyDir(S, x.id) }));
    const lit = {
      cpu: !!inv.cpu && n.hwActive.has(inv.cpu.i), gpu: !!inv.gpu && n.hwActive.has(inv.gpu.i), network: !!inv.network && n.hwActive.has(inv.network.i),
      htod: tr.some((x) => x.from === "host" && x.to === "device"), dtoh: tr.some((x) => x.from === "device" && x.to === "host"),
      ram: tr.some((x) => x.from === "host" || x.to === "host"), vram: tr.some((x) => x.from === "device" || x.to === "device") || dram > 0,
      nvme: val(M.nvme) > 0,
    };
    lit.chipset = lit.nvme;
    const why = {
      cpu: "lit: a row of a CPU thread runs at the cursor", gpu: "lit: a row of a GPU stream runs at the cursor",
      network: "lit: a network frame is on the wire at the cursor", ram: "lit: a copy from or to host memory is in flight",
      vram: `lit: a copy from or to device memory is in flight${M.dr >= 0 ? ", or the DRAM sample at the cursor is above 0" : ""}`,
      nvme: M.nvme >= 0 ? "lit: the NVMe busy sample at the cursor is above 0" : "never lit: this run has no NVMe samples",
      chipset: "lit with the NVMe behind it",
    };
    const name = (id) => S.nameText(S.field("name", id));
    /** [the grid line, SMs used]: up to min(blocks, SMs), since a block runs on one SM. */
    const grid = (d, when) => {
      const g = d?.args?.grid, blocks = g ? g.reduce((a, b) => a * b, 1) : 0, used = Math.min(nSM, blocks);
      if (d === undefined) return [`${when} · reading its grid`, 0];
      if (!blocks) return [`${when} · grid not recorded`, 0];
      return [`${blocks} block${blocks === 1 ? "" : "s"} (grid ${g.join("×")}) on up to ${used} of ${nSM} SMs · ${when}`, used];
    };
    const sampleLine = () => {
      if (M.sm < 0) return "this run has no SMs-active samples";
      const w = sampleWindow(S, M.sm, state.t), v = val(M.sm);
      return w && !Number.isNaN(v) ? `sample: SMs active ${fmtValue(v, S.metrics[M.sm].unit)} of ${nSM} SMs (avg) over ${ms(w[0])} to ${ms(w[1])} (${fmtSpan(S.samplePeriod(M.sm))} state)`
        : "SMs active: no sample at the cursor";
    };
    const header = (title, line) => { text(-21, -10, fit(title, 42, BIG), "big"); text(-21, -8.75, fit(line, 42, SUB), "sub"); text(-21, -7.6, fit(sampleLine(), 42, SUB), "sub"); };
    const smGrid = (x0, y0, litN, c, drill, note) => inv.sms.forEach((sm, i) => box(x0 + (i % 6) * 2.05, y0 + Math.floor(i / 6) * 2.05, 1.75, 1.75, c,
      { lit: i < litN, op: i < litN ? 0.95 : 0.2, pick: [sm.key, drill], title: `${sm.name}${note ? ` · ${note}` : ""}` }));
    const USED = "SMs lit: as many as the grid can use; which SMs ran it is not recorded";

    function board(device, x0 = 0, y0 = 0, k = 1) {
      const P = (x, y) => [x0 + x * k, y0 - y * k], th = 0.35 * k;
      if (inv.cpu && inv.gpu) { link(P(-6, 3.6), P(3, 3.6), lit.htod, HWC, th); link(P(3, 2.4), P(-6, 2.4), lit.dtoh, HWC, th); }
      if (inv.ram && inv.cpu) link(P(-11, 0.25), P(-11, -3.9), lit.ram, GREY, th);
      if (inv.vram && inv.gpu) link(P(9, 0.25), P(9, -3.9), lit.vram, VRAMC, th);
      if (inv.chipset) { if (inv.cpu) link(P(-6, 1), P(-3, -3.5), lit.nvme, GREY, th); if (inv.nvme) link(P(-1, -5.1), P(-1, -7.5), lit.nvme, COPYC, th); }
      if (inv.network && inv.cpu) link(P(-6, 5), P(-1, 6.5), lit.network, NETC, th);
      // [lit key, thing, x, y, w, h, colour, role, the hardware tier a click goes to]: D13's positions; the chipset is the run's
      const B = [["cpu", inv.cpu, -11, 3, 10, 5.5, GREY, "CPU", 3], ["ram", inv.ram, -11, -5.5, 10, 3.2, GREY, "RAM", 2],
        ["gpu", inv.gpu, 9, 3, 12, 5.5, HWC, "GPU", 3], ["vram", inv.vram, 9, -5.5, 12, 3.2, VRAMC, "VRAM", 4],
        ["nvme", inv.nvme, -1, -8.6, 7, 2.2, COPYC, "NVMe", 2], ["network", inv.network, -1, 7.6, 7, 2.2, NETC, "network", 2],
        ["chipset", inv.chipset, -1, -4.3, 6, 1.6, GREY, "chipset", 2]];
      for (const [id, thing, x, y, w, h, c, role, drill] of B) {
        if (!thing) continue;
        const W = w * k, Hh = h * k, small = Hh < 3;
        const lines = k < 1 ? [] : wrap(thing.name, Math.floor((W - 0.8) / 0.31), Math.max(0, Math.floor((Hh - (small ? 0.95 : 1.3) - 0.3) / 0.8)));
        box(...P(x, y), W, Hh, c, { lit: lit[id], label: k < 1 && id === "chipset" ? null : role, cls: k < 1 || small ? "sub" : "big", pick: [thing.key, drill], lines,
          title: `${thing.name} (${thing.evidence ?? "inventory"}) · ${why[id]}` });
      }
      if (k === 1) {
        const pcie = inv.link(inv.cpu, inv.gpu), dmi = inv.link(inv.chipset, inv.cpu);
        if (pcie) text(...P(-1.5, 0.9), pcie, "sub", 0.5);
        if (dmi) text(...P(-4.6, -2), dmi, "sub", 1);
        if (inv.board) text(-21, -10.2, `board: ${inv.board.name}`, "sub");
      }
      if (device) {
        const nx = devSt.ids[next];
        const copy = (id) => { const b = S.field("bytes", id); return `${name(id)}${Number.isNaN(b) ? "" : `, ${fmtBytes(b)}`}`; };
        text(-21, 10.6, fit(tr.length ? `in flight: ${copy(tr[0].id)}${tr.length > 1 ? ` (+${tr.length - 1} more)` : ""}`
          : `no copy in flight · next: ${nx != null ? `${copy(nx)} at ${ms(devSt.t[next])}` : "none"}`, 42, BIG), "big");
      }
    }

    const TIERS = [
      () => {
        box(-12, 0.5, 18, 17, PANEL, { op: 0.55, pick: inv.host ? [inv.host.key, 1] : null, title: inv.host?.name });
        text(-20.4, -7.2, `system: ${inv.hosts} node${inv.hosts === 1 ? "" : "s"}, ${inv.gpus} GPU${inv.gpus === 1 ? "" : "s"}`, "big");
        board(false, -12, 1.4, 0.36);
        if (inv.board) box(-12, 7.2, 15, 1.6, PANEL, { op: 0.9, label: fit(`node: ${inv.board.name} (click to open)`, 14.4, SUB), cls: "sub", pick: [inv.board.key, 1], title: inv.board.name });
        text(0, -8.4, "samples at the cursor (state, not stops)", "sub");
        const gib = (b) => (b / 2 ** 30).toFixed(1), vram = inv.gpu?.attrs?.vram_bytes;
        const pctOf = (i) => (/%/.test(S.metrics[i].unit) ? val(i) / 100 : NaN);
        const bars = [   // [label, catalog indexes it reads, fraction of the bar, value text]
          ["GPU busy", [M.gpu], () => pctOf(M.gpu), () => fmtValue(val(M.gpu), S.metrics[M.gpu].unit)],
          ["SMs active", [M.sm], () => pctOf(M.sm), () => `${fmtValue(val(M.sm), S.metrics[M.sm].unit)} of ${nSM} SMs (avg)`],
          ["DRAM", [M.dr, M.dw].filter((i) => i >= 0), () => dram / 100, () => `${fmtValue(dram, "%")} (read + write)`],
          ["PCIe RX", [M.rx], () => pctOf(M.rx), () => fmtValue(val(M.rx), S.metrics[M.rx].unit)],
          ["PCIe TX", [M.tx], () => pctOf(M.tx), () => fmtValue(val(M.tx), S.metrics[M.tx].unit)],
          ["CPU", [M.cpu], () => pctOf(M.cpu), () => fmtValue(val(M.cpu), S.metrics[M.cpu].unit)],
          ["VRAM", [M.mem], () => (vram ? (val(M.mem) * 2 ** 20) / vram : NaN), () => `${gib(val(M.mem) * 2 ** 20)} of ${vram ? gib(vram) : "?"} GiB used`],
        ];
        bars.forEach(([label, idx, frac, value], i) => {
          const y = -5.6 + i * 2.3, have = idx.length > 0 && idx.every((j) => j >= 0), v = have ? frac() : NaN, fresh = have && !Number.isNaN(v);
          const title = have ? idx.map(about).join(" · ") : `${label}: not recorded in this run`, f = Math.max(0, Math.min(1, v));
          text(5.6, y, label, "", 1);
          box(10, y, 8, 1.4, PANEL, { op: 0.9, title });
          if (fresh) box(6 + 4 * f, y, Math.max(0.05, 8 * f), 1.4, HWC, { op: 0.95, title });
          text(14.5, y, !have ? "not in this run" : fresh ? value() : "no sample", "sub", 0, fresh ? undefined : "#5d6575");
        });
      },
      () => board(false),
      () => board(true),
      () => {
        const at = kid >= 0 && n.kernel?.id === kid, d = at ? this.detailOf(S, kid) : null, [line, used] = at ? grid(d, "at the cursor") : ["", 0];
        const after = kid >= 0 && !at ? `next kernel, starts ${ms(S.startOf[kid])}: ${name(kid)}` : "no kernel after it";
        if (at) header(`kernel grid: ${name(kid)}`, line);
        else header(n.kernel ? `a copy at the cursor: ${name(n.kernel.id)}` : "GPU idle at the cursor", after);
        smGrid(-19.5, -5.4, used, HWC, 4, used ? USED : "");
        const l2b = at ? d?.counters?.values?.find((x) => x.measure === "L2 traffic")?.value : undefined;
        if (inv.l2) box(-4.8, 0.8, 2.6, 12, CACHE, { lit: l2b > 0, label: "L2", cls: "big", pick: [inv.l2.key, 4],
          title: `${inv.l2.name} · lit: the kernel at the cursor has Nsight Compute L2 traffic above 0` });
        inv.mcs.slice(0, 4).forEach((mc, i) => box(-0.6, -3.6 + i * 2.9, 3, 2.4, CACHE, { lit: dram > 0, label: `MC${keyNum(mc)}`, pick: [mc.key, 4],
          title: `${mc.name} (${mc.evidence}) · lit: the DRAM sample at the cursor is above 0` }));
        if (inv.vram) box(4, 0.8, 3, 12, VRAMC, { lit: lit.vram, label: "VRAM", cls: "big", pick: [inv.vram.key, 4], title: `${inv.vram.name} · ${why.vram}` });
        inv.ces.slice(0, 2).forEach((ce, i) => box(i ? -0.6 : -4.8, 8.6, i ? 3 : 2.6, 1.8, COPYC, { lit: i === 0 && val(M.ce0) > 0, label: `CE${keyNum(ce)}`, pick: [ce.key, 2],
          title: `${ce.name} · ${i === 0 && M.ce0 >= 0 ? `lit: ${about(M.ce0)}, above 0 at the cursor` : "never lit: this run has no samples for it"}` }));
        const cpus = M.cpus.length || inv.cpu?.attrs?.threads || 0;
        text(8.6, -5.8, M.cpus.length ? "logical CPUs, busy %" : "logical CPUs", "big");
        for (let i = 0; i < cpus; i++) {
          const m = M.cpus[i] ?? -1, v = m >= 0 ? val(m) : NaN, on = !Number.isNaN(v);
          box(9.8 + (i % 4) * 2.6, -3.2 + Math.floor(i / 4) * 2.6, 2.2, 2.2, GREY, { op: on ? 0.15 + 0.8 * Math.min(1, v / 100) : 0.3,
            label: on ? `${Math.round(v)}` : null, cls: "sub", pick: inv.cpu ? [inv.cpu.key, 3] : null,
            title: m >= 0 ? `${about(m)} · ${on ? fmtValue(v, S.metrics[m].unit) : "no sample at the cursor"}` : `CPU ${i}: per-CPU use is not recorded in this run` });
        }
        if (!M.cpus.length) text(8.6, -3.2 + Math.ceil(cpus / 4) * 2.6, "per-CPU use: not recorded in this run", "sub");
      },
      () => {
        const [k2, when] = this.kernelAt(S, n), d = this.detailOf(S, k2);
        if (k2 < 0) { text(0, -1, "no kernel at or after the cursor", "big", 0.5); text(0, 1.6, `the request is in: ${phaseName(S, n)}`, "sub", 0.5); return; }
        const [line, used] = grid(d, when), cls = S.dims.kernelClass(k2);
        header(`kernel grid: ${name(k2)}`, line);
        smGrid(-19.5, -5.4, used, CLASS_COL[cls] ?? GREY, 5, `${cls ?? "unclassed"} kernel${used ? ` · ${USED}` : ""}`);
        const c = d?.counters, v = (m) => c?.values?.find((x) => x.measure === m)?.value;
        const rd = v("DRAM read"), wr = v("DRAM write"), l2 = v("L2 traffic"), occ = v("achieved occupancy");
        if (inv.l2) box(2, 0.8, 3, 12, CACHE, { lit: !!c, label: "L2", cls: "big", pick: [inv.l2.key, 4], title: inv.l2.name });
        if (inv.vram) box(15, 0.8, 4, 12, VRAMC, { lit: !!c, label: "VRAM", cls: "big", pick: [inv.vram.key, 4], title: inv.vram.name });
        link([13, -1], [3.5, -1], !!c, VRAMC, 0.3 + Math.min(1.2, ((rd ?? 0) + (wr ?? 0)) / 1e6 / 40));
        link([0.5, -1], [-7, -1], !!c, CACHE, 0.3 + Math.min(1.2, (l2 ?? 0) / 1e6 / 40));
        text(8.3, -4.6, "VRAM ⇄ L2", "big", 0.5);
        text(8.3, -3.4, c ? `DRAM read ${fmtBytes(rd)}` : "DRAM bytes:", "sub", 0.5);
        text(8.3, -2.5, c ? `DRAM write ${fmtBytes(wr)}` : "not profiled", "sub", 0.5);
        text(-3.2, -4.6, "L2 ⇄ SMs", "big", 0.5);
        text(-3.2, -3.4, c ? `L2 traffic ${fmtBytes(l2)}` : "L2 bytes: not profiled", "sub", 0.5);
        const ncu = S.tools?.ncu, notProf = ncu ? `not profiled (Nsight Compute profiled iteration ${ncu.kernels?.iteration ?? "?"} only)` : "not profiled (this run has no Nsight Compute counters)";
        text(-21, 8.8, d === undefined ? "reading the kernel's counters" : c ? `achieved occupancy ${fmtValue(occ, "%")} · profiled by Nsight Compute (replayed alone, caches flushed)` : notProf, "sub");
        text(-21, 10.4, `${d?.cause ? `launched by ${d.cause.name} at ${ms(d.cause.start)} on the CPU · ` : d === undefined ? "" : "launch call not recorded · "}click an SM for SM internals`, "sub");
      },
      () => {
        const [k2, when] = this.kernelAt(S, n), d = this.detailOf(S, k2), kn = k2 >= 0 ? name(k2) : "";
        const sm = typeof sel === "string" ? inv.sms.find((x) => x.key === sel) : null, a = (sm ?? inv.sms[0])?.attrs ?? {};
        box(-9, 0, 22, 15, PANEL, { op: 0.55 });
        text(-19.4, -6.2, fit(`${sm ? sm.name : "one SM"}${k2 >= 0 ? ` running ${kn}` : ""}`, 21, BIG), "big");
        box(-9, -1.8, 20.4, 4.4, HWC, { op: 0.12, label: "warp schedulers: not in this run's inventory", cls: "sub" });
        box(-9, 3, 20.4, 1.8, "#c792ea", { op: 0.3, cls: "sub",
          label: a.regs_per_sm ? `register file: ${a.regs_per_sm.toLocaleString("en-US")} 32-bit registers` : "register file: size not in the inventory",
          lines: d?.args?.registers != null ? [`this kernel: ${d.args.registers} registers per thread`] : [] });
        box(-9, 5.4, 20.4, 1.8, CACHE, { op: 0.3, cls: "sub",
          label: a.smem_per_sm ? `shared memory: ${fmtBytes(a.smem_per_sm)} per SM` : "shared memory: size not in the inventory",
          lines: d?.args?.shared_memory != null ? [`this kernel: ${fmtBytes(d.args.shared_memory)} per block`] : [] });
        out.push(`<rect x="3.4" y="-6" width="18.2" height="12" rx=".3" fill="#101827" stroke="${HWC}" stroke-width=".1"/>`);
        text(4.2, -4.6, "Open in Nsight Compute", "big", 0, HWC);
        text(4.2, -3, k2 >= 0 ? fit(`${kn} (${when})`, 17, 0.85) : "no kernel at or after the cursor");
        const ncu = S.tools?.ncu;
        ["Warps, registers and shared memory", "live in the ncu report.",
          ...(k2 < 0 || d === undefined || d?.counters ? [] : ncu ? ["This kernel was not profiled", `(ncu profiled iteration ${ncu.kernels?.iteration ?? "?"} only).`] : ["This run has no Nsight Compute", "counters."]),
          "Owner ruling: not redrawn here."].forEach((l, i) => text(4.2, -1.3 + i * 1.3, l, "sub"));
      },
    ];
    TIERS[tier]?.();
    return out.join("");
  }
}

/** The phase unit at the cursor, by name (D13: "the request is in"). */
function phaseName(S, n) {
  const p = S.dims.ladders.execution.indexOf("phase"), u = n.exec[p];
  return u ? unitLabel(S, "phase", u.id) : "–";
}
